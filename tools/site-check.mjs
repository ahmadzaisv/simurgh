// The website and the download server together, on this PC: a local server (temporary data, a throwaway signing key)
// serving the site, a headless Edge with its own temporary profile (the person's own browser is never used), and the
// download box tried the way a visitor would - no key, a wrong one, a real one (the installer arrives), the same
// one again. Pictures of the three pages, wide and phone-sized.
//   node tools/site-check.mjs <out dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newKey, keyHash } from '../server/keys.mjs';
import { signHeaders, sha256 } from '../server/auth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || '.');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simurgh-site-check-'));
const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${String(detail).slice(0, 300)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });

const server = spawn(process.execPath, [path.join(HERE, '..', 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), OWNER_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }), SERVE_SITE: path.join(HERE, '..', 'site') },
  stdio: 'ignore',
});
let edge;
const admin = async (method, p, body, raw) => {
  const buf = raw || (body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0));
  const h = sha256(buf);
  const r = await fetch(BASE + p, { method, headers: { ...signHeaders(PRIV, method, p, h), ...(raw ? { 'x-content-sha256': h } : { 'content-type': 'application/json' }) }, body: method === 'GET' ? undefined : buf });
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.json();
};

// a small DevTools client for the headless Edge
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
    else if (msg.method) for (const l of listeners) l(msg);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve) => (pending.set(++id, resolve), ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))));
  return { send, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  // keys, and a stand-in installer as the current release
  const keys = [newKey(), newKey()];
  await admin('POST', '/admin/keys', { add: keys.map(keyHash) });
  const exe = crypto.randomBytes(1536 * 1024);
  await admin('PUT', '/admin/files/local-check-channel/Simurgh-Setup.exe', null, exe);
  await admin('POST', '/admin/release', { channel: 'local-check-channel', file: 'Simurgh-Setup.exe', version: '0.1.14' });

  const profile = path.join(tmp, 'edge');
  const downloads = path.join(tmp, 'downloads');
  fs.mkdirSync(downloads);
  edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9341', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebarV2', 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 60 && !ver; i++) {
    ver = await fetch('http://127.0.0.1:9341/json/version').then((r) => r.json(), () => null);
    if (!ver) await sleep(250);
  }
  const b = await cdp(ver.webSocketDebuggerUrl);
  await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  const done = [];
  b.on((m) => m.method === 'Browser.downloadProgress' && m.params.state === 'completed' && done.push(m.params));
  const { result: t } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { result: s } = await b.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const S = s.sessionId;
  const ev = async (expr) => (await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S)).result?.result?.value;
  const go = async (url, w = 1280, h = 900, mobile = false) => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile }, S);
    await b.send('Page.navigate', { url }, S);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if ((await ev('document.readyState')) === 'complete') break;
    }
    await sleep(800);
  };
  const shot = async (name, full = true) => {
    const r = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full }, S);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
  };
  const submit = async (key) => {
    await ev(`(() => { const i = document.querySelector('#key'); i.value = ${JSON.stringify(key)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-keybox] button').click(); return true; })()`);
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      const m = await ev(`(() => { const m = document.querySelector('.msg'); return m.classList.contains('busy') ? null : m.innerText; })()`);
      if (m) return m;
    }
    return ev(`document.querySelector('.msg').innerText`);
  };

  await go(`${BASE}/`);
  await b.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads }, S).catch(() => {});
  check('the English page: no About, no story - the download and Notepad', /Download Simurgh/.test(await ev('document.body.innerText')) && !/Why I made|Bilal|What it does/.test(await ev('document.body.innerText')));
  check('the version and size from the server', (await ev(`document.querySelector('[data-version]').textContent`)) === 'Version 0.1.14 · 2 MB', await ev(`document.querySelector('[data-version]').textContent`));
  await ev('window.scrollTo(0, document.body.scrollHeight)'); // the lazy pictures further down
  await sleep(1500);
  await ev('window.scrollTo(0, 0)');
  const imgs = await ev(`[...document.images].map((i) => [i.getAttribute('src'), i.complete && i.naturalWidth > 0])`);
  check('all pictures load', imgs.every(([, ok]) => ok) && imgs.filter(([s]) => /shots\/notepad/.test(s)).length === 5, JSON.stringify(imgs));
  check('no key: asks for it', /Enter your download key/.test(await submit('')));
  check('not a key: says what one looks like', /20 letters and numbers/.test(await submit('hello')));
  check('a wrong key: not valid', /isn't valid/.test(await submit(newKey())));
  await ev(`(() => { const i = document.querySelector('#key'); i.value = ''; i.focus(); return true; })()`);
  await b.send('Input.insertText', { text: keys[0].toLowerCase().replace(/-/g, '') }, S);
  check('the key is tidied as it is typed', (await ev(`document.querySelector('#key').value`)) === keys[0], await ev(`document.querySelector('#key').value`));
  await shot('1-en-typed.png', false);
  const okMsg = await submit(keys[0]);
  check('a real key: the download starts', /download has started \(Simurgh-Setup\.exe, 2 MB\)/.test(okMsg), okMsg);
  for (let i = 0; i < 40 && !done.length; i++) await sleep(250);
  const got = fs.readdirSync(downloads).filter((f) => !f.endsWith('.crdownload'));
  check('the installer arrives, byte for byte, as Simurgh-Setup.exe', got.includes('Simurgh-Setup.exe') && fs.readFileSync(path.join(downloads, 'Simurgh-Setup.exe')).equals(exe), JSON.stringify(got));
  await shot('2-en-started.png', false);
  check('the same key again: already used', /already been used/.test(await submit(keys[0])));
  const st = await admin('GET', '/admin/state');
  check('the server knows when and on what', st.used.length === 1 && /^Windows 1[01]/.test(st.used[0].os) && /Edge/.test(st.used[0].browser), JSON.stringify(st.used[0]));
  await go(`${BASE}/`);
  await shot('3-en.png');
  await go(`${BASE}/ps/`);
  check('the Pashto page, right to left', (await ev('document.documentElement.dir')) === 'rtl' && /سیمرغ ډاونلوډ کړئ/.test(await ev('document.body.innerText')));
  check('Pashto: a used key', /مخکې کارول شوې/.test(await submit(keys[0])));
  await shot('4-ps.png');
  await go(`${BASE}/fa/`);
  check('the Dari page', /دانلود سیمرغ/.test(await ev('document.body.innerText')));
  check('Dari: a wrong key', /درست نیست/.test(await submit(newKey())));
  await shot('5-fa.png');
  await go(`${BASE}/`, 390, 844, true);
  check('on a phone: no sideways scrolling', (await ev('document.documentElement.scrollWidth')) <= 390, await ev('document.documentElement.scrollWidth'));
  await shot('6-phone.png');
  await b.send('Browser.close').catch(() => {});
  b.close();
} catch (e) {
  check('driver', false, e.stack);
} finally {
  // Edge runs as several processes: end them all (only this test's, by its process tree)
  // Edge restarts itself into several processes: end every one that uses this test's own profile
  await sleep(1000);
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(tmp)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' });
  server.kill();
  await sleep(1500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
