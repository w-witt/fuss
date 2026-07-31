/**
 * feedback.js — beta feedback for the LaTeX → plain-text library.
 *
 * Same purpose as the in-reader feedback in the desktop app: readers flag a
 * LaTeX command that was missed or mis-spoken, and that drives new rules in
 * latex2text.js (the JS port of pipeline/replacements.py).
 *
 * Static-site delivery means there's no server writing feedback.jsonl. Two sinks:
 *   - If FEEDBACK_ENDPOINT is set (a serverless collector — Cloudflare Worker,
 *     Formspree, etc.), POST the JSON record there.
 *   - Otherwise open a prefilled GitHub issue on the public repo.
 */

const FEEDBACK_ENDPOINT = ''; // e.g. 'https://fuss-feedback.example.workers.dev'
const GITHUB_REPO = 'https://github.com/w-witt/fuss';

const CATEGORIES = [
  ['missed-latex', 'A LaTeX command was missed or read as gibberish'],
  ['pronunciation', 'A word or symbol was expanded/read wrong (e.g. wrong math wording)'],
  ['voice-quality', "The voice itself sounds bad/robotic (your browser's voice, not the text)"],
  ['other', 'Something else'],
];

let context = { fileName: '', segments: [] };

export function setFeedbackContext(ctx) {
  context = { ...context, ...ctx };
}

function buildRecord(category, comment) {
  return {
    timestamp: new Date().toISOString(),
    category,
    comment: comment.slice(0, 5000),
    file_name: (context.fileName || '').slice(0, 200),
    segment_count: context.segments?.length || 0,
    // Conversion-quality lint (mmdlint.js): how many invented LaTeX commands
    // the OCR produced, and on which pages. Separates "the OCR degenerated"
    // reports from genuine gaps in the replacement rules.
    lint: context.lint || null,
    user_agent: navigator.userAgent,
  };
}

async function submit(category, comment) {
  const record = buildRecord(category, comment);

  if (FEEDBACK_ENDPOINT) {
    const res = await fetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!res.ok) throw new Error(`Feedback server returned ${res.status}`);
    return 'sent';
  }

  // Fall back to a prefilled GitHub issue.
  const title = `[beta] ${category}: ${comment.slice(0, 60)}`;
  const body = [
    `**Category:** ${category}`,
    `**File:** ${record.file_name || '(unknown)'}`,
    '',
    comment,
    '',
    '---',
    `_segments: ${record.segment_count}` +
      (record.lint
        ? ` · lint: ${record.lint.unknown_commands}/${record.lint.total_commands} unknown` +
          (record.lint.bad_pages.length ? ` (pages ${record.lint.bad_pages.join(', ')})` : '')
        : '') +
      ` · ${record.user_agent}_`,
  ].join('\n');
  const url = `${GITHUB_REPO}/issues/new?labels=beta-feedback&title=${encodeURIComponent(
    title
  )}&body=${encodeURIComponent(body)}`;
  window.open(url, '_blank', 'noopener');
  return 'github';
}

function injectModal() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <button id="fb-open" class="fb-fab" title="Report a LaTeX/pronunciation issue">Feedback</button>
    <div id="fb-modal" class="fb-modal" hidden>
      <div class="fb-card" role="dialog" aria-modal="true" aria-labelledby="fb-title">
        <h3 id="fb-title">Help improve the LaTeX → speech library</h3>
        <p class="fb-hint">Spotted a command read as gibberish, or a symbol said wrong? Tell us — it becomes a rule everyone benefits from.</p>
        <label class="fb-label" for="fb-category">What happened?</label>
        <select id="fb-category">
          ${CATEGORIES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select>
        <label class="fb-label" for="fb-comment">Details</label>
        <textarea id="fb-comment" rows="4" placeholder="e.g. \\\\widehat{x} was read as 'widehatx' instead of 'x hat'"></textarea>
        <div class="fb-actions">
          <button id="fb-cancel" class="fb-btn fb-btn-ghost">Cancel</button>
          <button id="fb-send" class="fb-btn">Send</button>
        </div>
        <p id="fb-status" class="fb-status"></p>
      </div>
    </div>`;
  document.body.appendChild(wrap);
}

export function initFeedback() {
  injectModal();
  const modal = document.getElementById('fb-modal');
  const status = document.getElementById('fb-status');
  const open = () => {
    status.textContent = '';
    modal.hidden = false;
  };
  const close = () => (modal.hidden = true);

  document.getElementById('fb-open').addEventListener('click', open);
  document.getElementById('fb-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  document.getElementById('fb-send').addEventListener('click', async () => {
    const category = document.getElementById('fb-category').value;
    const comment = document.getElementById('fb-comment').value.trim();
    if (!comment) {
      status.textContent = 'Please add a few words of detail.';
      return;
    }
    status.textContent = 'Sending…';
    try {
      const how = await submit(category, comment);
      status.textContent =
        how === 'github' ? 'Opening a GitHub issue — thank you!' : 'Thanks! Feedback recorded.';
      document.getElementById('fb-comment').value = '';
      setTimeout(close, 1200);
    } catch (err) {
      status.textContent = `Could not send: ${err.message}`;
    }
  });
}
