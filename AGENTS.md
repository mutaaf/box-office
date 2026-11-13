# Box Office: operating manual

Analytics for every app at mutaafaziz.com, plus the company sites, on PostHog's free tier (US cloud,
org "mutaafaziz.com", project "Portfolio", id 732590). One Worker on `mutaafaziz.com/boxoffice/*`:

| Path | What |
|---|---|
| `/boxoffice/v1/insights.js` | The loader. Built from Cast List on each request (5 min cache). |
| `/boxoffice/e/*` | First-party relay to PostHog: `/static/*` → us-assets.i.posthog.com, everything else → us.i.posthog.com |
| `/boxoffice/health` | `{ok, apps, kids}`: which apps are tracked and which are refused |

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
   location. Cookies are stripped both ways. Persistence is localStorage, person profiles only on identify.
3. **Global Privacy Control and Do Not Track are honoured** (no load at all).
4. **Session replay masks every input**, plus anything marked `data-private`.
5. **Never break a page.** Any error serves a no-op loader; the relay answers 200 on failure.
6. Native apps: not until the App Store reviews of Nov 2026 have cleared, and only with the App Privacy
   label updated in the same submission.

## Dashboards

PostHog → Dashboards: "Portfolio" (all apps) and one per app, filtered by the `app` property. Segments
are properties, not projects: filter or break down by `app`, `surface`, `$geoip_country_name`,
`$geoip_city_name`, `$device_type`, `$referring_domain`, `$initial_referring_domain`.

## Run

`npm run up` (dev), `npm test`, `npm run deploy`. Free-plan note: every relay call is a Worker request
and shares the account's 100k/day with the other Workers.
