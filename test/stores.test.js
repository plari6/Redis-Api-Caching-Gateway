import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import { MemoryStore } from '../src/store/memory.js';
import { RedisStore } from '../src/store/redis.js';
import { CacheEngine } from '../src/engine.js';
import { encodeEntry, windows } from '../src/entry.js';
import { sleep } from './helpers.js';

const factories = {
  memory: async () => new MemoryStore(),
  'redis (ioredis-mock)': async () => new RedisStore({ client: new RedisMock(), prefix: `t${Math.random().toString(36).slice(2, 8)}` }),
};
// Real Redis integration: set REDIS_URL=redis://localhost:6379 to include it.
if (process.env.REDIS_URL) {
  factories['redis (real)'] = async () => {
    const s = new RedisStore({ url: process.env.REDIS_URL, prefix: `rcg-test-${Date.now()}` });
    assert.ok(await s.connect(), 'REDIS_URL set but Redis not reachable');
    return s;
  };
}

for (const [name, make] of Object.entries(factories)) {
  describe(`store contract: ${name}`, () => {
    const stores = [];
    const fresh = async () => { const s = await make(); stores.push(s); return s; };
    after(async () => { for (const s of stores) { await s.purgeAll().catch(() => {}); await s.resetStats().catch(() => {}); await s.close(); } });

    test('get/set/del and expiry', async () => {
      const s = await fresh();
      await s.set('a', Buffer.from('hello'), 60_000, []);
      assert.equal((await s.get('a')).toString(), 'hello');
      assert.equal(await s.get('missing'), null);
      assert.equal(await s.del(['a']), 1);
      assert.equal(await s.get('a'), null);
      await s.set('short', Buffer.from('x'), 50, []);
      await sleep(120);
      assert.equal(await s.get('short'), null);
    });

    test('binary bodies survive byte for byte', async () => {
      const s = await fresh();
      const buf = Buffer.from([0, 255, 1, 128, 10, 13, 0]);
      await s.set('bin', buf, 60_000, ['t']);
      assert.deepEqual(await s.get('bin'), buf);
    });

    test('tag invalidation removes only tagged entries', async () => {
      const s = await fresh();
      await s.set('p1', Buffer.from('1'), 60_000, ['products', 'product:1']);
      await s.set('p2', Buffer.from('2'), 60_000, ['products', 'product:2']);
      await s.set('o1', Buffer.from('3'), 60_000, ['orders']);
      assert.equal(await s.invalidateTags(['product:1']), 1);
      assert.equal(await s.get('p1'), null);
      assert.ok(await s.get('p2'));
      assert.equal(await s.invalidateTags(['products', 'nope']), 1);
      assert.equal(await s.get('p2'), null);
      assert.ok(await s.get('o1'));
      assert.equal(await s.invalidateTags([]), 0);
    });

    test('locks are exclusive and owner-only', async () => {
      const s = await fresh();
      const t1 = await s.lock('k', 5_000);
      assert.ok(t1);
      assert.equal(await s.lock('k', 5_000), null);
      assert.equal(await s.locked('k'), true);
      await s.unlock('k', 'not-the-owner');
      assert.equal(await s.locked('k'), true);
      await s.unlock('k', t1);
      assert.equal(await s.locked('k'), false);
      assert.ok(await s.lock('k', 5_000));
    });

    test('stats counters and purgeAll', async () => {
      const s = await fresh();
      await s.incrStats({ 'r|hit': 2, 'r|miss': 1 });
      await s.incrStats({ 'r|hit': 3 });
      assert.deepEqual(await s.getStats(), { 'r|hit': 5, 'r|miss': 1 });
      await s.set('x', Buffer.from('1'), 60_000, ['t']);
      assert.ok((await s.purgeAll()) >= 1);
      assert.equal(await s.get('x'), null);
      assert.deepEqual(await s.getStats(), { 'r|hit': 5, 'r|miss': 1 }, 'purgeAll keeps stats');
      await s.resetStats();
      assert.deepEqual(await s.getStats(), {});
    });

    test('engine: concurrent loads run the loader once', async () => {
      const s = await fresh();
      const engine = new CacheEngine({ store: s });
      let calls = 0;
      const loader = async () => {
        calls++;
        await sleep(50);
        const meta = { s: 200, h: {}, ...windows(Date.now(), 60), tg: [] };
        return { value: 'v', store: { meta, body: Buffer.from('v') } };
      };
      const results = await Promise.all(Array.from({ length: 20 }, () => engine.load('id1', loader)));
      assert.equal(calls, 1);
      assert.ok(results.every((r) => r.value === 'v' || r.entry));
      assert.equal((await engine.read('id1')).state, 'fresh');
    });

    test('engine: a second instance waits for the first (distributed lock)', async () => {
      const s = await fresh();
      const a = new CacheEngine({ store: s });
      const b = new CacheEngine({ store: s, pollMs: 10 });
      let calls = 0;
      const loader = async () => {
        calls++;
        await sleep(80);
        return { store: { meta: { s: 200, h: {}, ...windows(Date.now(), 60), tg: [] }, body: Buffer.from('shared') } };
      };
      const [ra, rb] = await Promise.all([a.load('id2', loader), sleep(10).then(() => b.load('id2', loader))]);
      assert.equal(calls, 1);
      assert.ok(ra.stored);
      assert.equal(rb.peer, true);
      assert.equal(rb.entry.body.toString(), 'shared');
    });

    test('raw entry written by encodeEntry is readable by the engine', async () => {
      const s = await fresh();
      const meta = { s: 200, h: {}, ...windows(Date.now(), 60), tg: [] };
      await s.set('raw', encodeEntry(meta, Buffer.from('ok')), 60_000, []);
      const e = await new CacheEngine({ store: s }).read('raw');
      assert.equal(e.body.toString(), 'ok');
    });
  });
}

test('redis store fails fast when Redis is down (no hanging requests)', async () => {
  const s = new RedisStore({ url: 'redis://127.0.0.1:1', connectTimeoutMs: 300, commandTimeoutMs: 300 });
  const ok = await s.connect();
  assert.equal(ok, false);
  assert.equal(s.isUp(), false);
  const t = performance.now();
  await assert.rejects(s.get('x'));
  assert.ok(performance.now() - t < 200, 'get should reject immediately');
  s.client.disconnect();
});
