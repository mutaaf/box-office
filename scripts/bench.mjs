// In-process benchmark: the Worker before this change (origin/main~ or BENCH_BASE) vs now, with Cast List
// and PostHog replaced by stubs that answer after realistic delays. Measures what the Worker itself adds.
//   node scripts/bench.mjs [baseRef]
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseRef = process.argv[2] || process.env.BENCH_BASE || 'e87915c';
const CAST_MS = 150, POSTHOG_MS = 40;
const feed = { apps: [
  { slug: 'mutaafaziz', kind: 'site', audience: 'general', url: 'https://mutaafaziz.com/' },
  { slug: 'cold-gas', kind: 'game', audience: 'general', url: 'https://mutaafaziz.com/coldgas/' },
  { slug: 'kin', kind: 'game', audience: 'kids', url: 'https://mutaafaziz.com/kin/' },
  ...Array.from({ length: 40 }, (_, i) => ({ slug: `app-${i}`, kind: 'app', audience: 'general', url: `https://mutaafaziz.com/app${i}/` })),
] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { CAST: { fetch: async () => { await sleep(CAST_MS); return Response.json(feed); } }, VERSION: 'bench' };
globalThis.fetch = async () => { await sleep(POSTHOG_MS); return new Response('{"status":1}'); };
const ctx = { waitUntil() {} };
// Cloudflare's per-colo edge cache, shared by isolates. (Node has none.)
const store = new Map();
globalThis.caches = { default: {
  async match(k) { const v = store.get(String(k.url ?? k)); return v ? new Response(v.body, v.init) : undefined; },
  async put(k, r) { store.set(String(k.url ?? k), { body: await r.arrayBuffer(), init: { status: r.status, headers: [...r.headers] } }); },
} };
const say = console.log.bind(console); console.log = () => {};

async function load(dir) {
  const w = await import(join(dir, 'worker.js') + `?t=${Date.now()}`);
  return w;
}
const old = mkdtempSync(join(tmpdir(), 'bo-old-'));
for (const f of ['worker.js', 'catalog.js', 'loader.js']) writeFileSync(join(old, f), execSync(`git show ${baseRef}:src/${f}`));
const OLD = await load(old), NEW = await load(new URL('../src/', import.meta.url).pathname);

async function time(fn, n) {
  const t = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  return (performance.now() - t) / n;
}
const req = (p, init) => new Request(`https://mutaafaziz.com${p}`, init);
const post = () => req('/boxoffice/e/e/', { method: 'POST', body: '{}', headers: { referer: 'https://mutaafaziz.com/coldgas/', 'cf-connecting-ip': '203.0.113.7' } });
const kids = () => req('/boxoffice/e/e/', { method: 'POST', body: '{}', headers: { referer: 'https://mutaafaziz.com/kin/', 'cf-connecting-ip': '203.0.113.7' } });

const rows = [];
for (const [name, W] of [['before', OLD], ['after', NEW]]) {
  const f = (r) => W.default.fetch(r, env, ctx);
  // A new isolate in a colo where another isolate has already run (the common case after the first minute).
  W._reset(); await f(req('/boxoffice/v1/insights.js')); W._reset();
  const cold = await time(() => f(req('/boxoffice/v1/insights.js')), 1);
  const warm = await time(() => f(req('/boxoffice/v1/insights.js')), 2000);
  // Catalog expiry: the request that lands after the 5-minute TTL.
  const realNow = Date.now; Date.now = () => realNow() + 400_000;
  const expired = await time(() => f(req('/boxoffice/v1/insights.js')), 1);
  Date.now = realNow;
  const drop = await time(() => f(kids()), 2000);
  const fwd = await time(() => f(post()), 50);
  rows.push({ name, cold, warm, expired, drop, fwd });
}
const fmt = (ms) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(1)} ms`);
say(`Cast List stub ${CAST_MS} ms, PostHog stub ${POSTHOG_MS} ms\n`);
say('case                               before        after       speed-up');
for (const [k, label] of [['cold', 'loader, cold isolate'], ['expired', 'loader, catalog just expired'], ['warm', 'loader, warm'], ['drop', 'relay, kids event dropped'], ['fwd', 'relay, event forwarded']]) {
  const [b, a] = rows.map((r) => r[k]);
  say(`${label.padEnd(34)} ${fmt(b).padStart(9)}  ${fmt(a).padStart(10)}  ${(b / a).toFixed(1).padStart(8)}x`);
}
