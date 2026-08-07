/**
 * latex2text.js — Fuss LaTeX/Mathpix-Markdown → speakable plain text.
 *
 * A faithful in-browser port of the Python pipeline:
 *   - pipeline/replacements.py     (text_replacements, math_replacements)
 *   - pipeline/text_processor.py   (process_mmd and helpers)
 *
 * This is the library the beta "Feedback" button is meant to improve: when a
 * LaTeX command is read as gibberish or missed, the fix is a new rule in the
 * arrays below. Order matters — longer/compound patterns must precede the
 * shorter ones they contain, exactly as in the Python source.
 *
 * Pure functions (applyTextRules, speakMath, preprocessMmd) run anywhere and
 * are unit-tested under Node. processMmd additionally needs a Markdown renderer
 * and DOMParser, which the browser supplies (see app.js).
 */

// ---------------------------------------------------------------------------
// Replacement tables (ported 1:1 from pipeline/replacements.py)
// ---------------------------------------------------------------------------

// Applied to ordinary prose. No surrounding spaces are added (matches Python).
export const textReplacements = [
  [/i\.e\./g, 'that is'],
  [/e\.g\./g, 'for example'],
  [/e\. g\./g, 'for example'],
  [/i\.i\.d\.?/g, 'independent and identically distributed'],
  [/\b[iI][iI][dD]\b/g, 'independent and identically distributed'],
  [/Eq\./g, 'Equation'],
  [/eq\./g, 'equation'],
  [/Fig\./g, 'Figure'],
  [/fig\./g, 'figure'],
  [/Sec\./g, 'Section'],
  [/sec\./g, 'section'],
  [/Tab\./g, 'Table'],
  [/tab\./g, 'table'],
  [/Thm\./g, 'Theorem'],
  [/thm\./g, 'theorem'],
  [/vs\./g, 'versus'],
  [/w\.r\.t\./g, 'with respect to'],
  [/w\.r\.t/g, 'with respect to'],
  [/w\.l\.o\.g\./g, 'without loss of generality'],
  [/\((.*?)\)-th/g, '$1-th'],
  // remove numbers after sentences, e.g. ... of training.4
  [/(\w+)\.(\d+)$/g, '$1'],
  // add break after title number
  [/#+\s+(\d+(\.\d+)*)\s+/g, '<s>$1</s>'],
  [/ et al\./g, ' et al'],
  // normalise ssml closing tags
  [/<break time="0\.5s"><\/break>/g, '<break time="0.5s"/>'],
  // remove references: [1], [1, 2], [14] etc. but NOT (0), (1) which may be math
  [/\s*\[[0-9,\-, ]+(, pp\. [0-9,\-]+|, p\.\d+f?f?\.?)?\]/g, ''],
  // paren citations need a space after each comma — "(1, 2)" is a citation,
  // "(1,2)" is math (a tuple, or the argument of BG(1,2) / BS(1,2))
  [/\s*\(\d+(?:(?:,\s+|\s*[-–]\s*)\d+)+(, pp\. [0-9,\-]+|, p\.\d+f?f?\.?)?\)/g, ''],
  [/\s*\[[^\]]*, \d{4}(?:, [^\]]*, \d{4})*\]/g, ''],
  [/\s*\([^)]*, \d{4}(?:[;,] [^)]*, \d{4}[a-zA-Z]*?)*\)/g, ''],
  [/\s*(\b\w+\s+et al\.) (\[\d{4}\]|\(\d{4}\))/g, '$1'],
  // remove urls
  [/\s*https?:\/\/[\w/:%#$&?()~.=+\-]*[\w\d_\-]/g, ''],
  // remove new lines
  [/\n/g, ''],
];

// Applied to the contents of a math span. Each replacement is surrounded by
// spaces (matches Python's re.sub(pattern, ' ' + repl + ' ', result)).
export const mathReplacements = [
  // combined symbols
  [/\\lVert\\cdot\\rVert/g, 'norm'],

  // Fractions, powers, exponents (BEFORE arithmetic so ^{-1} isn't mangled)
  [/\^\{-1\}/g, 'inverse'],
  [/\^\{-1}/g, 'inverse'],
  [/\^{-1}/g, 'inverse'],
  [/\^\{\\circ\}/g, 'degrees'],
  [/\^\{2\}/g, 'squared'],
  [/\^2/g, 'squared'],
  [/\^\{3\}/g, 'cubed'],
  [/\^3/g, 'cubed'],
  [/\^\{T\}/g, 'transpose'],
  [/\^\{\\prime\}/g, 'prime'],
  [/\^\{\*\}/g, 'star'],
  [/\^\{n\}/g, 'to the n'],
  [/\^\{[+]\}/g, ' '],
  [/\^\{([^}]+)\}/g, 'to the $1'],
  [/\\[td]?frac{([^}]+)}{([^}]+)}/g, '$1 over $2'],
  [/\\[td]?frac/g, 'over'],

  // Basic arithmetic operations
  [/\+/g, 'plus'],
  [/-/g, 'minus'],
  [/\*/g, 'multiplied by'],
  [/\//g, 'divided by'],

  // Roots
  [/\\sqrt{([^}]+)}/g, 'square root of $1'],
  [/\\sqrt\[3]{([^}]+)}/g, 'cube root of $1'],
  [/\\sqrt\[(\d+)]{([^}]+)}/g, '$1-th root of $2'],

  // Logarithmic and exponential functions (subscripted base first)
  [/\\log_\{([^}]+)\}/g, 'log base $1 of'],
  [/\\log_(\w)/g, 'log base $1 of'],
  [/\\ln/g, 'natural log of'],
  [/\\log/g, 'log of'],
  [/\\exp/g, 'e to the'],

  // Modular arithmetic
  [/\\pmod\{([^}]+)}/g, 'mod $1'],
  [/\\bmod/g, 'mod'],
  [/\\mod/g, 'mod'],
  [/\\equiv/g, 'is congruent to'],

  // Calculus symbols
  [/\\int/g, 'integral'],
  [/\\prod/g, 'product over'],
  [/\\sum/g, 'summation over'],
  [/\\lim/g, 'limit'],
  [/\\infty/g, 'infinity'],

  // Basic mathematical symbols
  [/\\pm/g, 'plus or minus'],
  [/\\times/g, 'times'],
  [/\\div/g, 'divided by'],
  [/\\cdot/g, 'times'],
  [/\\leq/g, 'less than or equal to'],
  [/\\geq/g, 'greater than or equal to'],
  [/>/g, 'greater'],
  [/</g, 'less than'],
  [/\\neq/g, 'not equal to'],
  [/\\approx/g, 'approximately'],

  // Relations
  [/\\cong/g, 'is isomorphic to'],
  [/\\rtimes/g, 'semidirect product with'],
  [/\\ltimes/g, 'semidirect product with'],
  [/\\sim/g, 'distributed as'],
  [/\\propto/g, 'proportional to'],
  [/\\odot/g, 'element-wise'],
  [/\\otimes/g, 'tensor product'],
  [/\\oplus/g, 'direct sum'],

  // Quantifiers and logic symbols
  [/\\forall/g, 'for all'],
  [/\\ni/g, 'such that'],
  [/\\exists/g, 'there exists'],
  [/\\leftarrow/g, 'gets'],
  [/\\gets/g, 'gets'],
  [/\\rightarrow/g, 'goes to'],
  [/\\Rightarrow/g, 'implies'],
  [/\\Leftarrow/g, 'is implied by'],
  [/\\Leftrightarrow/g, 'if and only if'],
  [/\\mapsto/g, 'maps to'],
  [/\\to/g, 'to'],
  [/\\not\s*\\in/g, 'is not in'],
  [/\\in/g, 'in'],

  // Greek letters (capitals first — longer names match before shorter)
  [/\\Gamma/g, 'Gamma'],
  [/\\Delta/g, 'Delta'],
  [/\\Theta/g, 'Theta'],
  [/\\Lambda/g, 'Lambda'],
  [/\\Sigma/g, 'Sigma'],
  [/\\Phi/g, 'Phi'],
  [/\\Psi/g, 'Psi'],
  [/\\Omega/g, 'Omega'],
  [/\\alpha/g, 'alpha'],
  [/\\beta/g, 'beta'],
  [/\\gamma/g, 'gamma'],
  [/\\delta/g, 'delta'],
  [/\\epsilon/g, 'epsilon'],
  [/\\zeta/g, 'zeta'],
  [/\\eta/g, 'eta'],
  [/\\theta/g, 'theta'],
  [/\\iota/g, 'iota'],
  [/\\kappa/g, 'kappa'],
  [/\\lambda/g, 'lambda'],
  [/\\mu/g, 'mu'],
  [/\\nu/g, 'nu'],
  [/\\xi/g, 'ksi'],
  [/\\pi/g, 'pi'],
  [/\\rho/g, 'rho'],
  [/\\sigma/g, 'sigma'],
  [/\\tau/g, 'tau'],
  [/\\upsilon/g, 'upsilon'],
  [/\\phi/g, 'phi'],

  // Trigonometric functions
  [/\\sin/g, 'sine'],
  [/\\cos/g, 'cosine'],
  [/\\tan/g, 'tangent'],
  [/\\cot/g, 'cotangent'],
  [/\\arcsin/g, 'arcsine'],
  [/\\arccos/g, 'arccosine'],
  [/\\arctan/g, 'arctangent'],

  // Set notation
  [/\\emptyset/g, 'empty set'],
  [/\\subseteq/g, 'is a subset of or equal to'],
  [/\\superset/g, 'superset'],
  [/\\cup/g, 'union'],
  [/\\cap/g, 'intersection'],
  [/\\notin/g, 'is not an element of'],
  [/\\subset/g, 'subset'],
  [/\\setminus/g, 'set minus'],
  [/\\operatorname\{supp}/g, 'support of'],

  // Other symbols
  [/\\mathbb\{E}/g, 'expectation'],
  [/\\hat\{([^}]+)}/g, '$1 hat'],
  [/\\bar\{([^}]+)}/g, '$1 bar'],
  [/\\tilde\{([^}]+)}/g, '$1 tilde'],
  [/\\dot\{([^}]+)}/g, '$1 dot'],
  [/\\ddot\{([^}]+)}/g, '$1 double dot'],
  [/\\mathcal\{([^}]+)}/g, '$1'],
  [/\\mathbb\{([^}]+)}/g, '$1'],
  [/\\mathbf\{([^}]+)}/g, '$1'],
  [/\\mathcal\{([^}]+)}/g, '$1'],
  [/\\lVert/g, 'norm of'],
  [/\\rVert/g, ''],
  [/\\langle/g, ''],
  [/\\rangle/g, ''],
  [/\\dots/g, ''],
  [/\\ldots/g, ''],
  [/\\mid/g, ''],

  // Calculus and vector notation
  [/\\nabla/g, 'gradient of'],
  [/\\partial/g, 'partial'],
  [/\\operatorname\{([^}]+)}/g, '$1'],

  // Display math formatting
  [/\\text\{([^}]*)}/g, '$1'],
  [/\\textrm\{([^}]*)}/g, '$1'],
  [/\\mathrm\{([^}]*)}/g, '$1'],
  [/\\tag\{[^}]*}/g, ''],
  [/\\tag\s*\d+/g, ''],
  [/\\boxed\{([^}]*)}/g, '$1'],
  [/\\quad/g, ' '],
  [/\\qquad/g, ' '],
  [/\\,/g, ' '],
  [/\\;/g, ' '],
  [/\\!/g, ''],
  [/\\begin\{[^}]*}/g, ''],
  [/\\end\{[^}]*}/g, ''],
  [/\\underbrace\{([^}]*)}/g, '$1'],
  [/\\overbrace\{([^}]*)}/g, '$1'],
  [/\\overline\{([^}]*)}/g, '$1 bar'],

  // Removing unnecessary LaTeX commands
  [/\\[Bb]ig[gl]?/g, ''],
  [/\\[Bb]ig[gr]?/g, ''],
  [/\\boldsymbol/g, ''],
  [/\\left(?!arrow)/g, ''],
  [/\\right(?!arrow)/g, ''],
  [/\^/g, ''],
  [/\|/g, ''],
  [/\\/g, ''],
  [/_/g, ''],
  [/\{/g, ''],
  [/\}/g, ''],
];

// ---------------------------------------------------------------------------
// Pure transforms
// ---------------------------------------------------------------------------

/** Convert a LaTeX math expression to spoken English. Mirrors _speak_math. */
export function speakMath(latex) {
  let result = latex;
  // Expand nested fractions/roots innermost-first before the flat rule table:
  // its single-pass regexes use [^}]+ and can't see through nesting, which
  // turned ^{\frac{1}{\sqrt{2}}} into "to the over 1 square root of 2".
  // [^{}]* only matches brace-free arguments, so looping resolves inside-out.
  let prev;
  do {
    prev = result;
    result = result
      .replace(/\\[td]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, ' $1 over $2 ')
      .replace(/\\sqrt\s*\[3\]\s*\{([^{}]*)\}/g, ' cube root of $1 ')
      .replace(/\\sqrt\s*\[(\d+)\]\s*\{([^{}]*)\}/g, ' $1-th root of $2 ')
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, ' square root of $1 ');
  } while (result !== prev);
  for (const [pattern, replacement] of mathReplacements) {
    result = result.replace(pattern, ' ' + replacement + ' ');
  }
  return result.replace(/\s+/g, ' ').trim();
}

/** Apply prose replacement rules (abbreviations, reference removal, etc.). */
export function applyTextRules(text) {
  // Strip Markdown emphasis asterisks; math asterisks were handled in speakMath.
  text = text.replace(/\*/g, '');
  for (const [pattern, replacement] of textReplacements) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

/**
 * Crop Nougat's repetition loops. The small model often degenerates into the
 * same sentence repeated many times (sometimes with tiny variations that slip
 * past token-level no_repeat_ngram). This collapses consecutive duplicate
 * sentences and caps any substantial sentence at ONE occurrence per block —
 * within a single paragraph, an identical ≥4-word sentence appearing again is
 * a generation loop, not prose. (Legitimate restatements, e.g. a theorem
 * repeated before its proof, live in separate blocks and are unaffected.)
 */
export function dedupeRepeats(text) {
  if (!text) return text;
  const units = text.split(/(?<=[.!?])\s+/);
  if (units.length < 3) return text;

  const norm = (u) =>
    u
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const out = [];
  const seen = new Map();
  let prevKey = null;
  for (const u of units) {
    const key = norm(u);
    if (!key) {
      out.push(u);
      continue;
    }
    const wordCount = key.split(' ').length;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (key === prevKey) continue; // collapse a run of identical sentences
    if (wordCount >= 4 && count > 1) continue; // a long sentence speaks once per block
    prevKey = key;
    out.push(u);
  }
  return out.join(' ');
}

/** Fix MMD quirks before Markdown parsing. Mirrors _preprocess_mmd. */
export function preprocessMmd(content) {
  // Put each \[...\] block on its own paragraph.
  content = content.replace(/(\\\[.*?\\\])/g, '\n\n$1\n\n');

  // Remove raw LaTeX table environments Nougat sometimes emits as text.
  content = content.replace(/\\begin\{table\}[\s\S]*?\\end\{table\}/g, '');

  // Remove duplicate consecutive lines (Nougat sometimes repeats content).
  const lines = content.split('\n');
  const deduped = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (deduped.length && stripped && stripped === deduped[deduped.length - 1].trim()) {
      continue;
    }
    deduped.push(line);
  }
  return deduped.join('\n');
}

/**
 * Replace every math span with its spoken form, removing the delimiters.
 *
 * Nougat emits display math as \[...\], inline as \(...\), plus $$...$$ and
 * $...$. We speak math *before* Markdown rendering so the result is plain prose
 * (this replaces the Python texmath-plugin step, which isn't needed here).
 */
export function speakMathSpans(content) {
  const span = (re) => {
    content = content.replace(re, (_m, inner) => ' ' + speakMath(inner) + ' ');
  };
  span(/\\\[([\s\S]*?)\\\]/g); // display \[ ... \]
  span(/\\\(([\s\S]*?)\\\)/g); // inline  \( ... \)
  span(/\$\$([\s\S]*?)\$\$/g); // display $$ ... $$
  span(/\$([^$\n]+?)\$/g); // inline  $ ... $
  return content;
}

// ---------------------------------------------------------------------------
// Full document pipeline (browser: needs a Markdown renderer + DOMParser)
// ---------------------------------------------------------------------------

function isPageHeaderFooter(el) {
  const text = el.textContent.trim();
  if (text.length > 120) return false;
  // Entirely wrapped in a single <em> → likely a running header/footer.
  const kids = Array.from(el.childNodes).filter(
    (n) => n.nodeType !== 3 || n.textContent.trim() !== ''
  );
  return kids.length === 1 && kids[0].nodeName === 'EM';
}

/** Drop likely author/affiliation lines between the title and the abstract. */
function stripAuthorLines(segments) {
  let titleIdx = null;
  let abstractIdx = null;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].segment_type === 'heading') {
      if (titleIdx === null) {
        titleIdx = i;
        continue;
      }
      const lower = segments[i].text.toLowerCase();
      if (lower.includes('abstract') || lower.includes('introduction')) {
        abstractIdx = i;
        break;
      }
    }
  }
  if (titleIdx === null || abstractIdx === null || abstractIdx - titleIdx <= 1) {
    return segments;
  }
  const keep = [];
  for (let i = 0; i < segments.length; i++) {
    if (titleIdx < i && i < abstractIdx) {
      const text = segments[i].text.trim();
      const authorLike =
        text.length < 300 &&
        (text.includes(',') ||
          /\d/.test(text) ||
          text.includes('@') ||
          /university|institute|department|lab/i.test(text));
      if (authorLike) continue;
    }
    keep.push(segments[i]);
  }
  return keep;
}

// ---------------------------------------------------------------------------
// Footnote handling
// ---------------------------------------------------------------------------
//
// Journal classes (amsart etc.) render \thanks{}, \keywords{}, \subjclass{}
// as unnumbered footnotes at the bottom of page 1. Nougat transcribes the page
// in layout order, so that metadata lands mid-stream — typically right after
// the abstract — and gets read aloud. It's metadata, never referenced from a
// sentence, so it is stripped from the spoken stream entirely.

// A paragraph that IS a metadata footnote (matched against its start).
const metadataFootnoteRes = [
  /^key\s?words?( and phrases)?\s*[.:;—–-]/i,
  /^index terms\s*[.:;—–-]/i,
  /^ccs concepts\s*[.:;—–-]/i,
  /^(\d{4}\s+)?mathematics subject classifications?\b/i,
  /^msc( ?\(?\d{4}\)?)?\s*[.:;]/i,
  /^(this (work|research|study|project|material)|the (first |second |third |corresponding )?authors?('s work)?) (is|are|was|were|has been|have been)\b.{0,40}\b(supported|funded|financed)\b/i,
  /^(partially |gratefully )?(supported|funded) (in part )?by\b/i,
  /^funding\s*[.:;]/i,
  /^e-?mail address(es)?\s*[.:;]/i,
];

// Keywords/MSC glued onto the end of a real paragraph (Nougat sometimes merges
// the last prose block with the page-bottom footnotes). These clauses run to
// the end of the block, so truncating at the marker is safe.
const metadataTailRe =
  /\s(?:key\s?words?(?: and phrases)?\s*[.:;]|(?:\d{4}\s+)?mathematics subject classifications?\s*[.:;]|index terms\s*[—–.:;-]|ccs concepts\s*[.:;])/i;

/** Drop keywords / MSC codes / funding-acknowledgment footnotes. */
export function stripMetadataFootnotes(segments) {
  const keep = [];
  for (const seg of segments) {
    if (seg.segment_type !== 'paragraph') {
      keep.push(seg);
      continue;
    }
    const isMetadata = (t) => t.length < 600 && metadataFootnoteRes.some((re) => re.test(t));
    let text = seg.text;
    if (isMetadata(text)) continue;
    const tail = text.match(metadataTailRe);
    if (tail && tail.index > 0) {
      text = text.slice(0, tail.index).trim();
      const srcTail = seg.source_text.match(metadataTailRe);
      if (srcTail && srcTail.index > 0) {
        seg.source_text = seg.source_text.slice(0, srcTail.index).trim();
      }
      seg.text = text;
    }
    // What's left may itself be metadata (a merged thanks+keywords block).
    if (!text || isMetadata(text)) continue;
    keep.push(seg);
  }
  return keep;
}

// A real footnote definition: Nougat's "Footnote 1: ..." / "Footnote †: ..."
// style, or a paragraph opening with a footnote symbol. Bare leading numbers
// are deliberately NOT treated as footnotes — too many false positives
// (enumerations, equation tags).
const footnoteDefRe = /^(?:footnote\s*(\d{1,3}|[*†‡§¶])?\s*[.:]\s+|([†‡§¶])\s*[.:]?\s*)/i;

/** Where the in-text reference to footnote `marker` is, or -1. */
function findFootnoteRef(segments, marker, before) {
  if (!marker || marker === '*') return -1;
  const isNum = /^\d+$/.test(marker);
  const explicit = isNum ? new RegExp(`\\bfootnote\\s+${marker}\\b`, 'i') : null;
  // A superscript marker survives Nougat as a digit glued to the preceding
  // word or punctuation, e.g. "as shown.3" — match that, but not decimals
  // ("3.5") or longer numbers ("x12" when looking for 1).
  const glued = isNum
    ? new RegExp(`(?<![0-9])[a-zA-Z.,)\\]”"']${marker}(?=[\\s.,;:!?)\\]]|$)`)
    : null;
  for (let i = before - 1; i >= 0; i--) {
    const text = segments[i].text;
    if (isNum ? explicit.test(text) || glued.test(text) : text.includes(marker)) return i;
  }
  return -1;
}

/**
 * Move footnote paragraphs out of the mid-page reading flow. If the in-text
 * reference can be found, the footnote is spoken right after the segment that
 * cites it ("Footnote 1: … End of footnote."); otherwise it is deferred to the
 * end of its section (before the next heading) so it never interrupts a
 * sentence mid-thought.
 */
export function relocateFootnotes(segments) {
  const rest = [];
  const defs = []; // { at: index in rest where the def sat, marker, body, seg }
  for (const seg of segments) {
    const m = seg.segment_type === 'paragraph' ? seg.text.match(footnoteDefRe) : null;
    if (!m) {
      rest.push(seg);
      continue;
    }
    const body = seg.text.slice(m[0].length).trim();
    if (!body) continue; // marker with no content — nothing to speak
    defs.push({ at: rest.length, marker: m[1] || m[2] || '', body, seg });
  }
  // Insert back-to-front so earlier insertions don't shift later positions.
  for (let d = defs.length - 1; d >= 0; d--) {
    const { at, marker, body, seg } = defs[d];
    const label = marker && marker !== '*' ? ` ${marker}` : '';
    seg.text = `Footnote${label}: ${body} End of footnote.`;
    seg.segment_type = 'footnote';

    const refIdx = findFootnoteRef(rest, marker, at);
    let insertAt;
    if (refIdx >= 0) {
      insertAt = refIdx + 1;
    } else {
      insertAt = rest.length;
      for (let i = at; i < rest.length; i++) {
        if (rest[i].segment_type === 'heading') {
          insertAt = i;
          break;
        }
      }
    }
    rest.splice(insertAt, 0, seg);
  }
  return rest;
}

/**
 * Convert Mathpix Markdown into ordered speakable segments. Mirrors process_mmd.
 *
 * @param {string} mmd            raw Nougat output
 * @param {object} deps
 * @param {Function} deps.renderMarkdown  (md:string) => htmlString
 * @param {Function} deps.parseHtml       (html:string) => Document
 * @returns {Array<{text, source_text, segment_type, index}>}
 */
export function processMmd(mmd, { renderMarkdown, parseHtml }) {
  let content = preprocessMmd(mmd);
  content = speakMathSpans(content);
  const html = renderMarkdown(content);
  const doc = parseHtml(html);

  // Images and tables don't read well.
  doc.querySelectorAll('img, table').forEach((el) => el.remove());

  const segments = [];
  const blocks = doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, section');
  blocks.forEach((el) => {
    // Crop runaway repetition within a block (the common case: one paragraph
    // that loops the same sentence) before anything else.
    const rawText = dedupeRepeats(el.textContent.replace(/\s+/g, ' ').trim());
    if (!rawText) return;

    const name = el.nodeName.toLowerCase();
    if (name === 'p' && isPageHeaderFooter(el)) return;

    const segType = name.startsWith('h') ? 'heading' : 'paragraph';
    let spoken = applyTextRules(rawText).replace(/\s+/g, ' ').trim();
    // Nothing speakable (e.g. a lone "(" or ")" left over from an equation
    // tag rendered as its own paragraph) → skip.
    if (spoken && /[a-zA-Z0-9]/.test(spoken)) {
      segments.push({ text: spoken, source_text: rawText, segment_type: segType, index: 0 });
    }
  });

  const deduped = dedupeSegments(segments); // catch loops split across paragraphs
  const stripped = stripAuthorLines(deduped);
  const noMeta = stripMetadataFootnotes(stripped);
  const relocated = relocateFootnotes(noMeta);
  relocated.forEach((seg, i) => (seg.index = i));
  return relocated;
}

/** Drop consecutive duplicate segments and cap repeated segments. */
function dedupeSegments(segments) {
  const out = [];
  const seen = new Map();
  let prevKey = null;
  for (const seg of segments) {
    const key = seg.text
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const wordCount = key ? key.split(' ').length : 0;
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (key && key === prevKey) continue;
    // An identical ≥10-word block appearing twice is a Nougat artifact (it
    // re-emits front-matter footnotes at the end of the page), not prose.
    if (wordCount >= 10 && count > 1) continue;
    if (wordCount >= 4 && count > 2) continue;
    prevKey = key;
    out.push(seg);
  }
  return out;
}

/** Convenience: segments → a single plain-text document. */
export function segmentsToText(segments) {
  return segments.map((s) => s.text).join('\n\n');
}
