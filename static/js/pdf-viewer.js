/**
 * PDF viewer using pdf.js. Renders all pages into a scrollable container,
 * extracts word-level bounding boxes from the text layer, and manages the
 * read-along highlight overlay.
 */

const PdfViewer = (function () {
    let pdfjsLib = null;
    let pdfDoc = null;
    let currentPage = 1;
    let totalPages = 0;
    let pageData = [];   // [{wrapper, canvas, viewport, words}]
    let allWords = [];   // flattened [{page, x, y, w, h, str}] in reading order
    let highlightEl = null;
    let lastRect = null;
    let pageClickHandler = null;
    const scale = 1.5;

    const viewport = document.getElementById('pdf-viewport');
    const pageInfo = document.getElementById('pdf-page-info');

    async function load(url) {
        pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

        pdfDoc = await pdfjsLib.getDocument(url).promise;
        totalPages = pdfDoc.numPages;

        viewport.innerHTML = '';
        pageData = [];
        allWords = [];

        for (let i = 1; i <= totalPages; i++) {
            const page = await pdfDoc.getPage(i);
            const vp = page.getViewport({ scale });

            const wrapper = document.createElement('div');
            wrapper.className = 'pdf-page';
            wrapper.dataset.page = i;

            const canvas = document.createElement('canvas');
            canvas.width = vp.width;
            canvas.height = vp.height;

            wrapper.appendChild(canvas);
            viewport.appendChild(wrapper);

            const data = { wrapper, canvas, viewport: vp, words: [] };
            pageData.push(data);

            const ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: vp }).promise;

            data.words = await buildWordBoxes(page, vp, wrapper, i);
            allWords.push(...data.words);

            wrapper.addEventListener('click', (e) => {
                if (!pageClickHandler) return;
                const ratio = displayRatio(data);
                const rect = wrapper.getBoundingClientRect();
                pageClickHandler({
                    page: i,
                    x: (e.clientX - rect.left) / ratio,
                    y: (e.clientY - rect.top) / ratio,
                });
            });
        }

        updatePageInfo();
        viewport.addEventListener('scroll', onScroll);
        window.addEventListener('resize', () => {
            if (lastRect) highlightRect(lastRect, false);
        });
    }

    /**
     * Render the (invisible) pdf.js text layer for a page, then measure each
     * word's exact box with DOM ranges. Boxes are stored in viewport
     * coordinates (i.e. at the render scale, independent of display size).
     */
    async function buildWordBoxes(page, vp, wrapper, pageNum) {
        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        textLayerDiv.style.setProperty('--scale-factor', vp.scale);
        wrapper.appendChild(textLayerDiv);

        await pdfjsLib.renderTextLayer({
            textContentSource: await page.getTextContent(),
            container: textLayerDiv,
            viewport: vp,
        }).promise;

        // Span positions are laid out in viewport-scale pixels regardless of
        // how the page is displayed, so rects measured relative to the text
        // layer origin are already in viewport coordinates.
        const layerRect = textLayerDiv.getBoundingClientRect();
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
                words.push({
                    page: pageNum,
                    x: r.left - layerRect.left,
                    y: r.top - layerRect.top,
                    w: r.width,
                    h: r.height,
                    str: m[0],
                });
            }
        }
        return words;
    }

    function displayRatio(data) {
        return data.canvas.clientWidth / data.viewport.width;
    }

    /**
     * Move the highlight overlay to a word rect ({page, x, y, w, h} in
     * viewport coordinates). Optionally auto-scrolls to keep it in view.
     */
    function highlightRect(rect, autoScroll) {
        const data = pageData[rect.page - 1];
        if (!data) return;
        lastRect = rect;

        if (!highlightEl) {
            highlightEl = document.createElement('div');
            highlightEl.className = 'word-highlight';
        }
        if (highlightEl.parentNode !== data.wrapper) {
            // Skip the position transition when jumping between pages
            highlightEl.style.transition = 'none';
            data.wrapper.appendChild(highlightEl);
            requestAnimationFrame(() => { highlightEl.style.transition = ''; });
        }

        const ratio = displayRatio(data);
        const pad = 2;
        highlightEl.style.left = (rect.x * ratio - pad) + 'px';
        highlightEl.style.top = (rect.y * ratio - pad) + 'px';
        highlightEl.style.width = (rect.w * ratio + 2 * pad) + 'px';
        highlightEl.style.height = (rect.h * ratio + 2 * pad) + 'px';
        highlightEl.style.display = 'block';

        if (autoScroll) {
            const yTop = data.wrapper.offsetTop + rect.y * ratio;
            const viewTop = viewport.scrollTop;
            const viewH = viewport.clientHeight;
            if (yTop < viewTop + viewH * 0.15 || yTop > viewTop + viewH * 0.7) {
                viewport.scrollTo({ top: yTop - viewH * 0.35, behavior: 'smooth' });
            }
        }
    }

    function clearHighlight() {
        if (highlightEl) highlightEl.style.display = 'none';
        lastRect = null;
    }

    function onPageClick(handler) {
        pageClickHandler = handler;
    }

    function getAllWords() {
        return allWords;
    }

    function onScroll() {
        const viewportMid = viewport.scrollTop + viewport.clientHeight / 2;
        for (let i = 0; i < pageData.length; i++) {
            const el = pageData[i].wrapper;
            const top = el.offsetTop;
            const bottom = top + el.offsetHeight;
            if (viewportMid >= top && viewportMid < bottom) {
                if (currentPage !== i + 1) {
                    currentPage = i + 1;
                    updatePageInfo();
                }
                break;
            }
        }
    }

    function updatePageInfo() {
        pageInfo.textContent = `Page ${currentPage} / ${totalPages}`;
    }

    function goToPage(num) {
        if (num < 1 || num > totalPages || !pdfDoc) return;
        currentPage = num;
        updatePageInfo();
        pageData[num - 1].wrapper.scrollIntoView({ behavior: 'smooth' });
    }

    function prevPage() {
        goToPage(currentPage - 1);
    }

    function nextPage() {
        goToPage(currentPage + 1);
    }

    function getTotalPages() {
        return totalPages;
    }

    function getCurrentPage() {
        return currentPage;
    }

    return {
        load, goToPage, prevPage, nextPage, getTotalPages, getCurrentPage,
        getAllWords, highlightRect, clearHighlight, onPageClick,
    };
})();
