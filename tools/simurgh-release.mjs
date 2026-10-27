// The owner's release tool, on the owner's PC: it signs its requests with the owner's key, so only this PC can put a
// new version on the download server.
//   node simurgh-release.mjs release <dir> <version>   uploads the installer, its blockmap and latest.yml from <dir> to
//                                                      the update channel and makes it the website's download (the
//                                                      installed copies see it within 30 minutes). It stops when
//                                                      What's new is still the release's before (Simurgh's
//                                                      assets/release-notes.md wasn't written); --same-notes lets it
//   node simurgh-release.mjs status                    the release on the server and how often each version was downloaded
//   node simurgh-release.mjs setup [<repo>]            makes the owner's signing key (once) and writes its public half
//                                                      to <repo>/server/owner-public.pem
//   node simurgh-release.mjs trust <device id> [<note>]  one of the owner's own computers: its id (Simurgh's Settings ->
//                                                      About - the full id, or the short one it shows, e.g.
//                                                      BC0D-2B31-4129: a computer where the owner's account is locked
//                                                      tells the server its full id) is signed with the owner's key and added to
//                                                      trusted-devices.json on the update channel. With the owner's
//                                                      Claude account, Simurgh unlocks Opus, Fable, Extra high/Max
//                                                      effort and Ultracode only on these computers.
//   node simurgh-release.mjs untrust <device id>       takes a computer off that list
//   node simurgh-release.mjs devices [--out <file>]    the list on the server (and a copy in <file>: Simurgh ships one
//                                                      in electron/agent/trusted-devices.json for offline starts)
// Files: %LOCALAPPDATA%\Simurgh Keys\ (config.json - the server and the update channel; owner-private.pem - keep it
// private). Until 2026-10-09 this was simurgh-keys.mjs and also made one-time download keys; downloads are free now.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = process.env.SIMURGH_RELEASE_HOME || process.env.SIMURGH_KEYS_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Simurgh Keys');
const CONFIG = path.join(HOME, 'config.json');
const PRIVATE = path.join(HOME, 'owner-private.pem');
const LOG = path.join(HOME, 'release.log');

// the signing is the server's own (shipped next to this file, or in the website repository)
const here = path.dirname(fileURLToPath(import.meta.url));
const lib = fs.existsSync(path.join(here, 'lib', 'auth.mjs')) ? path.join(here, 'lib') : path.join(here, '..', 'server');
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
    fs.appendFileSync(LOG, line);
  } catch {}
};
// latest.yml's releaseNotes (electron-builder writes it as a YAML block), spaces aside
const notesIn = (yml) => (/^releaseNotes:([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(yml)?.[1] || '').replace(/\s+/g, ' ').trim();

function config() {
  return { server: 'https://simurgh-download.onrender.com', ...readJson(CONFIG, {}) };
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

async function status() {
  const s = await call('GET', '/admin/state');
  const r = s.release;
  console.log(`release: ${r ? `${r.version} (${Math.round(r.size / 1048576)} MB, ${r.at})` : 'none yet'}`);
  const d = Object.entries(s.downloads || {}).sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true }));
  console.log(`downloads from the website: ${d.length ? d.map(([v, n]) => `${v}: ${n}`).join(', ') : 'none yet'}`);
}

async function release(dir, version, sameNotes = false) {
  if (!dir || !version) throw new Error('release <folder with latest.yml and the installer> <version>');
  const c = config();
  if (!c.channel) throw new Error(`no update channel in ${CONFIG}`);
  const files = ['latest.yml', 'Simurgh-Setup.exe.blockmap', 'Simurgh-Setup.exe'];
  const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(yml)) throw new Error(`latest.yml is not version ${version}`);
  // What's new on the update screen is latest.yml's releaseNotes (Simurgh's assets/release-notes.md): 0.1.41 went out
  // with 0.1.40's. The update channel's latest.yml is public.
  const live = await fetch(new URL(`/u/${c.channel}/latest.yml`, c.server), { cache: 'no-store', signal: AbortSignal.timeout(60000) });
  if (live.ok && !sameNotes) {
    const was = await live.text();
    const wasVersion = (/^version: (\S+)$/m.exec(was) || [])[1];
    if (wasVersion !== version && notesIn(was) && notesIn(was) === notesIn(yml)) throw new Error(`What's new in latest.yml is still ${wasVersion}'s - write Simurgh's assets/release-notes.md for ${version} and build again (or add --same-notes)`);
  }
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

// ---------------------------------------------------------------- the owner's computers
const TRUST_PREFIX = 'simurgh-trusted-device:'; // what is signed (Simurgh's electron/agent/ownerlock.js checks the same)
const LIST = 'trusted-devices.json';

async function serverList() {
  const c = config();
  if (!c.channel) throw new Error(`no update channel in ${CONFIG}`);
  const r = await fetch(new URL(`/u/${c.channel}/${LIST}`, c.server), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (r.status === 404) return { devices: [] };
  if (!r.ok) throw new Error(`GET ${LIST}: ${r.status}`);
  return r.json();
}

/** Only entries whose signature is the owner's, one per id. */
function cleanList(list) {
  const pub = crypto.createPublicKey(fs.readFileSync(PRIVATE, 'utf8'));
  const seen = new Map();
  for (const d of list.devices || []) {
    const id = String(d?.id || '').toLowerCase();
    try {
      if (/^[0-9a-f]{64}$/.test(id) && crypto.verify(null, Buffer.from(TRUST_PREFIX + id), pub, Buffer.from(String(d.sig), 'base64'))) seen.set(id, { id, sig: d.sig, ...(d.note ? { note: String(d.note) } : {}) });
    } catch {}
  }
  return { v: 1, devices: [...seen.values()] };
}

async function putList(list) {
  const c = config();
  const file = path.join(HOME, LIST);
  writeAtomic(file, `${JSON.stringify(list, null, 2)}\n`);
  await call('PUT', `/admin/files/${c.channel}/${LIST}`, { file });
}

/** The full id of a short one (the 12 characters Simurgh's About shows): a locked computer told the server its id. */
async function fullId(short) {
  const seen = (await call('GET', '/admin/devices-seen')).devices || [];
  const hits = [...new Set(seen.map((d) => d.id).filter((x) => x.startsWith(short)))];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`${hits.length} computers start with ${short} - use the full id (Copy id in its Settings → About)`);
  throw new Error(`no computer ${short} has told the server its id yet: open Simurgh 0.1.33 or newer there, signed in with your Claude account, and try again in a minute`);
}

async function trust(id, note) {
  let clean = String(id || '').trim().toLowerCase().replace(/-/g, '');
  if (/^[0-9a-f]{12,63}$/.test(clean)) clean = await fullId(clean);
  if (!/^[0-9a-f]{64}$/.test(clean)) throw new Error("trust <device id>: the id from Simurgh's Settings → About (the short one it shows, or the full one - Copy id)");
  const key = fs.readFileSync(PRIVATE, 'utf8');
  const list = cleanList(await serverList());
  const entry = { id: clean, sig: crypto.sign(null, Buffer.from(TRUST_PREFIX + clean), key).toString('base64'), ...(note ? { note: String(note).slice(0, 80) } : {}) };
  list.devices = [...list.devices.filter((d) => d.id !== clean), entry];
  await putList(list);
  log(`trusted ${clean.slice(0, 12)}…${note ? ` (${note})` : ''} - ${list.devices.length} computer(s) on the list`);
}

async function untrust(id) {
  const clean = String(id || '').trim().toLowerCase().replace(/-/g, '');
  const list = cleanList(await serverList());
  // the full id, or at least its short form (12 characters)
  if (clean.length < 12) throw new Error('untrust <device id>: at least the 12 characters of the short id');
  const left = list.devices.filter((d) => !d.id.startsWith(clean));
  if (left.length === list.devices.length) throw new Error(`${id} is not on the list`);
  list.devices = left;
  await putList(list);
  log(`took ${clean.slice(0, 12)}… off the list - ${left.length} computer(s) left`);
}

async function devices(out) {
  const list = cleanList(await serverList());
  for (const d of list.devices) console.log(`${d.id.slice(0, 12).toUpperCase().match(/.{4}/g).join('-')}  ${d.id}${d.note ? `  ${d.note}` : ''}`);
  if (!list.devices.length) console.log('no computers on the list yet');
  if (out) {
    writeAtomic(out, `${JSON.stringify(list, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
}

function setup(repo) {
  fs.mkdirSync(HOME, { recursive: true });
  if (!fs.existsSync(PRIVATE)) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
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
  if (cmd === 'release') await release(args[0], args[1], args.includes('--same-notes'));
  else if (cmd === 'status') await status();
  else if (cmd === 'setup') setup(args[0]);
  else if (cmd === 'trust') await trust(args[0], args.slice(1).join(' '));
  else if (cmd === 'untrust') await untrust(args[0]);
  else if (cmd === 'devices') await devices(args[0] === '--out' ? args[1] : null);
  else console.log('simurgh-release.mjs release <dir> <version> [--same-notes] | status | setup [<website repo>] | trust <device id> [<note>] | untrust <device id> | devices [--out <file>]');
} catch (e) {
  log(`error: ${e.message}`);
  process.exitCode = 1;
}
