// The owner's release tool, on the owner's PC: it signs its requests with the owner's key, so only this PC can put a
// new version on the download server.
//   node simurgh-release.mjs release <dir> <version>   uploads the installer, its blockmap and latest.yml from <dir> to
//                                                      the update channel and makes it the website's download (the
//                                                      installed copies see it within 30 minutes)
//   node simurgh-release.mjs status                    the release on the server and how often each version was downloaded
//   node simurgh-release.mjs setup [<repo>]            makes the owner's signing key (once) and writes its public half
//                                                      to <repo>/server/owner-public.pem
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
  if (cmd === 'release') await release(args[0], args[1]);
  else if (cmd === 'status') await status();
  else if (cmd === 'setup') setup(args[0]);
  else console.log('simurgh-release.mjs release <dir> <version> | status | setup [<website repo>]');
} catch (e) {
  log(`error: ${e.message}`);
  process.exitCode = 1;
}
