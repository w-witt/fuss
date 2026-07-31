/**
 * app.js — client-side orchestration for Fuss in the browser.
 *
 *   PDF → (pdf.js) page images → (worker: Nougat) LaTeX/MMD per page
 *       → (latex2text.js) speakable plain text → display + download
 *
 * Everything runs on the visitor's own machine; the PDF never leaves the
 * browser. The page count from pdf.js drives the conversion ETA.
 */

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.min.mjs';
import markdownit from 'https://cdn.jsdelivr.net/npm/markdown-it@14/+esm';
import { processMmd, segmentsToText } from './latex2text.js';
import { lintMmd, lintLooksBad } from './mmdlint.js';
import { Progress } from './progress.js';
import { initFeedback, setFeedbackContext } from './feedback.js';
import { AudioReader, loadVoices, ttsSupported } from './tts.js';
import { initAbout } from './about.js';
import { PdfView } from './pdfview.js';
import { align } from './aligner.js';

// Pinned to 4.0.379: this build exposes renderTextLayer, which pdfview.js uses
// to measure per-word boxes for the read-along highlight.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs';

const md = markdownit({ html: false, linkify: false });
const renderMarkdown = (s) => md.render(s);
const parseHtml = (h) => new DOMParser().parseFromString(h, 'text/html');

const TARGET_WIDTH = 1280; // rasterization width fed to Nougat

const els = {};
let worker = null;
let progress = null;
let modelReady = false;
let currentFile = null;
let lastResult = null; // { mmd, text, segments }
let reader = null; // AudioReader instance
let pdfView = null; // PdfView instance
let selectedVoice = null;

// --- Worker plumbing: one in-flight page at a time, promise per page --------
let pageResolver = null;
let loadFailed = null; // error message if model load failed

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  // Fires when the worker module itself can't load/parse (e.g. a CDN import is
  // blocked) — otherwise this would hang silently waiting for 'ready'.
  worker.onerror = (e) => {
    loadFailed =
      'Worker failed to load — a module import (transformers.js CDN) was blocked. ' +
      (e.message || e.filename || '');
    if (pageResolver && pageResolver.reject) pageResolver.reject(new Error(loadFailed));
    pageResolver = null;
    fail(loadFailed);
  };
  worker.onmessage = (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'status':
        // surface load status under the bar without disturbing the percentage
        if (!modelReady) progress.message('Preparing model…', msg.message);
        break;
      case 'download':
        progress.download(msg.file, msg.loaded, msg.total);
        break;
      case 'ready':
        modelReady = true;
        els.deviceBadge.textContent =
          msg.device === 'webgpu' ? 'Running on your GPU (WebGPU)' : 'Running on your CPU (WASM)';
        els.deviceBadge.style.display = 'inline-block';
        break;
      case 'pageResult':
        if (pageResolver) {
          const r = pageResolver;
          pageResolver = null;
          r(msg.mmd);
        }
        break;
      case 'error':
        loadFailed = msg.message;
        if (pageResolver && pageResolver.reject) pageResolver.reject(new Error(msg.message));
        pageResolver = null;
        fail(msg.message);
        break;
    }
  };
  return worker;
}

function convertPageInWorker(index, total, imageData) {
  return new Promise((resolve, reject) => {
    pageResolver = resolve;
    pageResolver.reject = reject;
    worker.postMessage(
      {
        type: 'page',
        index,
        total,
        width: imageData.width,
        height: imageData.height,
        buffer: imageData.data.buffer,
      },
      [imageData.data.buffer]
    );
  });
}

function loadModelOnce() {
  return new Promise((resolve, reject) => {
    if (modelReady) return resolve();
    loadFailed = null;
    const check = setInterval(() => {
      if (modelReady) {
        clearInterval(check);
        resolve();
      } else if (loadFailed) {
        clearInterval(check);
        reject(new Error(loadFailed));
      }
    }, 100);
    ensureWorker().postMessage({ type: 'load' });
  });
}

// --- PDF rasterization -------------------------------------------------------
async function renderPageToImageData(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.0, TARGET_WIDTH / base.width);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // White background so transparent PDFs don't go black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // free the canvas
  canvas.width = canvas.height = 0;
  return imageData;
}

// --- Main flow ---------------------------------------------------------------
async function convert(file) {
  setBusy(true);
  els.result.style.display = 'none';
  progress.reset();
  progress.show();

  let stage = 'model';
  try {
    // 1. Load the model (downloads on first run; cached afterwards).
    await loadModelOnce();

    // 2. Open the PDF and count pages.
    stage = 'pdf';
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const total = pdf.numPages;
    stage = 'convert';

    // 3. Convert page by page; ETA derives from per-page timing.
    progress.startConversion(total);
    const mmdPages = [];
    for (let i = 1; i <= total; i++) {
      const imageData = await renderPageToImageData(pdf, i);
      const mmd = await convertPageInWorker(i, total, imageData);
      mmdPages.push(mmd);
      progress.pageDone();
    }

    // 4. Fidelity lint: invented control sequences (\begindagger…) mean a span
    // of the OCR degenerated. Per page, so the warning names where to look.
    const pageLints = mmdPages.map((m, i) => ({ page: i + 1, ...lintMmd(m) }));
    const badPages = pageLints.filter(lintLooksBad);
    for (const l of pageLints) {
      for (const u of l.unknown) {
        console.warn(`[fuss] page ${l.page}: unknown LaTeX ${u.command} in “…${u.context}…”`);
      }
    }
    showLintNote(pageLints, badPages);

    // 5. LaTeX/MMD → speakable plain text (the feedback-improvable library).
    const mmd = mmdPages.join('\n\n');
    progress.message('Cleaning up text…', '');
    const segments = processMmd(mmd, { renderMarkdown, parseHtml });
    const text = segmentsToText(segments);

    lastResult = { mmd, text, segments, lint: pageLints };
    setFeedbackContext({
      fileName: file.name,
      segments,
      lint: {
        unknown_commands: pageLints.reduce((n, l) => n + l.unknown.length, 0),
        total_commands: pageLints.reduce((n, l) => n + l.total, 0),
        bad_pages: badPages.map((l) => l.page),
      },
    });
    await showResult(text, file.name, segments, pdf);
  } catch (err) {
    const where = { model: 'loading the model', pdf: 'reading the PDF', convert: 'converting a page' }[
      stage
    ];
    fail(`Failed while ${where}: ${err?.message || String(err)}`);
  } finally {
    setBusy(false);
  }
}

async function showResult(text, fileName, segments, pdfDoc) {
  progress.message('Rendering PDF…', '');
  els.resultText.value = text;
  els.result.style.display = 'block';
  // Take over the whole page: the converted PDF becomes the reader.
  document.body.classList.add('reading');
  await buildReader(segments, pdfDoc);
  progress.hide();
}

function resetToUpload() {
  if (reader) reader.stop();
  if (pdfView) pdfView.destroy();
  document.body.classList.remove('reading');
  els.result.style.display = 'none';
  progress.hide();
  progress.reset();
  currentFile = null;
  els.fileName.textContent = '';
  els.fileName.style.display = 'none';
  els.fileInput.value = '';
  els.convertBtn.disabled = true;
  window.scrollTo({ top: 0 });
}

function setPlayLabel(state) {
  els.playBtn.textContent = !state.playing ? '▶ Play' : state.paused ? '▶ Resume' : '⏸ Pause';
  els.readerPos.textContent = state.total
    ? `Section ${Math.min(state.segIndex + 1, state.total)} / ${state.total}`
    : '';
  // Stopped/finished (not merely paused) → drop the on-page highlight.
  if (pdfView && !state.playing) pdfView.clearHighlight();
}

// Split each segment into its \S+ tokens, flattened in playback order. Must
// match tts.js's tokenization so word indices line up with the aligner's rects.
function flattenSpokenWords(segments) {
  const words = [];
  const wordSeg = [];
  segments.forEach((seg, i) => {
    for (const m of seg.text.matchAll(/\S+/g)) {
      words.push(m[0]);
      wordSeg.push(i);
    }
  });
  return { words, wordSeg };
}

async function buildReader(segments, pdfDoc) {
  if (reader) reader.destroy();
  if (pdfView) pdfView.destroy();

  // Render the actual PDF and align the spoken stream to its words so the
  // word being read lights up on the page (the Fuss e-reader experience).
  pdfView = new PdfView(pdfjsLib, els.pdfViewport);
  await pdfView.render(pdfDoc);
  const pdfWords = pdfView.getAllWords();
  const { words: spokenWords, wordSeg } = flattenSpokenWords(segments);
  const rects = align(spokenWords, pdfWords);

  if (!ttsSupported()) {
    els.playBtn.disabled = true;
    els.playBtn.textContent = 'Speech not supported';
  }

  reader = new AudioReader({
    segments,
    container: null, // PDF is the reading surface; no separate text pane
    onState: setPlayLabel,
    onWord: ({ global }) => {
      const rect = rects[global];
      if (rect) pdfView.highlightRect(rect, true);
    },
  });
  reader.setRate(parseFloat(els.rate.value));
  if (selectedVoice) reader.setVoice(selectedVoice);

  // Click a spot on the page → start reading from the nearest aligned word.
  pdfView.onPageClick((pt) => {
    let best = -1;
    let bestDist = Infinity;
    for (let g = 0; g < rects.length; g++) {
      const r = rects[g];
      if (!r || r.page !== pt.page) continue;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const d = (cx - pt.x) ** 2 + (cy - pt.y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = g;
      }
    }
    if (best >= 0) reader.playFrom(wordSeg[best]);
  });

  setPlayLabel({ playing: false, paused: false, segIndex: 0, total: segments.length });
}

// Conversion-quality note under the reader toolbar. Green when the whole
// document lints clean; a per-page warning when OCR degeneration was detected
// (details for each hit are in the console).
function showLintNote(pageLints, badPages) {
  const el = els.lintNote;
  if (!el) return;
  if (!badPages.length) {
    el.textContent = '✓ Conversion check: no invalid LaTeX detected.';
    el.classList.remove('lint-warn');
  } else {
    const pages = badPages.map((l) => l.page).join(', ');
    el.textContent =
      `⚠️ Conversion check: page${badPages.length > 1 ? 's' : ''} ${pages} may not have ` +
      `converted cleanly (invalid LaTeX detected) and may read as gibberish there. ` +
      `Re-converting sometimes helps; the Feedback button sends us the details.`;
    el.classList.add('lint-warn');
  }
  el.style.display = 'block';
}

function fail(message) {
  progress.message('Something went wrong', message);
  els.result.style.display = 'none';
  console.error('[fuss]', message);
}

function setBusy(busy) {
  els.convertBtn.disabled = busy || !currentFile;
  els.convertBtn.textContent = busy ? 'Converting…' : 'Convert';
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Wiring ------------------------------------------------------------------
function pickFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) return;
  currentFile = file;
  els.fileName.textContent = file.name;
  els.fileName.style.display = 'block';
  els.convertBtn.disabled = false;
}

export function init() {
  for (const id of [
    'drop-zone',
    'file-input',
    'file-name',
    'convert-btn',
    'progress',
    'progress-bar',
    'progress-label',
    'progress-sub',
    'result',
    'result-text',
    'download-txt',
    'download-tex',
    'device-badge',
    'play-btn',
    'prev-btn',
    'next-btn',
    'new-btn',
    'rate',
    'rate-val',
    'voice',
    'pdf-viewport',
    'reader-pos',
    'voice-note',
    'lint-note',
  ]) {
    els[camel(id)] = document.getElementById(id);
  }

  progress = new Progress({
    container: els.progress,
    bar: els.progressBar,
    label: els.progressLabel,
    sub: els.progressSub,
  });

  const dz = els.dropZone;
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('dragover');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    pickFile(e.dataTransfer.files[0]);
  });
  els.fileInput.addEventListener('change', (e) => pickFile(e.target.files[0]));

  els.convertBtn.addEventListener('click', () => {
    if (currentFile) convert(currentFile);
  });

  els.downloadTxt.addEventListener('click', () => {
    if (lastResult) download(baseName(currentFile.name) + '.txt', lastResult.text, 'text/plain');
  });
  els.downloadTex.addEventListener('click', () => {
    if (lastResult) download(baseName(currentFile.name) + '.mmd', lastResult.mmd, 'text/plain');
  });

  // Reader transport
  els.playBtn.addEventListener('click', () => reader && reader.toggle());
  els.prevBtn.addEventListener('click', () => reader && reader.prev());
  els.nextBtn.addEventListener('click', () => reader && reader.next());
  els.newBtn.addEventListener('click', resetToUpload);
  els.rate.addEventListener('input', () => {
    const r = parseFloat(els.rate.value);
    els.rateVal.textContent = r.toFixed(1) + '×';
    if (reader) reader.setRate(r);
  });

  // Keyboard: space toggles play/pause when a reader exists and we're not typing.
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && reader && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {
      e.preventDefault();
      reader.toggle();
    }
  });

  populateVoices();
  initFeedback();
  initAbout();
}

async function populateVoices() {
  if (!ttsSupported()) {
    els.voiceNote.textContent = '⚠️ This browser has no speech support. Try Chrome or Edge to listen.';
    return;
  }

  const voices = await loadVoices();

  // No system voices at all (e.g. some Linux Chrome installs): be explicit
  // instead of leaving a dead Play button.
  if (!voices.length) {
    els.voiceNote.innerHTML =
      '⚠️ No speech voices are installed on your system, so playback is unavailable. ' +
      'On macOS/Windows the built-in voices work out of the box; on Linux, install ' +
      '<code>speech-dispatcher</code> + a voice (e.g. espeak-ng). You can still read and ' +
      'download the converted text below.';
    els.playBtn.disabled = true;
    els.playBtn.textContent = 'No voices found';
    return;
  }

  // Prefer English, then *local* voices (network voices often drop the word
  // boundary events that drive highlighting, and can fail offline).
  const english = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
  const pool = english.length ? english : voices;
  const local = pool.filter((v) => v.localService);
  const ordered = [...local, ...pool.filter((v) => !v.localService)];

  els.voice.innerHTML = '';
  ordered.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${v.name} (${v.lang})${v.localService ? '' : ' · online'}`;
    els.voice.appendChild(opt);
  });

  // Default to a natural-sounding *local* voice if one exists.
  let idx = ordered.findIndex(
    (v) => v.localService && /natural|enhanced|premium|samantha|aria|jenny/i.test(v.name)
  );
  if (idx < 0) idx = ordered.findIndex((v) => v.localService);
  if (idx < 0) idx = 0;
  els.voice.value = String(idx);
  selectedVoice = ordered[idx] || null;

  els.voice.addEventListener('change', () => {
    selectedVoice = ordered[parseInt(els.voice.value, 10)] || null;
    if (reader) reader.setVoice(selectedVoice);
  });
}

function camel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
function baseName(name) {
  return name.replace(/\.[^.]+$/, '');
}

init();
