// پښتو غږ on this PC, the way a speaker uses it: a local server (temporary data, a throwaway signing key) serving the
// site, a headless Edge with its own temporary profile and a FAKE microphone that plays a sound file (the person's
// own browser and microphone are never used). Join with consent, keep the code, read sentences, speak about a topic,
// check someone else's recording and fix a text, come back with the code, delete everything. Pictures, phone-sized.
//   node tools/voice-check.mjs <out dir> [speech.wav]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signHeaders, sha256 } from '../server/auth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.argv[2] || '.');
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simurgh-voice-check-'));
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FFMPEG = ['C:/ProgramData/chocolatey/bin/ffmpeg.exe', 'ffmpeg'].find((f) => f === 'ffmpeg' || fs.existsSync(f));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${String(detail).slice(0, 300)}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });

// the fake microphone's sound: the given speech, or a warbling tone that looks like speech to a level meter
let wav = process.argv[3] && path.resolve(process.argv[3]);
if (!wav) {
  wav = path.join(tmp, 'tone.wav');
  const rate = 16000;
  const n = rate * 8;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0), b.writeUInt32LE(36 + n * 2, 4), b.write('WAVEfmt ', 8), b.writeUInt32LE(16, 16), b.writeUInt16LE(1, 20), b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24), b.writeUInt32LE(rate * 2, 28), b.writeUInt16LE(2, 32), b.writeUInt16LE(16, 34), b.write('data', 36), b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * (160 + 40 * Math.sin(i / 3000)) * i) / rate) * (0.5 + 0.5 * Math.sin(i / 1800))), 44 + i * 2);
  fs.writeFileSync(wav, b);
}

const server = spawn(process.execPath, [path.join(HERE, '..', 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), OWNER_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }), SERVE_SITE: path.join(HERE, '..', 'site') },
  stdio: 'ignore',
});
let edge;
const admin = async (method, p, body) => {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const r = await fetch(BASE + p, { method, headers: { ...signHeaders(PRIV, method, p, sha256(buf)), 'content-type': 'application/json' }, body: method === 'GET' ? undefined : buf });
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : Buffer.from(await r.arrayBuffer());
};
/** Seconds and loudness of a recording, decoded by ffmpeg. */
const probe = (file) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const t = r.stderr.match(/time=(\d+):(\d+):([\d.]+)/g)?.pop()?.match(/time=(\d+):(\d+):([\d.]+)/);
  return { seconds: t ? +t[1] * 3600 + +t[2] * 60 + +t[3] : 0, mean: Number(r.stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1] ?? -99) };
};

// a small DevTools client for the headless Edge
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg), pending.delete(msg.id);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve) => (pending.set(++id, resolve), ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))));
  return { send, close: () => ws.close() };
}

try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  const SENTENCES = ['زه هره ورځ سهار وختي له خوبه پاڅېږم.', 'ستاسو کور له ښوونځي څومره لرې دی؟', 'نن د باران ورځ ده، چترۍ درسره واخلئ.'];
  check('the owner adds sentences', (await admin('POST', '/admin/voice/sentences', { add: SENTENCES.map((text) => ({ text, source: 'check' })) })).added === 3);

  const profile = path.join(tmp, 'edge');
  // the fake microphone: these flags make Edge play the file instead of opening any real device
  edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9342', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 60 && !ver; i++) {
    ver = await fetch('http://127.0.0.1:9342/json/version').then((r) => r.json(), () => null);
    if (!ver) await sleep(250);
  }
  const b = await cdp(ver.webSocketDebuggerUrl);
  const { result: t } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { result: s } = await b.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const S = s.sessionId;
  const ev = async (expr) => {
    const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, S);
    if (r.result?.exceptionDetails) throw new Error(`${expr.slice(0, 80)}: ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    return r.result?.result?.value;
  };
  await b.send('Page.enable', {}, S);
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push(e.message)); addEventListener('unhandledrejection', (e) => __errs.push(String(e.reason)));` }, S);
  const go = async (url, w = 390, h = 844) => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true }, S);
    await b.send('Page.navigate', { url }, S);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      if ((await ev('document.readyState')) === 'complete') break;
    }
    await ev(`document.fonts.ready.then(() => true)`);
    await sleep(700);
  };
  const shot = async (name) => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S); // a nudge, or headless captures can stall
    const r = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, S);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
  };
  const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`);
  const visible = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !!e.offsetParent; })()`);
  const click = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)}).click(), true)`);
  const until = async (fn, ms = 8000) => {
    for (let i = 0; i < ms / 150; i++) {
      const v = await fn();
      if (v) return v;
      await sleep(150);
    }
    return fn();
  };
  /** Record `secs` seconds in the panel's recorder, listen check, and send. */
  const record = async (panel, secs) => {
    const p = `[data-panel="${panel}"]`;
    await click(`${p} [data-mic]`);
    await until(() => ev(`document.querySelector('${p} [data-mic]').classList.contains('on')`));
    let level = 0;
    for (const end = Date.now() + secs * 1000; Date.now() < end; await sleep(100)) level = Math.max(level, await ev(`parseFloat(document.querySelector('${p} [data-meter] i').style.width) || 0`));
    await click(`${p} [data-mic]`);
    await until(() => visible(`${p} [data-after]`));
    const dur = await until(() => ev(`(() => { const a = document.querySelector('${p} [data-play]'); return a.readyState >= 1 && a.duration > 0 && a.duration !== Infinity ? a.duration : (a.duration === Infinity ? -1 : 0); })()`), 4000);
    return { level, dur, state: await text(`${p} [data-state]`) };
  };

  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, S);
  await go(`${BASE}/voice/`);
  check('the page: Pashto, right to left, what it is and the promise', (await ev('document.documentElement.dir')) === 'rtl' && /خپل غږ د پښتو ژبې لپاره ورکړئ/.test(await text('h1')) && /هېچا ته نه ورکول کېږي/.test(await text('.promise')));
  check('the totals come from the server', /۰ کسانو/.test(await until(() => text('[data-stats]'))), await text('[data-stats]'));
  check('on a phone: no sideways scrolling', (await ev('document.documentElement.scrollWidth')) <= 390, await ev('document.documentElement.scrollWidth'));
  await shot('1-intro.png');
  // no consent: nothing happens (the browser's own "required"), no code
  await ev(`document.querySelector('[data-join]').requestSubmit(), true`);
  await sleep(500);
  check('without the consent there is no code', (await ev(`localStorage.getItem('pashto-voice-code')`)) === null && (await visible('[data-page="intro"]')));
  await ev(`(() => { const f = document.querySelector('[data-join]'); f.dialect.value = 'southern'; f.region.value = 'کندهار'; f.age.value = '18-29'; f.consent.checked = true; f.requestSubmit(); return true; })()`);
  const code = await until(() => ev(`localStorage.getItem('pashto-voice-code')`));
  check('joining: a 12-letter private code, shown first', /^[a-z0-9]{12}$/.test(code || '') && (await visible('[data-panel="me"]')) && (await text('[data-code]')) === code, code);
  check('its counts say nothing is recorded yet', /تر اوسه مو غږ نه دی ورکړی/.test(await until(() => text('[data-mine]'))), await text('[data-mine]'));
  await shot('2-code.png');

  // reading
  await click('[data-tab="read"]');
  const s1 = await until(() => ev(`(() => { const t = document.querySelector('[data-sentence]').innerText; return t && t !== '' ? t : null; })()`));
  check('reading: one of the sentences', SENTENCES.includes(s1), s1);
  const r1 = await record('read', 3.2);
  check('the microphone is heard (the level meter moves)', r1.level > 3, r1.level);
  check('after recording: listen, then send', /ثانیې/.test(r1.state) && r1.dur !== 0, `${r1.state} / ${r1.dur}`);
  await shot('3-recorded.png');
  await click('[data-panel="read"] [data-send]');
  const sent = await until(() => ev(`/ولېږل شو/.test(document.querySelector('[data-panel="read"] [data-state]').innerText)`));
  const s2 = await text('[data-sentence]');
  check('sent; the next sentence is a different one', sent && SENTENCES.includes(s2) && s2 !== s1, s2);
  check('the totals count it at once', /[۳۴] ثانیې غږ/.test(await until(() => ev(`(() => { const t = document.querySelector('[data-total]').innerText; return /^۰/.test(t) ? null : t; })()`))), await text('[data-total]'));
  let all = await admin('GET', '/admin/voice/clips?since=0');
  const c1 = all.clips[0];
  check('the server has it: read, the sentence as its text, the profile', all.clips.length === 1 && c1.kind === 'read' && c1.text === s1 && c1.dialect === 'southern' && c1.region === 'کندهار' && c1.seconds >= 3 && c1.seconds < 4.5, JSON.stringify(c1));
  const f1 = path.join(tmp, `c1.${c1.mime.split('/')[1]}`);
  fs.writeFileSync(f1, await admin('GET', `/admin/voice/file/${c1.id}`));
  const p1 = probe(f1);
  check(`the recording is real sound (${c1.mime}, ${Math.round(c1.bytes / 1024)} KB, ${p1.seconds.toFixed(1)} s, ${p1.mean} dB)`, c1.mime === 'audio/webm' && Math.abs(p1.seconds - c1.seconds) < 0.8 && p1.mean > -45, JSON.stringify(p1));
  // a bad sentence, reported
  await click('[data-report]');
  await sleep(600);
  check('"this sentence is wrong" moves on', (await text('[data-sentence]')) !== s2);

  // speaking about a topic
  await click('[data-tab="speak"]');
  const topic = await until(() => text('[data-prompt]'));
  check('speaking: a topic', topic && topic.length > 10, topic);
  const r2 = await record('speak', 2.6);
  await click('[data-panel="speak"] [data-send]');
  await until(() => ev(`/ولېږل شو/.test(document.querySelector('[data-panel="speak"] [data-state]').innerText)`));
  all = await admin('GET', '/admin/voice/clips?since=0');
  const c2 = all.clips.find((c) => c.kind === 'speak');
  check('the free speech arrives with its topic and no text yet', c2 && c2.prompt === topic && c2.text === null && c2.seconds >= 2, JSON.stringify(c2) + ` ${r2.state}`);
  await shot('4-speak.png');

  // checking: someone else's - another speaker sends a reading (with this browser's real recording) and a free
  // speech that the owner's PC gave a draft text
  const other = (await fetch(`${BASE}/voice/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: 1 }) }).then((r) => r.json())).code;
  const sentenceId = all.clips[0].sentence;
  const up = (q, body) => fetch(`${BASE}/voice/api/clip?${new URLSearchParams({ code: other, ...q })}`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body }).then((r) => r.json());
  const o1 = await up({ kind: 'read', sentence: sentenceId, seconds: c1.seconds }, fs.readFileSync(f1));
  const o2 = await up({ kind: 'speak', seconds: c1.seconds, prompt: 'x' }, fs.readFileSync(f1));
  await admin('POST', '/admin/voice/drafts', { items: [{ id: o2.id, text: 'زما کلی ډېر ښکلی دی' }] });
  await click('[data-tab="check"]');
  const first = await until(() => text('[data-check-text]'));
  const playable = await until(() => ev(`document.querySelector('[data-audio]').readyState >= 1`), 5000);
  check('checking: someone else\'s recording, its sound plays, its text', playable && first.length > 3 && (await visible('[data-yes]')), first);
  const isRead = SENTENCES.includes(first);
  check('a read sentence cannot be retyped; a free speech can', (await visible('[data-fix-btn]')) === !isRead);
  await shot('5-check.png');
  // say yes to the reading, fix the free speech's text (whichever comes first)
  for (let i = 0; i < 2; i++) {
    const tx = await until(() => ev(`(() => { const t = document.querySelector('[data-check-text]').innerText; return document.querySelector('[data-yes]').offsetParent && t ? t : null; })()`));
    if (SENTENCES.includes(tx)) await click('[data-yes]');
    else {
      await click('[data-fix-btn]');
      await ev(`(() => { const f = document.querySelector('[data-fix]'); f.value = 'زما کلی ډېر ښکلی دی.'; return true; })()`);
      await shot('6-fix.png');
      await click('[data-fix-btn]');
    }
    await until(() => ev(`/مننه/.test(document.querySelector('[data-check-msg]').innerText)`));
    await sleep(900);
  }
  check('nothing left to check', /څه نشته/.test(await until(() => ev(`(() => { const t = document.querySelector('[data-check-text]').innerText; return /څه نشته/.test(t) ? t : null; })()`))));
  all = await admin('GET', '/admin/voice/clips?since=0');
  const a1 = all.clips.find((c) => c.id === o1.id);
  const a2 = all.clips.find((c) => c.id === o2.id);
  check('the votes and the fixed text reached the server', a1.yes === 1 && a2.text === 'زما کلی ډېر ښکلی دی.' && a2.text_by === 'checker', JSON.stringify([a1.yes, a2.text, a2.text_by]));

  // mine, then coming back on "another phone" with the code
  await click('[data-tab="me"]');
  const mine = await until(() => ev(`(() => { const t = document.querySelector('[data-mine]').innerText; return /تاسو/.test(t) ? t : null; })()`));
  check('mine: two recordings and their seconds, two checks', /تاسو ۲ غږونه \(۶ ثانیې\)/.test(mine) && /۲ غږونه مو کتلي/.test(mine), mine);
  await go(`${BASE}/voice/`);
  check('the same browser later: straight in, where it was', (await visible('[data-panel="me"]')) && (await text('[data-code]')) === code);
  await ev(`localStorage.clear(), true`);
  await go(`${BASE}/voice/`);
  check('another browser: the introduction again', await visible('[data-page="intro"]'));
  await ev(`(() => { document.querySelector('.have-code').open = true; const f = document.querySelector('[data-have-code]'); f.code.value = 'nottherealone'; f.requestSubmit(); return true; })()`);
  check('a code that is not 12 letters is refused', /۱۲ توري/.test(await until(() => text('[data-code-msg]'))));
  await ev(`(() => { const f = document.querySelector('[data-have-code]'); f.code.value = 'zzzzzzzzzzzz'; f.requestSubmit(); return true; })()`);
  check('an unknown code is refused', /ونه موندل شو/.test(await until(() => ev(`(() => { const t = document.querySelector('[data-code-msg]').innerText; return /ونه موندل/.test(t) ? t : null; })()`))));
  await ev(`(() => { const f = document.querySelector('[data-have-code]'); f.code.value = ' ${code.toUpperCase()} '; f.requestSubmit(); return true; })()`);
  check('the code brings the speaker back', (await until(() => visible('[data-page="work"]'))) && (await ev(`localStorage.getItem('pashto-voice-code')`)) === code);

  // dark
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, S);
  await click('[data-tab="read"]');
  await sleep(600);
  await shot('7-dark.png');
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, S);

  // deleting everything
  await click('[data-tab="me"]');
  await ev(`(document.querySelector('.danger').open = true, true)`);
  await shot('8-forget.png');
  await click('[data-forget]');
  check('deleting: back to the start, told so', /ړنګ شول/.test(await until(() => text('[data-msg]'))) && (await visible('[data-page="intro"]')) && (await ev(`localStorage.getItem('pashto-voice-code')`)) === null);
  all = await admin('GET', '/admin/voice/clips?since=0');
  check('the server: this speaker\'s recordings are gone, the other\'s stay', all.clips.length === 2 && all.clips.every((c) => c.code === other), JSON.stringify(all.clips.map((c) => c.code)));
  check('the code no longer works', (await fetch(`${BASE}/voice/api/me?code=${code}`)).status === 404);
  check('no script errors on the page', (await ev(`window.__errs.length`)) === 0, await ev(`window.__errs.join(' | ')`));
  await b.send('Browser.close').catch(() => {});
  b.close();
} catch (e) {
  check('driver', false, e.stack);
} finally {
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
