/**
 * worker.js — runs the Nougat model off the main thread.
 *
 * Loads facebook/nougat-small (ONNX, via Xenova) with transformers.js. Tries
 * WebGPU first and transparently falls back to WASM/CPU so the tool still works
 * on machines without a usable GPU — at the cost of speed. The heavy lifting
 * happens here so the UI thread stays responsive and the progress bar animates.
 *
 * Messages in:
 *   { type: 'load' }
 *   { type: 'page', index, total, width, height, buffer }  // buffer = RGBA bytes
 * Messages out:
 *   { type: 'status', message }
 *   { type: 'download', file, loaded, total, progress }     // model fetch progress
 *   { type: 'ready', device }
 *   { type: 'pageProgress', index, total, tokens, estTotal, tps }  // within a page
 *   { type: 'pageResult', index, mmd }
 *   { type: 'error', message }
 */

import {
  pipeline,
  env,
  RawImage,
  TextStreamer,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';

// Surface *which* request fails: turn an opaque "Failed to fetch" into the
// actual URL, so model-load problems are diagnosable from the error alone.
const _fetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  return _fetch(input, init).catch((err) => {
    throw new Error(`could not fetch ${url} — ${err.message}`);
  });
};

// Pull weights from the HF hub; we ship no local models with the static site.
env.allowLocalModels = false;

// Fetch model files through our own Cloudflare proxy instead of huggingface.co
// directly. Direct cross-origin fetches to huggingface.co fail on some networks
// (e.g. campus SSL-inspecting proxies) even though Cloudflare/CDN hosts work —
// the proxy makes model loading reliable for every tester. Deploy web/hf-proxy/
// (npx wrangler deploy) and set this to its URL. Leave as huggingface.co to use
// HF directly (works on unrestricted networks).
env.remoteHost = 'https://fuss-hf.wwitt003.workers.dev';

// Critical for a static host: without this, onnxruntime resolves its .wasm
// relative to the worker's OWN origin (fuss.../ort-...wasm) and 404s — the
// "Failed to fetch" on model load. Point it at the matching library dist, which
// holds ort-wasm-simd-threaded.jsep.wasm. We do NOT force numThreads: the dist
// ships only the threaded build, and ORT runs it single-threaded at runtime
// when SharedArrayBuffer is absent (we don't enable cross-origin isolation).
try {
  env.backends.onnx.wasm.wasmPaths =
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1/dist/';
} catch (e) {
  // older/newer layouts — non-fatal
}

const MODEL_ID = 'Xenova/nougat-small';
const MAX_NEW_TOKENS = 3584; // a full page of dense math can be long
const MIN_LENGTH = 1024; // block early EOS: a dense page is ~1k tokens

let extractor = null; // image-to-text pipeline
let device = 'wasm';

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function progressCallback(p) {
  if (p.status === 'progress') {
    post({
      type: 'download',
      file: p.file,
      loaded: p.loaded,
      total: p.total,
      progress: p.progress,
    });
  } else if (p.status === 'initiate' || p.status === 'done') {
    post({ type: 'status', message: `${p.status}: ${p.file || ''}` });
  }
}

async function load() {
  // Try WebGPU (fast). If anything about it is unavailable, fall back to WASM.
  const hasWebGPU = 'gpu' in navigator;
  if (hasWebGPU) {
    try {
      post({ type: 'status', message: 'Loading model on GPU (WebGPU)…' });
      extractor = await pipeline('image-to-text', MODEL_ID, {
        device: 'webgpu',
        dtype: 'fp32',
        progress_callback: progressCallback,
      });
      device = 'webgpu';
      post({ type: 'ready', device });
      return;
    } catch (e) {
      post({ type: 'status', message: `WebGPU unavailable (${e.message}); using CPU…` });
      extractor = null;
    }
  }

  // WASM / CPU fallback — quantized weights keep the download smaller.
  post({ type: 'status', message: 'Loading model on CPU (WASM)…' });
  try {
    extractor = await pipeline('image-to-text', MODEL_ID, {
      dtype: 'q8',
      progress_callback: progressCallback,
    });
  } catch (e) {
    // Make the common network failure legible instead of a bare "Failed to fetch".
    throw new Error(`Model/runtime load failed (${e.message}). This is usually the ` +
      `model weights or the onnxruntime WASM not downloading — check the Network tab.`);
  }
  device = 'wasm';
  post({ type: 'ready', device });
}

async function convertPage({ index, total, width, height, buffer }) {
  if (!extractor) throw new Error('Model not loaded');

  // pdf.js hands us RGBA; drop alpha to RGB (Nougat's processor expects 3
  // channels) and let the processor handle resizing/normalization.
  const image = new RawImage(new Uint8ClampedArray(buffer), width, height, 4).rgb();

  // Nougat's dominant failure here is the early-EOS "page skip": the decoder
  // emits end-of-sequence right after a page's front matter and the whole body
  // is silently dropped (verified on real papers with tools/pdf2mmd.mjs).
  // min_length forbids EOS until a page's worth of tokens is out, which
  // recovers the body. Do NOT add no_repeat_ngram_size / repetition_penalty:
  // math legitimately repeats short token runs (^{-1}, b^{-1}…), and blocking
  // repeats mangles it badly. The cost of min_length is that a sparse page
  // pads its tail with repetition loops — dedupeRepeats/dedupeSegments in
  // latex2text.js crop those in post-processing.
  // Stream token counts back to the UI. On single-threaded WASM a page takes
  // many minutes, and without this the progress bar sits frozen at 0% — the
  // exact symptom testers report as "stuck". estTotal is min_length: every
  // page emits at least that many tokens, so it's an honest denominator.
  const genStart = performance.now();
  let tokenCount = 0;
  let lastPost = 0;
  const streamer = new TextStreamer(extractor.tokenizer, {
    skip_prompt: true,
    callback_function: () => {}, // default prints decoded text; we only count
    token_callback_function: () => {
      tokenCount += 1;
      const now = performance.now();
      if (now - lastPost >= 250) {
        lastPost = now;
        post({
          type: 'pageProgress',
          index,
          total,
          tokens: tokenCount,
          estTotal: MIN_LENGTH,
          tps: (tokenCount * 1000) / (now - genStart),
        });
      }
    },
  });

  const output = await extractor(image, {
    min_length: MIN_LENGTH,
    max_new_tokens: MAX_NEW_TOKENS,
    bad_words_ids: [[extractor.tokenizer.unk_token_id]],
    streamer,
  });

  // transformers.js returns [{ generated_text }]
  const mmd = Array.isArray(output) ? output[0]?.generated_text ?? '' : output?.generated_text ?? '';
  post({ type: 'pageResult', index, total, mmd });
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await load();
    } else if (msg.type === 'page') {
      await convertPage(msg);
    }
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err) });
  }
};
