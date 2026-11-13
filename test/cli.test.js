import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockApi } from '../src/mock-api.js';

const CLI = fileURLToPath(new URL('../bin/rcg.js', import.meta.url));
const cleanEnv = { ...process.env };
for (const k of ['REDIS_URL', 'CACHE_ADMIN_TOKEN', 'UPSTREAM_URL', 'PORT', 'CACHE_PREFIX', 'LOG_LEVEL']) delete cleanEnv[k];
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: cleanEnv, timeout: 120_000 });
// async variant: needed when the test process itself hosts a server the CLI talks to
const runAsync = (args, cwd) => new Promise((resolve) => {
  const p = spawn(process.execPath, [CLI, ...args], { cwd, env: cleanEnv });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rcg-'));

test('cli: help and version', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  for (const cmd of ['init', 'check', 'serve', 'demo', 'bench', 'warm', 'stats', 'purge', 'inspect', 'mock-api']) assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`));
  assert.match(run(['--version']).stdout, /\d+\.\d+\.\d+/);
});

test('cli: init writes config + .env once, check validates', async () => {
  const dir = tmp();
  const api = await startMockApi({ latencyMs: 1 });
  try {
    assert.equal(run(['init', '--upstream', api.url], dir).status, 0);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'gateway.config.json'), 'utf8'));
    assert.equal(cfg.upstream, api.url);
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /CACHE_ADMIN_TOKEN=[0-9a-f]{48}/);
    assert.notEqual(run(['init'], dir).status, 0, 'refuses to overwrite');
    fs.writeFileSync(path.join(dir, '.env'), `CACHE_ADMIN_TOKEN=${'x'.repeat(40)}\n`);
    const check = await runAsync(['check'], dir);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /upstream\s+reachable/);
    assert.match(check.stdout, /product-writes/);
    assert.doesNotMatch(check.stdout, /no adminToken/, 'token picked up from .env');
    cfg.routes.push({ path: 'broken' });
    fs.writeFileSync(path.join(dir, 'gateway.config.json'), JSON.stringify(cfg));
    const bad = await runAsync(['check'], dir);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /path must start/);
  } finally { await api.close(); }
});

test('cli: demo passes all checks and writes a report', () => {
  const dir = tmp();
  const r = run(['demo', '-n', '120', '--latency', '120', '--report', 'report.md'], dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ALL CHECKS PASSED/);
  const md = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  assert.match(md, /faster/);
  assert.doesNotMatch(md, /\| FAIL \|/);
});

test('cli: serve + bench + warm against a live gateway', async () => {
  const dir = tmp();
  const api = await startMockApi({ latencyMs: 60 });
  fs.writeFileSync(path.join(dir, 'gateway.config.json'), JSON.stringify({ upstream: api.url, routes: [{ name: 'p', path: '/api/products/:id', ttl: 60 }] }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [CLI, 'serve', '--port', String(port), '--memory'], { cwd: dir, env: cleanEnv });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  try {
    for (let i = 0; i < 50 && !log.includes('gateway listening'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(log, /gateway listening/);
    const gw = `http://127.0.0.1:${port}`;
    const warm = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'warm', gw, '--paths', '/api/products/1,/api/products/2'], { cwd: dir, env: cleanEnv });
      let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(warm.code, 0);
    assert.match(warm.out, /warmed 2\/2/);
    const bench = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'bench', gw, '--direct', api.url, '--paths', '/api/products/1,/api/products/2', '-n', '40', '--json'], { cwd: dir, env: cleanEnv });
      let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(bench.code, 0);
    const result = JSON.parse(bench.out);
    assert.ok(result.improvement.p50 > 0.8, `p50 improvement ${result.improvement.p50}`);
  } finally {
    child.kill('SIGTERM');
    await api.close();
  }
});

test('cli: stats/purge explain that they need Redis when none is configured', () => {
  const dir = tmp();
  const r = run(['purge', '--all'], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /needs Redis/);
});
