#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Command } from 'commander';
import { loadConfig, starterConfig, CONFIG_FILE } from '../src/config.js';
import { createStore, redactUrl } from '../src/store/index.js';
import { startGateway } from '../src/server.js';
import { startMockApi } from '../src/mock-api.js';
import { runDemo, demoReport } from '../src/demo.js';
import { runLoad, improvement, table, mdTable, loadColumns, fmtMs, fmtPct } from '../src/bench.js';
import { summarize } from '../src/stats.js';
import { compileRoutes, matchRoute } from '../src/router.js';
import { buildKey, normalizeQuery } from '../src/key.js';
import { decodeEntry, classify } from '../src/entry.js';
import { createLogger } from '../src/log.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command();

program
  .name('rcg')
  .description('Redis API Caching Gateway - make slow APIs and database queries answer in milliseconds')
  .version(pkg.version)
  .option('-c, --config <file>', `config file (default: ./${CONFIG_FILE} if present)`)
  .option('--env-file <file>', 'load environment variables from this file', '.env')
  .hook('preAction', (cmd) => {
    const envFile = cmd.opts().envFile;
    if (envFile && fs.existsSync(envFile)) process.loadEnvFile(envFile);
  });

const cfgFrom = (cmd, overrides = {}, requireUpstream = false) => {
  const { config, warnings, file } = loadConfig({ file: cmd.optsWithGlobals().config, overrides, requireUpstream });
  return { config, warnings, file };
};
const out = (s = '') => process.stdout.write(s + '\n');
const fail = (msg, code = 1) => { process.stderr.write(`error: ${msg}\n`); process.exit(code); };
const readPaths = (spec) => {
  if (!spec) return null;
  if (fs.existsSync(spec)) {
    return fs.readFileSync(spec, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  return spec.split(',').map((s) => s.trim()).filter(Boolean);
};

// ------------------------------------------------------------------ init
program.command('init')
  .description(`create ${CONFIG_FILE} and .env.example in the current folder`)
  .option('-u, --upstream <url>', 'the slow API to put the cache in front of', 'http://localhost:4000')
  .option('-f, --force', 'overwrite an existing config')
  .action((opts) => {
    if (fs.existsSync(CONFIG_FILE) && !opts.force) fail(`${CONFIG_FILE} already exists (use --force to overwrite)`);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(starterConfig(opts.upstream), null, 2) + '\n');
    out(`created ${CONFIG_FILE} (upstream ${opts.upstream})`);
    const envLines = ['REDIS_URL=redis://localhost:6379', `CACHE_ADMIN_TOKEN=${randomBytes(24).toString('hex')}`, 'LOG_LEVEL=info'];
    if (!fs.existsSync('.env')) {
      fs.writeFileSync('.env', envLines.join('\n') + '\n');
      out('created .env with a random CACHE_ADMIN_TOKEN (keep it out of git)');
    } else {
      out('.env exists - left untouched');
    }
    if (!fs.existsSync('.env.example')) fs.writeFileSync('.env.example', 'REDIS_URL=redis://localhost:6379\nCACHE_ADMIN_TOKEN=\nLOG_LEVEL=info\n');
    out('next: edit the routes, then run "rcg check" and "rcg serve"');
  });

// ------------------------------------------------------------------ check
program.command('check')
  .description('validate the config and test Redis and the upstream API')
  .action(async (opts, cmd) => {
    let cfg;
    try { cfg = cfgFrom(cmd, {}, true); } catch (err) { fail(err.message); }
    const { config, warnings, file } = cfg;
    out(`config     ${file ?? '(none - defaults + env)'}`);
    out(`upstream   ${config.upstream}`);
    const routes = compileRoutes(config.routes, config.defaults);
    out(`routes     ${routes.length}${config.cacheUnmatched ? ' (+ cache everything else)' : ' (unmatched paths pass through)'}`);
    out(table(routes, [
      { label: 'name', value: (r) => r.name },
      { label: 'methods', value: (r) => r.methods.filter((m) => m !== 'HEAD').join(',') },
      { label: 'path', value: (r) => r.path },
      { label: 'action', value: (r) => (r.cache === false ? 'pass-through' : r.invalidates.length && !r.methods.includes('GET') ? `invalidate ${r.invalidates.join(',')}` : `cache ${r.ttl}s (+swr ${r.staleWhileRevalidate}s, if-error ${r.staleIfError}s)`) },
      { label: 'varyBy', value: (r) => r.varyBy.join(',') || '-' },
    ]).split('\n').map((l) => '  ' + l).join('\n'));
    let ok = true;
    const store = await createStore(config, createLogger('silent'));
    try {
      if (store.kind === 'redis') {
        if (!store.isUp()) { ok = false; out(`redis      DOWN (${redactUrl(config.redis.url)}) - the gateway would run without cache`); }
        else {
          const ping = await store.ping();
          const info = await store.info();
          out(`redis      up ${ping.toFixed(1)} ms, v${info.version}, memory ${info.usedMemory}, maxmemory ${info.maxMemory} (${info.evictionPolicy}), ${info.entries} cached entries`);
          if (info.maxMemory === '0B') warnings.push('Redis has no maxmemory limit: set maxmemory + maxmemory-policy allkeys-lru (or volatile-lru) so the cache cannot fill the server');
          else if (!/lru|lfu/.test(info.evictionPolicy ?? '')) warnings.push(`Redis eviction policy is ${info.evictionPolicy}; use allkeys-lru or volatile-lru for a cache`);
        }
      } else out('redis      not configured - in-memory cache');
    } finally { await store.close(); }
    try {
      const t = performance.now();
      const r = await fetch(config.upstream, { signal: AbortSignal.timeout(5000) });
      await r.arrayBuffer();
      out(`upstream   reachable (HTTP ${r.status}, ${fmtMs(performance.now() - t)})`);
    } catch (err) { ok = false; out(`upstream   NOT reachable: ${err.cause?.code ?? err.message}`); }
    for (const w of warnings) out(`warning    ${w}`);
    process.exitCode = ok ? 0 : 1;
  });

// ------------------------------------------------------------------ serve
program.command('serve')
  .description('run the caching gateway')
  .option('-p, --port <n>', 'port', (v) => Number(v))
  .option('-u, --upstream <url>', 'upstream API base URL')
  .option('--redis <url>', 'Redis URL (overrides REDIS_URL)')
  .option('--memory', 'use the in-process memory store instead of Redis')
  .action(async (opts, cmd) => {
    let cfg;
    try {
      cfg = cfgFrom(cmd, {
        port: opts.port, upstream: opts.upstream, store: opts.memory ? 'memory' : undefined,
        redis: opts.redis ? { url: opts.redis } : undefined,
      }, true);
    } catch (err) { fail(err.message); }
    const logger = createLogger(cfg.config.logLevel);
    for (const w of cfg.warnings) logger.warn(w);
    let gw;
    try { gw = await startGateway(cfg.config, { logger }); } catch (err) { fail(err.message); }
    const stop = async (sig) => {
      logger.info(`${sig} received, shutting down`);
      const force = setTimeout(() => process.exit(1), 10_000);
      force.unref();
      await gw.close();
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

// ------------------------------------------------------------------ demo
program.command('demo')
  .description('prove the speed-up: slow mock API vs the gateway, plus safety checks')
  .option('-n, --requests <n>', 'requests per load run', (v) => Number(v), 400)
  .option('--concurrency <n>', 'parallel clients', (v) => Number(v), 10)
  .option('--latency <ms>', 'simulated database latency', (v) => Number(v), 350)
  .option('--redis [url]', 'use Redis (default REDIS_URL or redis://127.0.0.1:6379)')
  .option('--report <file>', 'write a Markdown report for the client')
  .option('--json', 'print the result as JSON')
  .action(async (opts) => {
    const redisUrl = opts.redis === true ? process.env.REDIS_URL || 'redis://127.0.0.1:6379' : opts.redis || undefined;
    try {
      const result = await runDemo({
        requests: opts.requests, concurrency: opts.concurrency, latencyMs: opts.latency, redisUrl,
        log: opts.json ? () => {} : out,
      });
      if (opts.report) { fs.writeFileSync(opts.report, demoReport(result)); if (!opts.json) out(`report written to ${path.resolve(opts.report)}`); }
      if (opts.json) out(JSON.stringify(result, null, 2));
      process.exitCode = result.passed ? 0 : 1;
    } catch (err) { fail(err.message); }
  });

// ------------------------------------------------------------------ bench
program.command('bench')
  .description('load-test a running gateway, optionally against the API directly')
  .argument('<gateway>', 'gateway base URL, e.g. http://localhost:8080')
  .requiredOption('--paths <list|file>', 'comma-separated paths or a file with one path per line')
  .option('--direct <url>', 'API base URL to compare against (same paths, no cache)')
  .option('-n, --requests <n>', 'requests per run', (v) => Number(v), 300)
  .option('--concurrency <n>', 'parallel clients', (v) => Number(v), 10)
  .option('-H, --header <header...>', 'extra request header, "Name: value"')
  .option('--report <file>', 'write a Markdown report')
  .option('--json', 'print JSON')
  .action(async (gateway, opts) => {
    const paths = readPaths(opts.paths);
    if (!paths?.length) fail('no paths');
    const headers = Object.fromEntries((opts.header ?? []).map((h) => { const i = h.indexOf(':'); return [h.slice(0, i).trim(), h.slice(i + 1).trim()]; }));
    const log = opts.json ? () => {} : out;
    const runs = [];
    if (opts.direct) { log('running direct...'); runs.push({ label: 'API direct', ...(await runLoad({ base: opts.direct, paths, requests: opts.requests, concurrency: opts.concurrency, headers })) }); }
    log('warming the gateway...');
    runs.push({ label: 'Gateway, first pass', ...(await runLoad({ base: gateway, paths, requests: paths.length, concurrency: opts.concurrency, headers })) });
    log('running through the gateway...');
    runs.push({ label: 'Gateway, warm', ...(await runLoad({ base: gateway, paths, requests: opts.requests, concurrency: opts.concurrency, headers })) });
    const imp = opts.direct ? improvement(runs[0], runs.at(-1)) : null;
    if (opts.json) return out(JSON.stringify({ runs, improvement: imp }, null, 2));
    out('\n' + table(runs, loadColumns()));
    if (imp) out(`\nmedian ${fmtPct(imp.p50)} faster, p95 ${fmtPct(imp.p95)} faster, throughput ${imp.throughputX.toFixed(1)}x`);
    if (opts.report) {
      const md = [`# Cache benchmark`, '', `${new Date().toISOString()} | ${opts.requests} requests over ${paths.length} paths, concurrency ${opts.concurrency}`, '', mdTable(runs, loadColumns()), '',
        imp ? `**Median ${fmtPct(imp.p50)} faster, p95 ${fmtPct(imp.p95)} faster, throughput ${imp.throughputX.toFixed(1)}x.**\n` : ''].join('\n');
      fs.writeFileSync(opts.report, md);
      out(`report written to ${path.resolve(opts.report)}`);
    }
  });

// ------------------------------------------------------------------ warm
program.command('warm')
  .description('pre-load the cache by requesting paths through the gateway')
  .argument('<gateway>', 'gateway base URL')
  .requiredOption('--paths <list|file>', 'comma-separated paths or a file')
  .option('--concurrency <n>', 'parallel requests', (v) => Number(v), 4)
  .action(async (gateway, opts) => {
    const paths = readPaths(opts.paths);
    const r = await runLoad({ base: gateway, paths, requests: paths.length, concurrency: opts.concurrency });
    out(`warmed ${r.ok}/${paths.length} paths in ${fmtMs(r.elapsedMs)} - ${Object.entries(r.xcache).map(([k, v]) => `${k}:${v}`).join(' ')}`);
    if (r.errors) process.exitCode = 1;
  });

// ------------------------------------------------------------------ stats
program.command('stats')
  .description('hit rate, database calls avoided and time saved, per route (shared across instances)')
  .option('--json', 'print JSON')
  .option('--reset', 'reset the counters after printing')
  .action(async (opts, cmd) => {
    const { config } = cfgFrom(cmd);
    const store = await createStore(config, createLogger('silent'));
    try {
      if (store.kind === 'memory') fail('stats need the shared Redis store (memory stats live inside the running gateway: GET /__cache/stats)');
      if (!store.isUp()) fail('Redis is not reachable');
      const s = summarize(await store.getStats());
      if (opts.json) out(JSON.stringify(s, null, 2));
      else if (!s.routes.length) out('no traffic recorded yet');
      else {
        out(table([...s.routes, s.total], [
          { label: 'route', value: (r) => r.route },
          { label: 'requests', value: (r) => r.requests },
          { label: 'hit rate', value: (r) => fmtPct(r.hitRate) },
          { label: 'hits', value: (r) => r.hits },
          { label: 'stale', value: (r) => r.stale },
          { label: 'misses', value: (r) => r.misses },
          { label: 'bypass', value: (r) => r.bypass },
          { label: 'avg API', value: (r) => fmtMs(r.avgUpstreamMs) },
          { label: 'avg cache', value: (r) => fmtMs(r.avgCacheMs) },
          { label: 'faster', value: (r) => fmtPct(r.fasterPct) },
          { label: 'DB calls avoided', value: (r) => r.upstreamCallsAvoided },
          { label: 'time saved', value: (r) => `${(r.savedMs / 1000).toFixed(1)} s` },
        ]));
        if (s.total.upstreamErrors || s.total.storeErrors) out(`\nupstream errors ${s.total.upstreamErrors}, redis errors ${s.total.storeErrors}`);
      }
      if (opts.reset) { await store.resetStats(); out('counters reset'); }
    } finally { await store.close(); }
  });

// ------------------------------------------------------------------ purge
program.command('purge')
  .description('invalidate cache entries by tag or path, or everything')
  .option('-t, --tag <tag...>', 'tag(s), e.g. products product:42')
  .option('-p, --path <path...>', 'exact path(s), e.g. /api/products/42 (all query/user variants)')
  .option('--all', 'remove every cached entry under this prefix')
  .action(async (opts, cmd) => {
    const { config } = cfgFrom(cmd);
    const tags = [...(opts.tag ?? []), ...(opts.path ?? []).map((p) => `path:${p}`)];
    if (!opts.all && !tags.length) fail('pass --tag, --path or --all');
    const store = await createStore(config, createLogger('silent'));
    try {
      if (store.kind === 'memory') fail('purge from the CLI needs Redis; for a memory store use POST /__cache/purge on the running gateway');
      if (!store.isUp()) fail('Redis is not reachable');
      const n = opts.all ? await store.purgeAll() : await store.invalidateTags(tags);
      out(`purged ${n} entr${n === 1 ? 'y' : 'ies'}`);
    } finally { await store.close(); }
  });

// ------------------------------------------------------------------ inspect
program.command('inspect')
  .description('show the cache entry for a path (anonymous variant)')
  .argument('<path>', 'e.g. "/api/products?limit=10"')
  .option('-H, --header <header...>', 'request header used by varyBy, "Name: value"')
  .action(async (target, opts, cmd) => {
    const { config } = cfgFrom(cmd);
    const url = new URL(target, 'http://x');
    const routes = compileRoutes(config.routes, config.defaults);
    const route = matchRoute(routes, 'GET', url.pathname)?.route ?? (config.cacheUnmatched ? compileRoutes([{ name: 'default', path: '/*' }], config.defaults)[0] : null);
    if (!route || route.cache === false) return out(`not cached: no caching rule matches ${url.pathname}`);
    const headers = Object.fromEntries((opts.header ?? []).map((h) => { const i = h.indexOf(':'); return [h.slice(0, i).trim().toLowerCase(), h.slice(i + 1).trim()]; }));
    const { varyParts } = await import('../src/key.js');
    const key = buildKey({
      pathname: url.pathname, query: normalizeQuery(url.searchParams, route.ignoreQuery, route.sortQuery),
      vary: varyParts(headers, route.varyBy), scope: String(route.upstream || config.upstream || '').replace(/\/+$/, ''),
    });
    out(`route      ${route.name}\nkey        ${key.raw}\nid         ${key.id}`);
    const store = await createStore(config, createLogger('silent'));
    try {
      if (store.kind === 'memory') return out('store      memory - entries live inside the running gateway (GET /__cache/inspect?url=...)');
      if (!store.isUp()) fail('Redis is not reachable');
      const buf = await store.get(key.id);
      if (!buf) return out('cached     no');
      const { meta, body } = decodeEntry(buf);
      const now = Date.now();
      out(`cached     yes (${classify(meta, now)})\nstatus     ${meta.s}\nage        ${Math.round((now - meta.t) / 1000)} s\nfresh for  ${Math.max(0, Math.round((meta.f - now) / 1000))} s\nkept for   ${Math.round((meta.e - now) / 1000)} s\nsize       ${body.length} bytes${meta.z ? ' (gzip)' : ''}\ntags       ${meta.tg.join(', ')}`);
    } finally { await store.close(); }
  });

// ------------------------------------------------------------------ mock-api
program.command('mock-api')
  .description('start the slow demo API (simulated database latency) for live demos')
  .option('-p, --port <n>', 'port', (v) => Number(v), 4000)
  .option('--latency <ms>', 'simulated query latency', (v) => Number(v), 350)
  .action(async (opts) => {
    const api = await startMockApi({ port: opts.port, host: '0.0.0.0', latencyMs: opts.latency });
    out(`slow demo API on http://localhost:${opts.port} (~${opts.latency} ms per query)`);
    out('try: rcg serve --upstream http://localhost:' + opts.port + '   then   curl -i http://localhost:8080/api/products');
    process.once('SIGINT', async () => { await api.close(); process.exit(0); });
  });

program.parseAsync().catch((err) => fail(err.message));
