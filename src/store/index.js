import { MemoryStore } from './memory.js';
import { silentLogger } from '../log.js';

/**
 * store: "auto" -> Redis when a URL is configured, else memory.
 * Redis being down at startup never stops the gateway: it serves from the API until Redis returns.
 */
export async function createStore(cfg = {}, logger = silentLogger) {
  const redisUrl = cfg.redis?.url;
  const kind = !cfg.store || cfg.store === 'auto' ? (redisUrl ? 'redis' : 'memory') : cfg.store;
  if (kind === 'redis') {
    const { RedisStore } = await import('./redis.js');
    const store = new RedisStore({ ...cfg.redis, url: redisUrl, logger });
    const ok = await store.connect();
    if (!ok) logger.warn('redis not reachable at startup - requests go straight to the API until it is', { url: redactUrl(redisUrl) });
    return store;
  }
  if (kind !== 'memory') throw new Error(`unknown store "${kind}" (use auto, redis or memory)`);
  return new MemoryStore({ maxBytes: cfg.memory?.maxBytes });
}

export function redactUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch { return url; }
}

export { MemoryStore };
