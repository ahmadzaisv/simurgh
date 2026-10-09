// The visitor's internet address, for the limits of پښتو غږ (voice.mjs) - it is not stored.

/** The visitor's address behind Render's proxy. */
export function clientIp(req) {
  const h = req.headers;
  const fwd = String(h['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return String(h['true-client-ip'] || h['cf-connecting-ip'] || fwd || req.socket?.remoteAddress || '')
    .replace(/^::ffff:/, '')
    .trim();
}
