// Box Office metrics from Workers Analytics Engine (dataset box_office), last N hours (default 24).
//   CLOUDFLARE_API_TOKEN=<token with Account Analytics: Read> node scripts/metrics.mjs [hours]
// Wrangler's OAuth login has no analytics scope, so a token is needed. Without one, use the Cloudflare
// dashboard: Workers → box-office → Observability (every request logs one JSON line with outcome/app/ms).
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || 'a38c5a156e655c95ac1d46aa8914b2fd';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const hours = Number(process.argv[2] || 24);
if (!TOKEN) { console.error('Set CLOUDFLARE_API_TOKEN (Account Analytics: Read). See the header of this file.'); process.exit(2); }

async function sql(q) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: q });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json()).data;
}
const since = `timestamp > NOW() - INTERVAL '${hours}' HOUR`;
// Columns: blob1 route, blob2 outcome, blob3 app, blob4 method, blob5 country, blob6 colo, blob7 version;
// double1 status, double2 ms, double3 upstream ms, double4 bytes. _sample_interval corrects for sampling.
const byOutcome = await sql(`SELECT blob1 AS route, blob2 AS outcome, SUM(_sample_interval) AS n,
  quantileWeighted(0.5)(double2, _sample_interval) AS p50, quantileWeighted(0.95)(double2, _sample_interval) AS p95,
  quantileWeighted(0.95)(double3, _sample_interval) AS up_p95
  FROM box_office WHERE ${since} GROUP BY route, outcome ORDER BY n DESC`);
const byApp = await sql(`SELECT blob3 AS app, SUM(_sample_interval) AS n FROM box_office
  WHERE ${since} AND blob1 = 'relay' AND blob2 = 'forwarded' GROUP BY app ORDER BY n DESC LIMIT 20`);
const versions = await sql(`SELECT blob7 AS version, SUM(_sample_interval) AS n, MAX(timestamp) AS last FROM box_office WHERE ${since} GROUP BY version ORDER BY last DESC`);

console.log(`Box Office, last ${hours} h\n`);
console.table(byOutcome.map((r) => ({ route: r.route, outcome: r.outcome, requests: Math.round(r.n), 'p50 ms': Math.round(r.p50), 'p95 ms': Math.round(r.p95), 'upstream p95 ms': Math.round(r.up_p95) })));
console.log('\nForwarded events by app');
console.table(byApp.map((r) => ({ app: r.app || '(none)', requests: Math.round(r.n) })));
console.log('\nVersions seen');
console.table(versions);
