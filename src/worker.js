// Box Office: analytics for every app at mutaafaziz.com (and the company sites), on PostHog's free tier.
//   GET  /boxoffice/v1/insights.js  the loader (built from Cast List; kids apps get a no-op)
//   ANY  /boxoffice/e/*             first-party relay to PostHog (assets from /static/*, ingest otherwise)
//   GET  /boxoffice/health          {ok, apps, kids}
// Privacy: PostHog never sees a full IP. The relay forwards the visitor's IP truncated to /24 (IPv4) or
// /48 (IPv6), enough for city-level location and no more. Events whose page belongs to a kids app are dropped.
import { compile, trackable, FALLBACK } from './catalog.js';
import { loader } from './loader.js';

const INGEST = 'us.i.posthog.com';
const ASSETS = 'us-assets.i.posthog.com';
const CATALOG_TTL = 300; // seconds

let memo = { at: 0, entries: null };

export async function catalog(env, now = Date.now()) {
  if (memo.entries && now - memo.at < CATALOG_TTL * 1000) return memo.entries;
  try {
    const r = await (env.CAST ?? globalThis).fetch('https://mutaafaziz.com/cast/api/apps', { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`cast ${r.status}`);
    const entries = compile(await r.json());
    if (!entries.length) throw new Error('cast empty');
    memo = { at: now, entries };
  } catch (e) {
    log({ event: 'catalog_fallback', ok: false, error: String(e) });
    if (!memo.entries) return compile(FALLBACK);
  }
  return memo.entries;
}
export const _reset = () => { memo = { at: 0, entries: null }; };

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

const cors = (req) => {
  const o = req.headers.get('origin');
  return o ? { 'access-control-allow-origin': o, 'access-control-allow-credentials': 'true', vary: 'origin' } : {};
};

async function relay(req, env, url) {
  const rest = url.pathname.slice('/boxoffice/e'.length) || '/';
  const isAsset = rest.startsWith('/static/');
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors(req), 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': req.headers.get('access-control-request-headers') || 'content-type', 'access-control-max-age': '86400' } });
  }
  if (!isAsset) {
    // Kids apps never reach PostHog, whatever the page or a stale loader sends.
    const page = req.headers.get('referer') || '';
    if (!trackable(await catalog(env), page)) {
      log({ event: 'dropped', ok: true, reason: page ? 'not_general' : 'no_referer' });
      return new Response(JSON.stringify({ status: 1 }), { status: 200, headers: { 'content-type': 'application/json', ...cors(req) } });
    }
  }
  const target = new URL(`https://${isAsset ? ASSETS : INGEST}${rest}${url.search}`);
  const headers = new Headers(req.headers);
  for (const h of ['cookie', 'host', 'cf-connecting-ip', 'x-real-ip', 'true-client-ip', 'cf-ipcountry', 'x-forwarded-for', 'x-forwarded-proto', 'cf-ray', 'cf-visitor', 'cdn-loop']) headers.delete(h);
  const ip = truncateIp(req.headers.get('cf-connecting-ip'));
  if (ip && !isAsset) headers.set('x-forwarded-for', ip);
  const init = { method: req.method, headers, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(req.method)) init.body = req.body;
  const res = await fetch(target, isAsset ? { ...init, cf: { cacheEverything: true, cacheTtl: 3600 } } : init);
  const out = new Response(res.body, res);
  out.headers.delete('set-cookie');
  for (const [k, v] of Object.entries(cors(req))) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const t0 = Date.now();
    try {
      if (url.pathname === '/boxoffice/v1/insights.js') {
        const entries = await catalog(env);
        return new Response(loader(entries, 'https://mutaafaziz.com'), {
          headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' },
        });
      }
      if (url.pathname === '/boxoffice/e' || url.pathname.startsWith('/boxoffice/e/')) return await relay(req, env, url);
      if (url.pathname === '/boxoffice/health') {
        const e = await catalog(env);
        return Response.json({ ok: true, apps: e.filter((x) => x.audience === 'general').map((x) => x.slug), kids: e.filter((x) => x.audience !== 'general').map((x) => x.slug) });
      }
      return new Response('Not found', { status: 404 });
    } catch (e) {
      log({ event: 'error', ok: false, path: url.pathname, ms: Date.now() - t0, error: String(e) });
      // Analytics must never break a page: the loader path degrades to a no-op script.
      if (url.pathname.endsWith('.js')) return new Response('window.boxoffice=window.boxoffice||{v:1,on:false,track:function(){}};', { headers: { 'content-type': 'text/javascript' } });
      return new Response(JSON.stringify({ status: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  },
};
