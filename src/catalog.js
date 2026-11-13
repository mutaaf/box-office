// Cast List → the facts the loader and the relay need: which URL prefix belongs to which app, and
// whether that app is for everyone. Only `audience: "general"` apps are ever tracked. A kids app, an
// app with no audience, or a URL no app claims is never tracked (fail closed).

export const FALLBACK = {
  // Used only if Cast List can't be reached at all. Kids prefixes are listed so the relay still drops them.
  apps: [
    { slug: 'openaero', kind: 'game', audience: 'kids', url: 'https://mutaafaziz.com/openaero/' },
    { slug: 'outatime', kind: 'game', audience: 'kids', url: 'https://mutaafaziz.com/outatime/' },
    { slug: 'kin', kind: 'game', audience: 'kids', url: 'https://mutaafaziz.com/kin/' },
    { slug: 'moon-club', kind: 'app', audience: 'kids', url: 'https://mutaafaziz.com/metaphases/kids/' },
  ],
};

/** Normalise Cast List's feed into [{slug, kind, audience, host, path}], longest path first. */
export function compile(feed) {
  const out = [];
  for (const a of feed?.apps ?? []) {
    if (!a?.slug || !a.url || a.status === 'retired') continue;
    let u;
    try { u = new URL(a.url); } catch { continue; }
    if (u.hostname === 'github.com') continue; // a repo, not a surface
    out.push({
      slug: String(a.slug),
      kind: String(a.kind || 'app'),
      audience: a.audience === 'general' ? 'general' : 'kids', // anything unknown is treated as kids
      host: u.hostname.replace(/^www\./, ''),
      path: u.pathname.endsWith('/') ? u.pathname : u.pathname + '/',
    });
  }
  return out.sort((x, y) => y.path.length - x.path.length);
}

/** The app that owns a URL: same host, longest matching path prefix. Root ("/") matches last. */
export function appFor(entries, href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname.endsWith('/') ? u.pathname : u.pathname + '/';
  return entries.find((e) => e.host === host && path.startsWith(e.path)) ?? null;
}

/** True only when the URL belongs to a general-audience app. */
export function trackable(entries, href) {
  return appFor(entries, href)?.audience === 'general';
}
