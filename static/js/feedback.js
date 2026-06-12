/**
 * Beta feedback: a modal for reporting missed LaTeX commands, pronunciation
 * problems, and general feedback. Snapshots the reading position when opened
 * so reports carry their context. Submits to the local feedback log and/or
 * opens a prefilled GitHub issue.
 */

const Feedback = (function () {
    const overlay = document.getElementById('feedback-overlay');
    const categorySelect = document.getElementById('feedback-category');
    const commentInput = document.getElementById('feedback-comment');
    const contextBox = document.getElementById('feedback-context');
    const githubLink = document.getElementById('feedback-github');
    const statusEl = document.getElementById('feedback-status');

    const CATEGORY_TITLES = {
        'missed-latex': 'Missed LaTeX command',
        'pronunciation': 'Incorrect pronunciation',
        'other': 'Beta feedback',
    };

    let getContext = null;   // callback returning {word, segment_text, time_ms, page}
    let snapshot = null;     // context captured when the modal was opened

    function init(contextProvider) {
        getContext = contextProvider;

        document.getElementById('btn-feedback').addEventListener('click', open);
        document.getElementById('feedback-cancel').addEventListener('click', close);
        document.getElementById('feedback-submit').addEventListener('click', submit);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Escape' && !overlay.hidden) close();
        });
        categorySelect.addEventListener('change', updateGithubLink);
        commentInput.addEventListener('input', updateGithubLink);
    }

    function open() {
        if (AudioPlayer.isPlaying()) AudioPlayer.togglePlay();
        snapshot = getContext ? getContext() : {};
        statusEl.textContent = '';

        const parts = [];
        if (snapshot.word) parts.push(`Reading: “${snapshot.word}”`);
        if (snapshot.page) parts.push(`page ${snapshot.page}`);
        if (snapshot.time_ms != null) parts.push(`at ${formatTime(snapshot.time_ms)}`);
        contextBox.textContent = parts.length
            ? `Context attached — ${parts.join(', ')}`
            : 'No playback context (nothing has been played yet).';

        updateGithubLink();
        overlay.hidden = false;
        commentInput.focus();
    }

    function close() {
        overlay.hidden = true;
    }

    function isOpen() {
        return !overlay.hidden;
    }

    async function submit() {
        const comment = commentInput.value.trim();
        if (!comment) {
            statusEl.textContent = 'Please describe the issue first.';
            return;
        }
        try {
            const resp = await fetch(`/api/feedback/${window.FUSS.jobId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    category: categorySelect.value,
                    comment: comment,
                    context: snapshot,
                }),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            commentInput.value = '';
            statusEl.textContent = 'Thank you! Feedback recorded.';
            setTimeout(close, 1200);
        } catch (err) {
            statusEl.textContent = `Could not submit (${err.message}). ` +
                'You can still open a GitHub issue instead.';
        }
    }

    function updateGithubLink() {
        const category = categorySelect.value;
        const comment = commentInput.value.trim();
        const title = `[${CATEGORY_TITLES[category]}] ` +
            (comment ? comment.slice(0, 60) : 'Beta feedback');

        const lines = [
            `**Category:** ${CATEGORY_TITLES[category]}`,
            '',
            '**What happened / what should it have said?**',
            comment || '_describe here_',
            '',
            '---',
            '**Context (auto-captured by the Fuss reader)**',
        ];
        if (snapshot) {
            if (snapshot.word) lines.push(`- Word being read: \`${snapshot.word}\``);
            if (snapshot.page) lines.push(`- Page: ${snapshot.page}`);
            if (snapshot.time_ms != null) lines.push(`- Playback time: ${formatTime(snapshot.time_ms)}`);
            if (snapshot.segment_text) {
                lines.push('- Passage:', '', `> ${snapshot.segment_text.slice(0, 600)}`);
            }
        }

        const params = new URLSearchParams({
            title: title,
            body: lines.join('\n'),
            labels: category === 'other' ? 'beta-feedback' : `beta-feedback,${category}`,
        });
        githubLink.href = `${window.FUSS.repoUrl}/issues/new?${params}`;
    }

    function formatTime(ms) {
        const s = Math.floor(ms / 1000);
        return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
    }

    return { init, isOpen };
})();
