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
    segment_type: str   # "heading", "paragraph", "math_block", "pause"
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
