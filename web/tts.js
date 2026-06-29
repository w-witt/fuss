/**
 * tts.js — read-along audiobook engine built on the Web Speech API.
 *
 * Input is the segment list from latex2text.js, where math has *already* been
 * expanded to spoken words ("x squared", "summation over"). So the synthesizer
 * just reads clean English — the whole point of Fuss for math-heavy papers.
 *
 * Why Web Speech API: it's fully local (no upload, no extra model download),
 * available in the same Chrome/Edge browsers we target for WebGPU, and — unlike
 * most browser TTS — fires `boundary` events we use for word-by-word highlight.
 *
 * Long paragraphs are split into sentence-sized chunks: this dodges Chrome's
 * ~15s utterance cutoff bug and gives finer progress. Each chunk's boundary
 * charIndex is offset back into the segment so the right word lights up.
 */

const synth = window.speechSynthesis;

function splitIntoChunks(text, maxLen = 220) {
  // Split on sentence enders, then pack into <= maxLen chunks, tracking the
  // start offset of each chunk within `text` (for boundary→word mapping).
  const pieces = [];
  const re = /[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    pieces.push({ text: m[0], start: m.index });
  }
  if (pieces.length === 0) pieces.push({ text, start: 0 });

  // Merge tiny adjacent pieces, split overly long ones on spaces.
  const chunks = [];
  for (const p of pieces) {
    if (p.text.length <= maxLen) {
      chunks.push(p);
      continue;
    }
    let offset = 0;
    while (offset < p.text.length) {
      let end = Math.min(offset + maxLen, p.text.length);
      if (end < p.text.length) {
        const sp = p.text.lastIndexOf(' ', end);
        if (sp > offset) end = sp;
      }
      chunks.push({ text: p.text.slice(offset, end), start: p.start + offset });
      offset = end;
    }
  }
  return chunks;
}

export class AudioReader {
  constructor({ segments, container, onState }) {
    this.segments = segments;
    this.container = container;
    this.onState = onState || (() => {});
    this.rate = 1;
    this.voice = null;
    this.segIndex = 0;
    this.chunkIndex = 0;
    this.chunks = [];
    this.playing = false;
    this.paused = false;
    this.words = []; // per-segment: [{el, start, end}]
    this._keepAlive = null;
    this._build();
  }

  _build() {
    this.container.innerHTML = '';
    this.words = [];
    this.segEls = [];
    this.segments.forEach((seg, i) => {
      const tag = seg.segment_type === 'heading' ? 'h3' : 'p';
      const el = document.createElement(tag);
      el.className = 'seg';
      el.dataset.index = String(i);

      const wordSpans = [];
      // Tokenize keeping whitespace so charIndex offsets line up with seg.text.
      const re = /\S+|\s+/g;
      let m;
      while ((m = re.exec(seg.text)) !== null) {
        const token = m[0];
        if (/\S/.test(token)) {
          const span = document.createElement('span');
          span.className = 'word';
          span.textContent = token;
          el.appendChild(span);
          wordSpans.push({ el: span, start: m.index, end: m.index + token.length });
        } else {
          el.appendChild(document.createTextNode(token));
        }
      }
      el.addEventListener('click', () => this.playFrom(i));
      this.container.appendChild(el);
      this.segEls.push(el);
      this.words.push(wordSpans);
    });
  }

  setRate(r) {
    this.rate = r;
  }
  setVoice(v) {
    this.voice = v;
  }

  _clearHighlight() {
    this.container.querySelectorAll('.word.speaking, .seg.active').forEach((el) =>
      el.classList.remove('speaking', 'active')
    );
  }

  _highlightWord(absCharIndex) {
    const list = this.words[this.segIndex] || [];
    let target = null;
    for (const w of list) {
      if (absCharIndex >= w.start && absCharIndex < w.end) {
        target = w.el;
        break;
      }
    }
    if (!target) return;
    const prev = this.container.querySelector('.word.speaking');
    if (prev && prev !== target) prev.classList.remove('speaking');
    target.classList.add('speaking');
  }

  _markSegment() {
    this._clearHighlight();
    const el = this.segEls[this.segIndex];
    if (el) {
      el.classList.add('active');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  _emit() {
    this.onState({
      playing: this.playing,
      paused: this.paused,
      segIndex: this.segIndex,
      total: this.segments.length,
    });
  }

  // Chrome silently stops long-running synthesis; nudging resume keeps it alive.
  _startKeepAlive() {
    this._stopKeepAlive();
    this._keepAlive = setInterval(() => {
      if (this.playing && !this.paused && synth.speaking) {
        synth.pause();
        synth.resume();
      }
    }, 9000);
  }
  _stopKeepAlive() {
    if (this._keepAlive) clearInterval(this._keepAlive);
    this._keepAlive = null;
  }

  _speak() {
    if (this.segIndex >= this.segments.length) {
      this.stop();
      return;
    }
    if (this.chunkIndex === 0) {
      this.chunks = splitIntoChunks(this.segments[this.segIndex].text);
      this._markSegment();
    }
    const chunk = this.chunks[this.chunkIndex];
    if (!chunk) {
      // segment done → next segment
      this.segIndex += 1;
      this.chunkIndex = 0;
      this._speak();
      return;
    }

    const u = new SpeechSynthesisUtterance(chunk.text);
    u.rate = this.rate;
    if (this.voice) u.voice = this.voice;
    const base = chunk.start;

    u.onboundary = (e) => {
      if (e.name === 'word' || e.charIndex != null) this._highlightWord(base + (e.charIndex || 0));
    };
    u.onend = () => {
      if (!this.playing) return;
      this.chunkIndex += 1;
      if (this.chunkIndex >= this.chunks.length) {
        this.segIndex += 1;
        this.chunkIndex = 0;
      }
      this._speak();
    };
    u.onerror = () => {
      // Skip a failed chunk rather than stalling the whole book.
      if (!this.playing) return;
      this.chunkIndex += 1;
      this._speak();
    };

    synth.speak(u);
  }

  play() {
    if (this.paused) return this.resume();
    if (this.playing) return;
    synth.cancel();
    this.playing = true;
    this.paused = false;
    this._startKeepAlive();
    this._speak();
    this._emit();
  }

  playFrom(index) {
    synth.cancel();
    this.segIndex = Math.max(0, Math.min(index, this.segments.length - 1));
    this.chunkIndex = 0;
    this.playing = true;
    this.paused = false;
    this._startKeepAlive();
    this._speak();
    this._emit();
  }

  pause() {
    if (!this.playing || this.paused) return;
    this.paused = true;
    synth.pause();
    this._emit();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    synth.resume();
    this._emit();
  }

  toggle() {
    if (!this.playing) return this.play();
    if (this.paused) return this.resume();
    return this.pause();
  }

  next() {
    this.playFrom(Math.min(this.segIndex + 1, this.segments.length - 1));
  }
  prev() {
    this.playFrom(Math.max(this.segIndex - 1, 0));
  }

  stop() {
    this.playing = false;
    this.paused = false;
    this._stopKeepAlive();
    synth.cancel();
    this._clearHighlight();
    this._emit();
  }

  destroy() {
    this.stop();
  }
}

/** Load available voices (getVoices is populated asynchronously). */
export function loadVoices() {
  return new Promise((resolve) => {
    let voices = synth.getVoices();
    if (voices.length) return resolve(voices);
    synth.onvoiceschanged = () => resolve(synth.getVoices());
    // Safari sometimes never fires the event; poll briefly as a fallback.
    let tries = 0;
    const t = setInterval(() => {
      voices = synth.getVoices();
      if (voices.length || ++tries > 20) {
        clearInterval(t);
        resolve(voices);
      }
    }, 100);
  });
}

export function ttsSupported() {
  return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}
