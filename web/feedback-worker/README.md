# Fuss feedback collector (Cloudflare Worker)

A tiny serverless endpoint that durably stores beta feedback in Cloudflare KV.
Optional — if you don't deploy it, the site falls back to opening a prefilled
GitHub issue. Use this when you'd rather collect structured records.

## Deploy

You need a (free) Cloudflare account and [`wrangler`](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

```bash
cd web/feedback-worker

# 1. Create the KV namespace and copy the printed id into wrangler.toml
wrangler kv namespace create FEEDBACK

# 2. Set an admin key (used to export feedback later)
wrangler secret put ADMIN_KEY        # type any long random string

# 3. Deploy
wrangler deploy
```

`wrangler deploy` prints the public URL, e.g.
`https://fuss-feedback.<you>.workers.dev`.

## Point the site at it

In [`../feedback.js`](../feedback.js), set:

```js
const FEEDBACK_ENDPOINT = 'https://fuss-feedback.<you>.workers.dev';
```

That's it — the Feedback widget now POSTs JSON there instead of opening GitHub.

## Read the feedback

```bash
curl 'https://fuss-feedback.<you>.workers.dev/export?key=YOUR_ADMIN_KEY' > feedback.jsonl
```

Each line is one record:

```json
{"timestamp":"…","category":"missed-latex","comment":"…","file_name":"…","segment_count":42,"user_agent":"…","ip_country":"US"}
```

This matches the desktop app's `feedback/feedback.jsonl` shape, so the two
streams can be analyzed together.

## Notes

- CORS is open (`*`) so the static site can POST from any origin. Lock it to
  your Pages domain in `worker.js` (`Access-Control-Allow-Origin`) before a
  wide launch.
- KV `list()` is capped at 1000 here; raise/paginate if you collect more.
