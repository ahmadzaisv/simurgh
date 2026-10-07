// The owner's requests (new keys, the list of used ones, a new installer) are signed on the owner's PC with an
// Ed25519 private key that never leaves it; the server holds only the public key (owner-public.pem, in this
// repository). Nothing secret is stored on the server or typed into Render.
//   message = METHOD \n PATH(+query) \n TIME(ms) \n SHA-256 of the body (hex; for an upload: its declared hash)
import crypto from 'node:crypto';

export const MAX_SKEW_MS = 5 * 60 * 1000;

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

export function signedMessage(method, pathAndQuery, time, bodyHash) {
  return `${String(method).toUpperCase()}\n${pathAndQuery}\n${time}\n${bodyHash}`;
}

/** Headers for a signed request (the owner's tool). */
export function signHeaders(privateKeyPem, method, pathAndQuery, bodyHash, now = Date.now()) {
  const time = String(now);
  const sig = crypto.sign(null, Buffer.from(signedMessage(method, pathAndQuery, time, bodyHash)), privateKeyPem).toString('base64');
  return { 'x-simurgh-time': time, 'x-simurgh-sig': sig };
}

/**
 * Checks a signed request: { ok } or { ok: false, why }. seen: a Map of signatures already used (no replays);
 * entries older than the allowed clock skew are dropped.
 */
export function verifyRequest({ publicKeyPem, method, pathAndQuery, headers, bodyHash, seen, now = Date.now() }) {
  const time = Number(headers['x-simurgh-time']);
  const sig = String(headers['x-simurgh-sig'] || '');
  if (!time || !sig) return { ok: false, why: 'not signed' };
  if (Math.abs(now - time) > MAX_SKEW_MS) return { ok: false, why: 'the clock is off (or an old request)' };
  let good = false;
  try {
    good = crypto.verify(null, Buffer.from(signedMessage(method, pathAndQuery, String(time), bodyHash)), publicKeyPem, Buffer.from(sig, 'base64'));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, why: 'bad signature' };
  if (seen) {
    for (const [k, t] of seen) if (now - t > 2 * MAX_SKEW_MS) seen.delete(k);
    if (seen.has(sig)) return { ok: false, why: 'replayed' };
    seen.set(sig, now);
  }
  return { ok: true };
}
