const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const RESULTS = ['hit', 'stale', 'coalesced', 'stale_error', 'miss', 'bypass'];

/** Prometheus text exposition of this process's counters. */
export function renderMetrics(totals, { storeUp, store }) {
  const by = new Map();
  for (const [k, v] of totals) {
    const i = k.lastIndexOf('|');
    const route = k.slice(0, i);
    if (!by.has(route)) by.set(route, {});
    by.get(route)[k.slice(i + 1)] = v;
  }
  const lines = [
    '# HELP rcg_requests_total Requests by route and cache result.',
    '# TYPE rcg_requests_total counter',
  ];
  for (const [route, c] of by) {
    for (const r of RESULTS) if (c[r]) lines.push(`rcg_requests_total{route="${esc(route)}",result="${r}"} ${c[r]}`);
  }
  const counter = (name, help, field, scale = 1) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const [route, c] of by) if (c[field]) lines.push(`${name}{route="${esc(route)}"} ${+(c[field] * scale).toFixed(6)}`);
  };
  counter('rcg_upstream_requests_total', 'Requests sent to the upstream API to fill the cache.', 'upstream_calls');
  counter('rcg_upstream_seconds_total', 'Time spent waiting for the upstream API to fill the cache.', 'upstream_ms', 0.001);
  counter('rcg_cache_serve_seconds_total', 'Time spent answering from cache.', 'cache_ms', 0.001);
  counter('rcg_upstream_errors_total', 'Upstream network errors and timeouts.', 'upstream_errors');
  counter('rcg_store_errors_total', 'Cache store (Redis) errors; requests were served from the API.', 'store_errors');
  counter('rcg_invalidated_keys_total', 'Cache entries removed by invalidation.', 'invalidated');
  counter('rcg_cache_bytes_served_total', 'Bytes answered from cache.', 'bytes_from_cache');
  lines.push('# HELP rcg_store_up 1 when the cache store is reachable.', '# TYPE rcg_store_up gauge', `rcg_store_up{store="${store}"} ${storeUp ? 1 : 0}`);
  return lines.join('\n') + '\n';
}
