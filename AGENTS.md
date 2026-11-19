# Box Office: operating manual

Analytics for every app at mutaafaziz.com, plus the company sites, on PostHog's free tier (US cloud,
org "mutaafaziz.com", project "Portfolio", id 732590). One Worker on `mutaafaziz.com/boxoffice/*`:

| Path | What |
|---|---|
| `/boxoffice/v1/insights.js` | The loader. Rendered once per catalog version; ETag/304; `stale-while-revalidate` for a day. |
| `/boxoffice/e/*` | First-party relay to PostHog. `/static/*`, `/array/*` → us-assets.i.posthog.com (edge-cached); `/e /i /s /flags /decide /batch /capture /engage /track /api/surveys` → us.i.posthog.com. Any other path 404, other methods 405. |
| `/boxoffice/health` | `{ok, version, catalog:{source, age_s, etag}, apps, kids}`; `?deep=1` also probes PostHog and Cast List; 503 when degraded |

## Integrating an app (one line, last in `<body>`)

```html
<script async src="/boxoffice/v1/insights.js"></script>                       <!-- on mutaafaziz.com -->
<script async src="https://mutaafaziz.com/boxoffice/v1/insights.js"></script> <!-- any other domain -->
```

The URL decides the app (longest Cast List URL prefix on the same host), so there is nothing to configure.
Optional `data-release="1.4.0"`. Custom events, safe before the script loads:

```js
(window.boxoffice ??= { q: [], track(...a) { this.q.push(a) } }).track('game_over', { score: 4200, level: 3 });
```

Event names are snake_case verbs: `game_start`, `game_over`, `level_complete`, `share`, `signup`. Every
event already carries `app`, `surface`, `platform`, `site`. `store_tap` (App Store / Play / TestFlight /
Amazon link clicks) is captured automatically.

## Policy (non-negotiable; tests enforce it)

1. **Kids apps are never tracked.** Only `audience: "general"` in Cast List is tracked. Kids, missing
   audience, or a URL no app claims → the loader is a no-op, and the relay drops the event using the
   page's Referer, so a stale or copied tag still can't send data. Never add Box Office to a kids app.
2. **No full IP reaches PostHog.** The relay forwards the client IP truncated to /24 or /48 for city-level
   location. Cookies are stripped both ways. Persistence is localStorage. Anonymous person profiles are on (needed for cohorts, retention, returning-visitor segments); nobody is ever identified by name or email.
3. **Global Privacy Control and Do Not Track are honoured** (no load at all).
4. **Session replay masks every input**, plus anything marked `data-private`.
5. **Never break a page.** Any error serves a no-op loader; the relay answers 200 on failure.
6. **Native apps: only with the owner's yes for that app, and only with its App Privacy label updated in the
   same submission.** The owner said yes for Cold Gas's iPhone app on 2026-11-13 ("iPhone app metrics too";
   this replaces the earlier "not until the App Store reviews of Nov 2026 have cleared"). How a native app
   sends, with no change here: no SDK and no loader; it POSTs PostHog's `/batch/` shape to
   `https://mutaafaziz.com/boxoffice/e/batch/` with the public key and `Referer:` its own general-audience
   Cast List page (so rule 1 decides it like any page), `platform: "ios"`, `$geoip_disable: true` (no
   location on the label). A random install id kept on the device is the only id; no IDFA, no ATT prompt, no
   fingerprinting, no replays or autocapture; batched, off the frame loop; an in-app switch turns it off. Its
   label: Usage Data → Product Interaction and Identifiers → Device ID, Analytics, linked, not tracking.
   On 2026-11-16 the owner said yes for every native app ("update the native apps too"): Hearth, Hinge Pop, 17-0 and
   Fantasy Edge follow Cold Gas's design, each from its next version after the one in review. Kids apps never (rule 1):
   Moon Club and KIN send nothing.

## Dashboards

PostHog → Dashboards: "Portfolio" (all apps) and one per app, filtered by the `app` property. Segments
are properties, not projects: filter or break down by `app`, `surface`, `$geoip_country_name`,
`$geoip_city_name`, `$device_type`, `$referring_domain`, `$initial_referring_domain`.

## Speed

The catalog lives in each isolate and refreshes from Cast List in the background after 5 minutes
(stale-while-revalidate, single flight, 2.5 s timeout). The last good copy is also kept in the colo's edge
cache, so a new isolate starts from it instead of waiting on Cast List. Only the first request in a colo
that has never seen the catalog waits. With nothing at all, the built-in kids list is used (fail closed:
nothing is tracked) and `/health` says `fallback` with a 503. `npm run bench` compares against an older
commit in-process (`node scripts/bench.mjs <ref>`); at this change: new isolate 151 ms → 0.45 ms, first
request after the 5-minute expiry 151 ms → 0.05 ms. A forwarded event costs whatever PostHog takes.

## Hardening

- Path allowlist and method allowlist (above): the relay is not an open proxy to PostHog's API.
  `authorization`, cookies and every forwarding header are stripped.
- Bodies over 10 MB (by Content-Length) are dropped. Rate limit: 600 requests a minute per truncated IP
  (`RATE` binding). Upstream timeout 15 s. All three answer 200 `{status:1}` (rule 5) with the reason in `x-boxoffice`.
- CORS is reflected only for origins that belong to an app in Cast List.

## Observability

- Every response has `x-boxoffice: <outcome>` and `server-timing: edge;dur=…, up;dur=…`. Outcomes:
  loader `served|not_modified`; relay `forwarded|dropped_kids|dropped_no_referer|too_large|rate_limited|
  upstream_timeout|upstream_error|upstream_<status>|bad_path|bad_method|preflight`; assets `asset_hit|asset_miss|asset_error`.
- Workers Logs (dashboard → Workers → box-office → Observability): one JSON line per relay/asset request
  (`event, outcome, app, path, status, ms, upMs`, no IP) plus `catalog_refresh_failed`, `upstream_failed`,
  `error` with a short stack. Kept 3 days; filter or group by any field.
- Analytics Engine dataset `box_office`: one point per request (route, outcome, app, method, country, colo,
  version | status, ms, upstream ms, bytes). No IP, no URL. `npm run metrics [hours]` prints outcomes with
  p50/p95, forwarded events by app and versions; needs `CLOUDFLARE_API_TOKEN` with Account Analytics: Read
  (wrangler's login has no analytics scope).
- `.github/workflows/monitor.yml` runs `scripts/smoke.mjs` against production every 30 minutes; a failure
  emails the owner. The smoke test sends no real events.
- `npm run deploy` stamps `VERSION` with the git sha (shown in `/health` and every metric) and runs the smoke test.

## Run

`npm run up` (dev), `npm test`, `npm run deploy` (deploy + smoke), `npm run smoke`, `npm run bench`,
`npm run metrics`. Free-plan note: every relay call is a Worker request and shares the account's 100k/day
with the other Workers; `x-boxoffice` outcomes and the metrics show which routes spend it.

## PostHog objects (project 732590)

- Dashboard "Portfolio" (2346342, pinned): visitors by app, world map, top cities, US states, referrers,
  devices, top pages, store taps, game starts vs game overs, weekly actives by surface.
- "App · <name>" dashboards (2346345–2346357): the same tiles with a dashboard filter `app = <slug>`.
  A new app: duplicate Portfolio and set that filter.
- Cohorts: Players (started a game), Store tappers, Returning visitors (3+ days in 30).
- Test-account filter drops localhost and anything with a `smoke` property (relay smoke tests).
