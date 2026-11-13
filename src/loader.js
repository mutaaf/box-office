// The browser loader served at /boxoffice/v1/insights.js. Built per request from the compiled catalog
// so a new app in Cast List is tracked (or, if kids, refused) without touching this file.

export const TOKEN = 'phc_pj2w4pWnPNUNK5hZK5TX35tNRFa9skJQrGmZNbHVHr9m'; // PostHog public ingest key (write-only, made for browsers)

export function loader(entries, origin) {
  const cat = JSON.stringify(entries.map((e) => [e.host, e.path, e.slug, e.kind, e.audience]));
  return `/* Box Office: one analytics loader for every app (github.com/mutaaf/box-office). Kids apps are never tracked. */
(function () {
  if (window.boxoffice && window.boxoffice.v) return;
  var q = (window.boxoffice && window.boxoffice.q) || [];
  var noop = { v: 1, on: false, track: function () {}, q: q };
  window.boxoffice = noop;
  try {
    var s = document.currentScript, d = (s && s.dataset) || {};
    if (navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
    var host = location.hostname.replace(/^www\\./, ''), path = location.pathname.replace(/\\/?$/, '/');
    var cat = ${cat}, app = null, i;
    for (i = 0; i < cat.length; i++) if (cat[i][0] === host && path.indexOf(cat[i][1]) === 0) { app = cat[i]; break; }
    if (!app || app[4] !== 'general') return;           // the URL decides, never data-app: unknown or kids is never tracked
    var api = '${origin}/boxoffice/e';
    var ph = window.posthog = window.posthog || [];
    if (!ph.__SV) {
      ph._i = []; ph.__SV = 1;
      ph.init = function (token, cfg, name) {
        var t = ph, m = 'capture identify alias register register_once unregister reset opt_out_capturing opt_in_capturing set_config group getFeatureFlag isFeatureEnabled onFeatureFlags'.split(' ');
        function stub(o, k) { o[k] = function () { o.push([k].concat([].slice.call(arguments))); }; }
        for (var j = 0; j < m.length; j++) stub(t, m[j]);
        t._i.push([token, cfg, name]);
        var el = document.createElement('script');
        el.async = true; el.crossOrigin = 'anonymous'; el.src = api + '/static/array.js';
        (document.head || document.documentElement).appendChild(el);
      };
    }
    var props = { app: app[2], surface: app[3], audience: 'general', platform: 'web', site: host };
    if (d.release) props.release = d.release;
    ph.init('${TOKEN}', {
      api_host: api, ui_host: 'https://us.posthog.com',
      person_profiles: 'always', persistence: 'localStorage',
      capture_pageview: 'history_change', capture_pageleave: true,
      autocapture: true, enable_heatmaps: true, capture_performance: true,
      session_recording: { maskAllInputs: true, maskTextSelector: '[data-private]' },
      mask_all_element_attributes: false,
      loaded: function (p) { p.register(props); }
    });
    ph.register(props);
    function store(href) {
      return /apps\\.apple\\.com/.test(href) ? 'app_store' : /play\\.google\\.com/.test(href) ? 'google_play'
        : /testflight\\.apple\\.com/.test(href) ? 'testflight' : /amazon\\.com\\/.*(dp|gp\\/mas)/.test(href) ? 'amazon' : '';
    }
    document.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
      if (!a) return;
      var st = store(a.href);
      if (st) ph.capture('store_tap', { store: st, href: a.href });
    }, true);
    var api2 = { v: 1, on: true, app: app[2], track: function (e, p) { ph.capture(e, p || {}); } };
    window.boxoffice = api2;
    for (i = 0; i < q.length; i++) api2.track.apply(null, q[i]);
  } catch (e) { window.boxoffice = noop; }
})();
`;
}
