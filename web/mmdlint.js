/**
 * mmdlint.js — fidelity linter for Nougat output (browser + Node).
 *
 * OCR errors and decoder degeneration show up as LaTeX commands that don't
 * exist in any distribution (\begindagger, \multimd, …), so "unknown control
 * sequence" is a cheap, reliable signal that a span of the conversion went
 * bad. The app uses it to warn which pages may not have converted cleanly;
 * tools/lint-mmd.mjs uses it to measure conversion quality from the CLI.
 *
 * Vocabulary: web/latex-vocab.js, generated from the Comprehensive LaTeX
 * Symbol List by tools/gen-vocab.mjs.
 */
import { LATEX_VOCAB } from './latex-vocab.js';

const vocab = new Set(LATEX_VOCAB.split('\n'));

/**
 * Scan MMD text for control sequences not in the vocabulary.
 *
 * @param {string} text  raw Nougat output (one page or a whole document)
 * @returns {{total: number, unknown: Array<{command, index, context}>, badRatio: number}}
 */
export function lintMmd(text) {
  const unknown = [];
  let total = 0;
  for (const m of text.matchAll(/\\([a-zA-Z]{2,})/g)) {
    total++;
    if (!vocab.has(m[1])) {
      unknown.push({
        command: '\\' + m[1],
        index: m.index,
        context: text.slice(Math.max(0, m.index - 40), m.index + m[1].length + 41),
      });
    }
  }
  return { total, unknown, badRatio: total ? unknown.length / total : 0 };
}

/**
 * Judge whether a page's lint result is bad enough to warn the reader about.
 * A page with a couple of stray unknowns is normal OCR noise; a cluster or a
 * high ratio means a span of the page degenerated.
 */
export function lintLooksBad({ total, unknown, badRatio }) {
  return unknown.length >= 3 || (total >= 10 && badRatio > 0.05);
}
