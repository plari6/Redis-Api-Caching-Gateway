import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import RedisMock from 'ioredis-mock';
import { createCache } from '../src/cache.js';
import { cacheResponse, invalidateOnSuccess } from '../src/middleware.js';
import { MemoryStore } from '../src/store/memory.js';
import { RedisStore } from '../src/store/redis.js';
import { sleep } from './helpers.js';

const slowQuery = () => {
  let calls = 0;
  const fn = async (value) => { calls++; await sleep(30); return value ?? { rows: [{ id: 1, at: '2026-01-01' }], n: calls }; };
  return { fn, calls: () => calls };
};

for (const [name, store] of [['memory', () => new MemoryStore()], ['redis mock', () => new RedisStore({ client: new RedisMock(), prefix: 'wrap' + Math.random() })]]) {
  test(`cache.wrap (${name}): caches, coalesces, invalidates by tag`, async () => {
    const cache = await createCache({ store: store() });
    const q = slowQuery();
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.wrap(['products', { page: 1, size: 20 }], () => q.fn(), { ttl: 60, tags: ['products'] })));
    assert.equal(q.calls(), 1, 'one query for 10 concurrent callers');
    assert.ok(results.every((r) => r.rows[0].id === 1));
    // same key, different property order
    await cache.wrap(['products', { size: 20, page: 1 }], () => q.fn(), { ttl: 60 });
    assert.equal(q.calls(), 1);
    assert.equal(await cache.invalidate('products'), 1);
    await cache.wrap(['products', { page: 1, size: 20 }], () => q.fn(), { ttl: 60, tags: ['products'] });
    assert.equal(q.calls(), 2);
    await cache.close();
  });
}

test('cache.wrap: tags from the result, ttl 0 skips caching, errors are not cached', async () => {
  const cache = await createCache({ store: new MemoryStore() });
  const rows = [{ id: 7 }, { id: 8 }];
  await cache.wrap('list', async () => rows, { tags: (r) => r.map((x) => `product:${x.id}`) });
  assert.equal(await cache.invalidate(['product:8']), 1);

  let n = 0;
  await cache.wrap('nocache', async () => ++n, { ttl: 0 });
  await cache.wrap('nocache', async () => ++n, { ttl: 0 });
  assert.equal(n, 2);

  let attempts = 0;
  await assert.rejects(cache.wrap('fails', async () => { attempts++; throw new Error('db down'); }));
  assert.equal(await cache.wrap('fails', async () => { attempts++; return 'ok'; }), 'ok');
  assert.equal(attempts, 2);
  await cache.close();
});

test('cache.wrap: stale-while-revalidate and stale-if-error', async () => {
  const cache = await createCache({ store: new MemoryStore() });
  let v = 0;
  const opts = { ttl: 0.1, staleWhileRevalidate: 10 };
  assert.equal(await cache.wrap('swr', async () => ++v, opts), 1);
  await sleep(150);
  assert.equal(await cache.wrap('swr', async () => ++v, opts), 1, 'stale value returned instantly');
  await cache.engine.drain();
  assert.equal(await cache.wrap('swr', async () => ++v, opts), 2, 'refreshed in background');

  const sie = { ttl: 0.1, staleIfError: 10 };
  assert.equal(await cache.wrap('sie', async () => 'good', sie), 'good');
  await sleep(150);
  assert.equal(await cache.wrap('sie', async () => { throw new Error('db down'); }, sie), 'good');
  await cache.close();
});

test('cache.wrap: store down -> loader still runs (app keeps working)', async () => {
  const broken = new MemoryStore();
  broken.get = async () => { throw new Error('ECONNREFUSED'); };
  const cache = await createCache({ store: broken });
  assert.equal(await cache.wrap('k', async () => 42), 42);
  assert.equal(await cache.get('k'), undefined);
});

test('express middleware: caches JSON, per-user vary, invalidates on write', async () => {
  const cache = await createCache({ store: new MemoryStore() });
  let dbCalls = 0;
  const price = { 1: 10 };
  const app = express();
  app.use(express.json());
  app.get('/products/:id', cacheResponse(cache, { ttl: 60, tags: (req) => [`product:${req.params.id}`] }), async (req, res) => {
    dbCalls++;
    res.json({ id: req.params.id, price: price[req.params.id] });
  });
  app.get('/me', cacheResponse(cache, { ttl: 60, varyBy: ['header:authorization'] }), (req, res) => res.json({ user: req.headers.authorization }));
  app.put('/products/:id', invalidateOnSuccess(cache, (req) => [`product:${req.params.id}`]), (req, res) => {
    price[req.params.id] = req.body.price;
    res.json({ ok: true });
  });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = await fetch(`${base}/products/1`);
    const b = await fetch(`${base}/products/1`);
    assert.equal(a.headers.get('x-cache'), 'MISS');
    assert.equal(b.headers.get('x-cache'), 'HIT');
    assert.equal(dbCalls, 1);
    await fetch(`${base}/products/1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"price":99}' });
    await sleep(20);
    const c = await fetch(`${base}/products/1`).then((r) => r.json());
    assert.equal(c.price, 99);
    assert.equal(dbCalls, 2);
    const u1 = await fetch(`${base}/me`, { headers: { authorization: 'alice' } }).then((r) => r.json());
    const u2 = await fetch(`${base}/me`, { headers: { authorization: 'bob' } }).then((r) => r.json());
    assert.equal(u1.user, 'alice');
    assert.equal(u2.user, 'bob');
  } finally {
    server.close();
    await cache.close();
  }
});
