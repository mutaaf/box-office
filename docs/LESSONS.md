# Lessons

- The relay decides by Referer. A page served with `Referrer-Policy: no-referrer` sends none, so its events are dropped (fail closed). Use the default `strict-origin-when-cross-origin`.
