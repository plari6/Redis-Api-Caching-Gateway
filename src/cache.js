import { CacheEngine } from './engine.js';
import { windows } from './entry.js';
import { shortHash, stableStringify } from './key.js';
import { createStore } from './store/index.js';
import { silentLogger } from './log.js';

/**
 * In-app cache for slow database queries and function calls.
 *
 *   const cache = await createCache({ redisUrl: process.env.REDIS_URL });
 *   const rows = await cache.wrap(['top-products', { limit: 20 }],
 *     () => db.query('SELECT ...'), { ttl: 120, tags: ['products'] });
 *   await cache.invalidate(['products']);   // after a write
 *
 * Values are stored as JSON (Dates come back as ISO strings).
 * If Redis is down, wrap() simply calls the loader - your app keeps working.
 */
export async function createCache({
  redisUrl, store, prefix = 'rcg', ttl = 60, staleWhileRevalidate = 0, staleIfError = 0,
  lockMs = 15_000, lockWaitMs = 10_000, logger = silentLogger,
} = {}) {
  const ownStore = !store;
  store ??= await createStore({ store: redisUrl ? 'redis' : 'memory', redis: { url: redisUrl, prefix } }, logger);
  const engine = new CacheEngine({ store, logger, lockMs, lockWaitMs });
  const idOf = (key) => 'q_' + shortHash(stableStringify(key), 32);
  const resolve = (v, value) => (typeof v === 'function' ? v(value) : v);

  function entryFor(value, opts) {
    const t = resolve(opts.ttl ?? ttl, value);
    if (value === undefined || !(t > 0)) return null;
    const meta = {
      s: 200, h: {}, ...windows(Date.now(), t, opts.staleWhileRevalidate ?? staleWhileRevalidate, opts.staleIfError ?? staleIfError),
      z: false, tg: [...new Set(resolve(opts.tags ?? [], value))].map(String),
    };
    return { meta, body: Buffer.from(JSON.stringify(value)) };
  }

  const parse = (entry) => JSON.parse(entry.body.toString('utf8'));

  return {
    store,
    engine,

    /** Return the cached value for `key`, or run `loader` once (even under concurrency) and cache it. */
    async wrap(key, loader, opts = {}) {
      const id = idOf(key);
      let entry = null;
      try { entry = await engine.read(id); } catch { return loader(); }
      const load = async () => {
        const value = await loader();
        return { value, store: entryFor(value, opts) };
      };
      if (entry?.state === 'fresh') return parse(entry);
      if (entry?.state === 'stale') {
        engine.revalidate(id, load);
        return parse(entry);
      }
      try {
        const result = await engine.load(id, load);
        return result.entry ? parse(result.entry) : result.value;
      } catch (err) {
        if (entry) return parse(entry); // stale-if-error
        throw err;
      }
    },

    /** Fresh value or undefined. */
    async get(key) {
      try {
        const entry = await engine.read(idOf(key));
        return entry?.state === 'fresh' ? parse(entry) : undefined;
      } catch { return undefined; }
    },

    async set(key, value, opts = {}) {
      const e = entryFor(value, opts);
      if (!e) return false;
      try { await engine.write(idOf(key), e.meta, e.body); return true; } catch { return false; }
    },

    async delete(key) {
      try { return (await store.del([idOf(key)])) > 0; } catch { return false; }
    },

    /** Remove every entry carrying one of these tags. */
    async invalidate(tags) {
      try { return await store.invalidateTags([].concat(tags).map(String)); } catch { return 0; }
    },

    async close() {
      await engine.drain();
      if (ownStore) await store.close();
    },
  };
}
