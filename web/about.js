/**
 * about.js — the "Why 'Fuss'?" history modal.
 *
 * Injects a dialog explaining the name and wires it to any element marked
 * with [data-about-open].
 */

function injectModal() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div id="about-modal" class="about-modal" hidden>
      <div class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <button class="about-close" id="about-close" aria-label="Close">×</button>
        <h2 id="about-title">Why “Fuss”?</h2>
        <p>
          The tool is named after <strong>Nikolaus Fuss</strong> (1755–1826), the Swiss
          mathematician who became <strong>Leonhard Euler's assistant and scribe</strong>. By the
          time Fuss joined him, Euler was almost completely blind — so Euler would compose
          mathematics <em>aloud</em>, in his head, and Fuss wrote it down, turning spoken theorems
          and equations into the written page. He helped produce hundreds of Euler's works this way.
        </p>
        <p>
          This tool does the <strong>reverse</strong>. Where Nikolaus Fuss turned Euler's spoken
          mathematics into writing, <strong>Fuss turns written mathematics back into speech</strong> —
          taking a dense, equation-heavy PDF and reading it aloud, notation and all, so you can
          listen to a paper like an audiobook.
        </p>
        <p class="about-tag">
          Spoken math → written page (Nikolaus Fuss). &nbsp;Written page → spoken math (this Fuss).
        </p>
        <p class="about-foot">
          <a href="https://en.wikipedia.org/wiki/Nicolas_Fuss" target="_blank" rel="noopener">Nikolaus Fuss on Wikipedia</a>
          &middot;
          <a href="https://github.com/w-witt/fuss" target="_blank" rel="noopener">Fuss on GitHub</a>
        </p>
      </div>
    </div>`;
  document.body.appendChild(wrap);
}

export function initAbout() {
  injectModal();
  const modal = document.getElementById('about-modal');
  const open = () => (modal.hidden = false);
  const close = () => (modal.hidden = true);

  document.querySelectorAll('[data-about-open]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.preventDefault();
      open();
    })
  );
  document.getElementById('about-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) close();
  });
}
