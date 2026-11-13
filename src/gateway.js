import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { gzip as gzipCb, gunzip as gunzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { compileRoutes, matchRoute, expandTemplate } from './router.js';
import { buildKey, normalizeQuery, varyParts } from './key.js';
import { cachePolicy } from './cache-control.js';
import { windows } from './entry.js';
import { CacheEngine } from './engine.js';
import { Stats, summarize } from './stats.js';
import { createLogger } from './log.js';
import { renderMetrics } from './metrics.js';
import { createHttpFetch } from './upstream.js';

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const INTERNAL = new Set(['x-cache-tags', 'surrogate-key', 'x-cache-invalidate']);
const NOT_STORED = new Set([...HOP, ...INTERNAL, 'content-length', 'content-encoding', 'date', 'set-cookie', 'age', 'x-cache', 'x-cache-reason']);
const COMPRESSIBLE = /json|text|xml|javascript|ecmascript|svg|csv|graphql|yaml/i;
const CACHE_METHODS = new Set(['GET', 'HEAD']);

const parseList = (v) => (v ? String(v).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 64) : []);
const cleanTag = (t) => String(t).slice(0, 200);
const parentPath = (p) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';

function etagMatches(header, etag) {
  if (!header || !etag) return false;
  if (header.trim() === '*') return true;
  const strip = (s) => s.trim().replace(/^W\//, '');
  return header.split(',').some((t) => strip(t) === strip(etag));
}

/**
 * Build the caching gateway as an Express app.
 * @param {object} cfg   effective config from loadConfig()
 * @param {object} deps  { store (required), logger, fetchImpl }
 */
export function createGateway(cfg, { store, logger = createLogger(cfg.logLevel), fetchImpl } = {}) {
  if (!store) throw new Error('createGateway: store is required');
  const ownFetch = !fetchImpl;
  fetchImpl ??= createHttpFetch();
  const routes = compileRoutes(cfg.routes, cfg.defaults);
  const catchAll = cfg.cacheUnmatched ? compileRoutes([{ name: 'default', path: '/*' }], cfg.defaults)[0] : null;
  const stats = new Stats(store, { flushMs: cfg.statsFlushMs, logger });
  const engine = new CacheEngine({ store, logger, lockMs: cfg.defaults.lockMs, lockWaitMs: cfg.defaults.lockWaitMs });
  const tokenHash = cfg.adminToken ? createHash('sha256').update(String(cfg.adminToken)).digest() : null;

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('trust proxy', cfg.trustProxy);

  // ---------------------------------------------------------------- helpers
  const upstreamBase = (route) => String(route?.upstream || cfg.upstream).replace(/\/+$/, '');
  const targetUrl = (route, url) => upstreamBase(route) + url.pathname + url.search;

  function upstreamHeaders(req, route, forCache) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP.has(k) || k === 'host' || k === 'content-length' || k === 'accept-encoding') continue;
      if (forCache && (k === 'if-none-match' || k === 'if-modified-since' || k === 'range')) continue;
      if (forCache && k === 'cookie' && route.ignoreCookies) continue;
      h[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const ip = req.ip || req.socket.remoteAddress || '';
    h['x-forwarded-for'] = req.headers['x-forwarded-for'] && cfg.trustProxy ? `${req.headers['x-forwarded-for']}, ${ip}` : ip;
    h['x-forwarded-host'] = req.headers.host ?? '';
    h['x-forwarded-proto'] = req.protocol;
    h.via = '1.1 redis-cache-gateway';
    return h;
  }

  function responseHeaders(headers) {
    const out = {};
    for (const [k, v] of headers) if (!NOT_STORED.has(k)) out[k] = v;
    return out;
  }

  async function fetchUpstream(url, init, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('upstream timeout', 'TimeoutError')), timeoutMs);
    try {
      const resp = await fetchImpl(url, { ...init, redirect: 'manual', signal: ctrl.signal });
      return { resp, done: () => clearTimeout(timer) };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  function sendUpstreamError(res, err) {
    const timeout = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError';
    if (res.headersSent) return res.destroy();
    res.status(timeout ? 504 : 502).json({
      error: timeout ? 'upstream_timeout' : 'upstream_unavailable',
      message: timeout ? 'The API did not answer in time.' : 'The API could not be reached.',
    });
  }

  async function invalidate(tags, routeName = 'invalidate') {
    const list = [...new Set(tags.filter(Boolean).map(cleanTag))];
    if (!list.length) return 0;
    try {
      const n = await store.invalidateTags(list);
      stats.add(routeName, 'invalidated', n);
      logger.debug('invalidated', { tags: list.join(','), keys: n });
      return n;
    } catch (err) {
      stats.add(routeName, 'store_errors');
      logger.warn('invalidation failed', { tags: list.join(','), error: err.message });
      return 0;
    }
  }

  function keyFor(req, url, route) {
    const query = normalizeQuery(url.searchParams, route.ignoreQuery, route.sortQuery);
    return buildKey({ pathname: url.pathname, query, vary: varyParts(req.headers, route.varyBy), scope: upstreamBase(route) });
  }

  function bypassReason(req, route) {
    const h = req.headers;
    if (h.range) return 'range';
    const vary = route.varyBy;
    if (h.authorization && !route.shareAuthenticated && !vary.includes('header:authorization')) return 'authorization';
    if (h.cookie && !route.ignoreCookies && !vary.some((v) => v.startsWith('cookie:') || v === 'header:cookie')) return 'cookie';
    return null;
  }

  /** Send a body with conditional GET (304), gzip pass-through and HEAD support. */
  async function send(req, res, { status, headers, body, gzipped = false, age, setCookie }, xcache, reason) {
    res.status(status);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (setCookie?.length) res.setHeader('set-cookie', setCookie);
    res.setHeader('x-cache', xcache);
    if (reason) res.setHeader('x-cache-reason', reason);
    if (age !== undefined) res.setHeader('age', String(age));
    if (status === 200 && headers.etag && etagMatches(req.headers['if-none-match'], headers.etag)) {
      res.status(304);
      res.removeHeader('content-type');
      return res.end();
    }
    let out = body;
    if (gzipped) {
      res.setHeader('vary', headers.vary ? `${headers.vary}, Accept-Encoding` : 'Accept-Encoding');
      if (/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) res.setHeader('content-encoding', 'gzip');
      else out = await gunzip(body);
    }
    if (status === 204 || status === 304) return res.end();
    res.setHeader('content-length', String(out.length));
    return req.method === 'HEAD' ? res.end() : res.end(out);
  }

  function serveEntry(req, res, entry, xcache, reason, route, t0, timeField = 'cache_ms') {
    const { meta, body } = entry;
    const age = Math.max(0, Math.floor((Date.now() - meta.t) / 1000));
    return send(req, res, { status: meta.s, headers: meta.h, body, gzipped: meta.z, age }, xcache, reason).then(() => {
      const ms = performance.now() - t0;
      stats.add(route.name, timeField, ms);
      stats.add(route.name, 'bytes_from_cache', body.length);
      logger.debug('request', { method: req.method, path: req.path, cache: xcache, ms: ms.toFixed(1) });
    });
  }

  /** GET the upstream for caching. Never throws: errors come back as { error }. */
  async function fetchForCache(req, url, route, params, key) {
    const headers = upstreamHeaders(req, route, true);
    const t = performance.now();
    let resp, done, body;
    try {
      ({ resp, done } = await fetchUpstream(targetUrl(route, url), { method: 'GET', headers }, route.timeoutMs));
      body = Buffer.from(await resp.arrayBuffer());
      done();
    } catch (err) {
      done?.();
      stats.add(route.name, 'upstream_errors');
      logger.warn('upstream error', { path: url.pathname, error: err.message });
      return { error: err };
    }
    stats.add(route.name, 'upstream_calls');
    stats.add(route.name, 'upstream_ms', performance.now() - t);

    const toInvalidate = parseList(resp.headers.get('x-cache-invalidate'));
    if (toInvalidate.length) await invalidate(toInvalidate, route.name);

    const out = responseHeaders(resp.headers);
    if (resp.status === 200 && !out.etag) out.etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
    const response = { status: resp.status, headers: out, body, setCookie: resp.headers.getSetCookie() };
    if (resp.status >= 500) return { response, upstreamFailed: true, reason: `status-${resp.status}` };

    const policy = cachePolicy(route, {
      status: resp.status, headers: out, setCookie: resp.headers.getSetCookie().length > 0, bodyBytes: body.length,
    });
    if (!policy.cacheable) return { response, reason: policy.reason };

    const tags = [
      ...route.tags.map((t) => expandTemplate(t, params)),
      ...parseList(resp.headers.get('x-cache-tags') ?? resp.headers.get('surrogate-key')),
      `path:${url.pathname}`,
    ].map(cleanTag);
    const zip = body.length >= route.compressMinBytes && COMPRESSIBLE.test(out['content-type'] ?? '');
    const meta = {
      s: resp.status, h: out, ...windows(Date.now(), policy.ttl, policy.swr, policy.sie),
      z: zip, tg: [...new Set(tags)], r: route.name, u: key.raw,
    };
    return { response, store: { meta, body: zip ? await gzip(body) : body } };
  }

  /** Stream a request straight through (writes, uncached routes, bypasses). */
  async function proxy(req, res, url, route, { xcache = 'BYPASS', reason, onUpstream } = {}) {
    const name = route?.name ?? 'unmatched';
    const t = performance.now();
    const hasBody = !CACHE_METHODS.has(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
    let resp, done;
    try {
      ({ resp, done } = await fetchUpstream(targetUrl(route, url), {
        method: req.method, headers: upstreamHeaders(req, route ?? {}, false), body: hasBody ? req.body : undefined,
      }, route?.timeoutMs ?? cfg.defaults.timeoutMs));
    } catch (err) {
      stats.add(name, 'upstream_errors');
      logger.warn('upstream error', { method: req.method, path: url.pathname, error: err.message });
      return sendUpstreamError(res, err);
    }
    try {
      if (onUpstream) await onUpstream(resp);
      const toInvalidate = parseList(resp.headers.get('x-cache-invalidate'));
      if (toInvalidate.length) res.setHeader('x-cache-invalidated', String(await invalidate(toInvalidate, name)));
      res.status(resp.status);
      for (const [k, v] of resp.headers) {
        if (!HOP.has(k) && !INTERNAL.has(k) && k !== 'content-length' && k !== 'content-encoding' && k !== 'set-cookie') res.setHeader(k, v);
      }
      const cookies = resp.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.setHeader('x-cache', xcache);
      if (reason) res.setHeader('x-cache-reason', reason);
      if (!resp.body || req.method === 'HEAD') { res.end(); return; }
      await pipeline(Readable.fromWeb(resp.body), res);
    } catch (err) {
      if (!res.headersSent) return sendUpstreamError(res, err);
      res.destroy(err);
    } finally {
      done();
      if (CACHE_METHODS.has(req.method)) {
        stats.add(name, 'bypass');
        stats.add(name, 'bypass_ms', performance.now() - t);
      }
    }
  }

  // ---------------------------------------------------------------- flows
  async function handleCached(req, res, url, route, params, t0) {
    const key = keyFor(req, url, route);
    res.setHeader('x-cache-key', key.id);
    let entry;
    try {
      entry = await engine.read(key.id);
    } catch (err) {
      stats.add(route.name, 'store_errors');
      logger.debug('store read failed, bypassing', { error: err.message });
      return proxy(req, res, url, route, { reason: 'store-unavailable' });
    }
    const loader = () => fetchForCache(req, url, route, params, key);

    if (entry?.state === 'fresh') {
      stats.add(route.name, 'hit');
      return serveEntry(req, res, entry, 'HIT', null, route, t0);
    }
    if (entry?.state === 'stale') {
      stats.add(route.name, 'stale');
      engine.revalidate(key.id, loader);
      return serveEntry(req, res, entry, 'STALE', 'revalidating', route, t0);
    }

    const result = await engine.load(key.id, loader);
    if (result.entry) {
      stats.add(route.name, 'coalesced');
      return serveEntry(req, res, result.entry, 'HIT', 'filled-by-peer', route, t0, 'coalesced_ms');
    }
    if ((result.error || result.upstreamFailed) && entry) {
      stats.add(route.name, 'stale_error');
      return serveEntry(req, res, entry, 'STALE', 'stale-if-error', route, t0);
    }
    if (result.error) return sendUpstreamError(res, result.error);
    // Never hand one client's uncacheable (possibly personal) response to another: waiters fetch their own.
    if (result.coalesced && !result.stored) return proxy(req, res, url, route, { xcache: 'MISS', reason: result.reason ?? 'uncacheable' });

    const coalesced = Boolean(result.coalesced);
    const ms = () => performance.now() - t0;
    await send(req, res, result.response, coalesced ? 'HIT' : 'MISS', coalesced ? 'coalesced' : result.stored ? null : result.reason ?? (result.storeError ? 'store-unavailable' : null));
    if (coalesced) { stats.add(route.name, 'coalesced'); stats.add(route.name, 'coalesced_ms', ms()); }
    else { stats.add(route.name, 'miss'); stats.add(route.name, 'miss_ms', ms()); }
  }

  async function handleWrite(req, res, url, match) {
    const route = match?.route;
    const params = match?.params ?? {};
    const auto = route?.autoInvalidatePath ?? cfg.defaults.autoInvalidatePath;
    return proxy(req, res, url, route, {
      xcache: 'BYPASS',
      reason: 'write',
      // Invalidate BEFORE the response is sent, so the client's next GET sees fresh data.
      onUpstream: async (resp) => {
        if (resp.status >= 400) return;
        const tags = route ? route.invalidates.map((t) => expandTemplate(t, params)) : [];
        if (auto) tags.push(`path:${url.pathname}`, `path:${parentPath(url.pathname)}`);
        const n = await invalidate(tags, route?.name ?? 'unmatched');
        res.setHeader('x-cache-invalidated', String(n));
      },
    });
  }

  // ---------------------------------------------------------------- admin
  const admin = express.Router();
  const requireToken = (req, res, next) => {
    if (!tokenHash) return res.status(403).json({ error: 'admin_disabled', message: 'Set adminToken / CACHE_ADMIN_TOKEN to enable.' });
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const ok = given && timingSafeEqual(createHash('sha256').update(given).digest(), tokenHash);
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
  admin.get('/health', async (req, res) => {
    let storeUp = store.isUp();
    let pingMs;
    if (storeUp) { try { pingMs = Number((await store.ping()).toFixed(2)); } catch { storeUp = false; } }
    res.json({ ok: true, store: store.kind, storeUp, pingMs, uptimeSec: Math.round(process.uptime()) });
  });
  admin.get('/metrics', (req, res) => {
    res.type('text/plain; version=0.0.4').send(renderMetrics(stats.totals, { storeUp: store.isUp(), store: store.kind }));
  });
  admin.get('/stats', requireToken, async (req, res) => {
    await stats.flush();
    try { res.json(summarize(await store.getStats())); } catch { res.json(summarize(Object.fromEntries(stats.totals))); }
  });
  admin.post('/purge', requireToken, express.json({ limit: '100kb' }), async (req, res) => {
    const { tags = [], paths = [], all = false } = req.body ?? {};
    if (all === true) {
      const n = await store.purgeAll();
      logger.info('cache purged (all)', { keys: n });
      return res.json({ purged: n });
    }
    const list = [...[].concat(tags), ...[].concat(paths).map((p) => `path:${p}`)];
    if (!list.length) return res.status(400).json({ error: 'nothing_to_purge', message: 'Send {"tags":[...]}, {"paths":[...]} or {"all":true}.' });
    res.json({ purged: await invalidate(list, 'admin') });
  });
  admin.get('/inspect', requireToken, async (req, res) => {
    const target = String(req.query.url ?? '');
    if (!target.startsWith('/')) return res.status(400).json({ error: 'pass ?url=/path?query' });
    const url = new URL(target, 'http://x');
    const route = matchRoute(routes, 'GET', url.pathname)?.route ?? catchAll;
    if (!route || route.cache === false) return res.json({ cached: false, reason: 'no caching rule for this path' });
    const key = keyFor({ headers: {} }, url, route);
    const entry = await engine.read(key.id);
    if (!entry) return res.json({ cached: false, key: key.id, raw: key.raw, route: route.name });
    const { meta, body } = entry;
    res.json({
      cached: true, state: entry.state, key: key.id, raw: key.raw, route: meta.r, status: meta.s,
      ageSec: Math.round((Date.now() - meta.t) / 1000), freshForSec: Math.max(0, Math.round((meta.f - Date.now()) / 1000)),
      keptForSec: Math.round((meta.e - Date.now()) / 1000), bytes: body.length, gzipped: meta.z, tags: meta.tg,
    });
  });

  app.use(cfg.adminPath, admin);
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // ---------------------------------------------------------------- main
  app.use(express.raw({ type: () => true, limit: cfg.maxBodyBytes }));
  app.use(async (req, res, next) => {
    const t0 = performance.now();
    try {
      const url = new URL(req.originalUrl, 'http://gateway.local');
      const match = matchRoute(routes, req.method, url.pathname);
      if (!CACHE_METHODS.has(req.method)) return await handleWrite(req, res, url, match);
      const route = match?.route ?? catchAll;
      const params = match?.params ?? {};
      if (!route) return await proxy(req, res, url, null, { reason: 'no-rule' });
      if (route.cache === false) return await proxy(req, res, url, route, { reason: 'rule-disabled' });
      const why = bypassReason(req, route);
      if (why) return await proxy(req, res, url, route, { reason: why });
      return await handleCached(req, res, url, route, params, t0);
    } catch (err) {
      next(err);
    }
  });
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    logger.error('gateway error', { error: err.message, path: req.originalUrl });
    if (res.headersSent) return res.destroy();
    res.status(500).json({ error: 'gateway_error' });
  });

  return {
    app,
    stats,
    engine,
    routes,
    invalidate,
    async close() {
      await engine.drain();
      await stats.stop();
      if (ownFetch) fetchImpl.close?.();
    },
  };
}
