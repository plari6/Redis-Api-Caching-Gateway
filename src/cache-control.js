/** Parse a Cache-Control header into { directive: value|true }. */
export function parseCacheControl(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(',')) {
    const [k, v] = part.trim().split('=');
    if (!k) continue;
    const key = k.trim().toLowerCase();
    out[key] = v === undefined ? true : v.trim().replace(/^"|"$/g, '');
  }
  return out;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * Decide whether an upstream response may be stored, and for how long.
 * Safe by default: no-store, private, Set-Cookie, Vary on unknown headers
 * and non-listed statuses are never cached.
 */
export function cachePolicy(route, { status, headers, setCookie = false, bodyBytes = 0 }) {
  if (!route.statuses.includes(status)) return { cacheable: false, reason: `status-${status}` };
  if (setCookie) return { cacheable: false, reason: 'set-cookie' };
  if (bodyBytes > route.maxEntryBytes) return { cacheable: false, reason: 'too-large' };

  const cc = parseCacheControl(headers['cache-control']);
  if (route.respectCacheControl) {
    if (cc['no-store']) return { cacheable: false, reason: 'no-store' };
    if (cc.private && !route.private) return { cacheable: false, reason: 'private' };
    if (cc['no-cache'] && !route.explicitTtl) return { cacheable: false, reason: 'no-cache' };
  }

  const vary = String(headers.vary ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (vary.includes('*')) return { cacheable: false, reason: 'vary-*' };
  const unknownVary = vary.filter((h) => h !== 'accept-encoding' && !route.varyBy.includes(`header:${h}`));
  if (unknownVary.length) return { cacheable: false, reason: `vary-${unknownVary[0]}` };

  let ttl = route.ttl;
  if (!route.explicitTtl && route.respectCacheControl) {
    const fromHeader = num(cc['s-maxage']) ?? num(cc['max-age']);
    if (fromHeader !== undefined) ttl = fromHeader;
  }
  if (!(ttl > 0)) return { cacheable: false, reason: 'ttl-0' };

  const swr = route.staleWhileRevalidate ?? num(cc['stale-while-revalidate']) ?? 0;
  const sie = route.staleIfError ?? num(cc['stale-if-error']) ?? 0;
  return { cacheable: true, ttl, swr, sie };
}
