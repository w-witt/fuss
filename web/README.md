# Fuss — browser beta

A fully client-side version of Fuss for the beta test. It converts an academic
PDF to plain, speakable text **entirely on the visitor's machine** — the PDF is
never uploaded anywhere.

```text
PDF ──(pdf.js, rasterize pages)──▶ page images
    ──(Web Worker: Nougat via transformers.js, WebGPU→WASM)──▶ LaTeX / Mathpix-Markdown
    ──(latex2text.js: port of pipeline/replacements.py)──▶ plain text (math read as words)
    ──(tts.js: Web Speech API)──▶ spoken audiobook with word-by-word read-along
```

## Files

| File | Role |
| --- | --- |
| `index.html` | Landing page + converter UI |
| `app.js` | Orchestration: rasterize → worker → library, drives the progress bar |
| `worker.js` | Runs `Xenova/nougat-small` off the main thread (WebGPU, WASM fallback) |
| `gate.js` | Invite-code gate for the private beta (`gen-code.mjs` makes codes) |
| `about.js` | "Why 'Fuss'?" history modal (Nikolaus Fuss, Euler's scribe) |
| `latex2text.js` | LaTeX/MMD → speakable text — **the library beta feedback improves** |
| `tts.js` | Audiobook engine (Web Speech API); emits the spoken word index |
| `pdfview.js` | Renders the PDF + text-layer word boxes, moves the read-along highlight |
| `aligner.js` | Fuzzy-aligns the spoken word stream to PDF word boxes (math-aware) |
| `progress.js` | Two-phase progress with a real ETA (download, then per-page) |
| `feedback.js` | Feedback widget → serverless endpoint or prefilled GitHub issue |
| `feedback-worker/` | Deployable Cloudflare Worker that durably stores feedback (optional) |
| `styles.css` | Styling |
| `latex2text.test.mjs` | Node unit tests for the library port |

No build step. All dependencies (transformers.js, pdf.js, markdown-it) load from
CDN as ES modules.

## Run locally

Must be served over HTTP (ES module workers don't load from `file://`):

```bash
cd web
python3 -m http.server 8123
# open http://localhost:8123 in Chrome or Edge
```

## Test the library port

```bash
node web/latex2text.test.mjs
```

## Private beta access (invite codes)

The site opens behind an invite-code screen ([`gate.js`](gate.js)).

```bash
# make a new code + its hash
node gen-code.mjs                 # random code
node gen-code.mjs "FUSS-ADA-9F2K" # or pick your own
```

- Paste the printed **hash** into `ALLOWED_CODE_HASHES` in `gate.js`, and give
  the **code** to a tester.
- **Revoke** a tester: delete their hash — they're locked out on next load.
- **Open the gates for everyone:** set `BETA_GATE_ENABLED = false` in `gate.js`.
- Three demo codes work out of the box (`FUSS-EULER-1755`, `FUSS-SCRIBE-2026`,
  `FUSS-BETA-NXR4`) — **replace them before sending invites.**

> **How strong is this?** It's a *soft* gate. Codes are compared by SHA-256, so
> the plaintext codes aren't in the shipped source and can't be guessed — but
> the app itself is static, so a determined technical visitor could read the
> JS and bypass the screen. That's the right level for "a few invited testers."
> For a **hard** lock (a sealed pre-launch window), put the whole site behind
> **Cloudflare Access** or host-level basic-auth instead of (or on top of) this.
> To keep codes fully off the client, deploy the gate check to the Worker and
> set `GATE_ENDPOINT` in `gate.js`.

## Browser requirements

- **Best:** Chrome or Edge (WebGPU) — the model runs on the GPU.
- **Works:** any modern browser — falls back to WASM/CPU (slower).
- First conversion downloads the Nougat weights (~150–250 MB depending on
  WebGPU vs quantized WASM build), then they're cached by the browser.

## Manual smoke test (in-browser, can't be automated headlessly)

1. Serve locally and open in Chrome. Enter a demo code (e.g. `FUSS-EULER-1755`)
   at the gate — it should unlock and stay unlocked on reload. Click
   **Why "Fuss"?** to confirm the history modal opens.
2. Drop a short (2–3 page) academic PDF, click **Convert**.
3. Confirm: device badge shows GPU/CPU; download bar fills on first run; the
   conversion bar advances per page and shows "~Xm Ys remaining".
4. Confirm plain text appears and math reads as words (e.g. "x squared",
   "summation over").
5. Press **Play** (or Space): the **rendered PDF** is shown and the word being
   read is highlighted **on the page**, auto-scrolling as it goes. Try the
   **Speed** slider and **Voice** picker; **click anywhere on the page** to start
   listening from the nearest word; use ⏮/⏭ to skip sections. Expand
   **Plain text & downloads** for .txt/.mmd.
6. Click **Feedback**, submit a note → a prefilled GitHub issue opens (or the
   serverless endpoint receives it, if configured — see `feedback-worker/`).

## Audiobook / read-along notes

- TTS uses the browser's built-in voices (Web Speech API) — fully local, no
  extra download. Voice quality depends on the OS; macOS/Windows ship good
  natural voices, which the voice picker prefers automatically.
- Word highlighting **on the PDF** relies on `boundary` events (fire in
  Chrome/Edge). In browsers that don't emit them, playback still works but the
  on-page highlight won't advance per word.
- The spoken stream (from Nougat, with math verbalized) is fuzzy-aligned to the
  PDF's own text layer (`aligner.js`). Alignment is best-effort: dense equations
  or figures may briefly desync, then re-sync on the next distinctive word.

## Deploy (Cloudflare Pages)

The site is static (`web/`), no build step. Git-connected deploy auto-publishes
on every push to `main`:

1. Commit and push `web/` to GitHub (`w-witt/fuss`).
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git** → select `w-witt/fuss`.
3. Build settings:
   - Framework preset: **None**
   - Build command: **(empty)**
   - Build output directory: **`web`**
4. **Save and Deploy** → test on the `*.pages.dev` URL.
5. **Custom domain:** Pages project → **Custom domains** → **Set up a domain** →
   enter your domain. DNS is already in Cloudflare, so the record + SSL are
   provisioned automatically.

CLI alternative (no Git): `npx wrangler pages deploy web --project-name fuss`.

> **HTTPS note:** WebGPU, module workers, and the gate's `crypto.subtle` all
> need a secure context. Cloudflare Pages (HTTPS) and `localhost` both qualify.
>
> **Do _not_ add COOP/COEP headers.** The WebGPU fast path doesn't need
> cross-origin isolation, and `require-corp` would break the jsDelivr CDN
> imports (transformers.js / pdf.js). WASM fallback still works single-threaded.

## Collecting feedback to a server (optional)

`feedback.js` defaults to opening a prefilled GitHub issue (no backend needed).
To instead collect structured JSON, set `FEEDBACK_ENDPOINT` at the top of
`feedback.js` to a serverless collector (Cloudflare Worker, Formspree, etc.).
The posted record is `{ timestamp, category, comment, file_name, segment_count,
user_agent }`. The endpoint must allow CORS from the site origin.
