// The download server and the owner's tool, end to end on this PC: keys, signatures, a release uploaded, a key
// redeemed once (and never twice), the download (whole and resumed), the updates, the limits - then the tool's
// sync taking the used key off the owner's list and making a new one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newKey, normalizeKey, keyHash, formatKey } from '../keys.mjs';
import { signHeaders, verifyRequest, sha256 } from '../auth.mjs';
import { deviceOf, placeOf, clientIp } from '../who.mjs';
import { createServer } from '../server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', '..', 'tools', 'simurgh-keys.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simurgh-dl-test-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const CHANNEL = 'test-channel-0123456789';
let clock = Date.now();
const lookups = [];
let srv;
let base;

before(async () => {
  srv = createServer({
    dataDir: path.join(tmp, 'data'),
    publicKeyPem: PUB,
    origins: ['https://simurgh.onrender.com'],
    now: () => clock,
    log: () => {},
    lookup: async (url) => {
      lookups.push(url);
      if (url.includes('ipapi.co')) throw new Error('down');
      return { success: true, city: 'Kabul', region: 'Kabul', country: 'Afghanistan' };
    },
  });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(() => {
  srv.server.close();
  srv.voice.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const adminCall = async (method, p, { json, buf, priv = PRIV, time = clock } = {}) => {
  const body = json ? Buffer.from(JSON.stringify(json)) : buf;
  const bodyHash = sha256(body || Buffer.alloc(0));
  const headers = { ...signHeaders(priv, method, p, bodyHash, time), ...(buf ? { 'x-content-sha256': bodyHash } : {}) };
  return fetch(base + p, { method, headers, body });
};
const redeem = (key, headers = {}) =>
  fetch(`${base}/api/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', ...headers },
    body: JSON.stringify({ key, device: { platform: 'Windows', platformVersion: '15.0.0', bitness: '64' } }),
  });

test('keys: 20 characters, typed any way, hashed', () => {
  const k = newKey();
  assert.match(k, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
  assert.equal(normalizeKey(` ${k.toLowerCase().replace(/-/g, ' ')} `), k.replace(/-/g, ''));
  assert.equal(normalizeKey('O1234-5678I-L0000-00000'), '01234567811000000000', 'O is 0, I and L are 1');
  assert.equal(normalizeKey('12345'), null);
  assert.equal(normalizeKey('UUUUU-UUUUU-UUUUU-UUUUU'), null, 'U is not in the alphabet');
  assert.equal(keyHash(k), keyHash(k.toLowerCase()));
  assert.equal(formatKey(k.replace(/-/g, '')), k);
  assert.equal(new Set(Array.from({ length: 2000 }, newKey)).size, 2000);
});

test('signatures: only the owner, only once, only now', () => {
  const h = signHeaders(PRIV, 'POST', '/admin/keys', 'abc');
  const seen = new Map();
  const v = (o) => verifyRequest({ publicKeyPem: PUB, method: 'POST', pathAndQuery: '/admin/keys', headers: h, bodyHash: 'abc', seen, ...o });
  assert.deepEqual(v({}), { ok: true });
  assert.equal(v({}).why, 'replayed');
  assert.equal(v({ bodyHash: 'abd', seen: null }).why, 'bad signature', 'another body');
  assert.equal(v({ pathAndQuery: '/admin/release', seen: null }).why, 'bad signature');
  assert.equal(v({ now: Date.now() + 10 * 60 * 1000, seen: null }).why, 'the clock is off (or an old request)');
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(verifyRequest({ publicKeyPem: PUB, method: 'POST', pathAndQuery: '/x', headers: signHeaders(other, 'POST', '/x', 'a'), bodyHash: 'a' }).why, 'bad signature');
});

test('who: Windows 11 from the browser hints, the User-Agent otherwise; the place from the address', async () => {
  assert.deepEqual(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0', { platform: 'Windows', platformVersion: '15.0.0' }), { os: 'Windows 11 64-bit', browser: 'Edge 141' });
  assert.deepEqual(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'), { os: 'Windows 10/11 64-bit', browser: 'Firefox 140' });
  assert.equal(deviceOf('', { platform: 'Windows', platformVersion: '10.0.0' }).os, 'Windows 10');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36').os, 'Android 14');
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1').os, 'iOS 18');
  assert.deepEqual(await placeOf('127.0.0.1'), { city: '', region: '', country: 'local network' });
  assert.deepEqual(await placeOf('203.0.113.9', { lookup: async () => ({ city: 'Herat', region: 'Herat', country_name: 'Afghanistan' }) }), { city: 'Herat', region: 'Herat', country: 'Afghanistan' });
  assert.deepEqual(await placeOf('203.0.113.9', { lookup: async () => Promise.reject(new Error('x')), countryHint: 'AF' }), { city: '', region: '', country: 'AF' });
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.7, 10.1.1.1' }, socket: {} }), '198.51.100.7');
});

test('the owner adds keys and uploads a release; nobody else can', async () => {
  const keys = Array.from({ length: 3 }, newKey);
  assert.equal((await fetch(`${base}/admin/state`)).status, 401, 'not signed');
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal((await adminCall('POST', '/admin/keys', { json: { add: keys.map(keyHash) }, priv: other })).status, 401, 'signed by someone else');
  const r = await (await adminCall('POST', '/admin/keys', { json: { add: [...keys.map(keyHash), 'not-a-hash'] } })).json();
  assert.equal(r.added, 3);
  // a key before there is anything to download: refused, and the key stays good
  assert.equal((await redeem(keys[0])).status, 503);
  // the installer, its blockmap and the feed
  const exe = crypto.randomBytes(300 * 1024);
  const bad = await fetch(`${base}/admin/files/${CHANNEL}/Simurgh-Setup.exe`, { method: 'PUT', headers: { ...signHeaders(PRIV, 'PUT', `/admin/files/${CHANNEL}/Simurgh-Setup.exe`, sha256(Buffer.from('other'))), 'x-content-sha256': sha256(Buffer.from('other')) }, body: exe });
  assert.equal(bad.status, 400, 'damaged on the way: refused');
  assert.equal((await adminCall('PUT', `/admin/files/${CHANNEL}/Simurgh-Setup.exe`, { buf: exe })).status, 200);
  assert.equal((await adminCall('PUT', `/admin/files/${CHANNEL}/latest.yml`, { buf: Buffer.from('version: 0.1.14\n') })).status, 200);
  assert.notEqual((await adminCall('PUT', `/admin/files/../etc/passwd`, { buf: Buffer.from('x') })).status, 200);
  assert.equal((await adminCall('PUT', `/admin/files/${CHANNEL}/..passwd`, { buf: Buffer.from('x') })).status, 400, 'names are checked');
  assert.equal((await adminCall('POST', '/admin/release', { json: { channel: CHANNEL, file: 'missing.exe', version: '0.1.14' } })).status, 400);
  const rel = await (await adminCall('POST', '/admin/release', { json: { channel: CHANNEL, file: 'Simurgh-Setup.exe', version: '0.1.14', sha512: 'x' } })).json();
  assert.equal(rel.release.size, exe.length);
  assert.deepEqual(await (await fetch(`${base}/api/latest`)).json(), { version: '0.1.14', size: exe.length });

  // ---- a key, once
  const res = await redeem(keys[0].toLowerCase().replace(/-/g, ' '), { origin: 'https://simurgh.onrender.com' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://simurgh.onrender.com');
  const ok = await res.json();
  assert.match(ok.url, /^\/d\/[A-Za-z0-9_-]{32}$/);
  assert.equal(ok.version, '0.1.14');
  const whole = await fetch(base + ok.url);
  assert.equal(whole.headers.get('content-disposition'), 'attachment; filename="Simurgh-Setup.exe"');
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(exe), 'the installer, byte for byte');
  const part = await fetch(base + ok.url, { headers: { range: 'bytes=1000-1999' } });
  assert.equal(part.status, 206);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(exe.subarray(1000, 2000)), 'resumed');
  assert.equal((await redeem(keys[0])).status, 410, 'used: never again');
  assert.equal((await redeem(keys[0], { 'x-forwarded-for': '198.51.100.1' })).status, 410, 'not from another place either');
  assert.equal((await redeem('AAAAA-AAAAA-AAAAA-AAAAA')).status, 404);
  assert.equal((await redeem('hello')).status, 400);
  assert.equal((await fetch(`${base}/api/redeem`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' })).headers.get('access-control-allow-origin'), null);

  // what the owner sees: when, where (the address is not kept), what
  await new Promise((r) => setTimeout(r, 100));
  const st = await (await adminCall('GET', '/admin/state')).json();
  assert.equal(st.unused.length, 2);
  const u = st.used[0];
  assert.equal(u.hash, keyHash(keys[0]));
  assert.deepEqual({ city: u.city, country: u.country, os: u.os, browser: u.browser, version: u.version }, { city: 'Kabul', country: 'Afghanistan', os: 'Windows 11 64-bit', browser: 'Chrome 141', version: '0.1.14' });
  assert.ok(lookups.some((l) => l.includes('203.0.113.9')), 'the first address in X-Forwarded-For');
  assert.ok(!JSON.stringify(st).includes('203.0.113.9'), 'the address is not stored');

  // the link: 10 downloads from the start, 24 hours
  for (let i = 1; i < 10; i++) await (await fetch(base + ok.url)).arrayBuffer();
  assert.equal((await fetch(base + ok.url)).status, 429);
  const second = await (await redeem(keys[1])).json();
  clock += 25 * 60 * 60 * 1000;
  assert.equal((await fetch(base + second.url)).status, 410, 'expired after a day');

  // updates: the channel only
  assert.equal(await (await fetch(`${base}/u/${CHANNEL}/latest.yml`)).text(), 'version: 0.1.14\n');
  assert.equal((await fetch(`${base}/u/other-channel-000/latest.yml`)).status, 404);
  assert.equal((await fetch(`${base}/u/${CHANNEL}/..%2F..%2Fdb.json`)).status, 404);
});

test('ten wrong keys from one address: wait an hour', async () => {
  for (let i = 0; i < 10; i++) await redeem('BBBBB-BBBBB-BBBBB-BBBBB', { 'x-forwarded-for': '192.0.2.50' });
  assert.equal((await redeem('BBBBB-BBBBB-BBBBB-BBBBB', { 'x-forwarded-for': '192.0.2.50' })).status, 429);
  assert.equal((await redeem('BBBBB-BBBBB-BBBBB-BBBBB', { 'x-forwarded-for': '192.0.2.51' })).status, 404, 'another address is not held up');
});

test("the owner's tool: keys made here, used ones leave the list with when/where/what, new ones take their place", async () => {
  clock = Date.now();
  const home = path.join(tmp, 'owner');
  const folder = path.join(tmp, 'Documents', 'Simurgh Download Keys');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'owner-private.pem'), PRIV);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: base, target: 5, folder, channel: CHANNEL }));
  const tool = (...a) =>
    new Promise((resolve, reject) => execFile(process.execPath, [TOOL, ...a], { env: { ...process.env, SIMURGH_KEYS_HOME: home } }, (e, out, err) => (e ? reject(new Error(err || out || e.message)) : resolve(out))));
  await tool('sync');
  const list = () => fs.readFileSync(path.join(folder, 'Download keys.txt'), 'utf8').split(/\r?\n/).filter((l) => /^[0-9A-Z]{5}-/.test(l));
  const first = list();
  assert.equal(first.length, 5);
  const give = first[2];
  assert.equal((await redeem(give)).status, 200, 'a key from the list works');
  await new Promise((r) => setTimeout(r, 100));
  await tool('sync');
  const now = list();
  assert.equal(now.length, 5, 'still 5 ready');
  assert.ok(!now.includes(give), 'the used one is gone');
  assert.equal(now.filter((k) => !first.includes(k)).length, 1, 'one new key');
  const used = fs.readFileSync(path.join(folder, 'Used keys.csv'), 'utf8');
  assert.ok(used.startsWith('\ufeff"Key"'), 'opens in Excel with Pashto and Dari names intact');
  assert.match(used, new RegExp(`"${give}","\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d","Kabul","Kabul","Afghanistan","Windows 11 64-bit","Chrome 141","0\\.1\\.14",""`));
  assert.ok(fs.existsSync(path.join(folder, 'Read me.txt')));
  // a test key: not on the list, its use marked as a test
  const tk = (await tool('test-key')).trim();
  assert.match(tk, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  assert.ok(!list().includes(tk));
  assert.equal((await redeem(tk)).status, 200);
  await tool('sync');
  assert.match(fs.readFileSync(path.join(folder, 'Used keys.csv'), 'utf8'), new RegExp(`"${tk}",.*"test key"`));
  assert.match(await tool('status'), /here: 5 ready, 2 used/);
});

test('the tool uploads a release: installer, blockmap, then the feed; the website offers it', async () => {
  const home = path.join(tmp, 'owner');
  const dir = path.join(tmp, 'release');
  fs.mkdirSync(dir, { recursive: true });
  const exe = crypto.randomBytes(2 * 1024 * 1024);
  fs.writeFileSync(path.join(dir, 'Simurgh-Setup.exe'), exe);
  fs.writeFileSync(path.join(dir, 'Simurgh-Setup.exe.blockmap'), crypto.randomBytes(1000));
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 0.1.15\nfiles:\n  - url: Simurgh-Setup.exe\n    sha512: abc==\n');
  const out = await new Promise((resolve, reject) => execFile(process.execPath, [TOOL, 'release', dir, '0.1.15'], { env: { ...process.env, SIMURGH_KEYS_HOME: home } }, (e, o, err) => (e ? reject(new Error(err || o)) : resolve(o))));
  assert.match(out, /release 0\.1\.15 is the download now/);
  assert.deepEqual(await (await fetch(`${base}/api/latest`)).json(), { version: '0.1.15', size: exe.length });
  assert.ok(Buffer.from(await (await fetch(`${base}/u/${CHANNEL}/Simurgh-Setup.exe`)).arrayBuffer()).equals(exe));
  await assert.rejects(
    new Promise((resolve, reject) => execFile(process.execPath, [TOOL, 'release', dir, '0.1.16'], { env: { ...process.env, SIMURGH_KEYS_HOME: home } }, (e, o, err) => (e ? reject(new Error(err || o)) : resolve(o)))),
    /not version 0\.1\.16/
  );
});
