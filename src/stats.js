import { silentLogger } from './log.js';

export const FIELDS = [
  'hit', 'stale', 'coalesced', 'stale_error', 'miss', 'bypass',
  'cache_ms', 'coalesced_ms', 'miss_ms', 'bypass_ms', 'upstream_calls', 'upstream_ms',
  'upstream_errors', 'store_errors', 'invalidated', 'bytes_from_cache',
];

/**
 * Counters per route. Buffered in memory and flushed to the store every
 * `flushMs` (one pipelined HINCRBY batch), so stats never slow a request down.
 * `totals` holds this process's counters for /metrics.
 */
export class Stats {
  constructor(store, { flushMs = 2000, logger = silentLogger } = {}) {
    this.store = store;
    this.logger = logger;
    this.pending = new Map();
    this.totals = new Map();
    this.timer = flushMs > 0 ? setInterval(() => this.flush(), flushMs) : null;
    this.timer?.unref();
  }

  add(route, field, n = 1) {
    if (!n) return;
    const k = `${route}|${field}`;
    this.pending.set(k, (this.pending.get(k) ?? 0) + n);
    this.totals.set(k, (this.totals.get(k) ?? 0) + n);
  }

  async flush() {
    if (!this.pending.size || this.flushing) return;
    this.flushing = true;
    const batch = Object.fromEntries(this.pending);
    this.pending.clear();
    try {
      await this.store.incrStats(batch);
    } catch {
      for (const [k, v] of Object.entries(batch)) this.pending.set(k, (this.pending.get(k) ?? 0) + v);
    } finally {
      this.flushing = false;
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

/** Turn raw "route|field" counters into a per-route report. */
export function summarize(raw = {}) {
  const byRoute = new Map();
  for (const [key, value] of Object.entries(raw)) {
    const i = key.lastIndexOf('|');
    if (i < 0) continue;
    const route = key.slice(0, i);
    if (!byRoute.has(route)) byRoute.set(route, Object.fromEntries(FIELDS.map((f) => [f, 0])));
    byRoute.get(route)[key.slice(i + 1)] = Number(value) || 0;
  }
  const rows = [...byRoute].map(([route, c]) => describe(route, c));
  const total = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  for (const [, c] of byRoute) for (const f of FIELDS) total[f] += c[f] ?? 0;
  rows.sort((a, b) => b.requests - a.requests);
  return { routes: rows, total: describe('TOTAL', total) };
}

function describe(route, c) {
  // coalesced = waited for another request's upstream call: no extra DB query, but not instant either
  const instant = c.hit + c.stale + c.stale_error;
  const fromCache = instant + c.coalesced;
  const cacheable = fromCache + c.miss;
  const avgUpstreamMs = c.upstream_calls ? c.upstream_ms / c.upstream_calls : 0;
  const avgCacheMs = instant ? c.cache_ms / instant : 0;
  const withoutCacheMs = cacheable * avgUpstreamMs;
  const actualMs = c.cache_ms + c.coalesced_ms + c.miss_ms;
  const savedMs = Math.max(0, withoutCacheMs - actualMs);
  return {
    route,
    requests: cacheable + c.bypass,
    hits: c.hit,
    stale: c.stale + c.stale_error,
    coalesced: c.coalesced,
    misses: c.miss,
    bypass: c.bypass,
    hitRate: cacheable ? fromCache / cacheable : 0,
    avgUpstreamMs,
    avgCacheMs,
    upstreamCallsAvoided: fromCache,
    savedMs,
    fasterPct: withoutCacheMs ? savedMs / withoutCacheMs : 0,
    upstreamErrors: c.upstream_errors,
    storeErrors: c.store_errors,
    invalidated: c.invalidated,
    bytesFromCache: c.bytes_from_cache,
  };
}
