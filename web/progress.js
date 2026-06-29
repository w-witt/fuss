/**
 * progress.js — two-phase progress UI with a real time-remaining estimate.
 *
 * Phase 1 "Downloading model": aggregates byte progress across the ONNX files
 * transformers.js fetches (only on first visit; cached thereafter).
 * Phase 2 "Converting": Nougat runs one page at a time, so once a couple of
 * pages are done we have a genuine seconds-per-page rate and can extrapolate
 * the ETA for the pages that remain — not a fake animation.
 */

function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r.toString().padStart(2, '0')}s` : `${r}s`;
}

function fmtBytes(n) {
  if (!n) return '0 MB';
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export class Progress {
  constructor({ container, bar, label, sub }) {
    this.container = container;
    this.bar = bar;
    this.label = label;
    this.sub = sub;
    this.files = new Map(); // filename -> { loaded, total }
    this.reset();
  }

  reset() {
    this.files.clear();
    this.total = 0;
    this.done = 0;
    this.startTime = 0;
    this.pageTimes = [];
    this._set(0, '', '');
  }

  show() {
    if (this.container) this.container.style.display = 'block';
  }
  hide() {
    if (this.container) this.container.style.display = 'none';
  }

  _set(fraction, label, sub) {
    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    if (this.bar) this.bar.style.width = pct + '%';
    if (this.bar) this.bar.setAttribute('aria-valuenow', String(pct));
    if (label != null && this.label) this.label.textContent = label;
    if (sub != null && this.sub) this.sub.textContent = sub;
  }

  // --- Phase 1: model download ---------------------------------------------
  download(file, loaded, total) {
    if (file) this.files.set(file, { loaded: loaded || 0, total: total || 0 });
    let l = 0,
      t = 0;
    for (const f of this.files.values()) {
      l += f.loaded;
      t += f.total;
    }
    const frac = t > 0 ? l / t : 0;
    this._set(
      frac,
      'Downloading model (one time)…',
      `${fmtBytes(l)} / ${fmtBytes(t)} — cached for next time`
    );
  }

  // --- Phase 2: page-by-page conversion ------------------------------------
  startConversion(totalPages) {
    this.total = totalPages;
    this.done = 0;
    this.startTime = performance.now();
    this.pageTimes = [];
    this._set(0, `Converting 0 / ${totalPages} pages…`, 'Estimating time remaining…');
  }

  pageDone() {
    const now = performance.now();
    this.pageTimes.push(now);
    this.done += 1;

    const frac = this.total ? this.done / this.total : 0;
    const elapsed = (now - this.startTime) / 1000;
    const perPage = this.done > 0 ? elapsed / this.done : 0;
    const remaining = (this.total - this.done) * perPage;

    const eta =
      this.done >= 1 && this.done < this.total
        ? `~${fmtTime(remaining)} remaining (${perPage.toFixed(1)}s/page)`
        : this.done >= this.total
        ? `Done in ${fmtTime(elapsed)}`
        : 'Estimating time remaining…';

    this._set(frac, `Converting ${this.done} / ${this.total} pages…`, eta);
  }

  message(label, sub) {
    this._set(this.total ? this.done / this.total : 0, label, sub);
  }
}
