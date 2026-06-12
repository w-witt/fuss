/**
 * Synchronization module: parses WebVTT word timestamps and maps them to text segments.
 * Provides methods to find the active segment at any given audio time.
 */

const Sync = (function () {
    let words = [];       // [{start_time_ms, end_time_ms, text, segment_index}]
    let segments = [];    // [{segment_index, start_time_ms, end_time_ms}]

    async function loadSyncMap(jobId) {
        const resp = await fetch(`/api/sync_map/${jobId}`);
        const data = await resp.json();
        words = data.words || [];
        segments = data.segments || [];
    }

    /**
     * Find the segment index active at a given time (in milliseconds).
     * Uses binary search on the segments array for efficiency.
     */
    function getActiveSegmentAt(timeMs) {
        if (segments.length === 0) return -1;

        let lo = 0, hi = segments.length - 1;
        let result = -1;

        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (segments[mid].start_time_ms <= timeMs) {
                result = segments[mid].segment_index;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        return result;
    }

    /**
     * Find the word index active at a given time (in milliseconds).
     * Returns the latest word whose start time has passed.
     */
    function getActiveWordAt(timeMs) {
        if (words.length === 0) return -1;

        let lo = 0, hi = words.length - 1;
        let result = -1;

        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (words[mid].start_time_ms <= timeMs) {
                result = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        return result;
    }

    /**
     * Get all word timing data.
     */
    function getWords() {
        return words;
    }

    /**
     * Get the start time (ms) of a given segment index.
     */
    function getSegmentStartTime(segmentIndex) {
        const seg = segments.find(s => s.segment_index === segmentIndex);
        return seg ? seg.start_time_ms : 0;
    }

    /**
     * Get the total number of segments.
     */
    function getSegmentCount() {
        return segments.length;
    }

    /**
     * Get all segment timing data.
     */
    function getSegments() {
        return segments;
    }

    return {
        loadSyncMap,
        getActiveSegmentAt,
        getActiveWordAt,
        getWords,
        getSegmentStartTime,
        getSegmentCount,
        getSegments,
    };
})();
