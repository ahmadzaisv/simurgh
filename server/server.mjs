// Simurgh's download server (Render web service "simurgh-download", disk at DATA_DIR):
//   GET  /download                   the installer of the newest version - free, no key (resumable)
//   GET  /download/linux/<file>      a Linux package of it (.deb, .rpm, AppImage; x64 and ARM64)
//   GET  /api/latest                 the version and size shown on the website
//   GET  /ios/source.json            Simurgh for iPhone as a SideStore / AltStore source (they install it signed with
//                                    the user's own free Apple ID, and show each new version as an update)
//   GET  /download/ios[/<file>]      the iPhone app itself (.ipa): the newest, or one of the last few by name
//   GET  /api/ios/latest             the iPhone app's newest version (the website and the app's own update notice)
//   GET  /u/<channel>/<file>         the installed app's updates (latest.yml + installer), and trusted-devices.json - the
//                                    owner's own computers, each signed with his key (Simurgh's owner device lock)
//   POST /api/device                 a computer where the owner's own Claude account is locked tells its device id
//                                    (a hash) - so the owner can trust it by the short id he sees in its About page
//   /admin/...                       the owner's tool (signed on the owner's PC - see auth.mjs): upload a new version,
//                                    read the release and how many times each version was downloaded; the iPhone
//                                    app's release (POST /admin/ios-release, after its .ipa is uploaded)
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
const SEEN_DAYS = 30; // a locked computer's device id is kept this long for the owner's tool
const SEEN_MAX = 200;
const IPA_NAME = /^Simurgh-\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\.ipa$/;
const IOS_KEEP = 3; // the iPhone versions kept on the disk and listed in the source (older .ipa files are deleted)

const TYPES = { '.ipa': 'application/octet-stream', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.yml': 'text/yaml; charset=utf-8', '.json': 'application/json', '.mp4': 'video/mp4' };

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

  /** A Linux package of the newest version: from the same channel, counted with the version as "<version> linux". */
  const LINUX_FILES = new Set(['Simurgh-amd64.deb', 'Simurgh-arm64.deb', 'Simurgh-x86_64.rpm', 'Simurgh-aarch64.rpm', 'Simurgh-x86_64.AppImage', 'Simurgh-arm64.AppImage']);
  function downloadLinux(req, res, name) {
    const rel = db().release;
    const file = rel && LINUX_FILES.has(name) && store.filePath(rel.channel, name);
    if (!file || !fs.existsSync(file)) return send(res, 404, 'There is no such Linux package yet.\n');
    const fromStart = !req.headers.range || /^bytes=0-/.test(String(req.headers.range));
    if (req.method === 'GET' && fromStart) {
      const key = `${rel.version} linux`;
      db().downloads[key] = (db().downloads[key] || 0) + 1;
      store.saveSoon();
    }
    sendFile(req, res, file, { name, type: 'application/octet-stream', extra: { 'cache-control': 'no-store' } });
  }

  // ---------------------------------------------------------------- Simurgh for iPhone
  // Apple lets an iPhone app come from a website only in the EU, Japan and Brazil, and the App Store asks a yearly fee
  // and its review. So the iPhone app is offered the free way: SideStore or AltStore on the user's iPhone signs the
  // .ipa with the user's own free Apple ID and installs it, and this source tells them about each new version.
  const ios = () => db().ios || null;
  const iosVersions = (r) => (r ? [r, ...(r.history || [])] : []);
  const selfBase = (req) => {
    const host = String(req.headers.host || '');
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    return `${local ? 'http' : String(req.headers['x-forwarded-proto'] || 'https').split(',')[0]}://${host}`;
  };
  const siteBase = (req) => (siteDir ? selfBase(req) : origins[0] || selfBase(req));
  const ipaUrl = (req, file) => `${selfBase(req)}/download/ios/${file}`;

  /** The source SideStore and AltStore read (their format: https://faq.altstore.io/developers/make-a-source). */
  function iosSource(req) {
    const r = ios();
    const site = siteBase(req);
    const icon = `${site}/assets/ios-icon.png`;
    const about =
      'Simurgh is your own AI assistant on your iPhone, with your own Claude plan: it chats in English and Pashto, ' +
      'reads its answers aloud, browses the web with your saved passwords, runs a shell on your own server and can ' +
      'work your iPhone for you. It makes its own free server on Google Cloud from the iPhone, with no computer.\n\n' +
      'سیمرغ ستاسو خپل هوښیار مرستیال دی، چې ستاسو په ایفون کې ستاسو د Claude له پلان سره کار کوي.';
    const app = {
      name: 'Simurgh',
      bundleIdentifier: r?.bundleID || 'com.bilal.Simurgh',
      developerName: 'Simurgh',
      subtitle: 'Your own AI assistant, with your Claude plan',
      localizedDescription: about,
      iconURL: icon,
      tintColor: '#4f7fff',
      category: 'productivity',
      screenshots: [],
      versions: iosVersions(r).map((v) => ({
        version: v.version,
        buildVersion: String(v.build),
        date: v.at,
        localizedDescription: v.notes || `Simurgh ${v.version}`,
        downloadURL: ipaUrl(req, v.file),
        size: v.size,
        ...(v.sha256 ? { sha256: v.sha256 } : {}),
        minOSVersion: v.minOS || '18.0',
      })),
      appPermissions: { entitlements: r?.entitlements || [], privacy: r?.privacy || {} },
    };
    // the fields older SideStore and AltStore builds read
    if (r) Object.assign(app, { version: r.version, versionDate: r.at, versionDescription: r.notes || '', downloadURL: ipaUrl(req, r.file), size: r.size });
    return {
      name: 'Simurgh',
      identifier: 'com.onrender.simurgh',
      subtitle: 'Simurgh for iPhone',
      description: about,
      iconURL: icon,
      website: site,
      tintColor: '#4f7fff',
      featuredApps: [app.bundleIdentifier],
      apps: r ? [app] : [],
      news: [],
    };
  }

  /** The iPhone app: the newest (/download/ios) or one of the versions the source lists, counted as "<version> ios". */
  function downloadIos(req, res, name) {
    const r = ios();
    const v = name ? iosVersions(r).find((x) => x.file === name) : r;
    const file = v && store.filePath(r.channel, v.file);
    if (!file || !fs.existsSync(file)) return send(res, 404, 'There is no such iPhone version (yet).\n');
    const fromStart = !req.headers.range || /^bytes=0-/.test(String(req.headers.range));
    if (req.method === 'GET' && fromStart) {
      const key = `${v.version} ios`;
      db().downloads[key] = (db().downloads[key] || 0) + 1;
      store.saveSoon();
    }
    sendFile(req, res, file, { name: v.file, type: 'application/octet-stream', extra: { 'cache-control': 'no-store' } });
  }

  /** The owner's tool made a new iPhone version the current one (its .ipa is already uploaded to the channel). */
  function iosRelease(body) {
    const file = store.filePath(body.channel, body.file);
    if (!file || !IPA_NAME.test(String(body.file)) || !fs.existsSync(file)) return { status: 400, error: 'upload the .ipa first' };
    if (!/^\d+\.\d+\.\d+/.test(String(body.version || '')) || !/^\d+$/.test(String(body.build || ''))) return { status: 400, error: 'a version (1.2.3) and a build number' };
    const was = ios();
    const entry = {
      version: String(body.version),
      build: Number(body.build),
      file: body.file,
      size: fs.statSync(file).size,
      sha256: /^[0-9a-f]{64}$/.test(String(body.sha256 || '')) ? body.sha256 : '',
      notes: String(body.notes || '').slice(0, 4000),
      notesPs: String(body.notesPs || '').slice(0, 4000),
      minOS: /^\d+(\.\d+){0,2}$/.test(String(body.minOS || '')) ? String(body.minOS) : '18.0',
      at: new Date(now()).toISOString(),
    };
    if (was && was.build >= entry.build && was.file !== entry.file) return { status: 409, error: `build ${entry.build} is not newer than the current ${was.build} (${was.version})` };
    // the versions before it (the same file again replaces itself); the oldest beyond IOS_KEEP leave the disk
    const strip = ({ history, channel, bundleID, privacy, entitlements, ...v }) => v;
    const older = iosVersions(was).map(strip).filter((v) => v.file !== entry.file);
    for (const v of older.slice(IOS_KEEP - 1)) {
      const f = store.filePath(was.channel, v.file);
      if (f) fs.rmSync(f, { force: true });
    }
    const privacy = {};
    for (const [k, t] of Object.entries(body.privacy || {})) if (/^NS[A-Za-z]+UsageDescription$/.test(k)) privacy[k] = String(t).slice(0, 500);
    db().ios = {
      ...entry,
      channel: body.channel,
      bundleID: /^[A-Za-z0-9.-]{3,155}$/.test(String(body.bundleID || '')) ? body.bundleID : 'com.bilal.Simurgh',
      privacy,
      entitlements: Array.isArray(body.entitlements) ? body.entitlements.map(String).filter((e) => /^[A-Za-z0-9._-]{3,120}$/.test(e)) : [],
      history: older.slice(0, IOS_KEEP - 1),
    };
    store.save();
    log(`iPhone release ${entry.version} (${entry.build})`);
    return { status: 200, ios: db().ios };
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

  /**
   * A computer where the owner's account is locked says its device id (only Simurgh with the owner's account signed in
   * sends it; an id is a SHA-256, nothing about the person). Kept a month, newest 200, a few per address an hour.
   */
  const seenBy = new Map(); // ip -> { n, since }
  async function deviceSeen(req, res, ip) {
    const b = seenBy.get(ip);
    if (b && now() - b.since < 3600 * 1000 && b.n >= 20) return send(res, 429, { error: 'too many' });
    seenBy.set(ip, b && now() - b.since < 3600 * 1000 ? { ...b, n: b.n + 1 } : { n: 1, since: now() });
    let id = '';
    try {
      id = String(JSON.parse((await readBody(req, 1024)).toString('utf8')).id || '').toLowerCase();
    } catch {}
    if (!/^[0-9a-f]{64}$/.test(id)) return send(res, 400, { error: 'bad id' });
    const seen = (db().devicesSeen ||= {});
    seen[id] = new Date(now()).toISOString();
    const keep = Object.entries(seen)
      .filter(([, at]) => now() - Date.parse(at) < SEEN_DAYS * 24 * 3600 * 1000)
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, SEEN_MAX);
    db().devicesSeen = Object.fromEntries(keep);
    store.saveSoon();
    return send(res, 200, { ok: true });
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
    if (req.method === 'GET' && url.pathname === '/admin/state') return send(res, 200, { release: db().release, ios: ios(), downloads: db().downloads });
    if (req.method === 'GET' && url.pathname === '/admin/devices-seen') return send(res, 200, { devices: Object.entries(db().devicesSeen || {}).map(([id, at]) => ({ id, at })) });
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
    if (req.method === 'POST' && url.pathname === '/admin/ios-release') {
      const r = iosRelease(body);
      return send(res, r.status, r.error ? { error: r.error } : { ios: r.ios });
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
      if (url.pathname === '/ios/source.json' && (req.method === 'GET' || req.method === 'HEAD')) return send(res, 200, iosSource(req), { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' });
      if (url.pathname === '/api/ios/latest' && req.method === 'GET') {
        const r = ios();
        const body = r ? { version: r.version, build: r.build, size: r.size, minOS: r.minOS, notes: r.notes, notesPs: r.notesPs, at: r.at, ipa: ipaUrl(req, r.file), source: `${selfBase(req)}/ios/source.json`, page: `${siteBase(req)}/#iphone` } : { version: null };
        return send(res, 200, body, { ...cors, 'cache-control': 'public, max-age=300' });
      }
      const ipa = /^\/download\/ios(?:\/([^/]+))?$/.exec(url.pathname);
      if (ipa && (req.method === 'GET' || req.method === 'HEAD')) return downloadIos(req, res, ipa[1] ? decodeURIComponent(ipa[1]) : null);
      const lin = /^\/download\/linux\/([^/]+)$/.exec(url.pathname);
      if (lin && (req.method === 'GET' || req.method === 'HEAD')) return downloadLinux(req, res, lin[1]);
      if (url.pathname === '/api/device' && req.method === 'POST') return await deviceSeen(req, res, clientIp(req));
      // the old one-time links and keys: gone - the page now has a plain download
      if ((url.pathname === '/api/redeem' && req.method === 'POST') || /^\/d\//.test(url.pathname)) return send(res, 410, { error: 'gone', message: 'Download keys are no longer needed: download from https://simurgh.onrender.com' }, cors);
      const u = /^\/u\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (u && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = store.filePath(u[1], u[2]);
        if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'missing' });
        return sendFile(req, res, file, { extra: { 'cache-control': /\.(yml|json)$/.test(u[2]) ? 'no-cache' : 'public, max-age=3600' } });
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
