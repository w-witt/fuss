/**
 * pdfview.js — renders the PDF into a scrollable viewport, extracts word-level
 * boxes from the text layer, and moves a read-along highlight over the page.
 *
 * Ported from the desktop app's static/js/pdf-viewer.js, adapted to (a) take an
 * already-loaded PDFDocumentProxy and pdfjsLib instance, and (b) be driven by
 * the Web Speech word-boundary events rather than audio timestamps.
 */

export class PdfView {
  constructor(pdfjsLib, viewportEl) {
    this.pdfjsLib = pdfjsLib;
    this.viewport = viewportEl;
    this.pageData = []; // [{wrapper, canvas, viewport, words}]
    this.allWords = []; // flattened [{page,x,y,w,h,str}] in reading order
    this.highlightEl = null;
    this.lastRect = null;
    this.pageClickHandler = null;
    this.scale = 1.5;
    this._onResize = () => {
      if (this.lastRect) this.highlightRect(this.lastRect, false);
    };
  }

  async render(pdfDoc) {
    this.viewport.innerHTML = '';
    this.pageData = [];
    this.allWords = [];
    const total = pdfDoc.numPages;

    const dpr = window.devicePixelRatio || 1;
    const avail = Math.max(320, (this.viewport.clientWidth || 700) - 24);

    for (let i = 1; i <= total; i++) {
      const page = await pdfDoc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      // Fit the page to the container width; render the bitmap at device
      // resolution for crispness but lay out the (measured) text layer at the
      // CSS size, so word boxes match what's displayed.
      const cssScale = Math.max(0.5, Math.min(2.5, avail / base.width));
      const vpCss = page.getViewport({ scale: cssScale });
      const vpRender = page.getViewport({ scale: cssScale * dpr });

      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page';
      wrapper.dataset.page = String(i);

      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vpRender.width);
      canvas.height = Math.ceil(vpRender.height);
      canvas.style.width = Math.floor(vpCss.width) + 'px';
      canvas.style.height = Math.floor(vpCss.height) + 'px';
      wrapper.appendChild(canvas);
      this.viewport.appendChild(wrapper);

      const data = { wrapper, canvas, viewport: vpCss, words: [] };
      this.pageData.push(data);

      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vpRender }).promise;

      data.words = await this._buildWordBoxes(page, vpCss, wrapper, i);
      this.allWords.push(...data.words);

      wrapper.addEventListener('click', (e) => {
        if (!this.pageClickHandler) return;
        const r = wrapper.getBoundingClientRect();
        // Fractions of the page, matching the stored word boxes.
        this.pageClickHandler({
          page: i,
          x: (e.clientX - r.left) / r.width,
          y: (e.clientY - r.top) / r.height,
        });
      });
    }

    window.removeEventListener('resize', this._onResize);
    window.addEventListener('resize', this._onResize);
  }

  async _buildWordBoxes(page, vp, wrapper, pageNum) {
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.setProperty('--scale-factor', vp.scale);
    wrapper.appendChild(textLayerDiv);

    await this.pdfjsLib.renderTextLayer({
      textContentSource: await page.getTextContent(),
      container: textLayerDiv,
      viewport: vp,
    }).promise;

    const layerRect = textLayerDiv.getBoundingClientRect();
    const lw = layerRect.width || 1;
    const lh = layerRect.height || 1;
    const words = [];
    const walker = document.createTreeWalker(textLayerDiv, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      for (const m of node.textContent.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const r = range.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        // Store boxes as fractions of the page so positioning is independent of
        // how much CSS scales the displayed canvas (and survives window resize).
        words.push({
          page: pageNum,
          x: (r.left - layerRect.left) / lw,
          y: (r.top - layerRect.top) / lh,
          w: r.width / lw,
          h: r.height / lh,
          str: m[0],
        });
      }
    }
    return words;
  }

  highlightRect(rect, autoScroll) {
    const data = this.pageData[rect.page - 1];
    if (!data) return;
    this.lastRect = rect;

    if (!this.highlightEl) {
      this.highlightEl = document.createElement('div');
      this.highlightEl.className = 'word-highlight';
    }
    if (this.highlightEl.parentNode !== data.wrapper) {
      this.highlightEl.style.transition = 'none';
      data.wrapper.appendChild(this.highlightEl);
      requestAnimationFrame(() => {
        this.highlightEl.style.transition = '';
      });
    }

    // rect.{x,y,w,h} are fractions of the page; scale to the displayed canvas.
    const W = data.canvas.clientWidth;
    const H = data.canvas.clientHeight;
    const pad = 2;
    this.highlightEl.style.left = rect.x * W - pad + 'px';
    this.highlightEl.style.top = rect.y * H - pad + 'px';
    this.highlightEl.style.width = rect.w * W + 2 * pad + 'px';
    this.highlightEl.style.height = rect.h * H + 2 * pad + 'px';
    this.highlightEl.style.display = 'block';

    if (autoScroll) {
      const yTop = data.wrapper.offsetTop + rect.y * H;
      const viewTop = this.viewport.scrollTop;
      const viewH = this.viewport.clientHeight;
      if (yTop < viewTop + viewH * 0.15 || yTop > viewTop + viewH * 0.7) {
        this.viewport.scrollTo({ top: yTop - viewH * 0.35, behavior: 'smooth' });
      }
    }
  }

  clearHighlight() {
    if (this.highlightEl) this.highlightEl.style.display = 'none';
    this.lastRect = null;
  }

  onPageClick(handler) {
    this.pageClickHandler = handler;
  }

  getAllWords() {
    return this.allWords;
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    this.viewport.innerHTML = '';
    this.pageData = [];
    this.allWords = [];
    this.highlightEl = null;
  }
}
