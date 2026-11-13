/** Small HTTP load generator used by `rcg bench` and `rcg demo`. */
import http from 'node:http';
import https from 'node:https';

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** One GET over a keep-alive agent; resolves { status, xcache } after the full body arrived. */
function request(url, agent, headers, timeoutMs) {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { agent, headers }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode, xcache: res.headers['x-cache'] }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Send `requests` GETs round-robin over `paths` with `concurrency` workers.
 * Uses node:http keep-alive agents (like a real API client or browser) - Node's
 * fetch adds ~10 ms per request on some platforms and would hide sub-ms cache hits.
 * Returns latency percentiles, throughput, status and X-Cache counts.
 */
export async function runLoad({ base, paths, requests = 200, concurrency = 10, headers = {}, timeoutMs = 30_000 }) {
  if (!paths?.length) throw new Error('runLoad: no paths');
  const latencies = [];
  const statuses = {};
  const xcache = {};
  let errors = 0;
  let next = 0;
  const root = base.replace(/\/+$/, '');
  const workers = Math.max(1, Math.min(concurrency, requests));
  const isHttps = root.startsWith('https:');
  const agent = new (isHttps ? https : http).Agent({ keepAlive: true, maxSockets: workers });
  const reqHeaders = { 'accept-encoding': 'gzip', ...headers };
  const started = performance.now();

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= requests) return;
      const url = new URL(root + paths[i % paths.length]);
      const t = performance.now();
      try {
        const r = await request(url, agent, reqHeaders, timeoutMs);
        latencies.push(performance.now() - t);
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        const xc = r.xcache ?? 'none';
        xcache[xc] = (xcache[xc] ?? 0) + 1;
      } catch {
        errors++;
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: workers }, worker));
  } finally {
    agent.destroy();
  }
  const elapsedMs = performance.now() - started;
  return summarizeLoad(latencies, { elapsedMs, statuses, xcache, errors, requests });
}

export function summarizeLoad(latencies, { elapsedMs = 0, statuses = {}, xcache = {}, errors = 0, requests = latencies.length } = {}) {
  const s = [...latencies].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    requests,
    ok: s.length,
    errors,
    avgMs: s.length ? sum / s.length : 0,
    p50Ms: percentile(s, 50),
    p95Ms: percentile(s, 95),
    p99Ms: percentile(s, 99),
    maxMs: s.at(-1) ?? 0,
    rps: elapsedMs ? (s.length / elapsedMs) * 1000 : 0,
    elapsedMs,
    statuses,
    xcache,
  };
}

/** Percentage improvement of `after` over `before` (0.95 = 95% faster). */
export function improvement(before, after) {
  return {
    p50: before.p50Ms ? 1 - after.p50Ms / before.p50Ms : 0,
    p95: before.p95Ms ? 1 - after.p95Ms / before.p95Ms : 0,
    avg: before.avgMs ? 1 - after.avgMs / before.avgMs : 0,
    throughputX: before.rps ? after.rps / before.rps : 0,
  };
}

export const fmtMs = (ms) => (ms >= 100 ? `${ms.toFixed(0)} ms` : ms >= 10 ? `${ms.toFixed(1)} ms` : `${ms.toFixed(2)} ms`);
export const fmtPct = (x) => `${(x * 100).toFixed(1)}%`;

/** Plain-text table for terminals. */
export function table(rows, columns) {
  const head = columns.map((c) => c.label);
  const body = rows.map((r) => columns.map((c) => String(c.value(r))));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

/** Markdown table for reports. */
export function mdTable(rows, columns) {
  const head = `| ${columns.map((c) => c.label).join(' | ')} |`;
  const sep = `|${columns.map((_, i) => (i === 0 ? ' --- ' : ' ---: ')).join('|')}|`;
  return [head, sep, ...rows.map((r) => `| ${columns.map((c) => String(c.value(r))).join(' | ')} |`)].join('\n');
}

export function loadColumns() {
  return [
    { label: 'Run', value: (r) => r.label },
    { label: 'Requests', value: (r) => r.ok + (r.errors ? ` (+${r.errors} err)` : '') },
    { label: 'p50', value: (r) => fmtMs(r.p50Ms) },
    { label: 'p95', value: (r) => fmtMs(r.p95Ms) },
    { label: 'avg', value: (r) => fmtMs(r.avgMs) },
    { label: 'req/s', value: (r) => r.rps.toFixed(0) },
    { label: 'X-Cache', value: (r) => Object.entries(r.xcache).map(([k, v]) => `${k}:${v}`).join(' ') || '-' },
  ];
}
