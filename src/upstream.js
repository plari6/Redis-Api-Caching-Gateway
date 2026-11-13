import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { Readable, pipeline } from 'node:stream';

const DECODERS = {
  gzip: () => zlib.createGunzip(),
  'x-gzip': () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  br: () => zlib.createBrotliDecompress(),
};

/**
 * fetch-compatible upstream client on node:http keep-alive agents.
 * Returns standard Response objects (multiple Set-Cookie kept, bodies decoded),
 * but avoids the per-request overhead Node's built-in fetch shows on some
 * platforms (~10 ms on Windows), which matters on every cache miss.
 */
export function createHttpFetch({ maxSockets = 256, keepAliveMsecs = 1000 } = {}) {
  const agents = {
    'http:': new http.Agent({ keepAlive: true, keepAliveMsecs, maxSockets }),
    'https:': new https.Agent({ keepAlive: true, keepAliveMsecs, maxSockets }),
  };

  function httpFetch(input, { method = 'GET', headers = {}, body, signal } = {}) {
    const url = new URL(input);
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const reqHeaders = { 'accept-encoding': 'gzip, deflate, br', ...headers };
      if (body !== undefined) reqHeaders['content-length'] = String(Buffer.byteLength(body));
      const req = mod.request(url, { method, headers: reqHeaders, agent: agents[url.protocol] }, (res) => {
        const h = new Headers();
        const raw = res.rawHeaders;
        for (let i = 0; i < raw.length; i += 2) {
          try { h.append(raw[i], raw[i + 1]); } catch { /* invalid header value from upstream: drop it */ }
        }
        const status = res.statusCode;
        const noBody = method === 'HEAD' || status === 204 || status === 304;
        if (noBody) {
          res.resume();
          return resolve(new Response(null, { status, headers: h }));
        }
        let stream = res;
        const decoder = DECODERS[String(res.headers['content-encoding'] ?? '').trim().toLowerCase()];
        if (decoder) {
          stream = pipeline(res, decoder(), () => {});
          h.delete('content-encoding');
          h.delete('content-length');
        }
        resolve(new Response(Readable.toWeb(stream), { status, headers: h }));
      });
      req.on('error', reject);
      if (signal) {
        const onAbort = () => req.destroy(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', onAbort));
      }
      req.end(body);
    });
  }

  httpFetch.close = () => {
    agents['http:'].destroy();
    agents['https:'].destroy();
  };
  return httpFetch;
}
