# Redis API Caching Gateway

Make slow APIs and database queries answer in milliseconds, without rewriting them.

Put the gateway in front of an existing API (no code changes), or use the same cache engine inside a Node.js app to wrap slow SQL queries. Repeated reads come from Redis in under a millisecond. Writes clear exactly the data they changed, and if the API or database goes down, users keep getting the last good answer.

**Stack:** JavaScript (Node.js 22+ ESM), Express 5, ioredis, commander. No LLM calls, because this is the request hot path. JavaScript fits here: the project card names Node.js, and a gateway plus CLI is small, single-runtime and quick to hand over.

## Results (`rcg demo`)

Slow mock API with ~350 ms simulated query time, 400 requests over 22 endpoints, 10 concurrent clients, on a laptop:

| Run | p50 | p95 | req/s |
| --- | ---: | ---: | ---: |
| API direct | 362 ms | 482 ms | 25 |
| Gateway, cold (MISS) | 372 ms | 449 ms | 13 |
| Gateway, warm | 7.8 ms | 11.9 ms | 1,296 |

- **97.9% faster median response, ~40x throughput.** During the warm run the database got 0 of 400 calls.
- Server-side, a cache hit takes about 0.3 ms. The client-side numbers above also include the load generator, which runs in the same process.
- A cache miss adds about 10 ms over calling the API directly.

The same run also checks 11 behaviours: identical bodies, write invalidation, stampede protection, per-user isolation, no caching of `Set-Cookie`, and stale-if-error during an outage. Run `rcg demo --report report.md` to get a Markdown report you can hand to a client.

## Quick start

```bash
npm install
node bin/rcg.js demo                     # proof in ~30 s, no Redis needed
node bin/rcg.js demo --redis             # same, against redis://127.0.0.1:6379 (or REDIS_URL)

node bin/rcg.js init --upstream https://api.client.com   # gateway.config.json + .env (random admin token)
node bin/rcg.js check                    # validate config, test Redis + upstream, warn on bad Redis eviction settings
node bin/rcg.js serve                    # gateway on :8080
curl -i localhost:8080/api/products      # X-Cache: MISS, then HIT
```

Docker (gateway + Redis with a memory limit and LRU eviction):

```bash
cp .env.example .env    # set UPSTREAM_URL and CACHE_ADMIN_TOKEN
docker compose up -d
docker compose --profile demo up -d      # also starts the slow demo API as the upstream
```

## Three ways to use it

### 1. Gateway: no code changes

Point clients (frontend, mobile app, n8n/Make, partners) at the gateway instead of the API. Caching is driven by `gateway.config.json`:

```json
{
  "upstream": "https://api.client.com",
  "redis": { "url": "env:REDIS_URL?", "prefix": "rcg" },
  "adminToken": "env:CACHE_ADMIN_TOKEN?",
  "routes": [
    { "name": "products-list", "path": "/api/products", "ttl": 120, "tags": ["products"] },
    { "name": "product", "path": "/api/products/:id", "ttl": 300, "tags": ["product:{id}"] },
    { "name": "product-writes", "path": "/api/products/:id?", "methods": ["POST", "PUT", "PATCH", "DELETE"],
      "invalidates": ["products", "product:{id}"] },
    { "name": "sales-report", "path": "/api/reports/*", "ttl": 900, "staleWhileRevalidate": 300 },
    { "name": "my-profile", "path": "/api/me", "ttl": 30, "private": true, "varyBy": ["header:authorization"] },
    { "name": "orders", "path": "/api/orders/*", "cache": false }
  ]
}
```

### 2. Cache slow database queries in your app

```js
import { createCache } from 'redis-api-caching-gateway';

const cache = await createCache({ redisUrl: process.env.REDIS_URL, ttl: 120, staleWhileRevalidate: 60, staleIfError: 3600 });

const top = await cache.wrap(['top-products', { categoryId }],
  () => pool.query('SELECT ... heavy JOIN ...', [categoryId]).then((r) => r.rows),
  { tags: ['products', `category:${categoryId}`] });

await cache.invalidate([`category:${categoryId}`]);   // after an UPDATE
```

`examples/db-query-cache.js` shows the result: 413 ms on the first call, then 0.1 ms, and 100 concurrent callers trigger 1 query.

### 3. Express middleware

```js
app.get('/products/:id', cacheResponse(cache, { ttl: 300, tags: (req) => [`product:${req.params.id}`] }), handler);
app.put('/products/:id', invalidateOnSuccess(cache, (req) => [`product:${req.params.id}`]), handler);
```

See `examples/express-middleware.js`.

## What it does

| Feature | Behaviour |
| --- | --- |
| Route rules | Express-style paths (`:id`, `:id?`, `*`). Each rule sets its own TTL, tags, vary and upstream. First match wins. Unmatched paths pass through unless `cacheUnmatched: true`. |
| Stampede protection | Concurrent misses for the same key make **one** upstream call. This works within one process and across instances (a Redis `SET NX PX` lock; other instances wait for the result). |
| Stale-while-revalidate | After the TTL ends, the old copy is served instantly while it refreshes in the background. |
| Stale-if-error | If the API returns 5xx, times out or can't be reached, the last good copy is served (`X-Cache: STALE`, `X-Cache-Reason: stale-if-error`). |
| Tag invalidation | Tags support `{param}` templates. A successful write invalidates its own path, its parent path (e.g. the list) and the rule's `invalidates` tags. This happens **before** the response is sent, so the client's next read is fresh. |
| Upstream-driven tags | The API can send `X-Cache-Tags` / `Surrogate-Key` to tag a response and `X-Cache-Invalidate` to purge. Both headers are stripped before the response reaches clients. |
| Key normalisation | Query parameters are sorted, and tracking parameters (`utm_*`, `fbclid`, `gclid`, ...) are dropped, so `?b=2&a=1&utm_source=x` and `?a=1&b=2` share one entry. |
| Compression | Bodies over 1 KB are stored gzipped (less Redis memory) and sent compressed to clients that accept gzip, with no recompression on hits. |
| Conditional GET | Generates an ETag when the API doesn't send one, and answers `If-None-Match` with `304` from cache. |
| HEAD | HEAD requests are answered from the GET entry. |
| Fail-open | If Redis goes down, requests go straight to the API (`X-Cache-Reason: store-unavailable`) with no hanging, because Redis commands fail fast. It reconnects automatically. |
| Observability | `X-Cache`, `X-Cache-Reason`, `X-Cache-Key` and `Age` headers on every response. Prometheus `/__cache/metrics`. Shared per-route stats (hit rate, DB calls avoided, time saved). |

### Safe by default

Caching the wrong thing is worse than not caching, so these responses are **never cached**:

- `Set-Cookie` responses. Concurrent requests also never share such a response: each one fetches its own.
- `Cache-Control: no-store` or `private`, except on rules marked `private` that vary per user.
- `Vary` on a header the rule doesn't vary by.
- Statuses not listed in `statuses` (5xx always), and bodies over `maxEntryBytes`.

These requests **bypass** the cache:

- Requests with `Authorization` or cookies, unless the rule varies by them (one entry per user/tenant, values hashed in the key) or sets `shareAuthenticated` / `ignoreCookies`.
- `Range` requests.

## Configuration reference

Top level: `upstream`, `port` (8080), `host`, `store` (`auto` | `redis` | `memory`), `redis.url`, `redis.prefix` (use `{rcg}` for Redis Cluster), `memory.maxBytes`, `adminPath` (`/__cache`), `adminToken`, `trustProxy` (hop count, e.g. `1`), `cacheUnmatched`, `maxBodyBytes` (`10mb`), `statsFlushMs`, `logLevel`.

`defaults` and per-route keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `ttl` | 60 | Seconds fresh. If a rule sets no `ttl`, the API's `s-maxage` / `max-age` is used. |
| `staleWhileRevalidate` | 30 | Seconds a stale copy is served while refreshing. |
| `staleIfError` | 600 | Seconds a stale copy may cover an API failure. |
| `tags` / `invalidates` | `[]` | Tags stored with the entry / tags removed by a successful write (`{param}` templates). |
| `varyBy` | `[]` | `header:<name>`, `cookie:<name>` |
| `private` | false | Allow `Cache-Control: private` responses (use with `varyBy` per user). |
| `shareAuthenticated` | false | Cache requests with `Authorization` as one shared entry (only for data identical for all users). |
| `ignoreCookies` | false | Cache requests that carry cookies, and strip cookies when filling the cache. |
| `statuses` | 200,203,204,300,301,308,404,410 | Cacheable statuses. |
| `ignoreQuery` / `sortQuery` | tracking params / true | Query normalisation. |
| `respectCacheControl` | true | Honour `no-store`, `private`, `no-cache` and `max-age`. |
| `maxEntryBytes` / `compressMinBytes` | 5 MB / 1 KB | Size limits. |
| `timeoutMs` | 15000 | Upstream timeout (504 if no stale copy). |
| `autoInvalidatePath` | true | Writes clear their own path and its parent. |
| `upstream` | top level | Per-route upstream (several backends behind one gateway). |
| `cache` | true | `false` = always pass through. |

Config strings `env:NAME` (required) and `env:NAME?` (optional) read environment variables. `UPSTREAM_URL`, `PORT`, `REDIS_URL`, `CACHE_ADMIN_TOKEN`, `CACHE_PREFIX` and `LOG_LEVEL` override the file.

## Admin endpoints

| Endpoint | Auth | |
| --- | --- | --- |
| `GET /healthz`, `GET /__cache/health` | none | Liveness check; also reports whether the store is up and its ping time. |
| `GET /__cache/metrics` | none | Prometheus metrics. |
| `GET /__cache/stats` | Bearer token | Per-route hit rate, DB calls avoided, time saved. |
| `POST /__cache/purge` | Bearer token | `{"tags":[...]}`, `{"paths":["/api/products/7"]}` or `{"all":true}` |
| `GET /__cache/inspect?url=/path` | Bearer token | Entry state, age, TTL left, size, tags. |

Wire `POST /__cache/purge` to a CMS/ERP webhook or a database trigger so edits made outside the API also clear the cache.

## CLI

```
rcg init      [--upstream URL] [--force]       starter config + .env with a random admin token
rcg check                                      config, routes, Redis (version, memory, eviction policy), upstream
rcg serve     [--port N] [--upstream URL] [--redis URL] [--memory]
rcg demo      [-n 400] [--concurrency 10] [--latency 350] [--redis [URL]] [--report file.md] [--json]
rcg bench     <gateway> --paths <list|file> [--direct URL] [-n 300] [-H "Name: v"] [--report file.md] [--json]
rcg warm      <gateway> --paths <list|file>    pre-fill the cache after a deploy
rcg stats     [--json] [--reset]               shared stats from Redis
rcg purge     --tag t... | --path p... | --all
rcg inspect   <path> [-H "Authorization: ..."]
rcg mock-api  [--port 4000] [--latency 350]    slow demo API for live presentations
```

Global options: `-c, --config <file>`, `--env-file <file>` (default `.env`).

## Operating notes

- **Redis:** set `maxmemory` and `maxmemory-policy allkeys-lru`, which `docker-compose.yml` does and `rcg check` warns about. The cache needs no persistence.
- **Several instances:** point them at the same Redis. Locks, entries, tags and stats are shared.
- **Behind a load balancer / TLS proxy:** set `trustProxy: 1` so `X-Forwarded-For` is built correctly.
- **Large tags:** invalidation is one atomic Lua script per call. Keep tags granular (`product:{id}`) rather than putting 100k entries under one tag.
- Upstream calls use keep-alive `node:http` agents (Node's `fetch` adds ~10 ms per request on some platforms).

## Tests

```bash
npm test                                   # 58 tests, offline: memory store + Redis code path via ioredis-mock
REDIS_URL=redis://localhost:6379 npm test  # adds the store contract suite against a real Redis
```

The tests cover routing, keys, cache policy, entry format, both stores (TTL, binary bodies, tags, locks, stats), coalescing within one process and across two gateway instances, SWR, stale-if-error (5xx and dropped connections), 502/504, cookie and auth safety, gzip/ETag/HEAD, write invalidation, the admin API and auth, Redis fail-open, the 413 body limit, the library, the middleware and the CLI end to end.

## License

MIT
