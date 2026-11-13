import { describe, it, expect, beforeEach, vi } from 'vitest';
import vm from 'node:vm';
import worker, { truncateIp, _reset } from '../src/worker.js';
import { compile, appFor, trackable } from '../src/catalog.js';
import { loader } from '../src/loader.js';

const FEED = {
  apps: [
    { slug: 'mutaafaziz', kind: 'site', audience: 'general', url: 'https://mutaafaziz.com/' },
    { slug: 'metaphases', kind: 'app', audience: 'general', url: 'https://mutaafaziz.com/metaphases/' },
    { slug: 'moon-club', kind: 'app', audience: 'kids', url: 'https://mutaafaziz.com/metaphases/kids/' },
    { slug: 'kin', kind: 'game', audience: 'kids', url: 'https://mutaafaziz.com/kin/' },
    { slug: 'cold-gas', kind: 'game', audience: 'general', url: 'https://mutaafaziz.com/coldgas/' },
    { slug: 'mystery', kind: 'app', url: 'https://mutaafaziz.com/mystery/' },
    { slug: 'agent-fleet', kind: 'library', audience: 'general', url: 'https://github.com/mutaaf/agent-fleet' },
    { slug: 'digital-craft', kind: 'company', audience: 'general', url: 'https://digitalcraftai.com/' },
  ],
};
const E = compile(FEED);
const env = { CAST: { fetch: async () => Response.json(FEED) } };

describe('catalog', () => {
  it('longest prefix wins, so a kids section inside a general app is kids', () => {
    expect(appFor(E, 'https://mutaafaziz.com/metaphases/kids/app').slug).toBe('moon-club');
    expect(appFor(E, 'https://mutaafaziz.com/metaphases/AAPL').slug).toBe('metaphases');
    expect(appFor(E, 'https://mutaafaziz.com/coldgas').slug).toBe('cold-gas');
    expect(appFor(E, 'https://mutaafaziz.com/').slug).toBe('mutaafaziz');
  });
  it('fails closed: kids, missing audience and unknown hosts are not trackable', () => {
    expect(trackable(E, 'https://mutaafaziz.com/kin/play')).toBe(false);
    expect(trackable(E, 'https://mutaafaziz.com/mystery/')).toBe(false);
    expect(trackable(E, 'https://evil.example/')).toBe(false);
    expect(trackable(E, '')).toBe(false);
    expect(trackable(E, 'https://www.digitalcraftai.com/')).toBe(true);
  });
  it('skips repo links', () => expect(E.find((e) => e.slug === 'agent-fleet')).toBeUndefined());
});

describe('truncateIp', () => {
  it('keeps /24 and /48 only', () => {
    expect(truncateIp('203.0.113.77')).toBe('203.0.113.0');
    expect(truncateIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1::');
    expect(truncateIp('2001:db8::1')).toBe('2001:db8::');
    expect(truncateIp('')).toBe('');
  });
});

function runLoader(href, { gpc = false, dataset = {} } = {}) {
  const u = new URL(href);
  const appended = [];
  const listeners = [];
  const el = () => ({ dataset: {}, setAttribute() {} });
  const window = { doNotTrack: null };
  const ctx = {
    window, location: { hostname: u.hostname, pathname: u.pathname },
    navigator: { globalPrivacyControl: gpc, doNotTrack: null },
    document: {
      currentScript: { dataset }, head: { appendChild: (x) => appended.push(x) },
      createElement: el, addEventListener: (...a) => listeners.push(a),
    },
  };
  vm.runInNewContext(loader(E, 'https://mutaafaziz.com'), ctx);
  return { window, appended, listeners };
}

describe('loader', () => {
  it('tracks a general app, tagged with its segment', () => {
    const { window, appended } = runLoader('https://mutaafaziz.com/coldgas/');
    expect(window.boxoffice.on).toBe(true);
    expect(window.boxoffice.app).toBe('cold-gas');
    expect(appended[0].src).toBe('https://mutaafaziz.com/boxoffice/e/static/array.js');
    const reg = window.posthog.filter((c) => c[0] === 'register').map((c) => c[1]);
    expect(reg[0]).toMatchObject({ app: 'cold-gas', surface: 'game', platform: 'web' });
  });
  it('never loads PostHog on a kids page, even when the page claims another app', () => {
    for (const href of ['https://mutaafaziz.com/kin/', 'https://mutaafaziz.com/metaphases/kids/app']) {
      const { window, appended } = runLoader(href, { dataset: { app: 'metaphases' } });
      expect(window.boxoffice.on).toBe(false);
      expect(window.posthog).toBeUndefined();
      expect(appended).toHaveLength(0);
    }
  });
  it('honours Global Privacy Control', () => {
    const { window, appended } = runLoader('https://mutaafaziz.com/coldgas/', { gpc: true });
    expect(window.boxoffice.on).toBe(false);
    expect(appended).toHaveLength(0);
  });
});

describe('relay', () => {
  beforeEach(() => { _reset(); vi.restoreAllMocks(); });
  const req = (path, init = {}) => new Request(`https://mutaafaziz.com${path}`, init);

  it('drops events from kids pages without calling PostHog', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    const r = await worker.fetch(req('/boxoffice/e/e/', { method: 'POST', body: '{}', headers: { referer: 'https://mutaafaziz.com/kin/', 'cf-connecting-ip': '203.0.113.77' } }), env);
    expect(r.status).toBe(200);
    expect(f).not.toHaveBeenCalled();
  });
  it('forwards general events with a truncated IP and no cookies', async () => {
    let seen;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u, init) => { seen = { u: String(u), h: init.headers }; return new Response('{"status":1}', { headers: { 'set-cookie': 'x=1' } }); });
    const r = await worker.fetch(req('/boxoffice/e/e/?compression=gzip-js', { method: 'POST', body: 'x', headers: { referer: 'https://mutaafaziz.com/coldgas/', 'cf-connecting-ip': '203.0.113.77', cookie: 'secret=1', origin: 'https://mutaafaziz.com' } }), env);
    expect(seen.u).toBe('https://us.i.posthog.com/e/?compression=gzip-js');
    expect(seen.h.get('x-forwarded-for')).toBe('203.0.113.0');
    expect(seen.h.get('cookie')).toBeNull();
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('access-control-allow-origin')).toBe('https://mutaafaziz.com');
  });
  it('serves assets from the assets host', async () => {
    let seen;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => { seen = String(u); return new Response('js'); });
    await worker.fetch(req('/boxoffice/e/static/array.js'), env);
    expect(seen).toBe('https://us-assets.i.posthog.com/static/array.js');
  });
  it('serves the loader and a health report', async () => {
    const js = await worker.fetch(req('/boxoffice/v1/insights.js'), env);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    const h = await (await worker.fetch(req('/boxoffice/health'), env)).json();
    expect(h.kids).toEqual(expect.arrayContaining(['kin', 'moon-club', 'mystery']));
    expect(h.apps).toContain('cold-gas');
  });
});
