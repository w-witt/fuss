"""Convert Mathpix Markdown to a list of speakable text segments.

Adapted from paper2speech/src/markdown_to_html.py MarkdownModel.
Removes the Gemma.cpp dependency and outputs structured segments
instead of raw SSML.
"""

import re
from dataclasses import dataclass, asdict
from typing import List

from bs4 import BeautifulSoup
from markdown_it import MarkdownIt
from mdit_py_plugins.front_matter import front_matter_plugin
from mdit_py_plugins.footnote import footnote_plugin
from mdit_py_plugins.deflist import deflist_plugin
from mdit_py_plugins.tasklists import tasklists_plugin
from mdit_py_plugins.anchors import anchors_plugin
from mdit_py_plugins.attrs import attrs_plugin
from mdit_py_plugins.texmath import texmath_plugin

from pipeline.replacements import text_replacements, math_replacements


@dataclass
class TextSegment:
    text: str           # Speakable text for TTS
    source_text: str    # Display text (original, lightly cleaned)
    segment_type: str   # "heading", "paragraph", "math_block", "pause", "footnote"
    index: int = 0      # Segment index, set during processing


def process_mmd(mmd_content: str) -> List[TextSegment]:
    """Convert Mathpix Markdown content into ordered speakable segments."""
    mmd_content = _preprocess_mmd(mmd_content)
    html = _render_markdown(mmd_content)
    soup = BeautifulSoup(html, 'html.parser')

    # Replace inline and display math with spoken equivalents
    for eq in soup.find_all(['eq', 'eqn']):
        original = eq.get_text()
        spoken = _speak_math(original)
        eq.string = spoken

    # Remove images and tables — these don't read well
    for tag in soup.find_all(['img', 'table']):
        tag.decompose()

    segments: List[TextSegment] = []

    for tag in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'section']):
        raw_text = tag.get_text(separator=' ', strip=True)
        if not raw_text:
            continue

        # Skip page headers/footers: short italic-only paragraphs mid-document
        if tag.name == 'p' and _is_page_header_footer(tag):
            continue

        if tag.name.startswith('h'):
            seg_type = 'heading'
        else:
            seg_type = 'paragraph'

        # Source text: lightly cleaned for display
        source = raw_text

        # Speakable text: apply all text replacement rules
        spoken = _apply_text_rules(raw_text)
        spoken = re.sub(r'\s+', ' ', spoken).strip()

        if spoken:
            segments.append(TextSegment(
                text=spoken,
                source_text=source,
                segment_type=seg_type,
            ))

    # Strip likely author lines between title and abstract
    segments = _strip_author_lines(segments)

    # Drop metadata footnotes (keywords, MSC codes, funding), then move real
    # footnotes out of the mid-page reading flow
    segments = _strip_metadata_footnotes(segments)
    segments = _relocate_footnotes(segments)

    # Assign indices
    for i, seg in enumerate(segments):
        seg.index = i

    return segments


def segments_to_dicts(segments: List[TextSegment]) -> List[dict]:
    """Convert segments to JSON-serializable dicts."""
    return [asdict(seg) for seg in segments]


def _preprocess_mmd(content: str) -> str:
    """Fix MMD quirks so markdown-it can parse all math correctly.

    The texmath plugin only recognizes \\[...\\] as display math when it is
    alone on its own line.  Nougat often chains multiple display equations
    on a single line or places them after text.  Split them apart.
    """
    # Put each \[...\] block on its own paragraph so texmath recognizes it.
    # Needs a blank line before and after for markdown-it to treat it as
    # a separate block rather than inline content.
    content = re.sub(
        r'(\\\[.*?\\\])',
        r'\n\n\1\n\n',
        content,
    )

    # Remove raw LaTeX table environments that Nougat sometimes emits
    # outside of math delimiters (they appear as raw text in the HTML).
    content = re.sub(
        r'\\begin\{table\}.*?\\end\{table\}',
        '',
        content,
        flags=re.DOTALL,
    )

    # Remove duplicate consecutive lines (Nougat sometimes duplicates content)
    lines = content.split('\n')
    deduped = []
    for line in lines:
        stripped = line.strip()
        if deduped and stripped and stripped == deduped[-1].strip():
            continue
        deduped.append(line)
    content = '\n'.join(deduped)

    return content


def _render_markdown(content: str) -> str:
    """Parse Mathpix Markdown to HTML using markdown-it."""
    md = (
        MarkdownIt('commonmark', {})
        .use(front_matter_plugin)
        .use(footnote_plugin)
        .use(deflist_plugin)
        .use(tasklists_plugin)
        .use(anchors_plugin, max_level=6)
        .use(attrs_plugin)
        .use(texmath_plugin, delimiters='brackets')
    )
    return md.render(content)


def _is_page_header_footer(tag) -> bool:
    """Detect page headers/footers that Nougat picks up from PDFs.

    These are typically short, italic-only lines (e.g. '_Paper Title_')
    that repeat across pages.
    """
    text = tag.get_text(strip=True)
    if len(text) > 120:
        return False
    # Check if the paragraph is entirely wrapped in <em> (italic)
    children = list(tag.children)
    if len(children) == 1 and getattr(children[0], 'name', None) == 'em':
        return True
    return False


def _speak_math(latex: str) -> str:
    """Convert a LaTeX math expression to spoken English."""
    result = latex
    for pattern, replacement in math_replacements:
        result = re.sub(pattern, ' ' + replacement + ' ', result)
    return re.sub(r'\s+', ' ', result).strip()


def _apply_text_rules(text: str) -> str:
    """Apply text replacement rules (abbreviations, reference removal, etc.)."""
    # Strip asterisks used for Markdown formatting (bold, italic, list markers).
    # Math-context asterisks are already converted via _speak_math before this runs.
    text = text.replace('*', '')
    for pattern, replacement in text_replacements:
        text = re.sub(pattern, replacement, text)
    return text


# Journal classes (amsart etc.) render \thanks{}, \keywords{}, \subjclass{}
# as unnumbered footnotes at the bottom of page 1. Nougat transcribes the page
# in layout order, so that metadata lands mid-stream — typically right after
# the abstract — and gets read aloud. It's metadata, never referenced from a
# sentence, so it is stripped from the spoken stream entirely.

_METADATA_FOOTNOTE_RES = [
    re.compile(r'^key\s?words?( and phrases)?\s*[.:;—–-]', re.I),
    re.compile(r'^index terms\s*[.:;—–-]', re.I),
    re.compile(r'^ccs concepts\s*[.:;—–-]', re.I),
    re.compile(r'^(\d{4}\s+)?mathematics subject classifications?\b', re.I),
    re.compile(r'^msc( ?\(?\d{4}\)?)?\s*[.:;]', re.I),
    re.compile(
        r'^(this (work|research|study|project|material)'
        r'|the (first |second |third |corresponding )?authors?(\'s work)?) '
        r'(is|are|was|were|has been|have been)\b.{0,40}\b(supported|funded|financed)\b',
        re.I,
    ),
    re.compile(r'^(partially |gratefully )?(supported|funded) (in part )?by\b', re.I),
    re.compile(r'^funding\s*[.:;]', re.I),
    re.compile(r'^e-?mail address(es)?\s*[.:;]', re.I),
    re.compile(r'^date\s*[.:]', re.I),  # amsart \date footnote
]

# Keywords/MSC glued onto the end of a real paragraph (Nougat sometimes merges
# the last prose block with the page-bottom footnotes). These clauses run to
# the end of the block, so truncating at the marker is safe.
_METADATA_TAIL_RE = re.compile(
    r'\s(?:key\s?words?(?: and phrases)?\s*[.:;]'
    r'|(?:\d{4}\s+)?mathematics subject classifications?\s*[.:;]'
    r'|index terms\s*[—–.:;-]'
    r'|ccs concepts\s*[.:;])',
    re.I,
)


def _strip_metadata_footnotes(segments: List[TextSegment]) -> List[TextSegment]:
    """Drop keywords / MSC codes / funding-acknowledgment footnotes."""
    keep = []
    for seg in segments:
        if seg.segment_type != 'paragraph':
            keep.append(seg)
            continue
        def is_metadata(t):
            return len(t) < 600 and any(r.match(t) for r in _METADATA_FOOTNOTE_RES)

        text = seg.text
        if is_metadata(text):
            continue
        tail = _METADATA_TAIL_RE.search(text)
        if tail and tail.start() > 0:
            text = text[:tail.start()].strip()
            src_tail = _METADATA_TAIL_RE.search(seg.source_text)
            if src_tail and src_tail.start() > 0:
                seg.source_text = seg.source_text[:src_tail.start()].strip()
            seg.text = text
        # What's left may itself be metadata (a merged thanks+keywords block).
        if not text or is_metadata(text):
            continue
        keep.append(seg)
    return keep


# A real footnote definition: Nougat's "Footnote 1: ..." / "Footnote †: ..."
# style, or a paragraph opening with a footnote symbol. Bare leading numbers
# are deliberately NOT treated as footnotes — too many false positives
# (enumerations, equation tags).
_FOOTNOTE_DEF_RE = re.compile(
    r'^(?:footnote\s*(\d{1,3}|[*†‡§¶])?\s*[.:]\s+|([†‡§¶])\s*[.:]?\s*)', re.I
)


def _find_footnote_ref(segments: List[TextSegment], marker: str, before: int) -> int:
    """Index of the segment carrying the in-text reference to `marker`, or -1."""
    if not marker or marker == '*':
        return -1
    is_num = marker.isdigit()
    explicit = re.compile(r'\bfootnote\s+%s\b' % marker, re.I) if is_num else None
    # A superscript marker survives Nougat as a digit glued to the preceding
    # word or punctuation, e.g. "as shown.3" — match that, but not decimals
    # ("3.5") or longer numbers ("x12" when looking for 1).
    glued = (
        re.compile(r'(?<![0-9])[a-zA-Z.,)\]”"\']%s(?=[\s.,;:!?)\]]|$)' % marker)
        if is_num else None
    )
    for i in range(before - 1, -1, -1):
        text = segments[i].text
        if is_num:
            if explicit.search(text) or glued.search(text):
                return i
        elif marker in text:
            return i
    return -1


def _relocate_footnotes(segments: List[TextSegment]) -> List[TextSegment]:
    """Move footnote paragraphs out of the mid-page reading flow.

    If the in-text reference can be found, the footnote is spoken right after
    the segment that cites it ("Footnote 1: ... End of footnote."); otherwise
    it is deferred to the end of its section (before the next heading) so it
    never interrupts a sentence mid-thought.
    """
    rest: List[TextSegment] = []
    defs = []  # (index in rest where the def sat, marker, body, segment)
    for seg in segments:
        m = _FOOTNOTE_DEF_RE.match(seg.text) if seg.segment_type == 'paragraph' else None
        if not m:
            rest.append(seg)
            continue
        body = seg.text[m.end():].strip()
        if not body:
            continue  # marker with no content — nothing to speak
        defs.append((len(rest), m.group(1) or m.group(2) or '', body, seg))

    # Insert back-to-front so earlier insertions don't shift later positions.
    for at, marker, body, seg in reversed(defs):
        label = ' %s' % marker if marker and marker != '*' else ''
        seg.text = 'Footnote%s: %s End of footnote.' % (label, body)
        seg.segment_type = 'footnote'

        ref_idx = _find_footnote_ref(rest, marker, at)
        if ref_idx >= 0:
            insert_at = ref_idx + 1
        else:
            insert_at = len(rest)
            for i in range(at, len(rest)):
                if rest[i].segment_type == 'heading':
                    insert_at = i
                    break
        rest.insert(insert_at, seg)
    return rest


def _strip_author_lines(segments: List[TextSegment]) -> List[TextSegment]:
    """Simple heuristic to remove author/affiliation lines before the abstract.

    Looks for lines between the first heading (title) and a heading containing
    'abstract' or 'introduction'. Lines that look like author lists (short,
    contain commas, numbers, or institutional markers) are removed.
    """
    abstract_idx = None
    title_idx = None

    for i, seg in enumerate(segments):
        if seg.segment_type == 'heading':
            if title_idx is None:
                title_idx = i
                continue
            lower = seg.text.lower()
            if 'abstract' in lower or 'introduction' in lower:
                abstract_idx = i
                break

    if title_idx is None or abstract_idx is None or abstract_idx - title_idx <= 1:
        return segments

    # Check lines between title and abstract
    keep = []
    for i, seg in enumerate(segments):
        if title_idx < i < abstract_idx:
            text = seg.text.strip()
            # Heuristic: author lines are typically short, have commas,
            # superscript markers, or email-like patterns
            is_author_like = (
                len(text) < 300
                and (
                    ',' in text
                    or re.search(r'\d', text)
                    or '@' in text
                    or re.search(r'university|institute|department|lab', text, re.I)
                )
            )
            if is_author_like:
                continue
        keep.append(seg)

    return keep
