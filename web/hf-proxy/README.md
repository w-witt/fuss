# fuss-hf — Hugging Face model proxy

A tiny Cloudflare Worker that proxies model files from `huggingface.co` with
permissive CORS, so the browser loads weights/tokenizer/config from *your*
Cloudflare domain instead of hitting Hugging Face directly.

**Why it exists:** direct cross-origin `fetch()` to `huggingface.co` fails on
some networks (campus/corporate SSL-inspecting proxies) with "Failed to fetch",
even though the same URL opens fine in a browser tab and Cloudflare/CDN hosts
(jsDelivr) work. This Worker is reachable like jsDelivr and does the Hugging
Face fetch from Cloudflare's edge, so model loading works for every tester.

## Deploy

```bash
cd web/hf-proxy
npx wrangler deploy
```

It publishes at `https://fuss-hf.<your-account>.workers.dev` (for this account,
`https://fuss-hf.wwitt003.workers.dev`).

## Wire it up

[`../worker.js`](../worker.js) already points at it:

```js
env.remoteHost = 'https://fuss-hf.wwitt003.workers.dev';
```

If your deployed URL differs, update that one line, commit, and push (the static
site redeploys automatically).

To go back to hitting Hugging Face directly (fine on unrestricted networks), set
`env.remoteHost = 'https://huggingface.co'`.

## How it maps requests

transformers.js requests `${remoteHost}/Xenova/nougat-small/resolve/main/<file>`.
The Worker forwards `/<path>` → `https://huggingface.co/<path>`, follows the LFS
redirect edge-side, adds CORS, and edge-caches for a day.
