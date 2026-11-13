// Add Redis caching to routes of an existing Express app (no separate gateway).
// Run: node examples/express-middleware.js   then   curl -i localhost:3000/products/1
import express from 'express';
import { createCache, cacheResponse, invalidateOnSuccess } from '../src/index.js';

const cache = await createCache({ redisUrl: process.env.REDIS_URL, prefix: 'myapp' });
const db = { 1: { id: 1, name: 'Desk', price: 199 } };
const app = express();
app.use(express.json());

app.get('/products/:id',
  cacheResponse(cache, { ttl: 300, tags: (req) => ['products', `product:${req.params.id}`] }),
  async (req, res) => {
    await new Promise((r) => setTimeout(r, 300)); // slow query
    const p = db[req.params.id];
    return p ? res.json(p) : res.status(404).json({ error: 'not_found' });
  });

// One cached copy per logged-in user.
app.get('/me', cacheResponse(cache, { ttl: 30, varyBy: ['header:authorization'] }), (req, res) => {
  res.json({ user: req.headers.authorization ?? 'anonymous' });
});

app.put('/products/:id',
  invalidateOnSuccess(cache, (req) => ['products', `product:${req.params.id}`]),
  (req, res) => {
    db[req.params.id] = { ...db[req.params.id], ...req.body };
    res.json(db[req.params.id]);
  });

app.listen(3000, () => console.log('listening on http://localhost:3000'));
