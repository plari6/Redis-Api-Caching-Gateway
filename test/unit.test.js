import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePath, compileRoutes, matchRoute, expandTemplate } from '../src/router.js';
import { normalizeQuery, varyParts, buildKey, stableStringify, parseCookies } from '../src/key.js';
import { parseCacheControl, cachePolicy } from '../src/cache-control.js';
import { encodeEntry, decodeEntry, classify, windows } from '../src/entry.js';
import { summarize } from '../src/stats.js';
import { percentile, summarizeLoad, improvement } from '../src/bench.js';
import { loadConfig, validate, DEFAULTS, resolveEnv } from '../src/config.js';
import { renderMetrics } from '../src/metrics.js';

test('router: params, optional params, wildcards, trailing slash', () => {
  const routes = compileRoutes([
    { name: 'item', path: '/api/products/:id' },
    { name: 'writes', path: '/api/products/:id?', invalidates: ['products'] },
    { name: 'rest', path: '/api/orders/*' },
    { name: 'files', path: '/files/*.json' },
  ], DEFAULTS.defaults);
  assert.deepEqual(matchRoute(routes, 'GET', '/api/products/42').params, { id: '42' });
  assert.equal(matchRoute(routes, 'GET', '/api/products/42/').route.name, 'item');
  assert.equal(matchRoute(routes, 'HEAD', '/api/products/1').route.name, 'item');
  assert.equal(matchRoute(routes, 'GET', '/api/products/1/reviews'), null);
  assert.equal(matchRoute(routes, 'POST', '/api/products').route.name, 'writes');
  assert.deepEqual(matchRoute(routes, 'PUT', '/api/products/7').params, { id: '7' });
  assert.equal(matchRoute(routes, 'GET', '/api/orders/1/items').params['*'], '1/items');
  assert.equal(matchRoute(routes, 'GET', '/files/a.json').route.name, 'files');
  assert.equal(matchRoute(routes, 'GET', '/files/a.xml'), null);
  assert.equal(matchRoute(routes, 'GET', '/api/products/caf%C3%A9').params.id, 'café');
  assert.throws(() => compilePath('no-slash'));
  assert.equal(expandTemplate('product:{id}', { id: 5 }), 'product:5');
});

test('router: write routes default to POST/PUT/PATCH/DELETE', () => {
  const [r] = compileRoutes([{ path: '/x', invalidates: ['t'] }], DEFAULTS.defaults);
  assert.deepEqual(r.methods, ['POST', 'PUT', 'PATCH', 'DELETE']);
});

test('key: tracking params dropped, order ignored, vary values hashed', () => {
  const a = normalizeQuery(new URLSearchParams('b=2&a=1&utm_source=x&fbclid=y'), DEFAULTS.defaults.ignoreQuery);
  const b = normalizeQuery(new URLSearchParams('a=1&b=2'), DEFAULTS.defaults.ignoreQuery);
  assert.equal(a, b);
  assert.equal(a, 'a=1&b=2');
  const parts = varyParts({ authorization: 'Bearer secret-token', cookie: 'sid=abc; x=1' }, ['header:authorization', 'cookie:sid']);
  assert.equal(parts.length, 2);
  assert.ok(!parts.join('').includes('secret-token'));
  const k1 = buildKey({ pathname: '/a', query: 'x=1', vary: parts, scope: 'http://up' });
  const k2 = buildKey({ pathname: '/a', query: 'x=1', vary: parts, scope: 'http://other' });
  assert.notEqual(k1.id, k2.id);
  assert.match(k1.raw, /^GET \/a\?x=1 \| /);
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: 3 }] }), stableStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
  assert.deepEqual(parseCookies('a=1; b=two=2'), { a: '1', b: 'two=2' });
});

test('cache-control policy: safe defaults', () => {
  const [route] = compileRoutes([{ path: '/x' }], DEFAULTS.defaults);
  const ok = (h, extra = {}) => cachePolicy(route, { status: 200, headers: h, ...extra });
  assert.deepEqual(parseCacheControl('public, max-age=60, s-maxage="120"'), { public: true, 'max-age': '60', 's-maxage': '120' });
  assert.equal(ok({}).cacheable, true);
  assert.equal(ok({}).ttl, 60);
  assert.equal(ok({ 'cache-control': 's-maxage=120, max-age=10' }).ttl, 120);
  assert.equal(ok({ 'cache-control': 'max-age=0' }).reason, 'ttl-0');
  assert.equal(ok({ 'cache-control': 'no-store' }).reason, 'no-store');
  assert.equal(ok({ 'cache-control': 'private' }).reason, 'private');
  assert.equal(ok({}, { setCookie: true }).reason, 'set-cookie');
  assert.equal(ok({ vary: 'Accept-Language' }).reason, 'vary-accept-language');
  assert.equal(ok({ vary: 'Accept-Encoding' }).cacheable, true);
  assert.equal(ok({ vary: '*' }).reason, 'vary-*');
  assert.equal(cachePolicy(route, { status: 500, headers: {} }).reason, 'status-500');
  assert.equal(ok({}, { bodyBytes: 10 * 1024 * 1024 }).reason, 'too-large');
  const [explicit] = compileRoutes([{ path: '/x', ttl: 30, varyBy: ['header:accept-language'] }], DEFAULTS.defaults);
  assert.equal(cachePolicy(explicit, { status: 200, headers: { 'cache-control': 'max-age=999' } }).ttl, 30);
  assert.equal(cachePolicy(explicit, { status: 200, headers: { vary: 'accept-language' } }).cacheable, true);
  const [priv] = compileRoutes([{ path: '/me', private: true, varyBy: ['header:authorization'] }], DEFAULTS.defaults);
  assert.equal(cachePolicy(priv, { status: 200, headers: { 'cache-control': 'private, max-age=30' } }).ttl, 30);
});

test('entry: encode/decode round trip and time windows', () => {
  const now = 1_000_000;
  const meta = { s: 200, h: { a: 'b' }, ...windows(now, 10, 5, 60), z: false, tg: ['x'] };
  const { meta: m, body } = decodeEntry(encodeEntry(meta, Buffer.from('hello')));
  assert.deepEqual(m, meta);
  assert.equal(body.toString(), 'hello');
  assert.equal(classify(m, now + 9_000), 'fresh');
  assert.equal(classify(m, now + 12_000), 'stale');
  assert.equal(classify(m, now + 30_000), 'error');
  assert.equal(classify(m, now + 71_000), 'expired');
  assert.throws(() => decodeEntry(Buffer.from([0, 0, 0, 99, 1])));
});

test('stats summary: hit rate, avoided calls and time saved', () => {
  const s = summarize({
    'p|hit': 90, 'p|miss': 10, 'p|cache_ms': 90, 'p|miss_ms': 4000, 'p|upstream_calls': 10, 'p|upstream_ms': 4000, 'p|bypass': 5,
  });
  const r = s.routes[0];
  assert.equal(r.requests, 105);
  assert.equal(r.hitRate, 0.9);
  assert.equal(r.avgUpstreamMs, 400);
  assert.equal(r.avgCacheMs, 1);
  assert.equal(r.upstreamCallsAvoided, 90);
  assert.equal(r.savedMs, 100 * 400 - 4090);
  assert.ok(r.fasterPct > 0.89 && r.fasterPct < 0.9);
  assert.equal(s.total.requests, 105);
});

test('bench math', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(sorted, 50), 5);
  assert.equal(percentile(sorted, 95), 10);
  assert.equal(percentile([], 50), 0);
  const a = summarizeLoad([400, 400, 400], { elapsedMs: 1200 });
  const b = summarizeLoad([4, 4, 4], { elapsedMs: 12 });
  const imp = improvement(a, b);
  assert.equal(imp.p50, 0.99);
  assert.equal(Math.round(imp.throughputX), 100);
});

test('config: env references, overrides and validation', () => {
  process.env.RCG_TEST_URL = 'http://up.example';
  const missing = [];
  assert.equal(resolveEnv('env:RCG_TEST_URL', missing), 'http://up.example');
  assert.equal(resolveEnv('env:RCG_NOT_SET?', missing), undefined);
  resolveEnv('env:RCG_NOT_SET', missing);
  assert.equal(missing.length, 1);
  const { config } = loadConfig({ file: false, overrides: { upstream: 'http://x.test', store: 'memory', adminToken: 'a'.repeat(32), routes: [{ path: '/a', ttl: 5 }] } });
  assert.equal(config.defaults.ttl, 60);
  assert.equal(config.routes[0].ttl, 5);
  assert.throws(() => validate({ ...structuredClone(DEFAULTS), upstream: 'ftp://x' }), /http/);
  assert.throws(() => validate({ ...structuredClone(DEFAULTS), upstream: null }, { requireUpstream: true }), /upstream is required/);
  assert.throws(() => validate({ ...structuredClone(DEFAULTS), upstream: 'http://x', routes: [{ path: 'bad' }] }), /path/);
  assert.throws(() => validate({ ...structuredClone(DEFAULTS), upstream: 'http://x', routes: [{ path: '/a', varyBy: ['nope'] }] }), /varyBy/);
  const warnings = validate({ ...structuredClone(DEFAULTS), upstream: 'http://x', routes: [{ path: '/a', ttl: 1, shareAuthenticated: true, oops: 1 }] });
  assert.ok(warnings.some((w) => w.includes('unknown key "oops"')));
  assert.ok(warnings.some((w) => w.includes('shareAuthenticated')));
});

test('metrics: prometheus text', () => {
  const text = renderMetrics(new Map([['product|hit', 3], ['product|upstream_ms', 1500], ['product|upstream_calls', 2]]), { storeUp: true, store: 'redis' });
  assert.match(text, /rcg_requests_total\{route="product",result="hit"\} 3/);
  assert.match(text, /rcg_upstream_seconds_total\{route="product"\} 1\.5/);
  assert.match(text, /rcg_store_up\{store="redis"\} 1/);
});
