/**
 * lint-mmd.mjs — CLI wrapper around web/mmdlint.js (the same fidelity linter
 * the app runs after conversion). Scans an .mmd file for LaTeX control
 * sequences that don't exist in any real LaTeX distribution — OCR errors and
 * decoder degeneration show up as invented commands (\begindagger, \multimd).
 *
 * Vocabulary: web/latex-vocab.js — regenerate with tools/gen-vocab.mjs after
 * editing tools/data/*.txt.
 *
 * Usage: node tools/lint-mmd.mjs <file.mmd> [--json]
 * Exit code: 0 if clean, 1 if unknown commands found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { lintMmd } from '../web/mmdlint.js';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file) {
  console.error('usage: node tools/lint-mmd.mjs <file.mmd> [--json]');
  process.exit(1);
}

const text = fs.readFileSync(file, 'utf8');
const { total, unknown, badRatio } = lintMmd(text);

if (asJson) {
  console.log(JSON.stringify({ file, totalCommands: total, unknown }, null, 2));
} else {
  for (const f of unknown) {
    console.log(`@${f.index}  ${f.command}\n    …${f.context.replace(/\n/g, ' ')}…`);
  }
  console.log(
    `\n${unknown.length} unknown of ${total} control sequences ` +
      `(${(badRatio * 100).toFixed(1)}% bad) in ${path.basename(file)}`
  );
}
process.exit(unknown.length ? 1 : 0);
