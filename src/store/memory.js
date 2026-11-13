import { randomUUID } from 'node:crypto';

/**
 * In-process store with the same interface as RedisStore.
 * LRU with a byte budget. Use for local dev, tests and single-instance demos;
 * use Redis when you run several gateway instances or need restarts to keep the cache.
 */
export class MemoryStore {
  kind = 'memory';

  constructor({ maxBytes = 128 * 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.entries = new Map(); // id -> { buf, exp, tags }
    this.tags = new Map(); // tag -> Set(id)
    this.locks = new Map(); // id -> { token, exp }
    this.stats = new Map();
  }

  async connect() {}
  isUp() { return true; }

  #drop(id) {
    const e = this.entries.get(id);
    if (!e) return 0;
    this.entries.delete(id);
    this.bytes -= e.buf.length;
    for (const t of e.tags) {
      const set = this.tags.get(t);
      if (set) { set.delete(id); if (!set.size) this.tags.delete(t); }
    }
    return 1;
  }

  async get(id) {
    const e = this.entries.get(id);
    if (!e) return null;
    if (e.exp <= Date.now()) { this.#drop(id); return null; }
    this.entries.delete(id); // LRU bump
    this.entries.set(id, e);
    return e.buf;
  }

  async set(id, buf, ttlMs, tags = []) {
    this.#drop(id);
    if (buf.length > this.maxBytes) return;
    this.entries.set(id, { buf, exp: Date.now() + ttlMs, tags });
    this.bytes += buf.length;
    for (const t of tags) {
      if (!this.tags.has(t)) this.tags.set(t, new Set());
      this.tags.get(t).add(id);
    }
    for (const oldest of this.entries.keys()) {
      if (this.bytes <= this.maxBytes) break;
      this.#drop(oldest);
    }
  }

  async del(ids) {
    let n = 0;
    for (const id of ids) n += this.#drop(id);
    return n;
  }

  async invalidateTags(tags) {
    let n = 0;
    for (const t of tags) {
      const set = this.tags.get(t);
      if (!set) continue;
      for (const id of [...set]) n += this.#drop(id);
      this.tags.delete(t);
    }
    return n;
  }

  async purgeAll() {
    const n = this.entries.size;
    this.entries.clear();
    this.tags.clear();
    this.locks.clear();
    this.bytes = 0;
    return n;
  }

  async lock(id, ttlMs) {
    const cur = this.locks.get(id);
    if (cur && cur.exp > Date.now()) return null;
    const token = randomUUID();
    this.locks.set(id, { token, exp: Date.now() + ttlMs });
    return token;
  }

  async unlock(id, token) {
    if (this.locks.get(id)?.token === token) this.locks.delete(id);
  }

  async locked(id) {
    const cur = this.locks.get(id);
    return Boolean(cur && cur.exp > Date.now());
  }

  async incrStats(batch) {
    for (const [k, v] of Object.entries(batch)) this.stats.set(k, (this.stats.get(k) ?? 0) + v);
  }

  async getStats() { return Object.fromEntries(this.stats); }
  async resetStats() { this.stats.clear(); }
  async ping() { return 0; }

  async info() {
    return { kind: this.kind, entries: this.entries.size, usedBytes: this.bytes, maxBytes: this.maxBytes, tags: this.tags.size };
  }

  async close() {}
}
