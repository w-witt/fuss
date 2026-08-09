/**
 * gate.js — invite-code gate for the private beta.
 *
 * Honest scope: this is a SOFT gate. The whole app is static and runs in the
 * browser, so a determined technical visitor can read the source. What this
 * gate *does* reliably do:
 *   - keep out casual / non-invited visitors (they see only the code prompt),
 *   - make codes unguessable (strong random codes, compared by SHA-256 so the
 *     plaintext codes never live in the shipped source),
 *   - let you revoke a code (remove its hash → that tester is locked out again).
 *
 * For a hard lock (e.g. a public launch window you truly want sealed), put the
 * site behind Cloudflare Access / host-level auth instead — see README.
 *
 * To open the gates for everyone: set BETA_GATE_ENABLED = false.
 */

const BETA_GATE_ENABLED = false;

// SHA-256 (hex) of each valid code, compared against the UPPERCASED, trimmed
// input. Generate more with:  node gen-code.mjs "FUSS-YOUR-CODE"
// Demo codes that work out of the box (replace before sending to testers):
//   FUSS-EULER-1755 · FUSS-SCRIBE-2026 · FUSS-BETA-NXR4
const ALLOWED_CODE_HASHES = [
  'ae991eff6e691d143a954e1e668f6f095f3142d7e3e7f7ae96f0ca05b25ff4c5',
  'e55170ef8c9533f6727f3eaecfc21a7fa41774bcbf886b571ccecb6bf2ade4aa',
  'b40a79f808bd8a7469aab08b81d81a33fea4da78c98e741552272a3ff48aad0d',
];

// Optional: validate against the feedback Worker instead of the local list,
// so codes aren't in the client at all. Empty = use ALLOWED_CODE_HASHES.
const GATE_ENDPOINT = ''; // e.g. 'https://fuss-feedback.<you>.workers.dev/gate'

const STORAGE_KEY = 'fuss_access_hash';
const REQUEST_CONTACT = 'https://github.com/w-witt/fuss/issues/new?title=Beta%20access%20request';

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function isUnlocked() {
  if (!BETA_GATE_ENABLED) return true;
  const stored = localStorage.getItem(STORAGE_KEY);
  // Re-lock if the stored code's hash was since revoked from the list.
  return !!stored && ALLOWED_CODE_HASHES.includes(stored);
}

async function verify(code) {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return false;
  const hash = await sha256Hex(normalized);

  if (GATE_ENDPOINT) {
    try {
      const res = await fetch(GATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: normalized }),
      });
      if (res.ok) {
        localStorage.setItem(STORAGE_KEY, hash);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  if (ALLOWED_CODE_HASHES.includes(hash)) {
    localStorage.setItem(STORAGE_KEY, hash);
    return true;
  }
  return false;
}

function showGate() {
  const overlay = document.createElement('div');
  overlay.className = 'gate-overlay';
  overlay.innerHTML = `
    <div class="gate-card" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <h1 class="gate-logo">Fuss</h1>
      <p class="gate-sub">Private beta</p>
      <h2 id="gate-title" class="gate-h">Enter your invite code</h2>
      <p class="gate-hint">Fuss is in a closed beta with a handful of readers. Have a code? Enter it below.</p>
      <form id="gate-form">
        <input id="gate-input" type="text" autocomplete="off" autocapitalize="characters"
               spellcheck="false" placeholder="FUSS-XXXX-XXXX" aria-label="Invite code" />
        <button class="btn" type="submit">Unlock</button>
      </form>
      <p id="gate-error" class="gate-error" role="alert"></p>
      <p class="gate-foot">No code? <a href="${REQUEST_CONTACT}" target="_blank" rel="noopener">Request access</a></p>
    </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('gated');

  const input = overlay.querySelector('#gate-input');
  const error = overlay.querySelector('#gate-error');
  input.focus();

  overlay.querySelector('#gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const ok = await verify(input.value);
    if (ok) {
      overlay.remove();
      document.body.classList.remove('gated');
      window.dispatchEvent(new CustomEvent('fuss-unlocked'));
    } else {
      error.textContent = 'That code didn’t match. Check it and try again.';
      input.select();
    }
  });
}

// Run as early as the module loads (deferred until DOM is parsed).
(async () => {
  if (await isUnlocked()) {
    window.dispatchEvent(new CustomEvent('fuss-unlocked'));
    return;
  }
  showGate();
})();
