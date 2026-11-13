// Cache slow database queries inside your own Node.js app.
// Run:  node examples/db-query-cache.js            (in-memory)
//       REDIS_URL=redis://localhost:6379 node examples/db-query-cache.js
//
// Replace `slowQuery` with your real call, e.g. pg:  (sql, params) => pool.query(sql, params).then(r => r.rows)
import { createCache } from '../src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let queries = 0;
async function slowQuery(sql, params) {
  queries++;
  await sleep(400); // a heavy JOIN / aggregate
  return [{ id: params[0], name: 'Top product', revenue: 125_000 }];
}

const cache = await createCache({
  redisUrl: process.env.REDIS_URL, // omit -> in-process memory cache
  prefix: 'shop',
  ttl: 120, // seconds a result is fresh
  staleWhileRevalidate: 60, // then served instantly while it refreshes in the background
  staleIfError: 3600, // database down -> last good result for up to 1 hour
});

const topProducts = (categoryId) =>
  cache.wrap(
    ['top-products', { categoryId }], // any JSON key; property order does not matter
    () => slowQuery('SELECT ... FROM orders JOIN products ... WHERE category_id = $1', [categoryId]),
    { tags: ['products', `category:${categoryId}`] },
  );

for (let i = 1; i <= 3; i++) {
  const t = performance.now();
  await topProducts(7);
  console.log(`call ${i}: ${(performance.now() - t).toFixed(1)} ms`);
}

// 100 simultaneous requests for a key nobody has cached yet -> still one query.
await cache.invalidate(['category:7']);
const before = queries;
await Promise.all(Array.from({ length: 100 }, () => topProducts(7)));
console.log(`100 concurrent callers -> ${queries - before} database query`);

// After a write, drop everything tagged with the category.
await cache.invalidate(['category:7']);
console.log('invalidated; next call goes to the database again');
await cache.close();
