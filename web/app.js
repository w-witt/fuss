/**
 * app.js — client-side orchestration for Fuss in the browser.
 *
 *   PDF → (pdf.js) page images → (worker: Nougat) LaTeX/MMD per page
 *       → (latex2text.js) speakable plain text → display + download
 *
 * Everything runs on the visitor's own machine; the PDF never leaves the
 * browser. The page count from pdf.js drives the conversion ETA.
 */

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.min.mjs';
import markdownit from 'https://cdn.jsdelivr.net/npm/markdown-it@14/+esm';
import { processMmd, segmentsToText } from './latex2text.js';
import { Progress } from './progress.js';
import { initFeedback, setFeedbackContext } from './feedback.js';
import { AudioReader, loadVoices, ttsSupported } from './tts.js';
import { initAbout } from './about.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4/build/pdf.worker.min.mjs';

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

    // 4. LaTeX/MMD → speakable plain text (the feedback-improvable library).
    const mmd = mmdPages.join('\n\n');
    progress.message('Cleaning up text…', '');
    const segments = processMmd(mmd, { renderMarkdown, parseHtml });
    const text = segmentsToText(segments);

    lastResult = { mmd, text, segments };
    showResult(text, file.name, segments);
    setFeedbackContext({ fileName: file.name, segments });
  } catch (err) {
    const where = { model: 'loading the model', pdf: 'reading the PDF', convert: 'converting a page' }[
      stage
    ];
    fail(`Failed while ${where}: ${err?.message || String(err)}`);
  } finally {
    setBusy(false);
  }
}

function showResult(text, fileName, segments) {
  progress.message('Done', `Converted ${fileName} — press Play to listen`);
  els.resultText.value = text;
  buildReader(segments);
  els.result.style.display = 'block';
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setPlayLabel(state) {
  els.playBtn.textContent = !state.playing ? '▶ Play' : state.paused ? '▶ Resume' : '⏸ Pause';
  els.readerPos.textContent = state.total
    ? `Section ${Math.min(state.segIndex + 1, state.total)} / ${state.total}`
    : '';
}

function buildReader(segments) {
  if (reader) reader.destroy();
  if (!ttsSupported()) {
    els.playBtn.disabled = true;
    els.playBtn.textContent = 'Speech not supported';
    return;
  }
  reader = new AudioReader({ segments, container: els.reader, onState: setPlayLabel });
  reader.setRate(parseFloat(els.rate.value));
  if (selectedVoice) reader.setVoice(selectedVoice);
  setPlayLabel({ playing: false, paused: false, segIndex: 0, total: segments.length });
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
    'rate',
    'rate-val',
    'voice',
    'reader',
    'reader-pos',
    'voice-note',
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
