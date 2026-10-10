// The download server and the owner's release tool, end to end on this PC: signatures, a release uploaded, the free
// download (whole, resumed, counted), the updates, the old key paths gone and the old key data erased from the disk.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signHeaders, verifyRequest, sha256 } from '../auth.mjs';
import { clientIp } from '../who.mjs';
import { createServer } from '../server.mjs';
import { Store } from '../store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', '..', 'tools', 'simurgh-release.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simurgh-dl-test-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const CHANNEL = 'test-channel-0123456789';
let srv;
let base;

before(async () => {
  // a disk from before: download keys, who used them, links - they must go
  const data = path.join(tmp, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ keys: { abc: { used: { at: 'x', city: 'Kabul', os: 'Windows 11' } } }, tokens: { t: { hash: 'abc' } }, release: null }));
  srv = createServer({ dataDir: data, publicKeyPem: PUB, origins: ['https://simurgh.onrender.com'], log: () => {} });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(() => {
  srv.server.close();
  srv.voice.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const adminCall = async (method, p, { json, buf, priv = PRIV, time = Date.now() } = {}) => {
  const body = json ? Buffer.from(JSON.stringify(json)) : buf;
  const bodyHash = sha256(body || Buffer.alloc(0));
  const headers = { ...signHeaders(priv, method, p, bodyHash, time), ...(buf ? { 'x-content-sha256': bodyHash } : {}) };
  return fetch(base + p, { method, headers, body });
};

test('the old download keys are gone from the disk, and their paths answer "gone"', async () => {
  const db = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'db.json'), 'utf8'));
  assert.equal('keys' in db, false);
  assert.equal('tokens' in db, false);
  assert.ok(!JSON.stringify(db).includes('Kabul'), 'who used a key: erased');
  const r = await fetch(`${base}/api/redeem`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 410);
  assert.match((await r.json()).message, /no longer needed/);
  assert.equal((await fetch(`${base}/d/abcdefghijklmnopqrstuvwxyz012345`)).status, 410);
  assert.equal((await fetch(`${base}/admin/keys`, { method: 'POST' })).status, 401, 'nothing there for anyone else either');
});

test('signatures: only the owner, only once, only now', () => {
  const h = signHeaders(PRIV, 'POST', '/admin/release', 'abc');
  const seen = new Map();
  const v = (o) => verifyRequest({ publicKeyPem: PUB, method: 'POST', pathAndQuery: '/admin/release', headers: h, bodyHash: 'abc', seen, ...o });
  assert.deepEqual(v({}), { ok: true });
  assert.equal(v({}).why, 'replayed');
  assert.equal(v({ bodyHash: 'abd', seen: null }).why, 'bad signature', 'another body');
  assert.equal(v({ pathAndQuery: '/admin/state', seen: null }).why, 'bad signature');
  assert.equal(v({ now: Date.now() + 10 * 60 * 1000, seen: null }).why, 'the clock is off (or an old request)');
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(verifyRequest({ publicKeyPem: PUB, method: 'POST', pathAndQuery: '/x', headers: signHeaders(other, 'POST', '/x', 'a'), bodyHash: 'a' }).why, 'bad signature');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '198.51.100.7, 10.1.1.1' }, socket: {} }), '198.51.100.7');
});

test('the owner uploads a release; anyone downloads it - whole, resumed, counted; the updates by their channel', async () => {
  assert.equal((await fetch(`${base}/admin/state`)).status, 401, 'not signed');
  assert.equal((await fetch(`${base}/download`)).status, 503, 'nothing to download yet');
  const exe = crypto.randomBytes(300 * 1024);
  const bad = await fetch(`${base}/admin/files/${CHANNEL}/Simurgh-Setup.exe`, { method: 'PUT', headers: { ...signHeaders(PRIV, 'PUT', `/admin/files/${CHANNEL}/Simurgh-Setup.exe`, sha256(Buffer.from('other'))), 'x-content-sha256': sha256(Buffer.from('other')) }, body: exe });
  assert.equal(bad.status, 400, 'damaged on the way: refused');
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal((await adminCall('PUT', `/admin/files/${CHANNEL}/Simurgh-Setup.exe`, { buf: exe, priv: other })).status, 401, 'signed by someone else');
  assert.equal((await adminCall('PUT', `/admin/files/${CHANNEL}/Simurgh-Setup.exe`, { buf: exe })).status, 200);
  assert.equal((await adminCall('PUT', `/admin/files/${CHANNEL}/latest.yml`, { buf: Buffer.from('version: 0.1.23\n') })).status, 200);
  assert.notEqual((await adminCall('PUT', `/admin/files/../etc/passwd`, { buf: Buffer.from('x') })).status, 200);
  assert.equal((await adminCall('PUT', `/admin/files/${CHANNEL}/..passwd`, { buf: Buffer.from('x') })).status, 400, 'names are checked');
  assert.equal((await adminCall('POST', '/admin/release', { json: { channel: CHANNEL, file: 'missing.exe', version: '0.1.23' } })).status, 400);
  const rel = await (await adminCall('POST', '/admin/release', { json: { channel: CHANNEL, file: 'Simurgh-Setup.exe', version: '0.1.23', sha512: 'x' } })).json();
  assert.equal(rel.release.size, exe.length);
  const latest = await fetch(`${base}/api/latest`, { headers: { origin: 'https://simurgh.onrender.com' } });
  assert.deepEqual(await latest.json(), { version: '0.1.23', size: exe.length });
  assert.equal(latest.headers.get('access-control-allow-origin'), 'https://simurgh.onrender.com');

  // ---- the free download
  const whole = await fetch(`${base}/download`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-disposition'), 'attachment; filename="Simurgh-Setup.exe"');
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(exe), 'the installer, byte for byte');
  const part = await fetch(`${base}/download/Simurgh-Setup.exe`, { headers: { range: 'bytes=1000-1999' } });
  assert.equal(part.status, 206);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(exe.subarray(1000, 2000)), 'resumed');
  await (await fetch(`${base}/download`)).arrayBuffer();
  assert.equal((await fetch(`${base}/download`, { method: 'HEAD' })).headers.get('content-length'), String(exe.length));
  srv.store.save();
  const st = await (await adminCall('GET', '/admin/state')).json();
  assert.deepEqual(st.downloads, { '0.1.23': 2 }, 'two downloads from the start (resuming and HEAD are not counted)');
  assert.equal(st.release.version, '0.1.23');

  // ---- updates: the channel only
  assert.equal(await (await fetch(`${base}/u/${CHANNEL}/latest.yml`)).text(), 'version: 0.1.23\n');
  assert.equal((await fetch(`${base}/u/other-channel-000/latest.yml`)).status, 404);
  assert.equal((await fetch(`${base}/u/${CHANNEL}/..%2F..%2Fdb.json`)).status, 404);
});

test("a clip for Instagram: the owner's upload at a public link as video/mp4, deleted after, old ones cleared", async () => {
  const clip = crypto.randomBytes(5000);
  const old = path.join(tmp, 'data', 'files', 'clip-OLDoldOLDoldOLDold');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'c.mp4'), 'x');
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
  fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
  const p = '/admin/files/clip-AbCdEfGh12345678xyz/01-hook.mp4';
  assert.equal((await adminCall('PUT', p, { buf: clip, priv: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) })).status, 401, 'only the owner');
  assert.equal((await adminCall('PUT', p, { buf: clip })).status, 200);
  const r = await fetch(`${base}/u/clip-AbCdEfGh12345678xyz/01-hook.mp4`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(clip));
  assert.equal(fs.existsSync(old), false, 'a clip left over for two days is cleared');
  assert.equal((await fetch(base + p, { method: 'DELETE' })).status, 401, 'nobody else deletes');
  assert.equal((await adminCall('DELETE', p)).status, 200);
  assert.equal((await fetch(`${base}/u/clip-AbCdEfGh12345678xyz/01-hook.mp4`)).status, 404);
  assert.equal(fs.existsSync(path.join(tmp, 'data', 'files', 'clip-AbCdEfGh12345678xyz')), false, 'its folder too');
  // a release channel's files are never cleared as clips
  assert.equal((await fetch(`${base}/u/${CHANNEL}/latest.yml`)).status, 200);
});

test('the store: counts saved a moment later, names checked', () => {
  const dir = path.join(tmp, 'store');
  const s = new Store(dir);
  assert.deepEqual(s.db, { release: null, downloads: {} });
  s.db.downloads['1.0.0'] = 1;
  s.saveSoon();
  s.save();
  assert.deepEqual(new Store(dir).db.downloads, { '1.0.0': 1 });
  assert.equal(s.filePath('short', 'x'), null);
  assert.equal(s.filePath('channel-12345', '../x'), null);
});

test("the owner's tool uploads a release: installer, blockmap, then the feed; the website offers it; its status", async () => {
  const home = path.join(tmp, 'owner');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'owner-private.pem'), PRIV);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: base, channel: CHANNEL }));
  const tool = (...a) => new Promise((resolve, reject) => execFile(process.execPath, [TOOL, ...a], { env: { ...process.env, SIMURGH_RELEASE_HOME: home } }, (e, o, err) => (e ? reject(new Error(err || o)) : resolve(o))));
  const dir = path.join(tmp, 'release');
  fs.mkdirSync(dir, { recursive: true });
  const exe = crypto.randomBytes(2 * 1024 * 1024);
  fs.writeFileSync(path.join(dir, 'Simurgh-Setup.exe'), exe);
  fs.writeFileSync(path.join(dir, 'Simurgh-Setup.exe.blockmap'), crypto.randomBytes(1000));
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 0.1.24\nfiles:\n  - url: Simurgh-Setup.exe\n    sha512: abc==\n');
  assert.match(await tool('release', dir, '0.1.24'), /release 0\.1\.24 is the download now/);
  assert.deepEqual(await (await fetch(`${base}/api/latest`)).json(), { version: '0.1.24', size: exe.length });
  assert.ok(Buffer.from(await (await fetch(`${base}/u/${CHANNEL}/Simurgh-Setup.exe`)).arrayBuffer()).equals(exe));
  assert.ok(Buffer.from(await (await fetch(`${base}/download`)).arrayBuffer()).equals(exe), 'the website now offers it');
  await assert.rejects(tool('release', dir, '0.1.25'), /not version 0\.1\.25/);
  const st = await tool('status');
  assert.match(st, /release: 0\.1\.24/);
  assert.match(st, /downloads from the website: .*0\.1\.24: 1/);
});
