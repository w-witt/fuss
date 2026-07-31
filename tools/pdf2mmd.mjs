/**
 * pdf2mmd.mjs — run stage 1 of the web pipeline (Nougat OCR) from the command
 * line: PDF → page PNGs (pdftoppm) → Xenova/nougat-small → .mmd per page.
 *
 * Mirrors web/worker.js: same model, q8 weights (the WASM/CPU path), and the
 * same generation settings, so the output matches what the browser produces
 * on machines without WebGPU.
 *
 * Usage:
 *   node tools/pdf2mmd.mjs <file.pdf> [outdir] [--no-antirepeat] [--direct-hf]
 *
 *   --antirepeat     re-add no_repeat_ngram_size / repetition_penalty (the
 *                    pre-fix worker settings; mangles repeated math tokens)
 *   --direct-hf      fetch weights from huggingface.co instead of the proxy
 *   --model=<id>     alternative model (default Xenova/nougat-small; try
 *                    Xenova/nougat-base for higher accuracy at ~3x the size)
 *   --dtype=<t>      weight precision (default q8; fp32 matches the WebGPU path)
 *   --min-length=<n> forbid EOS before n tokens (default 1024, as worker.js;
 *                    use 1 to reproduce the early-EOS page-skip failure)
 *
 * Writes into <outdir> (default: <file>.mmd-out/):
 *   page-N.png   the raster Nougat saw
 *   page-N.mmd   Nougat's output for that page
 *   full.mmd     all pages joined (what app.js feeds to stage 2)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline, env, RawImage } from '@huggingface/transformers';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--') && !a.includes('=')));
const modelArg = args.find((a) => a.startsWith('--model='));
const MODEL_ID = modelArg ? modelArg.split('=')[1] : 'Xenova/nougat-small';
const dtypeArg = args.find((a) => a.startsWith('--dtype='));
const DTYPE = dtypeArg ? dtypeArg.split('=')[1] : 'q8';
const minLenArg = args.find((a) => a.startsWith('--min-length='));
const MIN_LENGTH = minLenArg ? parseInt(minLenArg.split('=')[1], 10) : 1024; // worker.js default
const [pdf, outArg] = args.filter((a) => !a.startsWith('--'));
if (!pdf) {
  console.error('usage: node tools/pdf2mmd.mjs <file.pdf> [outdir] [--antirepeat] [--min-length=N] [--model=ID] [--dtype=T] [--direct-hf]');
  process.exit(1);
}
const outDir = outArg || pdf.replace(/\.pdf$/i, '') + '.mmd-out';
fs.mkdirSync(outDir, { recursive: true });

// Same proxy the worker uses (campus networks block huggingface.co directly).
if (!flags.has('--direct-hf')) {
  env.remoteHost = 'https://fuss-hf.wwitt003.workers.dev';
}
env.allowLocalModels = false;

// Rasterize at the app's TARGET_WIDTH (app.js scales pages to 1280px wide).
console.log('Rasterizing PDF…');
execFileSync('pdftoppm', [
  '-png',
  '-scale-to-x', '1280',
  '-scale-to-y', '-1',
  pdf,
  path.join(outDir, 'page'),
]);
const pages = fs
  .readdirSync(outDir)
  .filter((f) => /^page-?\d+\.png$/.test(f))
  .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
console.log(`${pages.length} page(s).`);

console.log(`Loading ${MODEL_ID} (${DTYPE})…`);
let lastFile = '';
const extractor = await pipeline('image-to-text', MODEL_ID, {
  dtype: DTYPE,
  progress_callback: (p) => {
    if (p.status === 'progress' && p.file !== lastFile && p.progress > 99) {
      lastFile = p.file;
      console.log(`  fetched ${p.file}`);
    }
  },
});

// Generation settings — keep in sync with web/worker.js convertPage().
const genOpts = {
  min_length: MIN_LENGTH,
  max_new_tokens: 3584,
  bad_words_ids: [[extractor.tokenizer.unk_token_id]],
};
if (flags.has('--antirepeat')) {
  genOpts.no_repeat_ngram_size = 4;
  genOpts.repetition_penalty = 1.2;
}
console.log('Generation options:', genOpts);

const mmds = [];
for (const [i, file] of pages.entries()) {
  const t0 = Date.now();
  const image = (await RawImage.read(path.join(outDir, file))).rgb();
  const output = await extractor(image, genOpts);
  const mmd = Array.isArray(output) ? output[0]?.generated_text ?? '' : output?.generated_text ?? '';
  fs.writeFileSync(path.join(outDir, file.replace(/\.png$/, '.mmd')), mmd);
  mmds.push(mmd);
  console.log(`page ${i + 1}/${pages.length}: ${mmd.length} chars in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

fs.writeFileSync(path.join(outDir, 'full.mmd'), mmds.join('\n\n'));
console.log(`→ ${path.join(outDir, 'full.mmd')}`);
