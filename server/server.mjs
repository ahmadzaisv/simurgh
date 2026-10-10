// Simurgh's download server (Render web service "simurgh-download", disk at DATA_DIR):
//   GET  /download                   the installer of the newest version - free, no key (resumable)
//   GET  /api/latest                 the version and size shown on the website
//   GET  /u/<channel>/<file>         the installed app's updates (latest.yml + installer)
//   /admin/...                       the owner's tool (signed on the owner's PC - see auth.mjs): upload a new version,
//                                    read the release and how many times each version was downloaded
//   /u/clip-<random>/<name>.mp4      a clip the owner's Simurgh put here for a few minutes, for Instagram to fetch
//                                    (Instagram login takes a video only by a public link); Simurgh deletes it once
//                                    Instagram has it, and any left after a day go when the next one comes
// (Until 2026-10-09 a download needed a one-time key; the owner removed that: anyone may download.)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyRequest, sha256 } from './auth.mjs';
import { clientIp } from './who.mjs';
import { Store } from './store.mjs';
import { createVoice } from './voice.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD = 700 * 1024 * 1024;
const CLIP_DIR = /^clip-[A-Za-z0-9_-]{16,}$/; // a clip's folder (its name is the secret part of the link)
const CLIP_DAY = 24 * 3600 * 1000;

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.yml': 'text/yaml; charset=utf-8', '.json': 'application/json', '.mp4': 'video/mp4' };

export function createServer({ dataDir, publicKeyPem, origins = [], siteDir = null, now = () => Date.now(), log = console.log } = {}) {
  const store = new Store(dataDir);
  const voice = createVoice({ dir: path.join(dataDir, 'voice'), now, log }); // the Pashto voice project (voice.mjs)
  const seen = new Map(); // signatures already used
  const db = () => store.db;

  const corsFor = (req) => {
    const o = req.headers.origin;
    if (!o) return {};
    const ok = origins.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
    return ok ? { 'access-control-allow-origin': o, vary: 'Origin', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-voice-text, x-voice-code', 'access-control-max-age': '600' } : {};
  };
  const send = (res, status, body, headers = {}) => {
    const json = typeof body !== 'string';
    res.writeHead(status, { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(json ? JSON.stringify(body) : body);
  };
  const readBody = (req, limit) =>
    new Promise((resolve, reject) => {
      const parts = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > limit) {
          reject(Object.assign(new Error('too big'), { status: 413 }));
          req.destroy();
        } else parts.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', reject);
    });

  /** A file to the browser or the updater: whole, or one range of it (resuming). */
  const sendFile = (req, res, file, { name, type, extra = {} } = {}) => {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return send(res, 404, { error: 'missing' });
    }
    const headers = { 'content-type': type || TYPES[path.extname(file)] || 'application/octet-stream', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', ...extra };
    if (name) headers['content-disposition'] = `attachment; filename="${name}"`;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    if (m && (m[1] || m[2])) {
      start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['content-length'] = String(end - start + 1);
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  };

  // ---------------------------------------------------------------- the website's side
  /** The newest installer, for anyone: counted per version (a download from its start; resuming is not counted). */
  function download(req, res) {
    const rel = db().release;
    const file = rel && store.filePath(rel.channel, rel.file);
    if (!file || !fs.existsSync(file)) return send(res, 503, 'The download is not ready yet. Try again in a few minutes.\n');
    const fromStart = !req.headers.range || /^bytes=0-/.test(String(req.headers.range));
    if (req.method === 'GET' && fromStart) {
      db().downloads[rel.version] = (db().downloads[rel.version] || 0) + 1;
      store.saveSoon();
    }
    sendFile(req, res, file, { name: 'Simurgh-Setup.exe', type: 'application/vnd.microsoft.portable-executable', extra: { 'cache-control': 'no-store' } });
  }

  /** Clip folders left over for more than a day (Simurgh stopped before it deleted one): gone. */
  function clearOldClips(keep) {
    const dir = path.join(dataDir, 'files');
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => CLIP_DIR.test(n) && n !== keep);
    } catch {
      return;
    }
    for (const n of names) {
      try {
        if (now() - fs.statSync(path.join(dir, n)).mtimeMs > CLIP_DAY) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
      } catch {}
    }
  }

  // ---------------------------------------------------------------- the owner's side (signed)
  async function admin(req, res, url) {
    const pathAndQuery = url.pathname + url.search;
    const upload = req.method === 'PUT';
    let raw = Buffer.alloc(0);
    if (!upload && req.method !== 'GET') raw = await readBody(req, 8 * 1024 * 1024);
    const bodyHash = upload ? String(req.headers['x-content-sha256'] || '') : sha256(raw);
    const v = verifyRequest({ publicKeyPem, method: req.method, pathAndQuery, headers: req.headers, bodyHash, seen, now: now() });
    if (!v.ok) {
      log(`admin refused: ${v.why}`);
      return send(res, 401, { error: v.why });
    }
    const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    if (url.pathname.startsWith('/admin/voice/')) {
      const r = voice.admin(req, res, url, body, { send, sendFile });
      if (r !== false) return r;
    }
    if (req.method === 'GET' && url.pathname === '/admin/state') return send(res, 200, { release: db().release, downloads: db().downloads });
    const up = /^\/admin\/files\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (upload && up) {
      const file = store.filePath(up[1], up[2]);
      const size = Number(req.headers['content-length']);
      if (!file || !/^[0-9a-f]{64}$/.test(bodyHash) || !(size > 0) || size > MAX_UPLOAD) return send(res, 400, { error: 'bad upload' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.part`;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmp);
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        hash.update(c);
      });
      req.pipe(out);
      await new Promise((resolve, reject) => {
        out.on('finish', resolve);
        out.on('error', reject);
        req.on('error', reject);
      });
      if (n !== size || hash.digest('hex') !== bodyHash) {
        fs.rmSync(tmp, { force: true });
        return send(res, 400, { error: 'the file arrived damaged - upload it again' });
      }
      fs.renameSync(tmp, file);
      log(`uploaded ${up[1].slice(0, 4)}…/${up[2]} (${n} bytes)`);
      if (CLIP_DIR.test(up[1])) clearOldClips(up[1]);
      return send(res, 200, { ok: true, size: n });
    }
    if (req.method === 'DELETE' && up) {
      const file = store.filePath(up[1], up[2]);
      if (!file) return send(res, 400, { error: 'bad name' });
      fs.rmSync(file, { force: true });
      // a clip's folder goes with its file
      if (CLIP_DIR.test(up[1])) fs.rmSync(path.dirname(file), { recursive: true, force: true });
      log(`deleted ${up[1].slice(0, 4)}…/${up[2]}`);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/admin/release') {
      const file = store.filePath(body.channel, body.file);
      if (!file || !fs.existsSync(file) || !body.version) return send(res, 400, { error: 'upload the files first' });
      db().release = { version: String(body.version), channel: body.channel, file: body.file, size: fs.statSync(file).size, sha512: String(body.sha512 || ''), at: new Date(now()).toISOString() };
      store.save();
      log(`release ${body.version}`);
      return send(res, 200, { release: db().release });
    }
    return send(res, 404, { error: 'no such thing' });
  }

  // ---------------------------------------------------------------- routing
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const cors = corsFor(req);
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      if (url.pathname === '/health') return send(res, 200, 'ok\n');
      if (url.pathname === '/api/latest' && req.method === 'GET') {
        const r = db().release;
        return send(res, 200, r ? { version: r.version, size: r.size } : { version: null }, { ...cors, 'cache-control': 'public, max-age=60' });
      }
      if ((url.pathname === '/download' || url.pathname === '/download/Simurgh-Setup.exe') && (req.method === 'GET' || req.method === 'HEAD')) return download(req, res);
      // the old one-time links and keys: gone - the page now has a plain download
      if ((url.pathname === '/api/redeem' && req.method === 'POST') || /^\/d\//.test(url.pathname)) return send(res, 410, { error: 'gone', message: 'Download keys are no longer needed: download from https://simurgh.onrender.com' }, cors);
      const u = /^\/u\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (u && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = store.filePath(u[1], u[2]);
        if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'missing' });
        return sendFile(req, res, file, { extra: { 'cache-control': u[2].endsWith('.yml') ? 'no-cache' : 'public, max-age=3600' } });
      }
      if (url.pathname.startsWith('/voice/api/')) {
        const r = await voice.handle(req, res, url, { send, readBody, sendFile, ip: clientIp(req), cors });
        if (r !== false) return;
      }
      if (url.pathname.startsWith('/admin/')) return await admin(req, res, url);
      // a local test run serves the website too; on Render the website is its own static site
      if (siteDir && (req.method === 'GET' || req.method === 'HEAD')) {
        let rel = decodeURIComponent(url.pathname);
        if (rel.endsWith('/')) rel += 'index.html';
        const file = path.join(siteDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
        if (file.startsWith(siteDir) && fs.existsSync(file) && fs.statSync(file).isFile()) return sendFile(req, res, file, { extra: { 'cache-control': 'no-cache' } });
      }
      if (url.pathname === '/') return send(res, 302, '', { location: origins[0] || '/' });
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log(`error ${req.method} ${url.pathname}: ${e.message}`);
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'server error' }, cors);
      else res.destroy();
    }
  });
  return { server, store, voice };
}

// ---------------------------------------------------------------- run
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.DATA_DIR || path.join(HERE, '..', '.data');
  const publicKeyPem = process.env.OWNER_PUBLIC_KEY || fs.readFileSync(path.join(HERE, 'owner-public.pem'), 'utf8');
  const origins = (process.env.SITE_ORIGINS || 'https://simurgh.onrender.com').split(',').map((s) => s.trim()).filter(Boolean);
  const siteDir = process.env.SERVE_SITE ? path.resolve(process.env.SERVE_SITE) : null;
  const { server } = createServer({ dataDir, publicKeyPem, origins, siteDir, log: (m) => console.log(new Date().toISOString(), m) });
  const port = Number(process.env.PORT || 10000);
  server.listen(port, () => console.log(`simurgh-download on :${port}, data in ${dataDir}`));
}
