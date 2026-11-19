# Lessons

- The relay decides by Referer. A page served with `Referrer-Policy: no-referrer` sends none, so its events are dropped (fail closed). Use the default `strict-origin-when-cross-origin`.

- The loader used to wait on Cast List whenever an isolate was new or the 5-minute cache had expired (~150 ms each
  time). The catalog now refreshes in the background and a copy lives in the edge cache. Don't put a blocking
  upstream call back on the request path.
- PostHog's remote config (`/array/<token>/config(.js)`) belongs on the assets host, like `/static/*`. It used to go to ingest.
- Wrangler's OAuth login can't read Analytics Engine (no analytics scope); `scripts/metrics.mjs` needs an API token.
