/**
 * Main reader controller: loads data, wires up components, and drives the
 * read-along word highlight on the PDF.
 */

(async function () {
    const jobId = window.FUSS.jobId;
    let activeWordIndex = -1;
    let wordRects = [];   // spoken word index -> PDF rect or null

    await Sync.loadSyncMap(jobId);
    await PdfViewer.load(`/api/pdf/${jobId}`);

    // Align the spoken word stream to word boxes on the PDF
    const spokenWords = Sync.getWords();
    wordRects = Aligner.align(
        spokenWords.map(w => w.text),
        PdfViewer.getAllWords()
    );

    // Initialize audio player with time update callback
    AudioPlayer.init(`/api/audio/${jobId}`, (currentTimeMs) => {
        const wordIdx = Sync.getActiveWordAt(currentTimeMs);
        if (wordIdx !== activeWordIndex) {
            activeWordIndex = wordIdx;
            // If this word wasn't located on the PDF (e.g. verbalized math),
            // leave the highlight on the last located word.
            const rect = wordRects[wordIdx];
            if (rect) {
                PdfViewer.highlightRect(rect, AudioPlayer.isPlaying());
            }
        }
    });

    // Click a word on the page to start reading from it
    PdfViewer.onPageClick(({ page, x, y }) => {
        let best = -1;
        let bestDist = Infinity;
        for (let i = 0; i < wordRects.length; i++) {
            const r = wordRects[i];
            if (!r || r.page !== page) continue;
            const cx = r.x + r.w / 2;
            const cy = r.y + r.h / 2;
            const dist = Math.abs(cy - y) * 4 + Math.abs(cx - x); // favor same line
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }
        if (best >= 0) {
            AudioPlayer.seekTo(spokenWords[best].start_time_ms);
        }
    });

    // PDF navigation
    document.getElementById('pdf-prev').addEventListener('click', PdfViewer.prevPage);
    document.getElementById('pdf-next').addEventListener('click', PdfViewer.nextPage);

    // Segment skip buttons
    document.getElementById('btn-prev-seg').addEventListener('click', () => {
        const currentSeg = activeWordIndex >= 0
            ? spokenWords[activeWordIndex].segment_index : 0;
        const target = Math.max(0, currentSeg - 1);
        AudioPlayer.seekTo(Sync.getSegmentStartTime(target));
    });
    document.getElementById('btn-next-seg').addEventListener('click', () => {
        const currentSeg = activeWordIndex >= 0
            ? spokenWords[activeWordIndex].segment_index : -1;
        const maxIdx = Sync.getSegmentCount() - 1;
        const target = Math.min(maxIdx, currentSeg + 1);
        AudioPlayer.seekTo(Sync.getSegmentStartTime(target));
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (e.code === 'Space') {
            e.preventDefault();
            AudioPlayer.togglePlay();
        } else if (e.code === 'ArrowLeft') {
            document.getElementById('btn-prev-seg').click();
        } else if (e.code === 'ArrowRight') {
            document.getElementById('btn-next-seg').click();
        }
    });
})();
