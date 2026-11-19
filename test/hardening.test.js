import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { _reset, catalog, LIMITS } from '../src/worker.js';
import { compile, index, lookup, appFor } from '../src/catalog.js';

const FEED = { apps: [
  { slug: 'mutaafaziz', kind: 'site', audience: 'general', url: 'https://mutaafaziz.com/' },
  { slug: 'cold-gas', kind: 'game', audience: 'general', url: 'https://mutaafaziz.com/coldgas/' },
  { slug: 'kin', kind: 'game', audience: 'kids', url: 'https://mutaafaziz.com/kin/' },
  { slug: 'digital-craft', kind: 'company', audience: 'general', url: 'https://digitalcraftai.com/' },
] };
const req = (p, init = {}) => new Request(`https://mutaafaziz.com${p}`, init);
const general = { referer: 'https://mutaafaziz.com/coldgas/', 'cf-connecting-ip': '203.0.113.77' };

function makeEnv(over = {}) {
  const points = [];
  const cast = { calls: 0, fail: false, feed: FEED };
  return {
    points, cast,
    env: {
      CAST: { fetch: async () => { cast.calls++; if (cast.fail) throw new Error('down'); return Response.json(cast.feed); } },
      METRICS: { writeDataPoint: (p) => points.push(p) },
      VERSION: 'test',
      ...over,
    },
  };
}
let upstream;
beforeEach(() => {
  _reset();
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u, init) => new Response('{"status":1}', { headers: { 'set-cookie': 'a=1' } }));
});
afterEach(() => { delete globalThis.caches; });

describe('catalog index', () => {
  it('gives the same answer as the linear scan', () => {
    const e = compile(FEED), idx = index(e);
    for (const h of ['https://mutaafaziz.com/kin/x', 'https://www.mutaafaziz.com/coldgas', 'https://digitalcraftai.com/a', 'https://evil.example/', 'nope'])
      expect(lookup(idx, h)?.slug).toBe(appFor(e, h)?.slug);
  });
});

describe('catalog freshness', () => {
  it('serves the stale copy while it refreshes, and only once at a time', async () => {
    const { env, cast } = makeEnv();
    const t = Date.now();
    await catalog(env, null, t);
    expect(cast.calls).toBe(1);
    const waits = [];
    const ctx = { waitUntil: (p) => waits.push(p) };
    const later = t + LIMITS.catalogTtlMs + 1;
    const [a, b] = await Promise.all([catalog(env, ctx, later), catalog(env, ctx, later)]);
    expect(a.source).toBe('live');
    expect(b).toBe(a);
    await Promise.all(waits);
    expect(cast.calls).toBe(2); // single flight
  });
  it('a cold isolate uses the edge snapshot and never waits on Cast List', async () => {
    const store = new Map();
    globalThis.caches = { default: { match: async (k) => store.get(k)?.clone(), put: async (k, r) => { store.set(k, r); } } };
    const { env, cast } = makeEnv();
    await catalog(env, null); // isolate 1 fills the snapshot
    _reset();
    cast.fail = true; // Cast List is down for isolate 2
    const ctx = { waitUntil: () => {} };
    const st = await catalog(env, ctx);
    expect(st.source).toBe('snapshot');
    expect(st.apps).toContain('cold-gas');
  });
  it('with no Cast List and no snapshot, falls back to the kids list (fail closed) and reports degraded', async () => {
    const { env, cast } = makeEnv();
    cast.fail = true;
    const h = await worker.fetch(req('/boxoffice/health'), env);
    expect(h.status).toBe(503);
    const body = await h.json();
    expect(body.catalog.source).toBe('fallback');
    expect(body.kids).toContain('kin');
    const r = await worker.fetch(req('/boxoffice/e/e/', { method: 'POST', body: '{}', headers: general }), env);
    expect(r.headers.get('x-boxoffice')).toBe('dropped_kids'); // coldgas is unknown to the fallback, so it is refused
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('loader', () => {
  it('revalidates with an ETag and long stale-while-revalidate', async () => {
    const { env } = makeEnv();
    const a = await worker.fetch(req('/boxoffice/v1/insights.js'), env);
    const etag = a.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(a.headers.get('cache-control')).toContain('stale-while-revalidate');
    expect(a.headers.get('server-timing')).toMatch(/edge;dur=\d+/);
    const b = await worker.fetch(req('/boxoffice/v1/insights.js', { headers: { 'if-none-match': `W/${etag}` } }), env);
    expect(b.status).toBe(304);
    expect(await b.text()).toBe('');
  });
  it('keeps the same ETag while the catalog is unchanged', async () => {
    const { env } = makeEnv();
    const t = Date.now();
    const e1 = (await catalog(env, null, t)).etag;
    const e2 = (await catalog(env, null, t + LIMITS.catalogTtlMs + 1)).etag;
    expect(e2).toBe(e1);
  });
});

describe('relay hardening', () => {
  it('refuses paths PostHog clients never use (no open proxy)', async () => {
    const { env } = makeEnv();
    for (const p of ['/boxoffice/e/api/projects/', '/boxoffice/e/', '/boxoffice/e/admin', '/boxoffice/e/estatic', '/boxoffice/e/../health']) {
      const r = await worker.fetch(req(p, { headers: general }), env);
      if (new URL(req(p).url).pathname === '/boxoffice/health') continue; // the URL parser resolves ../ before us
      expect(r.status, p).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it('refuses other methods, and POSTs to assets', async () => {
    const { env } = makeEnv();
    expect((await worker.fetch(req('/boxoffice/e/e/', { method: 'DELETE', headers: general }), env)).status).toBe(405);
    expect((await worker.fetch(req('/boxoffice/e/static/array.js', { method: 'POST', body: 'x', headers: general }), env)).status).toBe(405);
  });
  it('drops oversized bodies with a 200 and never forwards them', async () => {
    const { env } = makeEnv();
    const r = await worker.fetch(req('/boxoffice/e/s/', { method: 'POST', body: 'x', headers: { ...general, 'content-length': String(LIMITS.maxBodyBytes + 1) } }), env);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-boxoffice')).toBe('too_large');
    expect(upstream).not.toHaveBeenCalled();
  });
  it('rate limits per truncated IP with a 200', async () => {
    const keys = [];
    const { env } = makeEnv({ RATE: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } });
    const r = await worker.fetch(req('/boxoffice/e/e/', { method: 'POST', body: '{}', headers: general }), env);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-boxoffice')).toBe('rate_limited');
    expect(keys).toEqual(['203.0.113.0']);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('strips credentials and proxy headers before PostHog', async () => {
    const { env } = makeEnv();
    let seen;
    upstream.mockImplementation(async (u, init) => { seen = init.headers; return new Response('{}'); });
    await worker.fetch(req('/boxoffice/e/i/v0/e/', { method: 'POST', body: '{}', headers: { ...general, authorization: 'Bearer phx_secret', cookie: 'c=1', 'x-forwarded-for': '1.2.3.4', forwarded: 'for=1.2.3.4' } }), env);
    expect(seen.get('authorization')).toBeNull();
    expect(seen.get('cookie')).toBeNull();
    expect(seen.get('forwarded')).toBeNull();
    expect(seen.get('x-forwarded-for')).toBe('203.0.113.0');
  });
  it('answers 200 when PostHog times out (never break a page)', async () => {
    const { env } = makeEnv();
    upstream.mockImplementation(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); });
    const r = await worker.fetch(req('/boxoffice/e/e/', { method: 'POST', body: '{}', headers: general }), env);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-boxoffice')).toBe('upstream_timeout');
  });
  it('allows CORS only for origins in Cast List', async () => {
    const { env } = makeEnv();
    const ok = await worker.fetch(req('/boxoffice/e/e/', { method: 'OPTIONS', headers: { origin: 'https://digitalcraftai.com' } }), env);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://digitalcraftai.com');
    const evil = await worker.fetch(req('/boxoffice/e/e/', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), env);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('sends remote config to the assets host and caches assets at the edge', async () => {
    const store = new Map();
    globalThis.caches = { default: { match: async (k) => store.get(k)?.clone(), put: async (k, r) => { store.set(k, r); } } };
    const { env } = makeEnv();
    const waits = [];
    const ctx = { waitUntil: (p) => waits.push(p) };
    upstream.mockImplementation(async (u) => new Response('js', { headers: { 'set-cookie': 'x=1' } }));
    const a = await worker.fetch(req('/boxoffice/e/array/phc_x/config.js'), env, ctx);
    expect(String(upstream.mock.calls[0][0])).toBe('https://us-assets.i.posthog.com/array/phc_x/config.js');
    expect(a.headers.get('x-boxoffice')).toBe('asset_miss');
    expect(a.headers.get('set-cookie')).toBeNull();
    await Promise.all(waits);
    const b = await worker.fetch(req('/boxoffice/e/array/phc_x/config.js'), env, ctx);
    expect(b.headers.get('x-boxoffice')).toBe('asset_hit');
    expect(await b.text()).toBe('js');
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe('observability', () => {
  it('writes one metric per request with the outcome and app, and no IP or URL', async () => {
    const { env, points } = makeEnv();
    await worker.fetch(req('/boxoffice/e/e/', { method: 'POST', body: '{}', headers: general }), env);
    const relay = points.find((p) => p.indexes[0] === 'relay');
    expect(relay.blobs.slice(0, 3)).toEqual(['relay', 'forwarded', 'cold-gas']);
    expect(JSON.stringify(points)).not.toMatch(/203\.0\.113|coldgas\//);
  });
  it('health reports version, catalog source and age', async () => {
    const { env } = makeEnv();
    const h = await (await worker.fetch(req('/boxoffice/health'), env)).json();
    expect(h).toMatchObject({ ok: true, version: 'test', catalog: { source: 'live' } });
    expect(h.apps).toContain('cold-gas');
  });
});
