import { randomBytes } from 'node:crypto';
import { startMockApi } from './mock-api.js';
import { startGateway } from './server.js';
import { createStore } from './store/index.js';
import { loadConfig, starterConfig } from './config.js';
import { runLoad, improvement, fmtMs, fmtPct, table, mdTable, loadColumns } from './bench.js';
import { summarize } from './stats.js';
import { silentLogger } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * End-to-end proof: slow mock API -> direct load test -> same load through the
 * gateway -> correctness and safety checks. Returns a result object; never needs
 * Redis (falls back to memory) but uses it when redisUrl is given.
 */
export async function runDemo({ requests = 400, concurrency = 10, latencyMs = 350, redisUrl, log = console.log, logger = silentLogger } = {}) {
  const mock = await startMockApi({ latencyMs });
  const prefix = `rcg-demo-${randomBytes(4).toString('hex')}`;
  const base = starterConfig(mock.url);
  base.routes.push({ name: 'inventory', path: '/api/inventory', ttl: 1, staleWhileRevalidate: 0, staleIfError: 300 });
  base.routes.push({ name: 'session', path: '/api/session', ttl: 60 });
  const { config } = loadConfig({
    file: false,
    overrides: {
      ...base, port: 0, host: '127.0.0.1', store: redisUrl ? 'redis' : 'memory', adminToken: randomBytes(24).toString('hex'),
      redis: { url: redisUrl ?? null, prefix }, statsFlushMs: 0, logLevel: 'silent',
    },
  });
  const store = await createStore(config, logger);
  if (store.kind === 'redis' && !store.isUp()) {
    await store.close();
    await mock.close();
    throw new Error(`Redis is not reachable at ${redisUrl}`);
  }
  const gw = await startGateway(config, { store, logger });
  const checks = [];
  const check = (name, pass, detail) => {
    checks.push({ name, pass: Boolean(pass), detail });
    log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  };
  const get = (path, headers = {}) => fetch(gw.url + path, { headers }).then(async (r) => ({ status: r.status, xcache: r.headers.get('x-cache'), reason: r.headers.get('x-cache-reason'), headers: r.headers, body: await r.json() }));

  try {
    const paths = [...Array.from({ length: 20 }, (_, i) => `/api/products/${i + 1}`), '/api/products', '/api/reports/sales?period=30d'];
    log(`\nRedis API Caching Gateway - demo`);
    log(`  slow API     ${mock.url}  (simulated DB latency ~${latencyMs} ms, reports ~${Math.round(latencyMs * 2.5)} ms)`);
    log(`  gateway      ${gw.url}  (store: ${store.kind}${store.kind === 'redis' ? `, prefix ${prefix}` : ' - pass --redis to use Redis'})`);
    log(`  load         ${requests} GET requests over ${paths.length} endpoints, concurrency ${concurrency}\n`);

    log('1) Direct to the API (no cache)...');
    const direct = { label: 'API direct', ...(await runLoad({ base: mock.url, paths, requests, concurrency })) };
    log('2) First request per endpoint through the gateway (cold cache)...');
    const cold = { label: 'Gateway, cold (MISS)', ...(await runLoad({ base: gw.url, paths, requests: paths.length, concurrency })) };
    // Unmeasured warm-up so V8 has compiled the hot path, as in a gateway that has been running for a while.
    await runLoad({ base: gw.url, paths, requests: 500, concurrency });
    mock.resetCalls();
    log('3) Same load through the gateway (warm cache, steady state)...');
    const warm = { label: 'Gateway, warm', ...(await runLoad({ base: gw.url, paths, requests, concurrency })) };
    const apiCallsDuringWarm = Object.values(mock.calls()).reduce((a, b) => a + b, 0);
    const imp = improvement(direct, warm);

    log('\n' + table([direct, cold, warm], loadColumns()) + '\n');
    log(`  Median response time: ${fmtMs(direct.p50Ms)} -> ${fmtMs(warm.p50Ms)}  =  ${fmtPct(imp.p50)} faster`);
    log(`  Throughput: ${imp.throughputX.toFixed(1)}x  |  API/database calls during warm run: ${apiCallsDuringWarm} of ${requests}\n`);

    log('4) Checks');
    check('cached responses are at least 90% faster (p50)', imp.p50 >= 0.9, fmtPct(imp.p50));
    check('warm run did not touch the database', apiCallsDuringWarm === 0, `${apiCallsDuringWarm} upstream calls`);
    check('no errors under load', direct.errors + cold.errors + warm.errors === 0);

    const viaApi = await fetch(`${mock.url}/api/products/7`).then((r) => r.json());
    const viaGw = await get('/api/products/7');
    check('cached body is identical to the API body', JSON.stringify(viaApi) === JSON.stringify(viaGw.body) && viaGw.xcache === 'HIT', `X-Cache ${viaGw.xcache}`);

    const put = await fetch(`${gw.url}/api/products/7`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ price: 1.23 }) });
    await put.arrayBuffer();
    const afterPut = await get('/api/products/7');
    const listAfterPut = await get('/api/products');
    check('a write invalidates the item and the list (no stale data)',
      afterPut.xcache === 'MISS' && afterPut.body.price === 1.23 && listAfterPut.xcache === 'MISS' && listAfterPut.body.items[6].price === 1.23,
      `${put.headers.get('x-cache-invalidated')} entries invalidated`);
    const again = await get('/api/products/7');
    check('the next read is cached again', again.xcache === 'HIT');

    await gw.gateway.invalidate(['reports']);
    mock.resetCalls();
    const burst = await Promise.all(Array.from({ length: 50 }, () => get('/api/reports/sales?period=30d')));
    const reportCalls = mock.calls('GET /api/reports/sales');
    check('50 simultaneous cold requests -> 1 database query (stampede protection)', reportCalls === 1 && burst.every((r) => r.status === 200), `${reportCalls} upstream call(s)`);

    const alice1 = await get('/api/me', { authorization: 'Bearer alice' });
    const bob = await get('/api/me', { authorization: 'Bearer bob' });
    const alice2 = await get('/api/me', { authorization: 'Bearer alice' });
    check('per-user data is cached per user, never shared', alice1.body.user === 'alice' && bob.body.user === 'bob' && alice2.body.user === 'alice' && alice2.xcache === 'HIT');

    const unauthShared = await get('/api/products/3', { authorization: 'Bearer eve' });
    check('authenticated requests on shared routes bypass the cache', unauthShared.xcache === 'BYPASS' && unauthShared.reason === 'authorization');

    await get('/api/session');
    const session2 = await get('/api/session');
    check('responses that set cookies are never cached', session2.xcache === 'MISS' && session2.reason === 'set-cookie');

    await get('/api/inventory');
    await sleep(1100);
    mock.setFailing(true);
    const outage = await get('/api/inventory');
    mock.setFailing(false);
    check('API outage -> last good data is served (stale-if-error)', outage.status === 200 && outage.xcache === 'STALE' && outage.reason === 'stale-if-error', `status ${outage.status}, X-Cache ${outage.xcache}`);

    await gw.gateway.stats.flush();
    const summary = summarize(await store.getStats());
    const t = summary.total;
    log(`\n5) Gateway stats: hit rate ${fmtPct(t.hitRate)}, ${t.upstreamCallsAvoided} database calls avoided, avg API ${fmtMs(t.avgUpstreamMs)} vs avg cache ${fmtMs(t.avgCacheMs)}, ${(t.savedMs / 1000).toFixed(1)} s of waiting saved`);

    const passed = checks.every((c) => c.pass);
    log(`\n${passed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'} (${checks.filter((c) => c.pass).length}/${checks.length})\n`);
    return { passed, checks, runs: { direct, cold, warm }, improvement: imp, apiCallsDuringWarm, stats: summary, store: store.kind, latencyMs, requests, concurrency };
  } finally {
    if (store.kind === 'redis') {
      await store.purgeAll().catch(() => {});
      await store.resetStats().catch(() => {});
    }
    await gw.close();
    await store.close();
    await mock.close();
  }
}

/** Markdown report for clients. */
export function demoReport(r) {
  const cols = loadColumns();
  const lines = [
    '# Redis API Caching Gateway - performance report',
    '',
    `Generated ${new Date().toISOString()} | cache store: ${r.store} | ${r.requests} requests, concurrency ${r.concurrency}, simulated query latency ~${r.latencyMs} ms`,
    '',
    '## Result',
    '',
    `- **Median response time:** ${fmtMs(r.runs.direct.p50Ms)} -> ${fmtMs(r.runs.warm.p50Ms)} (**${fmtPct(r.improvement.p50)} faster**)`,
    `- **95th percentile:** ${fmtMs(r.runs.direct.p95Ms)} -> ${fmtMs(r.runs.warm.p95Ms)} (${fmtPct(r.improvement.p95)} faster)`,
    `- **Throughput:** ${r.runs.direct.rps.toFixed(0)} -> ${r.runs.warm.rps.toFixed(0)} req/s (${r.improvement.throughputX.toFixed(1)}x)`,
    `- **Database calls during the warm run:** ${r.apiCallsDuringWarm} of ${r.requests}`,
    '',
    '## Load test',
    '',
    mdTable([r.runs.direct, r.runs.cold, r.runs.warm], cols),
    '',
    '## Safety and correctness checks',
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...r.checks.map((c) => `| ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.detail ?? ''} |`),
    '',
  ];
  return lines.join('\n');
}
