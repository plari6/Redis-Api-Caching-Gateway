import http from 'node:http';
import { loadConfig, starterConfig } from '../src/config.js';
import { startGateway } from '../src/server.js';
import { MemoryStore } from '../src/store/memory.js';
import { silentLogger } from '../src/log.js';

export const TOKEN = 'test-admin-token-0123456789abcdef';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a config the way the CLI does, without reading files or the user's env-driven store choice. */
export function makeConfig(upstream, overrides = {}) {
  const base = starterConfig(upstream);
  return loadConfig({
    file: false,
    overrides: {
      ...base, port: 0, host: '127.0.0.1', store: 'memory', adminToken: TOKEN, statsFlushMs: 0, logLevel: 'silent',
      redis: { url: null, prefix: 'rcg-test' }, ...overrides,
    },
  }).config;
}

export async function startGw(upstream, overrides = {}, store = new MemoryStore()) {
  const gw = await startGateway(makeConfig(upstream, overrides), { store, logger: silentLogger });
  return { gw, store, url: gw.url };
}

/** Minimal programmable upstream: handler(req, res, body, n) */
export async function startUpstream(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers });
      try { await handler(req, res, Buffer.concat(chunks), calls.length); } catch (err) { res.statusCode = 500; res.end(String(err)); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    count: (pred = () => true) => calls.filter(pred).length,
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  };
}

export const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** Raw HTTP GET (no automatic decompression) -> { status, headers, body: Buffer } */
export function rawGet(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function get(url, headers = {}) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, headers: r.headers, xcache: r.headers.get('x-cache'), reason: r.headers.get('x-cache-reason'), body };
}
