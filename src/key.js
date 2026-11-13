import { createHash } from 'node:crypto';

const globCache = new Map();
function globToRegex(glob) {
  let re = globCache.get(glob);
  if (!re) {
    re = new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
    globCache.set(glob, re);
  }
  return re;
}

export const shortHash = (v, len = 16) => createHash('sha256').update(String(v)).digest('base64url').slice(0, len);

/**
 * Drop tracking params (utm_*, fbclid...) and sort the rest so
 * `?b=2&a=1&utm_source=x` and `?a=1&b=2` share one cache entry.
 */
export function normalizeQuery(searchParams, ignore = [], sort = true) {
  const patterns = ignore.map(globToRegex);
  const pairs = [...searchParams].filter(([k]) => !patterns.some((re) => re.test(k)));
  if (sort) {
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  }
  return new URLSearchParams(pairs).toString();
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Values of the `varyBy` specs (header:x, cookie:x) for this request.
 * Secrets such as tokens are hashed so they never appear in keys or logs.
 */
export function varyParts(headers, varyBy = []) {
  const parts = [];
  let cookies;
  for (const spec of varyBy) {
    const [kind, ...rest] = spec.split(':');
    const name = rest.join(':').toLowerCase();
    let value;
    if (kind === 'header') value = headers[name];
    else if (kind === 'cookie') value = (cookies ??= parseCookies(headers.cookie))[name] ?? (cookies[rest.join(':')]);
    else continue;
    if (Array.isArray(value)) value = value.join(',');
    parts.push(`${spec}=${value ? shortHash(value) : '-'}`);
  }
  return parts;
}

/**
 * Cache key. HEAD shares the GET entry. `scope` (upstream origin) keeps
 * two upstreams from colliding in one Redis.
 */
export function buildKey({ pathname, query = '', vary = [], scope = '' }) {
  const raw = `GET ${pathname}${query ? '?' + query : ''}${vary.length ? ' | ' + vary.join(' ') : ''}`;
  return { raw, id: 'g_' + shortHash(scope + '\n' + raw, 32) };
}

/** Deterministic JSON for library keys: object key order does not matter. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  return '{' + Object.keys(value).sort().filter((k) => value[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}
