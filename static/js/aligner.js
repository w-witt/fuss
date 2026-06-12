/**
 * Aligner: matches the spoken word stream (from the TTS sync map) to word
 * boxes extracted from the PDF text layer, so the currently spoken word can
 * be highlighted directly on the rendered page.
 *
 * The two streams differ: the spoken text comes from Nougat markdown with
 * math verbalized ("alpha" for "α"), while the PDF text layer has raw glyphs,
 * hyphenated line breaks, page headers, etc. So this does a greedy sequential
 * fuzzy match with a bounded look-ahead window.
 */

const Aligner = (function () {
    // Glyphs the TTS pipeline reads out by name. Mapping them lets spoken
    // words like "alpha" land on the "α" glyph in the PDF.
    const SYMBOL_NAMES = {
        'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon',
        'ϵ': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'ϑ': 'theta',
        'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu', 'ν': 'nu',
        'ξ': 'xi', 'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau',
        'υ': 'upsilon', 'φ': 'phi', 'ϕ': 'phi', 'χ': 'chi', 'ψ': 'psi',
        'ω': 'omega',
        'Γ': 'gamma', 'Δ': 'delta', 'Θ': 'theta', 'Λ': 'lambda', 'Ξ': 'xi',
        'Π': 'pi', 'Σ': 'sigma', 'Φ': 'phi', 'Ψ': 'psi', 'Ω': 'omega',
        '∇': 'nabla', '∂': 'partial', '∑': 'sum', '∏': 'product',
        '∫': 'integral', '∞': 'infinity', '√': 'sqrt', '≈': 'approximately',
        '≤': 'lessthanorequal', '≥': 'greaterthanorequal', '≠': 'notequal',
        '±': 'plusorminus', '×': 'times', '·': 'dot', '∈': 'in',
        '→': 'to', '↦': 'mapsto', '⊂': 'subset', '⊆': 'subset',
        '∀': 'forall', '∃': 'thereexists', 'ℓ': 'ell', '°': 'degrees',
    };

    function normalize(word) {
        let t = word.toLowerCase();
        t = Array.from(t).map(ch => SYMBOL_NAMES[ch] || ch).join('');
        // Strip diacritics, then anything that isn't a letter or digit
        t = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        t = t.replace(/[^a-z0-9]/g, '');
        return t;
    }

    function matches(a, b) {
        if (!a || !b) return false;
        if (a === b) return true;
        // Prefix match covers stemming-ish drift and partial glyph extraction
        if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
        return false;
    }

    /**
     * Align spoken words to PDF words.
     * @param spokenWords array of strings, in playback order
     * @param pdfWords array of {page, x, y, w, h, str} in reading order
     * @returns array (same length as spokenWords) of rects {page,x,y,w,h} or null
     */
    function align(spokenWords, pdfWords) {
        const SEARCH_AHEAD = 40;
        const RESYNC_WINDOW = 200;
        const rects = new Array(spokenWords.length).fill(null);

        // Drop PDF words that normalize to nothing (dot leaders in tables of
        // contents, bare punctuation) — they would flood the search window.
        const candidates = [];
        for (let j = 0; j < pdfWords.length; j++) {
            const n = normalize(pdfWords[j].str);
            if (n) candidates.push({ idx: j, norm: n });
        }

        let p = 0;
        let misses = 0;

        for (let i = 0; i < spokenWords.length; i++) {
            const raw = spokenWords[i].trim();
            // Multi-word spoken tokens (e.g. verbalized dates): match on the
            // first sub-word so the highlight at least lands at the start.
            const s = normalize(raw.includes(' ') ? raw.split(/\s+/)[0] : raw);
            if (!s) continue;

            // Short, common words match anywhere; only trust them very close
            // to the cursor so they don't drag the alignment off course.
            let window = s.length < 3 ? 4 : SEARCH_AHEAD;
            // After a run of misses (e.g. a verbalized equation), widen the
            // search for a distinctive word to resynchronize.
            if (misses >= 6 && s.length >= 5) window = RESYNC_WINDOW;
            const end = Math.min(p + window, candidates.length);

            for (let k = p; k < end; k++) {
                const j = candidates[k].idx;
                if (matches(s, candidates[k].norm)) {
                    rects[i] = toRect(pdfWords[j]);
                    p = k + 1;
                    break;
                }
                // Word split across a line break with a hyphen
                if (k + 1 < candidates.length && pdfWords[j].str.endsWith('-')) {
                    const next = pdfWords[candidates[k + 1].idx];
                    const joined = normalize(pdfWords[j].str.slice(0, -1) + next.str);
                    if (matches(s, joined)) {
                        rects[i] = toRect(pdfWords[j]);
                        p = k + 2;
                        break;
                    }
                }
            }

            if (rects[i]) {
                misses = 0;
            } else {
                misses++;
            }
        }
        return rects;
    }

    function toRect(w) {
        return { page: w.page, x: w.x, y: w.y, w: w.w, h: w.h };
    }

    return { align, normalize };
})();
