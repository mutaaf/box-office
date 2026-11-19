// Box Office: analytics for every app at mutaafaziz.com (and the company sites), on PostHog's free tier.
//   GET  /boxoffice/v1/insights.js  the loader (built from Cast List; kids apps get a no-op)
//   ANY  /boxoffice/e/*             first-party relay to PostHog (assets from /static/* and /array/*, ingest otherwise)
//   GET  /boxoffice/health          catalog source and age, tracked and refused apps; ?deep=1 also probes upstreams
// Privacy: PostHog never sees a full IP. The relay forwards the visitor's IP truncated to /24 (IPv4) or
// /48 (IPv6), enough for city-level location and no more. Events whose page belongs to a kids app are dropped.
//
// Speed: the catalog is held per isolate and refreshed in the background (stale-while-revalidate), with the
// last good copy kept in the edge cache, so no request waits on Cast List once any isolate in the colo has
// seen it. The loader is rendered once per catalog version and revalidates with an ETag. PostHog assets are
// served from the edge cache.
// Observability: every response carries `x-boxoffice` (the outcome) and `server-timing`; every request writes
// one Analytics Engine data point (no IP, no URL); anything unusual is logged as one JSON line.
import { compile, index, lookup, FALLBACK } from './catalog.js';
import { loader } from './loader.js';

const ORIGIN = 'https://mutaafaziz.com';
const INGEST = 'us.i.posthog.com';
const ASSETS = 'us-assets.i.posthog.com';
const SNAPSHOT_KEY = 'https://mutaafaziz.com/boxoffice/_internal/catalog-v1';

export const LIMITS = {
  catalogTtlMs: 300_000, // refresh from Cast List after 5 min (in the background)
  catalogRetryMs: 30_000, // after a failed refresh, try again this soon
  catalogMaxAgeMs: 7 * 86_400_000, // an edge snapshot older than this is not used
  catalogTimeoutMs: 2_500,
  upstreamTimeoutMs: 15_000,
  maxBodyBytes: 10 * 1024 * 1024, // replay chunks are the largest posts; PostHog's own cap is higher
  logSample: 1, // share of routine (forwarded / asset) requests also logged; Workers Logs keeps 3 days, queryable by field
};

// PostHog paths the browser library and the native apps use. Anything else is refused (no open proxy).
const ROUTES = ['/e', '/i', '/s', '/flags', '/decide', '/batch', '/capture', '/engage', '/track', '/api/surveys', '/static', '/array'];
const ASSET_ROUTES = ['/static', '/array'];
const under = (path, prefixes) => prefixes.some((p) => path === p || path.startsWith(p + '/'));

const LOADER_CACHE = 'public, max-age=300, stale-while-revalidate=86400, stale-if-error=604800';
const NOOP_JS = 'window.boxoffice=window.boxoffice||{v:1,on:false,track:function(){}};';

// ---------------------------------------------------------------- catalog

let state = null; // { entries, idx, at, source, js, etag, apps, kids }
let refreshing = null;
export const _reset = () => { state = null; refreshing = null; };

async function digest(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function build(entries, source, at) {
  const js = loader(entries, ORIGIN);
  return {
    entries, idx: index(entries), at, source, js, etag: `"${await digest(js)}"`,
    apps: entries.filter((x) => x.audience === 'general').map((x) => x.slug),
    kids: entries.filter((x) => x.audience !== 'general').map((x) => x.slug),
  };
}

const edgeCache = () => (typeof caches !== 'undefined' && caches.default) || null;

async function loadSnapshot(now) {
  try {
    const hit = await edgeCache()?.match(SNAPSHOT_KEY);
    if (!hit) return null;
    const snap = await hit.json();
    if (!Array.isArray(snap.entries) || !snap.entries.length || now - snap.at > LIMITS.catalogMaxAgeMs) return null;
    return snap;
  } catch { return null; }
}

async function saveSnapshot(entries, at) {
  try {
    await edgeCache()?.put(SNAPSHOT_KEY, new Response(JSON.stringify({ at, entries }), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${LIMITS.catalogMaxAgeMs / 1000}` },
    }));
  } catch { /* the snapshot is an optimisation */ }
}

function refresh(env, now) {
  refreshing ??= (async () => {
    const t0 = Date.now();
    try {
      const r = await (env.CAST ?? globalThis).fetch(`${ORIGIN}/cast/api/apps`, {
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(LIMITS.catalogTimeoutMs),
      });
      if (!r.ok) throw new Error(`cast ${r.status}`);
      const entries = compile(await r.json());
      if (!entries.length) throw new Error('cast empty');
      const changed = !state || JSON.stringify(state.entries) !== JSON.stringify(entries);
      state = changed ? await build(entries, 'live', now) : { ...state, at: now, source: 'live' };
      await saveSnapshot(entries, now);
      metric(env, { route: 'catalog', outcome: changed ? 'refreshed' : 'unchanged', ms: Date.now() - t0 });
    } catch (e) {
      log({ event: 'catalog_refresh_failed', ok: false, error: String(e), ms: Date.now() - t0, serving: state?.source ?? 'fallback' });
      metric(env, { route: 'catalog', outcome: 'refresh_failed', ms: Date.now() - t0 });
      // Keep serving what we have; retry soon. With nothing at all, fall back to the built-in kids list (fail closed).
      state = state ? { ...state, at: now - LIMITS.catalogTtlMs + LIMITS.catalogRetryMs }
        : await build(compile(FALLBACK), 'fallback', now - LIMITS.catalogTtlMs + LIMITS.catalogRetryMs);
    } finally { refreshing = null; }
  })();
  return refreshing;
}

/** The current catalog. Only the very first request in a cold colo waits for Cast List. */
export async function catalog(env, ctx, now = Date.now()) {
  if (state && now - state.at < LIMITS.catalogTtlMs) return state;
  if (!state) {
    const snap = await loadSnapshot(now);
    if (snap) state = await build(snap.entries, 'snapshot', snap.at);
  }
  if (state) {
    const p = refresh(env, now);
    if (ctx?.waitUntil) ctx.waitUntil(p); else await p;
    return state;
  }
  await refresh(env, now);
  return state;
}

// ---------------------------------------------------------------- helpers

/** 203.0.113.77 → 203.0.113.0 ; 2001:db8:1:2:3::1 → 2001:db8:1:: */
export function truncateIp(ip) {
  if (!ip) return '';
  if (ip.includes('.') && !ip.includes(':')) {
    const p = ip.split('.');
    return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0` : '';
  }
  const full = ip.split('::');
  const head = full[0].split(':').filter(Boolean);
  return head.length ? `${head.slice(0, 3).join(':')}::` : '';
}

function log(o) { console.log(JSON.stringify({ service: 'box-office', ...o })); }

/** One Analytics Engine point per request: what happened, for which app, how long. No IP, no URL. */
function metric(env, { route, outcome, app = '', status = 0, ms = 0, upMs = 0, bytes = 0, req }) {
  try {
    env?.METRICS?.writeDataPoint({
      blobs: [route, outcome, app, req?.method ?? '', req?.cf?.country ?? '', req?.cf?.colo ?? '', env.VERSION ?? 'dev'],
      doubles: [status, ms, upMs, bytes],
      indexes: [route],
    });
  } catch { /* metrics never fail a request */ }
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
}

/** CORS only for origins that belong to an app in Cast List; native apps send no Origin and need none. */
function cors(req, st) {
  const o = req.headers.get('origin');
  if (!o || !st || !lookup(st.idx, o)) return {};
  return { 'access-control-allow-origin': o, 'access-control-allow-credentials': 'true', vary: 'origin' };
}

const ok1 = (req, st, outcome, extra = {}) => json({ status: 1 }, 200, { ...cors(req, st), 'x-boxoffice': outcome, ...extra });

// ---------------------------------------------------------------- relay

async function relay(req, env, ctx, url, t0) {
  const rest = url.pathname.slice('/boxoffice/e'.length) || '/';
  const isAsset = under(rest, ASSET_ROUTES);
  const st = await catalog(env, ctx);
  const done = (res, outcome, extra = {}) => {
    const ms = Date.now() - t0;
    res.headers.set('x-boxoffice', outcome);
    res.headers.set('server-timing', `edge;dur=${ms}${extra.upMs != null ? `, up;dur=${extra.upMs}` : ''}`);
    metric(env, { route: isAsset ? 'asset' : 'relay', outcome, app: extra.app, status: res.status, ms, upMs: extra.upMs ?? 0, bytes: extra.bytes ?? 0, req });
    const routine = outcome === 'forwarded' || outcome.startsWith('asset_');
    if (!routine || Math.random() < LIMITS.logSample) log({ event: 'relay', outcome, app: extra.app, path: rest, status: res.status, ms, upMs: extra.upMs });
    return res;
  };

  if (req.method === 'OPTIONS') {
    return done(new Response(null, { status: 204, headers: { ...cors(req, st), 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': req.headers.get('access-control-request-headers') || 'content-type', 'access-control-max-age': '86400' } }), 'preflight');
  }
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) return done(new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD, POST, OPTIONS' } }), 'bad_method');
  if (!under(rest, ROUTES)) return done(new Response('Not found', { status: 404 }), 'bad_path');

  if (isAsset && req.method === 'POST') return done(new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD, OPTIONS' } }), 'bad_method');
  if (isAsset) return asset(req, env, ctx, rest, url, done);

  // Kids apps never reach PostHog, whatever the page or a stale loader sends.
  const page = req.headers.get('referer') || '';
  const app = page ? lookup(st.idx, page) : null;
  if (app?.audience !== 'general') return done(ok1(req, st, page ? 'dropped_kids' : 'dropped_no_referer'), page ? 'dropped_kids' : 'dropped_no_referer', { app: app?.slug });

  const len = Number(req.headers.get('content-length') || 0);
  if (len > LIMITS.maxBodyBytes) return done(ok1(req, st, 'too_large'), 'too_large', { app: app.slug, bytes: len });

  const ip = truncateIp(req.headers.get('cf-connecting-ip'));
  if (env.RATE && ip) {
    try {
      const { success } = await env.RATE.limit({ key: ip });
      if (!success) return done(ok1(req, st, 'rate_limited'), 'rate_limited', { app: app.slug });
    } catch { /* the limiter is best effort */ }
  }

  const headers = new Headers(req.headers);
  for (const h of ['cookie', 'authorization', 'host', 'cf-connecting-ip', 'x-real-ip', 'true-client-ip', 'cf-ipcountry', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'cf-ray', 'cf-visitor', 'cdn-loop', 'cf-worker']) headers.delete(h);
  if (ip) headers.set('x-forwarded-for', ip);
  const init = { method: req.method, headers, redirect: 'manual', signal: AbortSignal.timeout(LIMITS.upstreamTimeoutMs) };
  if (req.method === 'POST') init.body = req.body;
  const u0 = Date.now();
  let res;
  try {
    res = await fetch(`https://${INGEST}${rest}${url.search}`, init);
  } catch (e) {
    const outcome = e?.name === 'TimeoutError' ? 'upstream_timeout' : 'upstream_error';
    log({ event: 'upstream_failed', ok: false, outcome, path: rest, error: String(e) });
    return done(ok1(req, st, outcome), outcome, { app: app.slug, upMs: Date.now() - u0, bytes: len });
  }
  const out = new Response(res.body, res);
  out.headers.delete('set-cookie');
  for (const [k, v] of Object.entries(cors(req, st))) out.headers.set(k, v);
  return done(out, res.ok ? 'forwarded' : `upstream_${res.status}`, { app: app.slug, upMs: Date.now() - u0, bytes: len });
}

async function asset(req, env, ctx, rest, url, done) {
  const key = `${ORIGIN}/boxoffice/e${rest}${url.search}`;
  const cache = edgeCache();
  const ttl = rest.startsWith('/array') ? 300 : 3600; // remote config changes with project settings; the bundle rarely
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) {
      const r = new Response(req.method === 'HEAD' ? null : hit.body, hit);
      for (const [k, v] of Object.entries(cors(req))) r.headers.set(k, v);
      return done(r, 'asset_hit');
    }
  }
  const u0 = Date.now();
  let res;
  try {
    res = await fetch(`https://${ASSETS}${rest}${url.search}`, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: { accept: req.headers.get('accept') || '*/*' }, signal: AbortSignal.timeout(LIMITS.upstreamTimeoutMs) });
  } catch (e) {
    log({ event: 'asset_failed', ok: false, path: rest, error: String(e) });
    return done(new Response(rest.endsWith('.js') ? '' : '{}', { status: 502, headers: { 'cache-control': 'no-store' } }), 'asset_error', { upMs: Date.now() - u0 });
  }
  const out = new Response(res.body, res);
  out.headers.delete('set-cookie');
  if (res.ok) out.headers.set('cache-control', `public, max-age=${ttl}, stale-while-revalidate=86400`);
  if (res.ok && req.method === 'GET' && cache) ctx?.waitUntil?.(cache.put(key, out.clone()).catch(() => {}));
  for (const [k, v] of Object.entries(cors(req))) out.headers.set(k, v);
  return done(out, res.ok ? 'asset_miss' : `asset_${res.status}`, { upMs: Date.now() - u0 });
}

// ---------------------------------------------------------------- loader + health

async function serveLoader(req, env, ctx, t0) {
  const st = await catalog(env, ctx);
  const ms = Date.now() - t0;
  const headers = {
    'content-type': 'text/javascript; charset=utf-8', 'cache-control': LOADER_CACHE, etag: st.etag,
    'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff',
    'server-timing': `edge;dur=${ms}, cat;desc="${st.source}"`,
  };
  const inm = req.headers.get('if-none-match');
  const fresh = inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(st.etag);
  metric(env, { route: 'loader', outcome: fresh ? 'not_modified' : 'served', status: fresh ? 304 : 200, ms, req });
  if (fresh) return new Response(null, { status: 304, headers: { ...headers, 'x-boxoffice': 'not_modified' } });
  return new Response(req.method === 'HEAD' ? null : st.js, { headers: { ...headers, 'x-boxoffice': 'served' } });
}

async function probe(url, init, via = globalThis) {
  const t = Date.now();
  try {
    const r = await (via ?? globalThis).fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
    return { ok: r.ok, status: r.status, ms: Date.now() - t };
  } catch (e) { return { ok: false, error: String(e), ms: Date.now() - t }; }
}

async function health(req, env, ctx, url, t0) {
  const st = await catalog(env, ctx);
  const body = {
    ok: st.source !== 'fallback', version: env.VERSION ?? 'dev',
    catalog: { source: st.source, age_s: Math.round((Date.now() - st.at) / 1000), etag: st.etag },
    apps: st.apps, kids: st.kids,
  };
  if (url.searchParams.has('deep')) {
    const [posthog, cast] = await Promise.all([
      probe(`https://${ASSETS}/static/array.js`, { method: 'HEAD' }),
      probe(`${ORIGIN}/cast/api/apps`, { method: 'GET', headers: { accept: 'application/json' } }, env.CAST),
    ]);
    body.upstreams = { posthog, cast };
    body.ok = body.ok && posthog.ok;
  }
  metric(env, { route: 'health', outcome: body.ok ? 'ok' : 'degraded', status: body.ok ? 200 : 503, ms: Date.now() - t0, req });
  return json(body, body.ok ? 200 : 503, { 'x-boxoffice': body.ok ? 'ok' : 'degraded', 'server-timing': `edge;dur=${Date.now() - t0}` });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const t0 = Date.now();
    try {
      if (url.pathname === '/boxoffice/v1/insights.js') return await serveLoader(req, env, ctx, t0);
      if (url.pathname === '/boxoffice/e' || url.pathname.startsWith('/boxoffice/e/')) return await relay(req, env, ctx, url, t0);
      if (url.pathname === '/boxoffice/health') return await health(req, env, ctx, url, t0);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      log({ event: 'error', ok: false, path: url.pathname, ms: Date.now() - t0, error: String(e), stack: e?.stack?.split('\n').slice(0, 3).join(' | ') });
      metric(env, { route: 'error', outcome: 'exception', status: 200, ms: Date.now() - t0, req });
      // Analytics must never break a page: the loader path degrades to a no-op script, the relay to {status:1}.
      if (url.pathname.endsWith('.js')) return new Response(NOOP_JS, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'x-boxoffice': 'error' } });
      return json({ status: 1 }, 200, { 'x-boxoffice': 'error' });
    }
  },
};
