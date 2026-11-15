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

test("the owner's computers: trust signs a device id onto the channel's list, uncached; untrust and devices", async () => {
  const home = path.join(tmp, 'owner');
  const tool = (...a) => new Promise((resolve, reject) => execFile(process.execPath, [TOOL, ...a], { env: { ...process.env, SIMURGH_RELEASE_HOME: home } }, (e, o, err) => (e ? reject(new Error(err || o)) : resolve(o))));
  const listUrl = `${base}/u/${CHANNEL}/trusted-devices.json`;
  assert.equal((await fetch(listUrl)).status, 404, 'no list yet');
  const a = crypto.createHash('sha256').update('pc-a').digest('hex');
  const b = crypto.createHash('sha256').update('vm-b').digest('hex');
  assert.match(await tool('trust', a, "Bilal's PC"), /trusted .* 1 computer/);
  assert.match(await tool('trust', b.toUpperCase(), 'SVR2025'), /2 computer/);
  assert.match(await tool('trust', a, "Bilal's PC"), /2 computer/, 'the same computer twice: once on the list');
  const r = await fetch(listUrl);
  assert.equal(r.headers.get('cache-control'), 'no-cache', 'a change reaches the apps at once');
  const list = await r.json();
  assert.deepEqual(list.devices.map((d) => d.id).sort(), [a, b].sort());
  for (const d of list.devices) assert.ok(crypto.verify(null, Buffer.from(`simurgh-trusted-device:${d.id}`), PUB, Buffer.from(d.sig, 'base64')), 'signed by the owner');
  await assert.rejects(tool('trust', 'not-an-id'), /the id from Simurgh's Settings/);
  // an entry someone else signed never survives the tool's next write
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  const forged = { id: 'f'.repeat(64), sig: crypto.sign(null, Buffer.from(`simurgh-trusted-device:${'f'.repeat(64)}`), other).toString('base64') };
  assert.equal((await adminCall('PUT', `/admin/files/${CHANNEL}/trusted-devices.json`, { buf: Buffer.from(JSON.stringify({ devices: [...list.devices, forged] })) })).status, 200);
  const out = path.join(tmp, 'embedded.json');
  const shown = await tool('devices', '--out', out);
  assert.ok(!shown.includes('ffff'), 'the forged entry is not shown');
  assert.match(shown, /SVR2025/);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).devices.length, 2);
  await assert.rejects(tool('untrust', b.slice(0, 6)), /12 characters/);
  assert.match(await tool('untrust', b.slice(0, 12)), /1 computer\(s\) left/);
  assert.deepEqual((await (await fetch(listUrl)).json()).devices.map((d) => d.id), [a]);
});

test("a locked computer tells its id; the owner trusts it by the short id its About shows", async () => {
  const home = path.join(tmp, 'owner');
  const tool = (...a) => new Promise((resolve, reject) => execFile(process.execPath, [TOOL, ...a], { env: { ...process.env, SIMURGH_RELEASE_HOME: home } }, (e, o, err) => (e ? reject(new Error(err || o)) : resolve(o))));
  const post = (body) => fetch(`${base}/api/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const vm = crypto.createHash('sha256').update('svr2025').digest('hex');
  assert.equal((await post({ id: 'nope' })).status, 400);
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post({ id: vm.toUpperCase() })).status, 200);
  assert.equal((await fetch(`${base}/admin/devices-seen`)).status, 401, 'the list of seen ids is the owner\'s only');
  const short = vm.slice(0, 12).toUpperCase().match(/.{4}/g).join('-');
  await assert.rejects(tool('trust', 'ABCD-ABCD-ABCD'), /has told the server its id yet/);
  assert.match(await tool('trust', short, 'SVR2025'), /trusted /);
  const list = await (await fetch(`${base}/u/${CHANNEL}/trusted-devices.json`)).json();
  const entry = list.devices.find((d) => d.id === vm);
  assert.ok(entry, 'the full id is on the list');
  assert.ok(crypto.verify(null, Buffer.from(`simurgh-trusted-device:${vm}`), PUB, Buffer.from(entry.sig, 'base64')));
  // two seen ids with the same short id: the tool asks for the full one
  const twin = vm.slice(0, 12) + 'f'.repeat(52);
  assert.equal((await post({ id: twin })).status, 200);
  await assert.rejects(tool('trust', short), /2 computers start with/);
  // a few an hour from one address
  let last;
  for (let i = 0; i < 25; i++) last = await post({ id: crypto.randomBytes(32).toString('hex') });
  assert.equal(last.status, 429);
});

test('a limited computer: its signature says "limited" (it cannot be turned into a full one), and the tool keeps it so', async () => {
  const home = path.join(tmp, 'owner');
  const tool = (...a) => new Promise((resolve, reject) => execFile(process.execPath, [TOOL, ...a], { env: { ...process.env, SIMURGH_RELEASE_HOME: home } }, (e, o, err) => (e ? reject(new Error(err || o)) : resolve(o))));
  const pc = crypto.createHash('sha256').update('friend-pc').digest('hex');
  assert.match(await tool('trust', pc, 'a laptop', '--limited'), /as limited \(no Fable, Max or Ultracode\) \(a laptop\)/);
  const list = await (await fetch(`${base}/u/${CHANNEL}/trusted-devices.json`)).json();
  const e = list.devices.find((d) => d.id === pc);
  assert.equal(e.level, 'limited');
  assert.ok(crypto.verify(null, Buffer.from(`simurgh-trusted-device:${pc}:limited`), PUB, Buffer.from(e.sig, 'base64')), 'signed as limited');
  assert.ok(!crypto.verify(null, Buffer.from(`simurgh-trusted-device:${pc}`), PUB, Buffer.from(e.sig, 'base64')), 'not as a full one (older apps keep it locked)');
  // someone takes "level" out of the list: the entry no longer checks out, so the tool drops it
  const tampered = { devices: list.devices.map((d) => (d.id === pc ? { id: d.id, sig: d.sig } : d)) };
  assert.equal((await adminCall('PUT', `/admin/files/${CHANNEL}/trusted-devices.json`, { buf: Buffer.from(JSON.stringify(tampered)) })).status, 200);
  assert.ok(!(await tool('devices')).includes(pc));
  // full again
  assert.match(await tool('trust', pc, 'a laptop'), /trusted [0-9a-f]+… \(a laptop\)/);
  assert.match(await tool('devices'), new RegExp(`${pc}  a laptop`));
});

test('the Linux packages of the release: by their own names only, counted apart', async () => {
  assert.equal((await fetch(`${base}/download/linux/Simurgh-amd64.deb`)).status, 404, 'not uploaded yet');
  const deb = crypto.randomBytes(2048);
  assert.equal((await adminCall('PUT', `/admin/files/${CHANNEL}/Simurgh-amd64.deb`, { buf: deb })).status, 200);
  const r = await fetch(`${base}/download/linux/Simurgh-amd64.deb`);
  assert.equal(r.status, 200);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(deb));
  assert.equal((await fetch(`${base}/download/linux/latest.yml`)).status, 404, 'only the packages');
  assert.equal((await fetch(`${base}/download/linux/..%2f..%2fdb.json`)).status, 404);
  const s = await (await adminCall('GET', '/admin/state')).json();
  assert.ok(Object.keys(s.downloads).some((k) => / linux$/.test(k)), JSON.stringify(s.downloads));
});

test('Simurgh for iPhone: the tool releases an .ipa; the SideStore/AltStore source, the download and the update notice offer it', async () => {
  const home = path.join(tmp, 'owner-ios');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'owner-private.pem'), PRIV);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: base, channel: CHANNEL }));
  const tool = (...a) => new Promise((resolve, reject) => execFile(process.execPath, [TOOL, ...a], { env: { ...process.env, SIMURGH_RELEASE_HOME: home } }, (e, o, err) => (e ? reject(new Error(err || o)) : resolve(o))));
  const empty = await (await fetch(`${base}/ios/source.json`)).json();
  assert.deepEqual(empty.apps, [], 'no version yet: a source with no apps');
  assert.equal((await fetch(`${base}/download/ios`)).status, 404);
  assert.deepEqual(await (await fetch(`${base}/api/ios/latest`)).json(), { version: null });
  const dir = path.join(tmp, 'ios');
  fs.mkdirSync(dir, { recursive: true });
  const make = (version, build, notes) => {
    const ipa = crypto.randomBytes(300 * 1024 + build);
    const f = path.join(dir, `Simurgh-${version}.ipa`);
    fs.writeFileSync(f, ipa);
    const meta = { version, build, bundleID: 'com.bilal.Simurgh', minOS: '18.0', size: ipa.length, sha256: crypto.createHash('sha256').update(ipa).digest('hex'), notes, notesPs: 'نوې خبرې', privacy: { NSCameraUsageDescription: 'کمره', Bad: 'x' }, entitlements: [] };
    fs.writeFileSync(f.replace(/\.ipa$/, '.json'), JSON.stringify(meta));
    return { f, ipa, meta };
  };
  const a = make('0.2.0', 2, 'First public version');
  assert.match(await tool('release-ios', a.f), /iPhone 0\.2\.0 \(build 2\) is the download now/);
  const src = await (await fetch(`${base}/ios/source.json`)).json();
  assert.equal(src.apps.length, 1);
  const app = src.apps[0];
  assert.equal(app.bundleIdentifier, 'com.bilal.Simurgh');
  assert.deepEqual(app.appPermissions, { entitlements: [], privacy: { NSCameraUsageDescription: 'کمره' } }, 'only real usage keys');
  assert.equal(app.versions.length, 1);
  assert.equal(app.versions[0].buildVersion, '2');
  assert.equal(app.versions[0].size, a.ipa.length);
  assert.equal(app.versions[0].downloadURL, `${base}/download/ios/Simurgh-0.2.0.ipa`);
  assert.equal(app.downloadURL, app.versions[0].downloadURL, 'the older fields too');
  assert.ok(Buffer.from(await (await fetch(app.versions[0].downloadURL)).arrayBuffer()).equals(a.ipa));
  assert.ok(Buffer.from(await (await fetch(`${base}/download/ios`)).arrayBuffer()).equals(a.ipa), 'the newest without a name');
  const latest = await (await fetch(`${base}/api/ios/latest`)).json();
  assert.equal(latest.build, 2);
  assert.equal(latest.source, `${base}/ios/source.json`);
  // the same notes again for a new version: stopped; a build that isn't newer: refused
  const b = make('0.2.1', 3, 'First public version');
  await assert.rejects(tool('release-ios', b.f), /still 0\.2\.0's/);
  const old = make('0.1.9', 1, 'Older');
  await assert.rejects(tool('release-ios', old.f), /not newer/);
  // three newer versions: the source keeps the last three, the oldest .ipa leaves the disk
  const c = make('0.2.1', 3, 'Second');
  await tool('release-ios', c.f);
  const d = make('0.2.2', 4, 'Third');
  await tool('release-ios', d.f);
  const e = make('0.3.0', 5, 'Fourth');
  await tool('release-ios', e.f);
  const vs = (await (await fetch(`${base}/ios/source.json`)).json()).apps[0].versions.map((v) => v.version);
  assert.deepEqual(vs, ['0.3.0', '0.2.2', '0.2.1']);
  assert.equal((await fetch(`${base}/download/ios/Simurgh-0.2.0.ipa`)).status, 404, 'the oldest is gone');
  assert.equal((await fetch(`${base}/download/ios/Simurgh-0.2.1.ipa`)).status, 200);
  assert.equal((await fetch(`${base}/download/ios/..%2fdb.json`)).status, 404);
  // a signed request with a name that is no .ipa: refused
  assert.equal((await adminCall('POST', '/admin/ios-release', { json: { channel: CHANNEL, file: 'Simurgh-Setup.exe', version: '9.9.9', build: 99 } })).status, 400);
  const st = await tool('status');
  assert.match(st, /iPhone: 0\.3\.0 build 5/);
  assert.match(st, /0\.2\.0 ios: \d/);
});

test("the website's no-computer iPhone install: the setup script and its files, by name only; release-ios sends them", async () => {
  const home = path.join(tmp, 'owner-ios');
  const tool = (...a) => new Promise((resolve, reject) => execFile(process.execPath, [TOOL, ...a], { env: { ...process.env, SIMURGH_RELEASE_HOME: home } }, (e, o, err) => (e ? reject(new Error(err || o)) : resolve(o))));
  const dir = path.join(tmp, 'ios-files');
  fs.mkdirSync(dir, { recursive: true });
  const script = '#!/usr/bin/env bash\necho simurgh\n';
  fs.writeFileSync(path.join(dir, 'cloud-setup.sh'), script);
  const xt = crypto.randomBytes(100 * 1024);
  fs.writeFileSync(path.join(dir, 'xtool-x86_64.AppImage'), xt);
  await tool('ios-file', path.join(dir, 'cloud-setup.sh'));
  await tool('ios-file', path.join(dir, 'xtool-x86_64.AppImage'));
  await assert.rejects(tool('ios-file', path.join(dir, 'other.bin')), /ios-file/);
  const s = await fetch(`${base}/ios/setup.sh`);
  assert.equal(s.status, 200);
  assert.match(s.headers.get('content-type'), /text\/plain/);
  assert.equal(await s.text(), script);
  assert.ok(Buffer.from(await (await fetch(`${base}/ios/files/xtool-x86_64.AppImage`)).arrayBuffer()).equals(xt));
  assert.equal((await fetch(`${base}/ios/files/server.tar.gz`)).status, 404, 'not uploaded yet');
  assert.equal((await fetch(`${base}/ios/files/Simurgh-Setup.exe`)).status, 404, 'only these names');
  // release-ios sends server.tar.gz and cloud-setup.sh when they are beside the .ipa
  const ipa = crypto.randomBytes(1000);
  const f = path.join(dir, 'Simurgh-0.4.0.ipa');
  fs.writeFileSync(f, ipa);
  const tgz = crypto.randomBytes(2000);
  fs.writeFileSync(path.join(dir, 'server.tar.gz'), tgz);
  fs.writeFileSync(f.replace(/\.ipa$/, '.json'), JSON.stringify({ version: '0.4.0', build: 6, bundleID: 'com.bilal.Simurgh', minOS: '18.0', size: ipa.length, sha256: crypto.createHash('sha256').update(ipa).digest('hex'), notes: 'Files too', privacy: {}, entitlements: [] }));
  assert.match(await tool('release-ios', f), /uploaded server\.tar\.gz/);
  assert.ok(Buffer.from(await (await fetch(`${base}/ios/files/server.tar.gz`)).arrayBuffer()).equals(tgz));
});
