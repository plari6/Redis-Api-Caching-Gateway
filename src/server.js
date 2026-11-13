import http from 'node:http';
import { createGateway } from './gateway.js';
import { createStore, redactUrl } from './store/index.js';
import { createLogger } from './log.js';

/** Start the gateway HTTP server. Returns { url, port, server, store, gateway, close }. */
export async function startGateway(cfg, { store, logger = createLogger(cfg.logLevel), fetchImpl } = {}) {
  if (!cfg.upstream) throw new Error('upstream is required');
  const ownStore = !store;
  store ??= await createStore(cfg, logger);
  const gateway = createGateway(cfg, { store, logger, fetchImpl });
  const server = http.createServer(gateway.app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  logger.info('gateway listening', {
    url, upstream: cfg.upstream, store: store.kind, redis: store.kind === 'redis' ? redactUrl(cfg.redis.url) : undefined, routes: gateway.routes.length,
  });

  let closing;
  return {
    url, port, server, store, gateway,
    close() {
      closing ??= (async () => {
        await new Promise((r) => { server.close(r); server.closeIdleConnections?.(); });
        await gateway.close();
        if (ownStore) await store.close();
      })();
      return closing;
    },
  };
}
