import http from 'node:http';

/**
 * A deliberately slow REST API that simulates expensive database queries.
 * Used by `rcg demo`, `rcg mock-api` and the tests.
 *
 * GET  /api/products            list (JOIN + sort)         ~1.2 x latency
 * GET  /api/products/:id        single row                 ~1.0 x latency
 * PUT  /api/products/:id        update row                 ~0.5 x latency
 * GET  /api/reports/sales       heavy aggregate            ~2.5 x latency
 * GET  /api/inventory           stock levels               ~1.0 x latency
 * GET  /api/me                  per-user profile (Authorization: Bearer <user>)
 * GET  /api/orders/:id          never cached by the sample config
 */
export async function startMockApi({ port = 0, host = '127.0.0.1', latencyMs = 350, jitter = 0.2 } = {}) {
  const products = new Map();
  for (let i = 1; i <= 50; i++) {
    products.set(String(i), { id: i, name: `Product ${i}`, price: Number((9.99 + i * 3.5).toFixed(2)), stock: 100 + i, updatedAt: new Date(0).toISOString() });
  }
  const calls = new Map();
  const state = { failing: false, latencyMs };

  const wait = (factor = 1) => new Promise((r) => setTimeout(r, state.latencyMs * factor * (1 - jitter + Math.random() * jitter * 2)));
  const send = (res, status, body, headers = {}) => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, ...headers });
    res.end(data);
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); }
    });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    calls.set(`${req.method} ${p}`, (calls.get(`${req.method} ${p}`) ?? 0) + 1);
    if (p === '/__mock/stats') return send(res, 200, Object.fromEntries(calls));
    if (state.failing) return send(res, 503, { error: 'database unavailable' });

    let m;
    if (req.method === 'GET' && p === '/api/products') {
      await wait(1.2);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return send(res, 200, { items: [...products.values()].slice(0, limit), total: products.size, generatedAt: new Date().toISOString() });
    }
    if ((m = p.match(/^\/api\/products\/([^/]+)$/))) {
      if (req.method === 'GET') {
        await wait(1);
        const item = products.get(m[1]);
        return item ? send(res, 200, item) : send(res, 404, { error: 'not_found' });
      }
      if (req.method === 'PUT' || req.method === 'PATCH') {
        const body = await readBody(req);
        await wait(0.5);
        const item = products.get(m[1]);
        if (!item) return send(res, 404, { error: 'not_found' });
        Object.assign(item, body, { id: item.id, updatedAt: new Date().toISOString() });
        return send(res, 200, item);
      }
    }
    if (req.method === 'GET' && p === '/api/reports/sales') {
      await wait(2.5);
      const revenue = [...products.values()].reduce((s, x) => s + x.price * (200 - x.stock), 0);
      return send(res, 200, { period: url.searchParams.get('period') ?? '30d', revenue: Math.round(revenue), orders: 4212, generatedAt: new Date().toISOString() });
    }
    if (req.method === 'GET' && p === '/api/inventory') {
      await wait(1);
      return send(res, 200, { skus: products.size, inStock: [...products.values()].filter((x) => x.stock > 0).length, at: Date.now() });
    }
    if (req.method === 'GET' && p === '/api/me') {
      await wait(0.6);
      const user = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!user) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { user, plan: 'pro' }, { 'cache-control': 'private, max-age=30' });
    }
    if (req.method === 'GET' && p === '/api/session') {
      return send(res, 200, { ok: true }, { 'set-cookie': 'sid=abc; HttpOnly' });
    }
    if (req.method === 'GET' && (m = p.match(/^\/api\/orders\/([^/]+)$/))) {
      await wait(0.8);
      return send(res, 200, { id: m[1], status: 'shipped' });
    }
    return send(res, 404, { error: 'not_found' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host}:${server.address().port}`;
  return {
    url,
    server,
    products,
    calls: (key) => (key ? calls.get(key) ?? 0 : Object.fromEntries(calls)),
    resetCalls: () => calls.clear(),
    setFailing: (v) => { state.failing = v; },
    setLatency: (ms) => { state.latencyMs = ms; },
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }),
  };
}
