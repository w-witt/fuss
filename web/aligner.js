/**
 * aligner.js — match the spoken word stream to word boxes from the PDF text
 * layer, so the word being read can be highlighted directly on the page.
 *
 * Ported from the desktop app's static/js/aligner.js. The two streams differ:
 * spoken text comes from Nougat markdown with math verbalized ("alpha" for "α"),
 * while the PDF text layer has raw glyphs, hyphenated line breaks, headers, etc.
 * So this is a greedy sequential fuzzy match with a bounded look-ahead window.
 */

// Glyphs the pipeline reads out by name; mapping them lets a spoken "alpha"
// land on the "α" glyph in the PDF.
const SYMBOL_NAMES = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon',
  ϵ: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta', ϑ: 'theta',
  ι: 'iota', κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu',
  ξ: 'xi', π: 'pi', ρ: 'rho', σ: 'sigma', τ: 'tau',
  υ: 'upsilon', φ: 'phi', ϕ: 'phi', χ: 'chi', ψ: 'psi',
  ω: 'omega',
  Γ: 'gamma', Δ: 'delta', Θ: 'theta', Λ: 'lambda', Ξ: 'xi',
  Π: 'pi', Σ: 'sigma', Φ: 'phi', Ψ: 'psi', Ω: 'omega',
  '∇': 'nabla', '∂': 'partial', '∑': 'sum', '∏': 'product',
  '∫': 'integral', '∞': 'infinity', '√': 'sqrt', '≈': 'approximately',
  '≤': 'lessthanorequal', '≥': 'greaterthanorequal', '≠': 'notequal',
  '±': 'plusorminus', '×': 'times', '·': 'dot', '∈': 'in',
  '→': 'to', '↦': 'mapsto', '⊂': 'subset', '⊆': 'subset',
  '∀': 'forall', '∃': 'thereexists', ℓ: 'ell', '°': 'degrees',
};

export function normalize(word) {
  let t = word.toLowerCase();
  t = Array.from(t)
    .map((ch) => SYMBOL_NAMES[ch] || ch)
    .join('');
  t = t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  t = t.replace(/[^a-z0-9]/g, '');
  return t;
}

function matches(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

function toRect(w) {
  return { page: w.page, x: w.x, y: w.y, w: w.w, h: w.h };
}

/**
 * Align spoken words to PDF words.
 * @param {string[]} spokenWords  in playback order
 * @param {Array<{page,x,y,w,h,str}>} pdfWords  in reading order
 * @returns {Array<{page,x,y,w,h}|null>} same length as spokenWords
 */
export function align(spokenWords, pdfWords) {
  const SEARCH_AHEAD = 40;
  const RESYNC_WINDOW = 200;
  const rects = new Array(spokenWords.length).fill(null);

  const candidates = [];
  for (let j = 0; j < pdfWords.length; j++) {
    const n = normalize(pdfWords[j].str);
    if (n) candidates.push({ idx: j, norm: n });
  }

  let p = 0;
  let misses = 0;

  for (let i = 0; i < spokenWords.length; i++) {
    const raw = spokenWords[i].trim();
    const s = normalize(raw.includes(' ') ? raw.split(/\s+/)[0] : raw);
    if (!s) continue;

    let window = s.length < 3 ? 4 : SEARCH_AHEAD;
    if (misses >= 6 && s.length >= 5) window = RESYNC_WINDOW;
    const end = Math.min(p + window, candidates.length);

    for (let k = p; k < end; k++) {
      const j = candidates[k].idx;
      if (matches(s, candidates[k].norm)) {
        rects[i] = toRect(pdfWords[j]);
        p = k + 1;
        break;
      }
      if (k + 1 < candidates.length && pdfWords[j].str.endsWith('-')) {
        const next = pdfWords[candidates[k + 1].idx];
        const joined = normalize(pdfWords[j].str.slice(0, -1) + next.str);
        if (matches(s, joined)) {
          rects[i] = toRect(pdfWords[j]);
          p = k + 2;
          break;
        }
      }
    }

    if (rects[i]) misses = 0;
    else misses++;
  }
  return rects;
}
