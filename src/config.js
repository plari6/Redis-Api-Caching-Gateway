import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'gateway.config.json';

export const DEFAULTS = Object.freeze({
  upstream: null,
  port: 8080,
  host: '0.0.0.0',
  store: 'auto',
  redis: { url: null, prefix: 'rcg', commandTimeoutMs: 1000, connectTimeoutMs: 3000 },
  memory: { maxBytes: 128 * 1024 * 1024 },
  adminPath: '/__cache',
  adminToken: null,
  trustProxy: false,
  cacheUnmatched: false,
  maxBodyBytes: '10mb',
  statsFlushMs: 2000,
  logLevel: 'info',
  defaults: {
    methods: ['GET', 'HEAD'],
    ttl: 60,
    staleWhileRevalidate: 30,
    staleIfError: 600,
    statuses: [200, 203, 204, 300, 301, 308, 404, 410],
    ignoreQuery: ['utm_*', 'fbclid', 'gclid', 'msclkid', '_'],
    sortQuery: true,
    varyBy: [],
    maxEntryBytes: 5 * 1024 * 1024,
    compressMinBytes: 1024,
    respectCacheControl: true,
    timeoutMs: 15_000,
    lockMs: 15_000,
    lockWaitMs: 10_000,
    autoInvalidatePath: true,
    private: false,
    shareAuthenticated: false,
    ignoreCookies: false,
  },
  routes: [],
});

const ROUTE_KEYS = new Set([
  'name', 'path', 'methods', 'cache', 'ttl', 'staleWhileRevalidate', 'staleIfError', 'statuses', 'ignoreQuery',
  'sortQuery', 'varyBy', 'maxEntryBytes', 'compressMinBytes', 'respectCacheControl', 'timeoutMs', 'tags',
  'invalidates', 'private', 'shareAuthenticated', 'ignoreCookies', 'upstream', 'autoInvalidatePath', 'lockMs', 'lockWaitMs',
]);

/** "env:NAME" (required) or "env:NAME?" (optional) -> process.env value. */
export function resolveEnv(value, missing = [], where = '') {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const optional = value.endsWith('?');
    const name = value.slice(4, optional ? -1 : undefined);
    const v = process.env[name];
    if ((v === undefined || v === '') && !optional) missing.push(`${name} (${where || 'config'})`);
    return v === '' ? undefined : v;
  }
  if (Array.isArray(value)) return value.map((v, i) => resolveEnv(v, missing, `${where}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnv(v, missing, where ? `${where}.${k}` : k)]));
  }
  return value;
}

/** Deep-merge plain objects (arrays replace). */
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

/**
 * Build the effective config: defaults <- file <- env vars <- explicit overrides.
 * Returns { config, warnings, file }. Throws on invalid config.
 */
export function loadConfig({ file, overrides = {}, requireUpstream = false } = {}) {
  let raw = {};
  let used = null;
  const candidate = file ?? (fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : null);
  if (candidate) {
    used = path.resolve(candidate);
    try {
      raw = JSON.parse(fs.readFileSync(used, 'utf8'));
    } catch (err) {
      throw new Error(`cannot read ${used}: ${err.message}`);
    }
  }
  const missing = [];
  const fromFile = resolveEnv(raw, missing);
  const env = process.env;
  const fromEnv = {
    upstream: env.UPSTREAM_URL || undefined,
    port: env.PORT ? Number(env.PORT) : undefined,
    adminToken: env.CACHE_ADMIN_TOKEN || undefined,
    logLevel: env.LOG_LEVEL || undefined,
    redis: { url: env.REDIS_URL || undefined, prefix: env.CACHE_PREFIX || undefined },
  };
  const config = merge(merge(merge(structuredClone(DEFAULTS), fromFile), fromEnv), overrides);
  const warnings = validate(config, { requireUpstream });
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`);
  return { config, warnings, file: used };
}

export function validate(cfg, { requireUpstream = false } = {}) {
  const errors = [];
  const warnings = [];
  if (cfg.upstream) {
    try {
      const u = new URL(cfg.upstream);
      if (!/^https?:$/.test(u.protocol)) errors.push('upstream must be an http(s) URL');
    } catch { errors.push(`upstream is not a valid URL: ${cfg.upstream}`); }
  } else if (requireUpstream) {
    errors.push('upstream is required (set "upstream" in gateway.config.json, UPSTREAM_URL, or --upstream)');
  }
  if (!['auto', 'redis', 'memory'].includes(cfg.store)) errors.push(`store must be auto, redis or memory (got ${cfg.store})`);
  if (cfg.store === 'redis' && !cfg.redis?.url) errors.push('store "redis" needs redis.url or REDIS_URL');
  if (!Number.isInteger(Number(cfg.port)) || cfg.port < 0 || cfg.port > 65535) errors.push(`invalid port ${cfg.port}`);
  if (!String(cfg.adminPath).startsWith('/')) errors.push('adminPath must start with "/"');
  if (cfg.trustProxy === true) warnings.push('trustProxy: true trusts any X-Forwarded-For; use a hop count such as 1');
  if (!cfg.adminToken) warnings.push('no adminToken: purge/stats/inspect HTTP endpoints are disabled (CLI still works)');
  else if (String(cfg.adminToken).length < 24) warnings.push('adminToken is short; use 32+ random characters');
  if ((cfg.store === 'memory' || (cfg.store === 'auto' && !cfg.redis?.url))) {
    warnings.push('no Redis configured: using in-process memory cache (not shared between instances, lost on restart)');
  }
  if (!Array.isArray(cfg.routes)) errors.push('routes must be an array');
  const names = new Set();
  for (const [i, r] of (cfg.routes ?? []).entries()) {
    const where = `routes[${i}]${r?.name ? ` (${r.name})` : ''}`;
    if (!r || typeof r.path !== 'string' || !r.path.startsWith('/')) { errors.push(`${where}: path must start with "/"`); continue; }
    for (const k of Object.keys(r)) if (!ROUTE_KEYS.has(k)) warnings.push(`${where}: unknown key "${k}"`);
    if (r.name) { if (names.has(r.name)) warnings.push(`${where}: duplicate name`); names.add(r.name); }
    if (r.ttl !== undefined && !(Number(r.ttl) >= 0)) errors.push(`${where}: ttl must be >= 0 seconds`);
    for (const v of r.varyBy ?? []) if (!/^(header|cookie):.+/i.test(v)) errors.push(`${where}: varyBy "${v}" must be header:<name> or cookie:<name>`);
    if (r.shareAuthenticated) warnings.push(`${where}: shareAuthenticated serves one cached response to every logged-in user - only for data that is identical for all users`);
    if (r.upstream) { try { new URL(r.upstream); } catch { errors.push(`${where}: upstream is not a valid URL`); } }
  }
  if (errors.length) {
    const err = new Error(`invalid config:\n  - ${errors.join('\n  - ')}`);
    err.errors = errors;
    throw err;
  }
  return warnings;
}

/** Starter config written by `rcg init`. */
export function starterConfig(upstream = 'http://localhost:4000') {
  return {
    upstream,
    port: 8080,
    store: 'auto',
    redis: { url: 'env:REDIS_URL?', prefix: 'rcg' },
    adminToken: 'env:CACHE_ADMIN_TOKEN?',
    trustProxy: false,
    cacheUnmatched: false,
    defaults: { ttl: 60, staleWhileRevalidate: 30, staleIfError: 600 },
    routes: [
      { name: 'products-list', path: '/api/products', ttl: 120, tags: ['products'] },
      { name: 'product', path: '/api/products/:id', ttl: 300, tags: ['product:{id}'] },
      { name: 'product-writes', path: '/api/products/:id?', methods: ['POST', 'PUT', 'PATCH', 'DELETE'], invalidates: ['products', 'product:{id}'] },
      { name: 'sales-report', path: '/api/reports/*', ttl: 900, staleWhileRevalidate: 300, tags: ['reports'] },
      { name: 'my-profile', path: '/api/me', ttl: 30, private: true, varyBy: ['header:authorization'] },
      { name: 'no-cache-orders', path: '/api/orders/*', cache: false },
    ],
  };
}
