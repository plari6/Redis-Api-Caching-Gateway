import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { silentLogger } from '../log.js';

// Store entry + register it in every tag set; a tag set lives as long as its longest entry.
const SET_LUA = `
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[1])
local ttl = tonumber(ARGV[1])
for i = 2, #KEYS do
  redis.call('SADD', KEYS[i], KEYS[1])
  if redis.call('PTTL', KEYS[i]) < ttl then redis.call('PEXPIRE', KEYS[i], ttl) end
end
return 1`;

// Delete every entry in the given tag sets, then the sets. Atomic.
const INVALIDATE_LUA = `
local n = 0
for i = 1, #KEYS do
  local members = redis.call('SMEMBERS', KEYS[i])
  for j = 1, #members, 500 do
    n = n + redis.call('UNLINK', unpack(members, j, math.min(j + 499, #members)))
  end
  redis.call('UNLINK', KEYS[i])
end
return n`;

const UNLOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * Redis-backed store. Fail-fast by design: no offline queue and a short command
 * timeout, so when Redis is down the gateway bypasses the cache instead of hanging.
 * ioredis keeps reconnecting in the background.
 *
 * Keys: {prefix}:e:<id> entry, {prefix}:t:<tag> tag set, {prefix}:l:<id> lock, {prefix}:stats hash.
 * For Redis Cluster use a hash-tag prefix such as "{rcg}" so all keys share a slot.
 */
export class RedisStore {
  kind = 'redis';

  constructor({ url, prefix = 'rcg', commandTimeoutMs = 1000, connectTimeoutMs = 3000, logger = silentLogger, client } = {}) {
    this.prefix = prefix;
    this.logger = logger;
    this.connectTimeoutMs = connectTimeoutMs;
    this.client = client ?? new Redis(url ?? 'redis://127.0.0.1:6379', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: commandTimeoutMs,
      connectTimeout: connectTimeoutMs,
      enableAutoPipelining: true,
      retryStrategy: (times) => Math.min(times * 250, 3000),
    });

    let lastErrorLog = 0;
    this.client.on('error', (err) => {
      if (Date.now() - lastErrorLog < 10_000) return;
      lastErrorLog = Date.now();
      this.logger.warn('redis error - cache bypassed until it reconnects', { error: err.message });
    });
    this.client.on('ready', () => this.logger.info('redis connected'));
  }

  k(type, id) { return `${this.prefix}:${type}:${id}`; }

  /** Resolves when connected or after connectTimeout; never throws (the gateway fails open). */
  async connect() {
    if (this.client.status === 'ready') return true;
    const ready = this.client.status === 'wait' ? this.client.connect().then(() => true, () => false) : Promise.resolve(false);
    const timeout = new Promise((r) => setTimeout(() => r(false), this.connectTimeoutMs).unref());
    return Promise.race([ready, timeout]);
  }

  isUp() { return this.client.status === 'ready'; }

  async get(id) { return this.client.getBuffer(this.k('e', id)); }

  async set(id, buf, ttlMs, tags = []) {
    const keys = [this.k('e', id), ...tags.map((t) => this.k('t', t))];
    await this.client.eval(SET_LUA, keys.length, ...keys, String(Math.max(1, Math.ceil(ttlMs))), buf);
  }

  async del(ids) {
    if (!ids.length) return 0;
    return this.client.unlink(...ids.map((id) => this.k('e', id)));
  }

  async invalidateTags(tags) {
    if (!tags.length) return 0;
    const keys = tags.map((t) => this.k('t', t));
    return this.client.eval(INVALIDATE_LUA, keys.length, ...keys);
  }

  async purgeAll() {
    let n = 0;
    const stream = this.client.scanStream({ match: `${this.prefix}:*`, count: 500 });
    for await (const keys of stream) {
      const own = keys.filter((k) => !k.startsWith(`${this.prefix}:stats:`));
      if (own.length) n += await this.client.unlink(...own);
    }
    return n;
  }

  async lock(id, ttlMs) {
    const token = randomUUID();
    const ok = await this.client.set(this.k('l', id), token, 'PX', Math.ceil(ttlMs), 'NX');
    return ok === 'OK' ? token : null;
  }

  async unlock(id, token) { await this.client.eval(UNLOCK_LUA, 1, this.k('l', id), token); }

  async locked(id) { return (await this.client.exists(this.k('l', id))) === 1; }

  async incrStats(batch) {
    const p = this.client.pipeline();
    for (const [field, n] of Object.entries(batch)) p.hincrby(this.k('stats', 'v1'), field, Math.round(n));
    const res = await p.exec();
    const err = res?.find(([e]) => e)?.[0];
    if (err) throw err;
  }

  async getStats() {
    const raw = await this.client.hgetall(this.k('stats', 'v1'));
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
  }

  async resetStats() { await this.client.del(this.k('stats', 'v1')); }

  async ping() {
    const t = performance.now();
    await this.client.ping();
    return performance.now() - t;
  }

  async info() {
    const text = await this.client.info();
    const field = (name) => text.match(new RegExp(`^${name}:(.*)$`, 'm'))?.[1]?.trim();
    let entries = 0;
    const stream = this.client.scanStream({ match: `${this.prefix}:e:*`, count: 1000 });
    for await (const keys of stream) { entries += keys.length; if (entries > 1_000_000) break; }
    return {
      kind: this.kind,
      version: field('redis_version'),
      usedMemory: field('used_memory_human'),
      maxMemory: field('maxmemory_human'),
      evictionPolicy: field('maxmemory_policy'),
      entries,
    };
  }

  async close() {
    try { await this.client.quit(); } catch { this.client.disconnect(); }
  }
}
