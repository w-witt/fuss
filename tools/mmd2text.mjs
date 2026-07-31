/**
 * mmd2text.mjs — run stage 2 of the web pipeline (latex2text.js) on an .mmd
 * file from the command line, dumping every intermediate so you can see
 * exactly where the text goes wrong.
 *
 * Usage: node tools/mmd2text.mjs <file.mmd> [outdir]
 *
 * Writes into <outdir> (default: <file>.stages/):
 *   1-preprocessed.mmd   after preprocessMmd (line dedupe, table strip)
 *   2-mathspoken.md      after speakMathSpans (math → spoken English)
 *   3-rendered.html      after markdown-it rendering
 *   4-segments.json      the segments processMmd emits (text + source_text)
 *   5-final.txt          what the reader would speak
 */
import fs from 'node:fs';
import path from 'node:path';
import markdownit from 'markdown-it';
import { DOMParser } from 'linkedom';
import {
  processMmd,
  segmentsToText,
  preprocessMmd,
  speakMathSpans,
} from '../web/latex2text.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/mmd2text.mjs <file.mmd> [outdir]');
  process.exit(1);
}
const outDir =
  process.argv[3] ||
  path.join(path.dirname(file), path.basename(file).replace(/\.[^.]+$/, '') + '.stages');
fs.mkdirSync(outDir, { recursive: true });

// Same renderer/parser wiring as web/app.js.
const md = markdownit({ html: false, linkify: false });
const renderMarkdown = (s) => md.render(s);
const parseHtml = (h) => new DOMParser().parseFromString(h, 'text/html');

const mmd = fs.readFileSync(file, 'utf8');

const pre = preprocessMmd(mmd);
fs.writeFileSync(path.join(outDir, '1-preprocessed.mmd'), pre);

const spoken = speakMathSpans(pre);
fs.writeFileSync(path.join(outDir, '2-mathspoken.md'), spoken);

fs.writeFileSync(path.join(outDir, '3-rendered.html'), renderMarkdown(spoken));

const segments = processMmd(mmd, { renderMarkdown, parseHtml });
fs.writeFileSync(path.join(outDir, '4-segments.json'), JSON.stringify(segments, null, 2));

const text = segmentsToText(segments);
fs.writeFileSync(path.join(outDir, '5-final.txt'), text);

console.log(`${segments.length} segments → ${outDir}/`);
