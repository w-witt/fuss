/**
 * gen-vocab.mjs — regenerate web/latex-vocab.js from tools/data/*.txt.
 *
 * Sources:
 *   tools/data/symlist-commands.txt  — every document-level control sequence
 *     in Scott Pakin's Comprehensive LaTeX Symbol List (extracted from its
 *     SYMLIST file: column 1, names only)
 *   tools/data/core-commands.txt     — structural/math commands the symbol
 *     list doesn't cover (\frac, \begin, \mathbb, sectioning, spacing, …)
 *
 * Run after editing either list: node tools/gen-vocab.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const names = [
  ...new Set(
    ['symlist-commands.txt', 'core-commands.txt']
      .flatMap((f) => fs.readFileSync(path.join(here, 'data', f), 'utf8').split('\n'))
      .map((s) => s.trim())
      .filter(Boolean)
  ),
].sort();

const out = `/**
 * latex-vocab.js — names of all real LaTeX control sequences (no backslash).
 *
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *   node tools/gen-vocab.mjs
 *
 * Sources: SYMLIST from the Comprehensive LaTeX Symbol List (Scott Pakin)
 * plus a curated list of structural commands. Used by mmdlint.js to spot
 * OCR-invented commands in Nougat output.
 */
export const LATEX_VOCAB = \`${names.join('\n')}\`;
`;

const dest = path.join(here, '..', 'web', 'latex-vocab.js');
fs.writeFileSync(dest, out);
console.log(`${names.length} commands → ${dest} (${(out.length / 1024).toFixed(0)} KB)`);
