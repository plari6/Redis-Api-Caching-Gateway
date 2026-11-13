import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { startMockApi } from '../src/mock-api.js';
import { MemoryStore } from '../src/store/memory.js';
import { startGw, startUpstream, json, rawGet, get, sleep, TOKEN } from './helpers.js';

describe('gateway against the slow mock API', () => {
  let api, gw, url;
  before(async () => {
    api = await startMockApi({ latencyMs: 40, jitter: 0 });
    ({ gw, url } = await startGw(api.url));
  });
  after(async () => { await gw.close(); await api.close(); });

  test('MISS then HIT with the identical body, Age and key headers', async () => {
    const a = await get(`${url}/api/products/1`);
    const b = await get(`${url}/api/products/1`);
    assert.equal(a.status, 200);
    assert.equal(a.xcache, 'MISS');
    assert.equal(b.xcache, 'HIT');
    assert.deepEqual(a.body, b.body);
    assert.ok(b.headers.get('age') !== null);
    assert.match(b.headers.get('x-cache-key'), /^g_/);
    assert.equal(api.calls('GET /api/products/1'), 1);
  });

  test('tracking params and param order share one entry', async () => {
    await get(`${url}/api/products?limit=5&b=1`);
    const r = await get(`${url}/api/products?b=1&utm_source=newsletter&limit=5&fbclid=x`);
    assert.equal(r.xcache, 'HIT');
    const other = await get(`${url}/api/products?limit=6&b=1`);
    assert.equal(other.xcache, 'MISS');
  });

  test('large JSON stored gzipped: gzip clients get it compressed, others plain', async () => {
    await get(`${url}/api/products`);
    const zipped = await rawGet(`${url}/api/products`, { 'accept-encoding': 'gzip, br' });
    assert.equal(zipped.headers['x-cache'], 'HIT');
    assert.equal(zipped.headers['content-encoding'], 'gzip');
    assert.match(zipped.headers.vary, /Accept-Encoding/);
    const plain = await rawGet(`${url}/api/products`);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(gunzipSync(zipped.body)), JSON.parse(plain.body));
    assert.equal(Number(plain.headers['content-length']), plain.body.length);
  });

  test('ETag: If-None-Match returns 304 from cache', async () => {
    const first = await get(`${url}/api/products/2`);
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const r = await rawGet(`${url}/api/products/2`, { 'if-none-match': etag });
    assert.equal(r.status, 304);
    assert.equal(r.body.length, 0);
    const changed = await rawGet(`${url}/api/products/2`, { 'if-none-match': '"other"' });
    assert.equal(changed.status, 200);
  });

  test('HEAD is answered from the GET entry without a body', async () => {
    await get(`${url}/api/products/3`);
    const r = await rawGet(`${url}/api/products/3`, {}, 'HEAD');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-cache'], 'HIT');
    assert.equal(r.body.length, 0);
  });

  test('Authorization on a shared route bypasses; varyBy route caches per user', async () => {
    const r = await get(`${url}/api/products/4`, { authorization: 'Bearer x' });
    assert.equal(r.xcache, 'BYPASS');
    assert.equal(r.reason, 'authorization');
    const cookie = await get(`${url}/api/products/4`, { cookie: 'sid=1' });
    assert.equal(cookie.reason, 'cookie');

    const a1 = await get(`${url}/api/me`, { authorization: 'Bearer alice' });
    const b1 = await get(`${url}/api/me`, { authorization: 'Bearer bob' });
    const a2 = await get(`${url}/api/me`, { authorization: 'Bearer alice' });
    const b2 = await get(`${url}/api/me`, { authorization: 'Bearer bob' });
    assert.equal(a1.xcache, 'MISS');
    assert.equal(b1.xcache, 'MISS');
    assert.equal(a2.xcache, 'HIT');
    assert.equal(b2.xcache, 'HIT');
    assert.equal(a2.body.user, 'alice');
    assert.equal(b2.body.user, 'bob');
  });

  test('404 is cached (configurable), disabled and unmatched routes pass through', async () => {
    await get(`${url}/api/products/999`);
    const nf = await get(`${url}/api/products/999`);
    assert.equal(nf.status, 404);
    assert.equal(nf.xcache, 'HIT');
    const orders = await get(`${url}/api/orders/1`);
    assert.equal(orders.xcache, 'BYPASS');
    assert.equal(orders.reason, 'rule-disabled');
    const inv = await get(`${url}/api/inventory`);
    assert.equal(inv.xcache, 'BYPASS');
    assert.equal(inv.reason, 'no-rule');
  });

  test('a write is forwarded with its body and invalidates exactly the item + list', async () => {
    await get(`${url}/api/products/10`);
    await get(`${url}/api/products/11`);
    await get(`${url}/api/products?limit=50`);
    const put = await fetch(`${url}/api/products/10`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ price: 5 }) });
    const updated = await put.json();
    assert.equal(put.status, 200);
    assert.equal(updated.price, 5);
    assert.ok(Number(put.headers.get('x-cache-invalidated')) >= 2);
    const item = await get(`${url}/api/products/10`);
    assert.equal(item.xcache, 'MISS');
    assert.equal(item.body.price, 5);
    const list = await get(`${url}/api/products?limit=50`);
    assert.equal(list.xcache, 'MISS');
    assert.equal(list.body.items[9].price, 5);
    const untouched = await get(`${url}/api/products/11`);
    assert.equal(untouched.xcache, 'HIT', 'other items stay cached');
  });

  test('failed writes do not invalidate', async () => {
    await get(`${url}/api/products/12`);
    const r = await fetch(`${url}/api/products/12345`, { method: 'PUT', body: '{}' });
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('x-cache-invalidated'), null);
    assert.equal((await get(`${url}/api/products/12`)).xcache, 'HIT');
  });

  test('50 concurrent cold requests make one upstream call', async () => {
    api.resetCalls();
    const all = await Promise.all(Array.from({ length: 50 }, () => get(`${url}/api/reports/sales?period=7d`)));
    assert.equal(api.calls('GET /api/reports/sales'), 1);
    assert.ok(all.every((r) => r.status === 200 && r.body.period === '7d'));
    assert.equal(all.filter((r) => r.xcache === 'MISS').length, 1);
  });

  test('admin: health/metrics open; stats, purge, inspect need the token', async () => {
    const health = await get(`${url}/__cache/health`);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.store, 'memory');
    const metrics = await fetch(`${url}/__cache/metrics`).then((r) => r.text());
    assert.match(metrics, /rcg_requests_total\{route="product",result="hit"\}/);

    assert.equal((await get(`${url}/__cache/stats`)).status, 401);
    assert.equal((await get(`${url}/__cache/stats`, { authorization: 'Bearer wrong' })).status, 401);
    const stats = await get(`${url}/__cache/stats`, { authorization: `Bearer ${TOKEN}` });
    assert.ok(stats.body.total.hits > 0);
    assert.ok(stats.body.total.upstreamCallsAvoided > 0);

    await get(`${url}/api/products/20`);
    const ins = await get(`${url}/__cache/inspect?url=/api/products/20`, { authorization: `Bearer ${TOKEN}` });
    assert.equal(ins.body.cached, true);
    assert.equal(ins.body.state, 'fresh');
    assert.ok(ins.body.tags.includes('product:20'));

    const purge = (body) => fetch(`${url}/__cache/purge`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json().then((j) => ({ status: r.status, ...j })));
    assert.equal((await fetch(`${url}/__cache/purge`, { method: 'POST' })).status, 401);
    assert.equal((await purge({})).status, 400);
    assert.equal((await purge({ tags: ['product:20'] })).purged, 1);
    assert.equal((await get(`${url}/api/products/20`)).xcache, 'MISS');
    assert.equal((await purge({ paths: ['/api/products/20'] })).purged, 1);
    assert.ok((await purge({ all: true })).purged > 0);
    assert.equal((await get(`${url}/api/products/1`)).xcache, 'MISS');
  });
});

describe('gateway policies with a programmable upstream', () => {
  let up, gw, url, version = 0, mode = 'ok';
  before(async () => {
    up = await startUpstream(async (req, res) => {
      const p = new URL(req.url, 'http://x').pathname;
      if (mode === 'down') return res.destroy();
      if (mode === '500') return json(res, 500, { error: 'boom' });
      if (p === '/tagged') return json(res, 200, { ok: 1 }, { 'x-cache-tags': 'catalog brand:7' });
      if (p === '/purger') return json(res, 200, { ok: 1 }, { 'x-cache-invalidate': 'catalog' });
      if (p === '/nostore') return json(res, 200, { v: ++version }, { 'cache-control': 'no-store' });
      if (p === '/maxage') return json(res, 200, { v: ++version }, { 'cache-control': 'max-age=1' });
      if (p === '/cookie') return json(res, 200, { v: ++version }, { 'set-cookie': ['a=1; HttpOnly', 'b=2'] });
      if (p === '/vary') return json(res, 200, { v: 1 }, { vary: 'Accept-Language' });
      if (p === '/error') return json(res, 500, { v: ++version });
      if (p === '/slow') { await sleep(300); return json(res, 200, { slow: true }); }
      if (p === '/echo') return json(res, 200, { headers: req.headers });
      return json(res, 200, { v: ++version, p });
    });
    ({ gw, url } = await startGw(up.url, {
      cacheUnmatched: true,
      routes: [
        { name: 'swr', path: '/swr', ttl: 1, staleWhileRevalidate: 30, staleIfError: 0 },
        { name: 'sie', path: '/sie', ttl: 1, staleWhileRevalidate: 0, staleIfError: 60 },
        { name: 'maxage', path: '/maxage' },
        { name: 'slow', path: '/slow', ttl: 60, timeoutMs: 100 },
        { name: 'shared-auth', path: '/shared', ttl: 60, shareAuthenticated: true, ignoreCookies: true },
      ],
    }));
  });
  after(async () => { await gw.close(); await up.close(); });

  test('upstream X-Cache-Tags + X-Cache-Invalidate headers', async () => {
    await get(`${url}/tagged`);
    assert.equal((await get(`${url}/tagged`)).xcache, 'HIT');
    const r = await get(`${url}/purger`);
    assert.equal(r.status, 200);
    assert.equal((await get(`${url}/tagged`)).xcache, 'MISS');
  });

  test('no-store, unknown Vary and 5xx are not cached; Cache-Control max-age is respected', async () => {
    await get(`${url}/nostore`);
    const ns = await get(`${url}/nostore`);
    assert.equal(ns.xcache, 'MISS');
    assert.equal(ns.reason, 'no-store');
    assert.equal((await get(`${url}/vary`)).reason, 'vary-accept-language');
    await get(`${url}/cookie`);
    const ck = await fetch(`${url}/cookie`);
    assert.equal(ck.headers.get('x-cache-reason'), 'set-cookie');
    assert.deepEqual(ck.headers.getSetCookie(), ['a=1; HttpOnly', 'b=2'], 'both cookies reach the client');
    const e = await get(`${url}/error`);
    assert.equal(e.status, 500);
    assert.equal(e.reason, 'status-500');
    await get(`${url}/maxage`);
    assert.equal((await get(`${url}/maxage`)).xcache, 'HIT');
    await sleep(1100);
    assert.notEqual((await get(`${url}/maxage`)).xcache, 'HIT', 'max-age=1 expired');
  });

  test('stale-while-revalidate: serve stale instantly, refresh in the background', async () => {
    const first = await get(`${url}/swr`);
    await sleep(1100);
    const stale = await get(`${url}/swr`);
    assert.equal(stale.xcache, 'STALE');
    assert.equal(stale.reason, 'revalidating');
    assert.equal(stale.body.v, first.body.v);
    await gw.gateway.engine.drain();
    const fresh = await get(`${url}/swr`);
    assert.equal(fresh.xcache, 'HIT');
    assert.ok(fresh.body.v > first.body.v);
  });

  test('stale-if-error: upstream 500 or connection failure serves the last good copy', async () => {
    const good = await get(`${url}/sie`);
    await sleep(1100);
    mode = '500';
    const r1 = await get(`${url}/sie`);
    mode = 'down';
    const r2 = await get(`${url}/sie`);
    mode = 'ok';
    for (const r of [r1, r2]) {
      assert.equal(r.status, 200);
      assert.equal(r.xcache, 'STALE');
      assert.equal(r.reason, 'stale-if-error');
      assert.deepEqual(r.body, good.body);
    }
  });

  test('concurrent requests never share an uncacheable (cookie-setting) response', async () => {
    const before = up.count((c) => c.url === '/cookie');
    const res = await Promise.all(Array.from({ length: 5 }, () => fetch(`${url}/cookie`).then(async (r) => ({ v: (await r.json()).v, cookies: r.headers.getSetCookie() }))));
    assert.equal(up.count((c) => c.url === '/cookie') - before, 5, 'each client got its own upstream response');
    assert.equal(new Set(res.map((r) => r.v)).size, 5);
    assert.ok(res.every((r) => r.cookies.length === 2));
  });

  test('no cached copy + upstream down -> 502; slow upstream -> 504', async () => {
    mode = 'down';
    const r = await get(`${url}/never-cached-${Date.now()}`);
    mode = 'ok';
    assert.equal(r.status, 502);
    assert.equal(r.body.error, 'upstream_unavailable');
    const slow = await get(`${url}/slow`);
    assert.equal(slow.status, 504);
    assert.equal(slow.body.error, 'upstream_timeout');
  });

  test('forwarding headers; hop-by-hop and conditional headers stripped for cache fills; ignoreCookies strips cookies', async () => {
    const r = await get(`${url}/echo`, { 'if-none-match': '"x"', 'x-custom': 'yes' });
    const h = r.body.headers;
    assert.equal(h['x-custom'], 'yes');
    assert.equal(h['if-none-match'], undefined);
    assert.ok(h['x-forwarded-for']);
    assert.match(h.via, /redis-cache-gateway/);
    await get(`${url}/shared`, { cookie: 'sid=secret', authorization: 'Bearer a' });
    const call = up.calls.findLast((c) => c.url === '/shared');
    assert.equal(call.headers.cookie, undefined);
    assert.equal((await get(`${url}/shared`, { authorization: 'Bearer b' })).xcache, 'HIT', 'shareAuthenticated shares one entry');
  });
});

test('two gateway instances sharing one store make a single upstream call', async () => {
  const api = await startMockApi({ latencyMs: 80, jitter: 0 });
  const shared = new MemoryStore();
  const a = await startGw(api.url, {}, shared);
  const b = await startGw(api.url, {}, shared);
  try {
    const reqs = Array.from({ length: 20 }, (_, i) => get(`${(i % 2 ? a : b).url}/api/products/5`));
    const res = await Promise.all(reqs);
    assert.equal(api.calls('GET /api/products/5'), 1);
    assert.ok(res.every((r) => r.status === 200 && r.body.id === 5));
  } finally {
    await a.gw.close(); await b.gw.close(); await api.close();
  }
});

test('Redis outage: gateway keeps answering from the API (fail-open)', async () => {
  const api = await startMockApi({ latencyMs: 5, jitter: 0 });
  const broken = new MemoryStore();
  const boom = async () => { throw new Error('ECONNREFUSED'); };
  Object.assign(broken, { get: boom, set: boom, lock: boom, invalidateTags: boom, incrStats: boom, isUp: () => false });
  const { gw, url } = await startGw(api.url, {}, broken);
  try {
    const r = await get(`${url}/api/products/1`);
    assert.equal(r.status, 200);
    assert.equal(r.xcache, 'BYPASS');
    assert.equal(r.reason, 'store-unavailable');
    const put = await fetch(`${url}/api/products/1`, { method: 'PUT', body: '{"price":2}', headers: { 'content-type': 'application/json' } });
    assert.equal(put.status, 200);
    const health = await get(`${url}/__cache/health`);
    assert.equal(health.body.storeUp, false);
  } finally {
    await gw.close(); await api.close();
  }
});

test('request body limit returns 413', async () => {
  const api = await startMockApi({ latencyMs: 1 });
  const { gw, url } = await startGw(api.url, { maxBodyBytes: '1kb' });
  try {
    const r = await fetch(`${url}/api/products/1`, { method: 'PUT', body: 'x'.repeat(5000), headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 413);
  } finally { await gw.close(); await api.close(); }
});
