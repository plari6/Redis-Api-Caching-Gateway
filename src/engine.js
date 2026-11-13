import { encodeEntry, decodeEntry, classify } from './entry.js';
import { silentLogger } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Shared cache engine used by the gateway, the Express middleware and cache.wrap().
 *
 * Request coalescing (stampede protection) on two levels:
 *  - in-process: concurrent misses for one key share a single loader promise;
 *  - across instances: a Redis lock (SET NX PX); other instances wait for the
 *    winner's entry instead of hitting the slow API/database too.
 */
export class CacheEngine {
  constructor({ store, logger = silentLogger, lockMs = 15_000, lockWaitMs = 10_000, pollMs = 30 }) {
    this.store = store;
    this.logger = logger;
    this.lockMs = lockMs;
    this.lockWaitMs = lockWaitMs;
    this.pollMs = pollMs;
    this.inflight = new Map();
    this.background = new Set();
  }

  /** Returns { meta, body, state } or null. Throws if the store is down. */
  async read(id) {
    const buf = await this.store.get(id);
    if (!buf) return null;
    let entry;
    try { entry = decodeEntry(buf); } catch { return null; }
    entry.state = classify(entry.meta);
    return entry.state === 'expired' ? null : entry;
  }

  async write(id, meta, body) {
    const ttlMs = meta.e - Date.now();
    if (ttlMs <= 0) return;
    await this.store.set(id, encodeEntry(meta, body), ttlMs, meta.tg ?? []);
  }

  /**
   * Run `loader` once per key at a time. loader() resolves to an object; if it has
   * `store: { meta, body }` the entry is written before waiters are released.
   * Resolves to the loader result, or { entry, peer: true } when another instance filled it.
   */
  load(id, loader) {
    const running = this.inflight.get(id);
    if (running) return running.then((r) => ({ ...r, coalesced: true }));
    const p = this.#load(id, loader).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  async #load(id, loader) {
    let token;
    try {
      token = await this.store.lock(id, this.lockMs);
    } catch {
      token = undefined; // store down: just load
    }
    if (token === null) {
      const entry = await this.#waitForPeer(id);
      if (entry) return { entry, peer: true };
    }
    try {
      const result = await loader();
      if (result?.store) {
        try {
          await this.write(id, result.store.meta, result.store.body);
          result.stored = true;
        } catch (err) {
          result.storeError = err;
          this.logger.warn('cache write failed', { error: err.message });
        }
      }
      return result;
    } finally {
      if (token) this.store.unlock(id, token).catch(() => {});
    }
  }

  async #waitForPeer(id) {
    const deadline = Date.now() + this.lockWaitMs;
    let delay = this.pollMs;
    while (Date.now() < deadline) {
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), 250);
      try {
        const entry = await this.read(id);
        if (entry?.state === 'fresh') return entry;
        if (!(await this.store.locked(id))) return null; // peer finished without a cacheable result
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Fire-and-forget refresh used by stale-while-revalidate. */
  revalidate(id, loader) {
    if (this.inflight.has(id)) return;
    const p = this.load(id, loader)
      .catch((err) => this.logger.warn('background refresh failed', { error: err.message }))
      .finally(() => this.background.delete(p));
    this.background.add(p);
  }

  async drain() {
    await Promise.allSettled([...this.background]);
  }
}
