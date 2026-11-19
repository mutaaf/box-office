// Post-deploy smoke test against the live Worker. Sends no real events: the only POST uses a kids
// Referer, which the relay must drop before PostHog. Exit 1 on any failure.
const BASE = process.env.BOX_OFFICE_BASE || 'https://mutaafaziz.com/boxoffice';
const fails = [];
const check = (name, cond, detail = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`); if (!cond) fails.push(name); };
const timing = (r) => r.headers.get('server-timing') || '';

const h = await fetch(`${BASE}/health?deep=1`);
const hb = await h.json();
check('health ok', h.status === 200 && hb.ok, `version ${hb.version}, catalog ${hb.catalog?.source} ${hb.catalog?.age_s}s, posthog ${hb.upstreams?.posthog?.ms}ms`);
check('kids listed as refused', ['kin', 'moon-club'].every((k) => hb.kids?.includes(k)));

const l = await fetch(`${BASE}/v1/insights.js`);
const etag = l.headers.get('etag');
const js = await l.text();
check('loader served', l.status === 200 && js.includes('Kids apps are never tracked') && !!etag, timing(l));
const l2 = await fetch(`${BASE}/v1/insights.js`, { headers: { 'if-none-match': etag } });
check('loader revalidates with 304', l2.status === 304, timing(l2));

const kids = await fetch(`${BASE}/e/e/`, { method: 'POST', body: '{"smoke":true}', headers: { referer: 'https://mutaafaziz.com/kin/', 'content-type': 'application/json' } });
check('kids event dropped', kids.status === 200 && kids.headers.get('x-boxoffice') === 'dropped_kids');
const none = await fetch(`${BASE}/e/e/`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' }, referrerPolicy: 'no-referrer' });
check('no-referer event dropped', none.headers.get('x-boxoffice') === 'dropped_no_referer');
const bad = await fetch(`${BASE}/e/api/projects/`, { headers: { referer: 'https://mutaafaziz.com/coldgas/' } });
check('non-PostHog path refused', bad.status === 404 && bad.headers.get('x-boxoffice') === 'bad_path');
const del = await fetch(`${BASE}/e/e/`, { method: 'DELETE', headers: { referer: 'https://mutaafaziz.com/coldgas/' } });
check('DELETE refused', del.status === 405);

const a1 = await fetch(`${BASE}/e/static/array.js`); await a1.arrayBuffer();
let a2;
for (let i = 0; i < 5; i++) { // the first fetch fills the cache in the background
  await new Promise((r) => setTimeout(r, 500));
  a2 = await fetch(`${BASE}/e/static/array.js`); await a2.arrayBuffer();
  if (a2.headers.get('x-boxoffice') === 'asset_hit') break;
}
check('asset served from edge cache', a2.status === 200 && a2.headers.get('x-boxoffice') === 'asset_hit', `${a1.headers.get('x-boxoffice')} → ${a2.headers.get('x-boxoffice')}, ${timing(a2)}`);

if (fails.length) { console.error(`\n${fails.length} smoke check(s) failed`); process.exit(1); }
console.log('\nsmoke: all good');
