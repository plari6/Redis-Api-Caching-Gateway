/**
 * Express middleware that caches JSON responses of GET routes inside an existing app.
 *
 *   const cache = await createCache({ redisUrl: process.env.REDIS_URL });
 *   app.get('/api/products', cacheResponse(cache, { ttl: 120, tags: ['products'] }), handler);
 *   app.put('/api/products/:id', invalidateOnSuccess(cache, (req) => ['products', `product:${req.params.id}`]), handler);
 *
 * Only 2xx res.json() bodies are cached. Requests with Authorization are not
 * cached unless you pass varyBy: ['header:authorization'] (one entry per user).
 */
export function cacheResponse(cache, { ttl = 60, tags = [], key, varyBy = [], staleWhileRevalidate, staleIfError } = {}) {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const vary = varyBy.map((v) => String(v).toLowerCase());
    if (req.headers.authorization && !vary.includes('header:authorization')) return next();
    const parts = vary.map((v) => req.headers[v.replace(/^header:/, '')] ?? '');
    const cacheKey = ['mw', key ? key(req) : req.originalUrl, ...parts];

    const hit = await cache.get(cacheKey);
    if (hit) {
      res.set('x-cache', 'HIT');
      return res.status(hit.status).json(hit.body);
    }
    const json = res.json.bind(res);
    res.json = (body) => {
      res.set('x-cache', 'MISS');
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const t = typeof tags === 'function' ? tags(req, body) : tags;
        cache.set(cacheKey, { status: res.statusCode, body }, { ttl, tags: t, staleWhileRevalidate, staleIfError }).catch(() => {});
      }
      return json(body);
    };
    next();
  };
}

/** Invalidate tags after a successful (2xx/3xx) write. */
export function invalidateOnSuccess(cache, tagsFor) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode < 400) cache.invalidate(typeof tagsFor === 'function' ? tagsFor(req) : tagsFor).catch(() => {});
    });
    next();
  };
}
