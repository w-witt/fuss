/**
 * textlayer.js — born-digital PDF → Mathpix-Markdown via the embedded text
 * layer, no OCR model involved.
 *
 * Why: Nougat re-*generates* the page from pixels and can hallucinate or loop.
 * A born-digital PDF already carries every word; prose fidelity is perfect if
 * we read the text layer directly. The hard part is math — glyph positions,
 * not semantics — so this module reconstructs LaTeX for the math it can
 * recognize (symbols by Unicode, variables by TeX font, scripts by baseline
 * geometry) and reports a per-page confidence. Pages with constructs it can't
 * linearize (stacked fractions, big operators with limits) get a LOW
 * confidence, and app.js sends those pages to Nougat instead.
 *
 * Input is pdf.js's TextContent (`page.getTextContent()`), plus an optional
 * map of internal font ids → PostScript names (resolved from page.commonObjs)
 * used to spot TeX math fonts (CMMI/CMSY/…). Pure data-in/data-out: no DOM,
 * runs under Node for tests and the tools/ harness.
 */

// --- Unicode → LaTeX -------------------------------------------------------

// Symbols that mark a character as "math" and their spoken-pipeline LaTeX.
// (latex2text.js speaks these; anything missing there reads as its name.)
const SYMBOL_TO_LATEX = {
  '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv',
  '≅': '\\cong', '∼': '\\sim', '∝': '\\propto', '±': '\\pm', '∓': '\\pm',
  '×': '\\times', '÷': '\\div', '⋅': '\\cdot', '·': '\\cdot', '∘': '\\circ',
  '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '√': '\\sqrt', '∞': '\\infty',
  '∂': '\\partial', '∇': '\\nabla', '∈': '\\in', '∉': '\\notin', '∋': '\\ni',
  '⊂': '\\subset', '⊆': '\\subseteq', '⊃': '\\superset', '∪': '\\cup',
  '∩': '\\cap', '∖': '\\setminus', '∅': '\\emptyset', '∀': '\\forall',
  '∃': '\\exists', '¬': '\\neg', '∧': '\\wedge', '∨': '\\vee',
  '→': '\\rightarrow', '←': '\\leftarrow', '↦': '\\mapsto', '⇒': '\\Rightarrow',
  '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '⟨': '\\langle', '⟩': '\\rangle',
  '⊕': '\\oplus', '⊗': '\\otimes', '⊙': '\\odot', '⋊': '\\rtimes', '⋉': '\\ltimes',
  '′': "^{\\prime}", '−': '-', '∗': '*', '∣': '\\mid', '∥': '\\|',
  'ℝ': '\\mathbb{R}', 'ℤ': '\\mathbb{Z}', 'ℕ': '\\mathbb{N}', 'ℚ': '\\mathbb{Q}',
  'ℂ': '\\mathbb{C}', 'ℍ': '\\mathbb{H}', 'ℓ': 'l', 'ℵ': '\\aleph',
};

const GREEK_TO_LATEX = {
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta', 'ε': '\\epsilon',
  'ϵ': '\\epsilon', 'ζ': '\\zeta', 'η': '\\eta', 'θ': '\\theta', 'ϑ': '\\theta',
  'ι': '\\iota', 'κ': '\\kappa', 'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu',
  'ξ': '\\xi', 'π': '\\pi', 'ρ': '\\rho', 'σ': '\\sigma', 'ς': '\\sigma',
  'τ': '\\tau', 'υ': '\\upsilon', 'φ': '\\phi', 'ϕ': '\\phi', 'χ': '\\chi',
  'ψ': '\\psi', 'ω': '\\omega', 'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta',
  'Λ': '\\Lambda', 'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Φ': '\\Phi',
  'Ψ': '\\Psi', 'Ω': '\\Omega',
};

// U+1D400–U+1D7FF Mathematical Alphanumeric Symbols → plain letters/digits.
function foldMathAlnum(cp) {
  if (cp < 0x1d400 || cp > 0x1d7ff) return null;
  if (cp >= 0x1d7ce) return String.fromCharCode(0x30 + ((cp - 0x1d7ce) % 10)); // digits
  const off = (cp - 0x1d400) % 52;
  return off < 26 ? String.fromCharCode(65 + off) : String.fromCharCode(97 + off - 26);
}

function isMathCodepoint(cp) {
  return (
    (cp >= 0x2200 && cp <= 0x22ff) || // math operators
    (cp >= 0x2190 && cp <= 0x21ff) || // arrows
    (cp >= 0x27c0 && cp <= 0x27ef) ||
    (cp >= 0x2a00 && cp <= 0x2aff) ||
    (cp >= 0x1d400 && cp <= 0x1d7ff) || // math alphanumerics
    (cp >= 0x2100 && cp <= 0x214f) || // letterlike (ℝ, ℓ, …)
    (cp >= 0x0370 && cp <= 0x03ff) || // Greek
    (cp >= 0x2032 && cp <= 0x2037) // primes
  );
}

// TeX / OpenType math font PostScript names ("ABCDEF+CMMI10" → math italic).
const MATH_FONT_RE = /CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|EUSM|RSFS|Math|Symbol/i;

// Math-ITALIC fonts specifically: a letter run in these ("bab") is juxtaposed
// single-letter variables, not a word — TeX sets multi-letter operator names
// (log, det, …) in roman, never math italic. Spoken, the letters must be
// separated ("b a b"), or the TTS reads "bab" as one syllable.
const MATH_ITALIC_FONT_RE = /CMMI|MI\d|[rt]?txmi|Math-?Italic|MathItalic/i;

// --- geometry helpers ------------------------------------------------------

function itemSize(it) {
  const t = it.transform;
  return Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 0;
}

function itemX(it) {
  return it.transform[4];
}
function itemY(it) {
  return it.transform[5];
}

/** Weighted mode of font sizes ≈ the body text size. */
function bodyFontSize(items) {
  const hist = new Map();
  for (const it of items) {
    const s = Math.round(itemSize(it) * 2) / 2;
    if (!s) continue;
    hist.set(s, (hist.get(s) || 0) + it.str.length);
  }
  let best = 10;
  let bestW = -1;
  for (const [s, w] of hist) {
    if (w > bestW) {
      bestW = w;
      best = s;
    }
  }
  return best;
}

/**
 * Group items into visual lines (top→bottom, then left→right). The tolerance
 * is body-relative and generous enough that sub/superscripts — which sit a few
 * points off the baseline in a smaller font — join their base line instead of
 * forming phantom mini-lines of exponents.
 */
function groupLines(items, body) {
  const sorted = [...items].sort((a, b) => itemY(b) - itemY(a) || itemX(a) - itemX(b));
  const tol = Math.max(2.5, body * 0.52);
  const lines = [];
  for (const it of sorted) {
    const size = itemSize(it);
    const line = lines.find((l) => Math.abs(l.y - itemY(it)) < tol);
    if (line) {
      line.items.push(it);
      if (size > line.size) line.size = size;
    } else {
      lines.push({ y: itemY(it), size, items: [it] });
    }
  }
  for (const l of lines) {
    l.items.sort((a, b) => itemX(a) - itemX(b));
    // Reference baseline = the item carrying the most text at full size, so
    // sub/superscripts and stray fragments don't drag the baseline around.
    const score = (it) => it.str.trim().length * itemSize(it);
    const main = l.items.reduce((a, b) => (score(b) > score(a) ? b : a));
    l.y = itemY(main);
    l.size = itemSize(main);
  }
  reassignScriptItems(lines, body);
  return lines.filter((l) => l.items.length);
}

/**
 * Display-style scripts sit ~0.7em off the baseline — beyond the line
 * grouping tolerance — so a display equation's exponents can cluster into a
 * phantom "line" of their own (often together with the equation's radical
 * glyphs) that reads before the bases. Fix at item granularity: every
 * script-size glyph (TeX scriptsize ≤0.7×body; footnote text is ≥0.8× and
 * unaffected) must live on a line that has full-size alphanumeric content
 * (an anchor) with the item in its script window. Items that don't are moved
 * to the nearest anchoring line whose x-span covers them, where the
 * level/offset logic attaches them as ^{}/_{ } correctly.
 */
function reassignScriptItems(lines, body) {
  const anchors = lines.filter(
    (l) =>
      l.size >= body * 0.9 &&
      l.items.some((it) => itemSize(it) >= body * 0.9 && /[A-Za-z0-9]/.test(it.str))
  );
  const span = (l) => [
    itemX(l.items[0]),
    itemX(l.items[l.items.length - 1]) + (l.items[l.items.length - 1].width || 0),
  ];
  // superscripts hang up to ~1.05×body above an anchor baseline; subscripts
  // up to ~0.6×body below
  const inWindow = (y, n) => {
    const dy = y - n.y;
    return dy >= -body * 0.6 && dy <= body * 1.05;
  };
  for (const l of lines) {
    const isAnchor = anchors.includes(l);
    for (let k = l.items.length - 1; k >= 0; k--) {
      const it = l.items[k];
      if (itemSize(it) > body * 0.78) continue;
      const y = itemY(it);
      if (isAnchor && inWindow(y, l)) continue; // already attached correctly
      let best = null;
      let bestDy = Infinity;
      for (const n of anchors) {
        if (n === l || !inWindow(y, n)) continue;
        const [b0, b1] = span(n);
        const x = itemX(it);
        if (x < b0 - body || x > b1 + body) continue;
        const dy = Math.abs(y - n.y);
        if (dy < bestDy) {
          bestDy = dy;
          best = n;
        }
      }
      if (best) {
        best.items.push(it);
        l.items.splice(k, 1);
      }
    }
  }
  for (const l of lines) l.items.sort((a, b) => itemX(a) - itemX(b));
}

// TeX renders some symbols as multi-glyph compositions; the text layer sees
// the pieces. Reassemble the common ones before character mapping.
function normalizeTexGlyphs(s) {
  return (
    s
      // combining long-slash (U+0338): TeX's \neq / \notin come through as
      // slash + base glyph (either order)
      .replace(/̸\s*=|=\s*̸/g, '≠')
      .replace(/̸\s*∈|∈\s*̸/g, '∉')
      .replace(/̸/g, '')
      // end-of-proof boxes and list bullets read as noise
      .replace(/[□∎■◻▪]/g, '')
  );
}

// --- per-line reconstruction ----------------------------------------------

/**
 * An inline \frac reaches the text layer as two script-size glyphs stacked at
 * the same x (numerator above the axis, denominator below) — read in glyph
 * order they glue into nonsense ("(12, 0)" for (1/2, 0)). Fuse each such pair
 * into a synthetic \frac{num}{den} item on the line's baseline, which
 * latex2text speaks as "num over den". Only simple alphanumeric pairs fuse;
 * anything richer stays as-is for the confidence penalty to judge.
 */
function fuseStackedFractions(items, line) {
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.latex) continue;
    const sa = itemSize(a);
    if (sa > line.size * 0.78) continue;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (b.latex) continue;
      const sb = itemSize(b);
      if (sb > line.size * 0.78) continue;
      const aw = a.width || sa;
      const bw = b.width || sb;
      const overlap = Math.min(itemX(a) + aw, itemX(b) + bw) - Math.max(itemX(a), itemX(b));
      if (overlap < Math.min(aw, bw) * 0.5) continue;
      const dy = itemY(a) - itemY(b);
      if (Math.abs(dy) < line.size * 0.25 || Math.abs(dy) > line.size * 1.4) continue;
      const [num, den] = dy > 0 ? [a, b] : [b, a];
      const numS = num.str.trim();
      const denS = den.str.trim();
      if (!/^[A-Za-z0-9]{1,4}$/.test(numS) || !/^[A-Za-z0-9]{1,4}$/.test(denS)) continue;
      items[i] = {
        str: `${numS}/${denS}`,
        latex: ` \\frac{${numS}}{${denS}} `,
        transform: [line.size, 0, 0, line.size, Math.min(itemX(a), itemX(b)), line.y],
        width: Math.max(aw, bw),
        fontName: a.fontName,
      };
      items.splice(j, 1);
      break;
    }
  }
}

/**
 * Convert one visual line into text, wrapping recognized math runs in \( \).
 *
 * Scripts are handled by LEVEL: a full-size item is level 0, a first-level
 * sub/superscript (TeX ~7pt vs 10pt body) is level 1, a script-of-a-script
 * (~5pt) is level 2. Walking left→right, a level increase opens ^{ or _{
 * (sign of the vertical offset), a decrease closes — which linearizes nested
 * exponents like x^{2^{n}} correctly from pure geometry.
 *
 * Returns { text, mathChars, totalChars, unknownMath, supSubs }.
 */
function lineToText(line, fontPs) {
  let mathChars = 0;
  let totalChars = 0;
  let unknownMath = 0;

  // TeX's \neq / \notin render as a standalone slash glyph overlaying the
  // next item — fuse them so normalizeTexGlyphs sees the pair.
  const items = [];
  for (const it of line.items) {
    const prev = items[items.length - 1];
    if (prev && prev.str.trim() === '̸') {
      items[items.length - 1] = { ...it, str: '̸' + it.str, transform: prev.transform };
      continue;
    }
    items.push(it);
  }
  fuseStackedFractions(items, line);

  // Tokenize: map characters, classify math-ness and script level.
  const tokens = []; // { text, math, level, y, space }
  let prevEnd = null;
  for (const it of items) {
    const raw = normalizeTexGlyphs(it.str);
    if (!raw.trim()) continue;
    const size = itemSize(it);
    const level = size >= line.size * 0.82 ? 0 : size >= line.size * 0.55 ? 1 : 2;
    const ps = fontPs[it.fontName] || '';
    const mathFont = MATH_FONT_RE.test(ps);
    const mathItalic = MATH_ITALIC_FONT_RE.test(ps);

    const gap = prevEnd === null ? 0 : itemX(it) - prevEnd;
    const space = prevEnd !== null && gap > size * 0.15;
    prevEnd = itemX(it) + (it.width || 0);

    if (it.latex) {
      // Synthetic construct (fused fraction) — pre-built LaTeX, always math.
      totalChars += it.str.length;
      mathChars += it.str.length;
      tokens.push({ text: it.latex, math: true, level: 0, y: itemY(it), space });
      continue;
    }

    let text = '';
    let itemMath = mathFont;
    for (const ch of raw) {
      const cp = ch.codePointAt(0);
      totalChars++;
      if (SYMBOL_TO_LATEX[ch]) {
        text += ` ${SYMBOL_TO_LATEX[ch]} `;
        itemMath = true;
        mathChars++;
      } else if (GREEK_TO_LATEX[ch]) {
        text += ` ${GREEK_TO_LATEX[ch]} `;
        itemMath = true;
        mathChars++;
      } else if (mathItalic && /[A-Za-z]/.test(ch)) {
        // Juxtaposed math-italic variables: separate so "bab" speaks b a b.
        text += ch + ' ';
        mathChars++;
      } else {
        const folded = foldMathAlnum(cp);
        if (folded !== null) {
          // Mathematical Alphanumeric letters are individual symbols too.
          text += /[A-Za-z]/.test(folded) ? folded + ' ' : folded;
          itemMath = true;
          mathChars++;
        } else if (isMathCodepoint(cp) || cp === 0xfffd) {
          // A math-range char we have no mapping for — fidelity risk.
          text += ' ';
          itemMath = true;
          mathChars++;
          unknownMath++;
        } else {
          text += ch;
          if (mathFont) mathChars++;
        }
      }
    }
    if (!text.trim()) continue;
    tokens.push({ text, math: itemMath, level, y: itemY(it), space });
  }

  // Assemble.
  let out = '';
  let inMath = false;
  let supSubs = 0;
  const stack = []; // open script operators, depth == current level
  const levelY = [line.y]; // last baseline seen per level

  const closeScripts = (toLevel) => {
    while (stack.length > toLevel) {
      out += '}';
      stack.pop();
    }
  };
  const closeMath = () => {
    closeScripts(0);
    if (inMath) {
      out = out.replace(/\s+$/, '') + '\\)';
      inMath = false;
    }
  };

  for (const tok of tokens) {
    if (tok.level === 0) {
      closeScripts(0);
      if (tok.math && !inMath) {
        out += (out && !/\s$/.test(out) ? ' ' : '') + '\\(';
        inMath = true;
      } else if (!tok.math && inMath) {
        closeMath();
        out += ' ';
      } else if (tok.space) {
        out += ' ';
      }
      out += tok.text;
      levelY[0] = tok.y;
      levelY.length = 1;
      continue;
    }

    // Script token.
    supSubs++;
    const script = tok.text.trim();
    if (!script) continue;
    if (!inMath && stack.length === 0) {
      // A small RAISED digit right after prose (a word or its punctuation) is
      // a footnote marker — keep it glued ("word.3") so relocateFootnotes can
      // find the reference. Lowered digits are subscripts (log_2), and a digit
      // following another digit is an exponent (2^2) — both take the script
      // path below.
      const prevChar = out.replace(/\s+$/, '').slice(-1);
      if (
        /^\d{1,3}$/.test(script) &&
        !tok.math &&
        tok.y > levelY[0] &&
        /[a-zA-Z.,;:)\]!?'’”]/.test(prevChar)
      ) {
        out = out.replace(/\s+$/, '') + script;
        continue;
      }
      // Pull the preceding bare token into a math span: x2 → \(x^{2}\).
      if (/\\\)\s*$/.test(out)) {
        out = out.replace(/\\\)\s*$/, ''); // reopen the span just closed
      } else {
        const m = out.match(/([^\s\\(){}]+)\s*$/);
        const baseTok = m ? m[1] : '';
        out = out.slice(0, out.length - (m ? m[0].length : 0));
        out += `\\(${baseTok}`;
      }
      inMath = true;
    }
    closeScripts(tok.level); // deeper scripts than this token end here
    while (stack.length < tok.level) {
      const baseY = levelY[stack.length] ?? line.y;
      const op = tok.y > baseY ? '^' : '_';
      out += `${op}{`;
      stack.push(op);
    }
    out += (tok.space && !/[{\s]$/.test(out) ? ' ' : '') + script;
    levelY[tok.level] = tok.y;
    levelY.length = tok.level + 1;
  }
  closeMath();

  // TeX's \mapsto is drawn as a "7"-shaped bar glyph + arrow; reassemble.
  out = out
    .replace(/7\s*\\\(\s*\\rightarrow/g, '\\(\\mapsto')
    .replace(/7\s*\\rightarrow/g, '\\mapsto')
    // ∼ stacked over = is how TeX draws \cong / \simeq
    .replace(/\\sim\s*\\\)\s*=/g, '\\cong\\)')
    .replace(/\\sim\s*=/g, '\\cong')
    // brace a bare radical's radicand so \sqrt speaks its argument
    .replace(/\\sqrt\s+(\d+|[a-zA-Z])/g, '\\sqrt{$1}');

  return {
    text: out.replace(/\s+/g, ' ').trim(),
    mathChars,
    totalChars,
    unknownMath,
    supSubs,
  };
}

// --- page assembly ---------------------------------------------------------

/**
 * Extract one page of Mathpix-Markdown from pdf.js text content.
 *
 * @param {object} textContent  result of page.getTextContent()
 * @param {object} [opts]
 * @param {object} [opts.fontNames]  map item.fontName → PostScript font name
 * @param {number} [opts.pageIndex]  0-based page number (running-head removal)
 * @param {object} [opts.viewBox]    page.view ([x0, y0, x1, y1]) for margins
 * @returns {{ mmd, confidence, mathRatio, hasText }}
 */
export function extractPageMmd(textContent, opts = {}) {
  const fontPs = opts.fontNames || {};
  // Drop rotated text (arXiv margin watermarks, sideways figure labels) —
  // vertical strips would otherwise splice into whatever line they cross.
  const items = textContent.items.filter((it) => {
    if (!it.str || it.str.trim() === '') return false;
    const t = it.transform;
    return Math.abs(t[1]) < Math.abs(t[0]) * 0.05 + 0.01 && t[0] > 0;
  });
  if (!items.length) return { mmd: '', confidence: 0, mathRatio: 0, hasText: false };

  const body = bodyFontSize(items);
  const allLines = groupLines(items, body);

  // A line with no full-size alphanumeric content at its own dominant size is
  // unanchored debris: radical bars plus script fragments the reassignment
  // pass couldn't place (deep fraction stacks). Speaking it would be noise —
  // drop it, but charge it to the page's confidence so equation-dense pages
  // still fall back to Nougat.
  let orphanChars = 0;
  const lines = [];
  for (const l of allLines) {
    const anchored = l.items.some(
      (it) => itemSize(it) >= l.size * 0.9 && /[A-Za-z0-9]/.test(it.str)
    );
    if (anchored) {
      lines.push(l);
    } else {
      orphanChars += l.items.reduce((n, it) => n + it.str.trim().length, 0);
    }
  }
  if (!lines.length) return { mmd: '', confidence: 0, mathRatio: 0, hasText: false };

  const pageTop = lines.length ? lines[0].y : 0;
  const pageBottom = lines.length ? lines[lines.length - 1].y : 0;

  // Line records with layout stats.
  const recs = [];
  let mathChars = 0;
  let totalChars = 0;
  let unknownMath = 0;
  for (const line of lines) {
    const r = lineToText(line, fontPs);
    if (!r.text) continue;
    // Orphan symbol debris (a radical's bar glyph on its own "line", stray
    // delimiters) has no alphanumeric content once commands are removed.
    // A short digits-only line is the same thing — the upper deck of a
    // stacked construct; real equation lines carry variable letters. Both
    // stay out of the speech but count against the page's confidence.
    const spoken = r.text.replace(/\\[a-zA-Z]+/g, '').replace(/[\\(){}^_]/g, '');
    if (
      !/[A-Za-z0-9]/.test(spoken) ||
      (!/[A-Za-z]/.test(spoken) && spoken.replace(/\s/g, '').length < 12)
    ) {
      orphanChars += r.totalChars;
      continue;
    }
    mathChars += r.mathChars;
    totalChars += r.totalChars;
    unknownMath += r.unknownMath;
    recs.push({
      ...r,
      y: line.y,
      size: line.size,
      x0: itemX(line.items[0]),
      x1: itemX(line.items[line.items.length - 1]) + (line.items[line.items.length - 1].width || 0),
    });
  }
  if (!recs.length) return { mmd: '', confidence: 0, mathRatio: 0, hasText: false };

  // Stacked math (fraction bars, limits under ∑): two "lines" almost touching
  // with horizontal overlap can't be linearized by reading order. Weigh the
  // damage by how much of the page's text sits in the stacked fragments — a
  // page-wide wall of fractions must fall back to Nougat, one inline fraction
  // in a sea of prose must not.
  let stackedChars = 0;
  for (let i = 1; i < recs.length; i++) {
    const a = recs[i - 1];
    const b = recs[i];
    const gap = a.y - b.y;
    if (gap > 0 && gap < Math.min(a.size, b.size) * 0.85) {
      if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0) {
        stackedChars += Math.min(a.totalChars, b.totalChars);
      }
    }
  }

  // Drop running heads / lone page numbers at the extreme top and bottom.
  const isRunningHead = (r, edge) => {
    if (Math.abs(r.y - edge) > body * 1.6) return false;
    const t = r.text.replace(/\s+/g, ' ').trim();
    if (/^\d{1,4}$/.test(t)) return true; // bare page number
    if (opts.pageIndex > 0 && t.length < 70 && !/[.?!:]$/.test(t)) {
      // short, unpunctuated strip at the page edge — arXiv/journal running head
      return /^[A-Z0-9 .,'’\-–—:]+$/.test(t) || /^\d+\s/.test(t) || /\s\d+$/.test(t);
    }
    return false;
  };
  let kept = recs.filter(
    (r, i) => !((i === 0 && isRunningHead(r, pageTop)) || (i === recs.length - 1 && isRunningHead(r, pageBottom)))
  );

  // Median inter-line gap of body-size lines → paragraph detection.
  const gaps = [];
  for (let i = 1; i < kept.length; i++) {
    const g = kept[i - 1].y - kept[i].y;
    if (g > 0 && g < body * 3) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : body * 1.2;

  const paras = [];
  let cur = null;
  for (let i = 0; i < kept.length; i++) {
    const r = kept[i];
    const prev = i > 0 ? kept[i - 1] : null;
    const gap = prev ? prev.y - r.y : Infinity;
    const indented = prev && r.x0 - prev.x0 > body * 0.8 && prev.x1 - prev.x0 > body * 4;
    const sizeBreak = prev && Math.abs(r.size - prev.size) > body * 0.2;
    // Section words set at body size (amsart small-caps "References") won't
    // trip the size heuristics — force them into their own heading block so
    // the bibliography is a strippable section downstream.
    const sectionWord = /^(references|bibliography|acknowledge?ments?)\s*\.?\s*$/i.test(r.text);
    if (!cur || gap > medGap * 1.45 || indented || sizeBreak || sectionWord) {
      cur = { lines: [r], size: r.size, forceHeading: sectionWord };
      paras.push(cur);
      if (sectionWord) cur = null; // next line starts a fresh block
    } else {
      cur.lines.push(r);
    }
  }

  // Paragraph → markdown block.
  const blocks = [];
  for (const p of paras) {
    let text = '';
    for (const r of p.lines) {
      if (text.endsWith('-')) text = text.slice(0, -1); // de-hyphenate wraps
      else if (text) text += ' ';
      text += r.text;
    }
    text = text.replace(/\\\)\s*\\\(/g, ' '); // merge adjacent math spans
    const chars = p.lines.reduce((n, r) => n + r.totalChars, 0);
    const isHeading =
      p.size >= body * 1.14 && p.lines.length <= 3 && text.length < 120 && !/[.]\s/.test(text);
    const isNumberedHeading =
      /^\d+(\.\d+)*\.?\s+[A-Z][A-Za-z]/.test(text) && text.length < 90 && p.lines.length === 1;
    if (isHeading || isNumberedHeading || p.forceHeading) {
      blocks.push(`## ${text}`);
    } else {
      blocks.push(text);
    }
  }
  // The first, largest block on page 1 is the title.
  if (opts.pageIndex === 0) {
    const maxSize = Math.max(...paras.map((p) => p.size));
    if (maxSize > body * 1.2) {
      const i = paras.findIndex((p) => p.size === maxSize);
      if (i >= 0 && blocks[i]) blocks[i] = `# ${blocks[i].replace(/^#+\s*/, '')}`;
    }
  }

  const mathRatio = totalChars ? mathChars / totalChars : 0;
  // Confidence: perfect prose = 1. Penalize what we couldn't linearize, in
  // proportion to how much of the page it is.
  let confidence = 1;
  confidence -= Math.min(0.7, (stackedChars / Math.max(1, totalChars)) * 4);
  confidence -= Math.min(0.4, (unknownMath / Math.max(1, totalChars)) * 30);
  confidence -= Math.min(0.3, (orphanChars / Math.max(1, totalChars + orphanChars)) * 4);
  confidence = Math.max(0, confidence);

  return {
    mmd: blocks.join('\n\n'),
    confidence,
    mathRatio,
    hasText: true,
  };
}

/**
 * Resolve pdf.js internal font ids → PostScript names for a page. Fonts only
 * materialize in commonObjs once the page's operator list has been built, so
 * this forces it (cheap relative to rasterizing, and cached by pdf.js).
 */
export async function resolveFontNames(page, textContent) {
  const names = {};
  const ids = new Set(textContent.items.map((it) => it.fontName).filter(Boolean));
  const grab = () => {
    for (const id of ids) {
      if (names[id]) continue;
      try {
        const font = page.commonObjs.get(id);
        if (font && font.name) names[id] = font.name;
      } catch {
        // not materialized yet
      }
    }
  };
  grab();
  if (Object.keys(names).length < ids.size) {
    try {
      await page.getOperatorList();
      grab();
    } catch {
      // rendering-level failure — geometry/Unicode heuristics still apply
    }
  }
  return names;
}
