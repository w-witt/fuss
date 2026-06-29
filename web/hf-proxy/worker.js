/**
 * fuss-hf — a Cloudflare Worker that proxies Hugging Face model files.
 *
 * Why: the browser fetches model weights/tokenizer/config from huggingface.co.
 * On some networks (campus/corporate SSL-inspecting proxies) those cross-origin
 * fetches fail ("Failed to fetch") even though the same files load fine in a
 * browser tab and Cloudflare/CDN hosts work. Routing through this Worker fixes
 * it: the browser only talks to *.workers.dev (reachable, CORS intact), and the
 * Worker fetches Hugging Face from Cloudflare's edge.
 *
 * It transparently maps  /<anything>  ->  https://huggingface.co/<anything>,
 * adds permissive CORS, forwards Range requests, and edge-caches responses.
 *
 * Deploy:  cd web/hf-proxy && npx wrangler deploy
 * Then set env.remoteHost in ../worker.js to the deployed URL.
 */

const HF = 'https://huggingface.co';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    const url = new URL(request.url);
    const target = HF + url.pathname + url.search;

    // Forward only the headers that matter for fetching a static file.
    const fwd = new Headers();
    const range = request.headers.get('Range');
    if (range) fwd.set('Range', range);
    fwd.set('Accept', request.headers.get('Accept') || '*/*');

    const resp = await fetch(target, {
      method: request.method,
      headers: fwd,
      redirect: 'follow', // HF LFS files 302 to a CDN; follow it edge-side
      cf: { cacheEverything: true, cacheTtl: 86400 },
    });

    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers,
    });
  },
};
