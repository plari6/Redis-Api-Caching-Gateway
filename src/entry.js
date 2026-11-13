/**
 * Cache entry wire format (one Redis GET per lookup):
 *   [uint32 meta length][meta JSON][body bytes]
 *
 * meta: { s: status, h: headers, t: storedAt, f: freshUntil, w: staleWhileRevalidateUntil,
 *         e: staleIfErrorUntil (= Redis expiry), z: body gzipped, tg: tags, r: route, u: raw key }
 */
export function encodeEntry(meta, body = Buffer.alloc(0)) {
  const m = Buffer.from(JSON.stringify(meta));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(m.length, 0);
  return Buffer.concat([head, m, body]);
}

export function decodeEntry(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) throw new Error('bad cache entry');
  const len = buf.readUInt32BE(0);
  if (len + 4 > buf.length) throw new Error('bad cache entry length');
  const meta = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
  return { meta, body: buf.subarray(4 + len) };
}

/** Build the time windows for an entry. Seconds in, epoch ms out. */
export function windows(now, ttlSec, swrSec = 0, sieSec = 0) {
  const f = now + ttlSec * 1000;
  const w = f + Math.max(0, swrSec) * 1000;
  const e = Math.max(w, f + Math.max(0, sieSec) * 1000);
  return { t: now, f, w, e };
}

/**
 * fresh   -> serve, no upstream call
 * stale   -> serve now, refresh in the background (stale-while-revalidate)
 * error   -> only served if the upstream fails (stale-if-error)
 * expired -> treat as miss
 */
export function classify(meta, now = Date.now()) {
  if (now < meta.f) return 'fresh';
  if (now < meta.w) return 'stale';
  if (now < meta.e) return 'error';
  return 'expired';
}
