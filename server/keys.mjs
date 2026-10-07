// Download keys: 20 characters of Crockford base32 in four groups (ABCDE-FGH12-...), about 100 bits each - far too
// many to guess. The server never sees a key it hasn't been given the hash of, and keeps only the hashes: a copy of
// its disk can't be used to download. Shared by the server and the owner's tool (tools/simurgh-keys.mjs).
import crypto from 'node:crypto';

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const KEY_CHARS = 20;

/** A new key, e.g. "7Q2KD-M9XTR-A4H0W-JZ3BN". */
export function newKey() {
  const bytes = crypto.randomBytes(KEY_CHARS);
  let s = '';
  for (let i = 0; i < KEY_CHARS; i++) s += ALPHABET[bytes[i] & 31];
  return s.match(/.{5}/g).join('-');
}

/** What the person typed, as the key's 20 characters - or null. Dashes, spaces and case don't matter; O reads as 0, I and L as 1. */
export function normalizeKey(input) {
  const s = String(input ?? '')
    .toUpperCase()
    .replace(/[\s\-_.–—]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== KEY_CHARS) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

/** The key as the server knows it. */
export function keyHash(key) {
  const k = normalizeKey(key);
  if (!k) throw new Error('not a download key');
  return crypto.createHash('sha256').update(`simurgh-download-key:${k}`).digest('hex');
}

/** The key written the way it is handed out. */
export function formatKey(key) {
  const k = normalizeKey(key);
  return k ? k.match(/.{5}/g).join('-') : null;
}
