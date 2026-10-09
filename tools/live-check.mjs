// The live website and download server, from a headless Edge with its own temporary profile (the person's browser is
// never used): the page, the version from the server, no download key anywhere, and the Download button handing the
// browser the installer (the download itself is refused by this browser - only its start is checked).
//   node tools/live-check.mjs <out dir> [<version expected>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const OUT = path.resolve(process.argv[2] || '.');
const VERSION = process.argv[3] || '';
fs.mkdirSync(OUT, { recursive: true });
const SITE = 'https://simurgh.onrender.com';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simurgh-live-check-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${String(detail).slice(0, 300)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=9342', `--user-data-dir=${path.join(tmp, 'edge')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
try {
  let ver;
  for (let i = 0; i < 60 && !ver; i++) {
    ver = await fetch('http://127.0.0.1:9342/json/version').then((r) => r.json(), () => null);
    if (!ver) await sleep(250);
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
    else if (msg.method) events.push(msg);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve) => (pending.set(++id, resolve), ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))));
  await send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
  const t = (await send('Target.createTarget', { url: 'about:blank' })).result;
  const S = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result.sessionId;
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S)).result?.result?.value;
  const go = async (url) => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, S);
    await send('Page.navigate', { url }, S);
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      if ((await ev('document.readyState')) === 'complete') break;
    }
    await sleep(2500);
  };
  const shot = async (name) => fs.writeFileSync(path.join(OUT, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, S)).result.data, 'base64'));
  await go(`${SITE}/`);
  const text = await ev('document.body.innerText');
  check('the live page: the download and Notepad only', /Download Simurgh/.test(text) && /Simurgh Notepad/.test(text) && !/Why I made|Bilal|What it does|Questions/.test(text));
  check('no download key on the live page', !/download key|Each key works once/i.test(text) && !(await ev(`!!document.querySelector('#key, [data-keybox]')`)));
  const v = await ev(`document.querySelector('[data-version]').textContent`);
  check('the version from the download server', /^Version \d+\.\d+\.\d+ · \d+ MB$/.test(v) && (!VERSION || v.includes(VERSION)), v);
  await ev(`document.querySelector('[data-download]').click()`);
  for (let i = 0; i < 40 && !events.some((e) => e.method === 'Browser.downloadWillBegin'); i++) await sleep(250);
  check('the Download button hands the browser the installer', events.some((e) => e.method === 'Browser.downloadWillBegin' && e.params.suggestedFilename === 'Simurgh-Setup.exe'), events.filter((e) => /download/i.test(e.method)).map((e) => e.params.suggestedFilename).join(','));
  await shot('live-en.png');
  await go(`${SITE}/ps/`);
  check('the live Pashto page with its button', /سیمرغ ډاونلوډ کړئ/.test(await ev('document.body.innerText')) && (await ev(`document.querySelector('[data-download]')?.innerText.trim()`)) === 'د وینډوز لپاره ډاونلوډ');
  await shot('live-ps.png');
  await send('Browser.close').catch(() => {});
  ws.close();
} catch (e) {
  check('driver', false, e.stack);
} finally {
  await sleep(1000);
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(tmp)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' });
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
