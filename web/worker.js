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
 *   { type: 'pageResult', index, mmd }
 *   { type: 'error', message }
 */

import {
  pipeline,
  env,
  RawImage,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1';

// Pull weights from the HF hub; we ship no local models with the static site.
env.allowLocalModels = false;

// Robustness for a static host without cross-origin isolation (no COOP/COEP):
//  - pin the onnxruntime WASM to the SAME CDN/version as the library so it
//    can't 404 (a common "Failed to fetch"), and
//  - force single-threaded WASM, since multi-threaded ORT needs SharedArrayBuffer
//    which requires cross-origin isolation we intentionally don't enable.
try {
  env.backends.onnx.wasm.wasmPaths =
    'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.1/dist/';
  env.backends.onnx.wasm.numThreads = 1;
} catch (e) {
  // older/newer layouts — non-fatal
}

const MODEL_ID = 'Xenova/nougat-small';
const MAX_NEW_TOKENS = 3584; // a full page of dense math can be long

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

  const output = await extractor(image, {
    min_length: 1,
    max_new_tokens: MAX_NEW_TOKENS,
    bad_words_ids: [[extractor.tokenizer.unk_token_id]],
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
