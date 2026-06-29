/**
 * Fuss beta feedback collector — a Cloudflare Worker.
 *
 * Durable, serverless sink for the in-app Feedback widget. Reports drive new
 * rules in the LaTeX → speech library (pipeline/replacements.py / latex2text.js).
 *
 * Routes:
 *   POST /            store one feedback record (JSON body). CORS-open.
 *   GET  /export      dump all records as JSONL. Requires ?key=<ADMIN_KEY>.
 *
 * Storage: a single KV namespace bound as FEEDBACK. Each record is one key
 * (ts:<iso>:<rand>) so listing/export is simple and append-only.
 *
 * Setup (see README.md in this folder):
 *   wrangler kv namespace create FEEDBACK
 *   wrangler secret put ADMIN_KEY
 *   wrangler deploy
 * then set FEEDBACK_ENDPOINT in ../feedback.js to the deployed URL.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}

const CATEGORIES = new Set(['missed-latex', 'pronunciation', 'voice-quality', 'other']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // --- Export (admin) ---
    if (request.method === 'GET' && url.pathname === '/export') {
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) {
        return json({ error: 'unauthorized' }, 401);
      }
      const list = await env.FEEDBACK.list({ limit: 1000 });
      const lines = [];
      for (const k of list.keys) {
        const v = await env.FEEDBACK.get(k.name);
        if (v) lines.push(v);
      }
      return new Response(lines.join('\n') + '\n', {
        headers: { 'Content-Type': 'application/x-ndjson', ...CORS },
      });
    }

    // --- Submit ---
    if (request.method === 'POST' && url.pathname === '/') {
      let data;
      try {
        data = await request.json();
      } catch {
        return json({ error: 'invalid JSON' }, 400);
      }

      const category = data.category;
      const comment = (data.comment || '').toString().trim();
      if (!CATEGORIES.has(category)) return json({ error: 'unknown category' }, 400);
      if (!comment) return json({ error: 'comment required' }, 400);

      const record = {
        timestamp: new Date().toISOString(),
        category,
        comment: comment.slice(0, 5000),
        file_name: (data.file_name || '').toString().slice(0, 200),
        segment_count: Number(data.segment_count) || 0,
        user_agent: (data.user_agent || '').toString().slice(0, 400),
        ip_country: request.headers.get('cf-ipcountry') || '',
      };

      const rand = Math.random().toString(36).slice(2, 8);
      const key = `ts:${record.timestamp}:${rand}`;
      await env.FEEDBACK.put(key, JSON.stringify(record));
      return json({ status: 'ok' }, 201);
    }

    return json({ error: 'not found' }, 404);
  },
};
