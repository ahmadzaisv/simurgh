// The owner's download keys, on the owner's PC. The keys themselves live only here; the server gets their hashes.
//   node simurgh-keys.mjs sync          used keys leave the list (when, where, on what -> "Used keys.csv") and new ones
//                                       take their place, so there are always <target> keys to give out (a scheduled
//                                       task runs this every few minutes)
//   node simurgh-keys.mjs status        how many keys there are and how many were used
//   node simurgh-keys.mjs test-key      one extra key for a test (not in the list; its use shows as a test)
//   node simurgh-keys.mjs release <dir> <version>    uploads latest.yml, the installer and its blockmap from <dir>
//                                       to the update channel and makes it the website's download
//   node simurgh-keys.mjs setup <repo>  makes the owner's signing key (once) and writes its public half to
//                                       <repo>/server/owner-public.pem
// Files: %LOCALAPPDATA%\Simurgh Keys\ (config.json, state.json, owner-private.pem, sync.log) and the list for the
// owner in Documents\Simurgh Download Keys\ ("Download keys.txt", "Used keys.csv", "Read me.txt").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = process.env.SIMURGH_KEYS_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Simurgh Keys');
const CONFIG = path.join(HOME, 'config.json');
const STATE = path.join(HOME, 'state.json');
const PRIVATE = path.join(HOME, 'owner-private.pem');
const LOG = path.join(HOME, 'sync.log');
const LOCK = path.join(HOME, 'sync.lock');

// the key helpers and the signing are the server's own (shipped next to this file, or in the website repository)
const here = path.dirname(fileURLToPath(import.meta.url));
const lib = fs.existsSync(path.join(here, 'lib', 'keys.mjs')) ? path.join(here, 'lib') : path.join(here, '..', 'server');
const { newKey, keyHash } = await import(pathToFileURL(path.join(lib, 'keys.mjs')).href);
const { signHeaders, sha256 } = await import(pathToFileURL(path.join(lib, 'auth.mjs')).href);

const readJson = (f, fallback) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : fallback);
const writeAtomic = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, f);
};
const log = (m) => {
  const line = `${new Date().toISOString()} ${m}\n`;
  process.stdout.write(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, `${LOG}.old`);
    fs.appendFileSync(LOG, line);
  } catch {}
};

function config() {
  const c = readJson(CONFIG, {});
  return { server: 'https://simurgh-download.onrender.com', target: 1000, folder: path.join(os.homedir(), 'Documents', 'Simurgh Download Keys'), ...c };
}

/** A signed request to the server (the private key never leaves this PC). */
async function call(method, p, { json, file, timeoutMs = 60000 } = {}) {
  const c = config();
  const key = fs.readFileSync(PRIVATE, 'utf8');
  let body;
  let bodyHash;
  const headers = {};
  if (file) {
    bodyHash = await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
    headers['x-content-sha256'] = bodyHash;
    headers['content-length'] = String(fs.statSync(file).size);
    headers['content-type'] = 'application/octet-stream';
    body = fs.createReadStream(file);
  } else {
    body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
    bodyHash = sha256(body || Buffer.alloc(0));
    if (body) headers['content-type'] = 'application/json';
  }
  Object.assign(headers, signHeaders(key, method, p, bodyHash));
  const r = await fetch(new URL(p, c.server), { method, headers, body, duplex: file ? 'half' : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${data.error || data.text || ''}`);
  return data;
}

// ---------------------------------------------------------------- the list
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const localTime = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** "Download keys.txt", "Used keys.csv" and "Read me.txt" from the state. */
function writeLists(state) {
  const c = config();
  const all = Object.values(state.keys);
  const ready = all.filter((k) => k.uploaded && !k.used && !k.test).sort((a, b) => a.created.localeCompare(b.created) || a.key.localeCompare(b.key));
  const used = all.filter((k) => k.used).sort((a, b) => b.used.at.localeCompare(a.used.at));
  const now = localTime(new Date().toISOString());
  writeAtomic(
    path.join(c.folder, 'Download keys.txt'),
    `Simurgh download keys - ${ready.length} ready. Each key works once: give one key to one person.\r\n` +
      `A key that was used leaves this list by itself within a few minutes, and a new one takes its place.\r\n` +
      `Who used which key (when, where, on what): Used keys.csv. Updated ${now}.\r\n\r\n` +
      ready.map((k) => k.key).join('\r\n') +
      '\r\n'
  );
  const rows = [['Key', 'Used on (your time)', 'City', 'Region', 'Country', 'Operating system', 'Browser', 'Version', 'Note'].map(csv).join(',')];
  for (const k of used) rows.push([k.key, localTime(k.used.at), k.used.city, k.used.region, k.used.country, k.used.os, k.used.browser, k.used.version, k.test ? 'test key' : ''].map(csv).join(','));
  writeAtomic(path.join(c.folder, 'Used keys.csv'), '﻿' + rows.join('\r\n') + '\r\n');
  const readme = path.join(c.folder, 'Read me.txt');
  if (!fs.existsSync(readme))
    writeAtomic(
      readme,
      [
        'Simurgh download keys',
        '',
        'People download Simurgh from https://simurgh.onrender.com with a key from "Download keys.txt".',
        'Copy one key and send it to one person. Each key works once.',
        '',
        'When someone uses a key, within a few minutes:',
        '  - the key leaves "Download keys.txt",',
        '  - "Used keys.csv" gets a line: when it was used, the city / region / country (from their internet',
        '    address - the address itself is not kept), their operating system and browser,',
        `  - a new key is made, so there are always ${c.target} keys ready.`,
        '',
        'This happens through the Windows scheduled task "Simurgh download keys" (every 5 minutes, while this PC is on).',
        'While the PC is off, the keys still work - the lists catch up when it is on again.',
        '',
        `The signing key that lets this PC manage the keys is in ${HOME}`,
        '(owner-private.pem). Keep it private. If it is lost, make a new one (simurgh-keys.mjs setup) and',
        'publish its public half with the website.',
        '',
      ].join('\r\n')
    );
}

// ---------------------------------------------------------------- commands
async function sync() {
  if (fs.existsSync(LOCK) && Date.now() - fs.statSync(LOCK).mtimeMs < 10 * 60 * 1000) return log('another sync is running');
  fs.writeFileSync(LOCK, String(process.pid));
  try {
    const c = config();
    const state = readJson(STATE, { keys: {} });
    const server = await call('GET', '/admin/state');
    const serverUnused = new Set(server.unused);
    // used on the server: off the list, into the log
    let newlyUsed = 0;
    for (const u of server.used) {
      const k = state.keys[u.hash];
      if (!k) continue;
      const { hash, ...info } = u;
      if (!k.used || JSON.stringify(k.used) !== JSON.stringify(info)) {
        if (!k.used) newlyUsed++;
        k.used = info;
      }
    }
    // keys the server should have (made but not sent yet, or sent before a failure)
    for (const [hash, k] of Object.entries(state.keys)) if (k.uploaded && !k.used && !serverUnused.has(hash)) k.uploaded = false;
    // new keys up to the target
    const ready = Object.values(state.keys).filter((k) => !k.used && !k.test).length;
    for (let i = ready; i < c.target; i++) {
      const key = newKey();
      state.keys[keyHash(key)] = { key, created: new Date().toISOString(), uploaded: false };
    }
    writeAtomic(STATE, JSON.stringify(state));
    const send = Object.entries(state.keys).filter(([, k]) => !k.uploaded && !k.used);
    for (let i = 0; i < send.length; i += 500) {
      const part = send.slice(i, i + 500);
      await call('POST', '/admin/keys', { json: { add: part.map(([h]) => h) } });
      for (const [, k] of part) k.uploaded = true;
      writeAtomic(STATE, JSON.stringify(state));
    }
    writeLists(state);
    const n = Object.values(state.keys).filter((k) => k.uploaded && !k.used && !k.test).length;
    log(`synced: ${n} keys ready, ${newlyUsed} newly used, ${send.length} new sent`);
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
}

async function status() {
  const state = readJson(STATE, { keys: {} });
  const all = Object.values(state.keys);
  const server = await call('GET', '/admin/state');
  console.log(`here: ${all.filter((k) => k.uploaded && !k.used && !k.test).length} ready, ${all.filter((k) => k.used).length} used, ${all.filter((k) => !k.uploaded && !k.used).length} not sent yet`);
  console.log(`server: ${server.unused.length} unused, ${server.used.length} used; release ${server.release ? `${server.release.version} (${Math.round(server.release.size / 1048576)} MB)` : 'none yet'}`);
}

async function testKey() {
  const state = readJson(STATE, { keys: {} });
  const key = newKey();
  const hash = keyHash(key);
  await call('POST', '/admin/keys', { json: { add: [hash] } });
  state.keys[hash] = { key, created: new Date().toISOString(), uploaded: true, test: true };
  writeAtomic(STATE, JSON.stringify(state));
  console.log(key);
}

async function release(dir, version) {
  if (!dir || !version) throw new Error('release <folder with latest.yml and the installer> <version>');
  const c = config();
  if (!c.channel) throw new Error(`no update channel in ${CONFIG}`);
  const files = ['latest.yml', 'Simurgh-Setup.exe.blockmap', 'Simurgh-Setup.exe'];
  const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(yml)) throw new Error(`latest.yml is not version ${version}`);
  // the installer and its blockmap first, the feed last: an updater never sees a version whose file isn't there
  for (const f of [files[2], files[1], files[0]]) {
    const t0 = Date.now();
    await call('PUT', `/admin/files/${c.channel}/${f}`, { file: path.join(dir, f), timeoutMs: 30 * 60 * 1000 });
    log(`uploaded ${f} in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  const sha512 = (/sha512: (\S+)/.exec(yml) || [])[1] || '';
  const r = await call('POST', '/admin/release', { json: { channel: c.channel, file: 'Simurgh-Setup.exe', version, sha512 } });
  log(`release ${r.release.version} is the download now (${Math.round(r.release.size / 1048576)} MB)`);
}

function setup(repo) {
  fs.mkdirSync(HOME, { recursive: true });
  if (!fs.existsSync(PRIVATE)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(PRIVATE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(`made ${PRIVATE}`);
  }
  const pub = crypto.createPublicKey(fs.readFileSync(PRIVATE, 'utf8')).export({ type: 'spki', format: 'pem' });
  if (repo) {
    fs.writeFileSync(path.join(repo, 'server', 'owner-public.pem'), pub);
    console.log(`wrote ${path.join(repo, 'server', 'owner-public.pem')}`);
  }
  if (!fs.existsSync(CONFIG)) writeAtomic(CONFIG, JSON.stringify({ ...config(), channel: crypto.randomBytes(18).toString('base64url') }, null, 2));
  console.log(`config ${CONFIG}`);
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'sync') await sync();
  else if (cmd === 'status') await status();
  else if (cmd === 'test-key') await testKey();
  else if (cmd === 'release') await release(args[0], args[1]);
  else if (cmd === 'setup') setup(args[0]);
  else console.log('simurgh-keys.mjs sync | status | test-key | release <dir> <version> | setup [<website repo>]');
} catch (e) {
  log(`error: ${e.message}`);
  process.exitCode = 1;
}
