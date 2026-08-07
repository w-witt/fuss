/**
 * pdf2mmd-textlayer.mjs — run the text-layer extractor (web/textlayer.js) from
 * the command line: PDF → per-page MMD + confidence, no model involved.
 *
 * Usage:
 *   node tools/pdf2mmd-textlayer.mjs <file.pdf> [outdir]
 *
 * Writes into <outdir> (default: <file>.textlayer-out/):
 *   page-N.mmd   extracted MMD for that page
 *   full.mmd     all pages joined
 * and prints per-page confidence / math ratio to stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageMmd, resolveFontNames } from '../web/textlayer.js';

const [pdfPath, outArg] = process.argv.slice(2);
if (!pdfPath) {
  console.error('usage: node tools/pdf2mmd-textlayer.mjs <file.pdf> [outdir]');
  process.exit(1);
}
const outDir = outArg || pdfPath.replace(/\.pdf$/i, '') + '.textlayer-out';
fs.mkdirSync(outDir, { recursive: true });

const data = new Uint8Array(fs.readFileSync(pdfPath));
const pdf = await getDocument({ data, useSystemFonts: true }).promise;

const pages = [];
for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const textContent = await page.getTextContent();
  const fontNames = await resolveFontNames(page, textContent);
  const res = extractPageMmd(textContent, {
    fontNames,
    pageIndex: i - 1,
    viewBox: page.view,
  });
  pages.push(res.mmd);
  fs.writeFileSync(path.join(outDir, `page-${i}.mmd`), res.mmd);
  console.log(
    `page ${i}: confidence=${res.confidence.toFixed(2)} mathRatio=${res.mathRatio.toFixed(2)} hasText=${res.hasText} fonts=[${[...new Set(Object.values(fontNames))].join(', ')}]`
  );
}
fs.writeFileSync(path.join(outDir, 'full.mmd'), pages.join('\n\n'));
console.log(`\nwrote ${outDir}/full.mmd`);
