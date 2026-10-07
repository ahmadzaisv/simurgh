// پښتو غږ, the Pashto voice project's server side: an anonymous speaker joins with consent, reads a sentence, talks
// about a topic, others check (and fix) the recordings, two agreeing checks decide, the owner reads everything with
// signed requests, a speaker deletes all of theirs with the code, and nobody else gets the sound.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { signHeaders, sha256 } from '../auth.mjs';
import { createServer } from '../server.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simurgh-voice-srv-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });
let srv;
let base;
before(async () => {
  srv = createServer({ dataDir: tmp, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }), origins: ['https://simurgh.onrender.com'], log: () => {} });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
after(() => {
  srv.server.close();
  srv.voice.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const J = (o) => JSON.stringify(o);
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: J(body) }).then(async (r) => ({ ...(await r.json()), http: r.status }));
const get = (p) => fetch(base + p).then(async (r) => ({ ...(await r.json()), http: r.status }));
const admin = async (method, p, body) => {
  const buf = body ? Buffer.from(J(body)) : Buffer.alloc(0);
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...signHeaders(PRIV, method, p, sha256(buf)) }, body: method === 'GET' ? undefined : buf });
  return r.headers.get('content-type')?.includes('json') ? { ...(await r.json()), http: r.status } : { http: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
};
const audio = (n = 4000) => crypto.randomBytes(n);
const upload = (code, q, body = audio(), type = 'audio/webm', headers = {}) => fetch(`${base}/voice/api/clip?code=${code}&${new URLSearchParams(q)}`, { method: 'POST', headers: { 'content-type': type, ...headers }, body }).then(async (r) => ({ ...(await r.json()), http: r.status }));

test('the whole round: join, read, speak, check, fix, decide, the owner, forgetting', async () => {
  // sentences come from the owner
  assert.equal((await post('/admin/voice/sentences', { add: [{ text: 'x' }] })).http, 401, 'not signed');
  const s = await admin('POST', '/admin/voice/sentences', { add: [{ text: 'زه کور ته ځم.', source: 'test' }, { text: 'نن هوا ښه ده.' }, { text: 'نن هوا ښه ده.' }, { text: 'x' }] });
  assert.equal(s.added, 2, 'twice the same, and too short: once');

  // joining needs the consent; the profile is cleaned
  assert.equal((await post('/voice/api/join', { profile: {} })).http, 400);
  const a = await post('/voice/api/join', { consent: 1, profile: { dialect: 'southern', region: 'کندهار', gender: 'male', age: '18-29', name: 'not kept' } });
  assert.match(a.code, /^[a-z0-9]{12}$/);
  const b = (await post('/voice/api/join', { consent: 1, profile: { dialect: 'nonsense' } })).code;
  const c = (await post('/voice/api/join', { consent: 1 })).code;
  assert.deepEqual((await get(`/voice/api/me?code=${a.code}`)).profile, { dialect: 'southern', region: 'کندهار', gender: 'male', age: '18-29' });
  assert.equal((await get(`/voice/api/me?code=${b}`)).profile.dialect, '');
  assert.equal((await get('/voice/api/me?code=zzzzzzzzzzzz')).http, 404);

  // reading: a sentence, then another (not the same one for the same speaker)
  const n1 = (await get(`/voice/api/next?code=${a.code}`)).sentence;
  const r1 = await upload(a.code, { kind: 'read', sentence: n1.id, seconds: 2.5 });
  assert.match(r1.id, /^[0-9a-f-]{36}$/);
  const n2 = (await get(`/voice/api/next?code=${a.code}`)).sentence;
  assert.notEqual(n2.id, n1.id);
  assert.equal((await get(`/voice/api/next?code=${a.code}&not=${n2.id}`)).sentence.id, n2.id, 'skipping the last one left: it again');
  await upload(a.code, { kind: 'read', sentence: n2.id, seconds: 2 });
  assert.equal((await get(`/voice/api/next?code=${a.code}`)).done, true, 'all read');
  // what a clip must be
  assert.equal((await upload(a.code, { kind: 'read', sentence: n1.id, seconds: 99 })).http, 400, 'too long for a sentence');
  assert.equal((await upload(a.code, { kind: 'read', sentence: n1.id, seconds: 2 }, audio(), 'text/html')).http, 400, 'not sound');
  assert.equal((await upload(a.code, { kind: 'read', sentence: 999, seconds: 2 })).http, 400);
  assert.equal((await upload('nobodyhere12', { kind: 'read', sentence: n1.id, seconds: 2 })).http, 404);

  // speaking freely: a topic, then a recording with no text yet (not checkable until it has one)
  const prompt = (await get(`/voice/api/next?code=${b}&kind=speak`)).prompt;
  assert.ok(prompt.length > 10);
  const sp = await upload(b, { kind: 'speak', seconds: 12, prompt });
  // a dictation from Simurgh: its text as the speaker left it
  const dic = await upload(c, { kind: 'dictation', seconds: 4 }, audio(), 'audio/wav', { 'x-voice-text': encodeURIComponent('زه ښوونځي ته ځم.') });

  // checking: never one's own; a link to the sound that only works for a while
  const own = await get(`/voice/api/check?code=${a.code}`);
  assert.notEqual(own.clip?.id, r1.id);
  const ck = await get(`/voice/api/check?code=${b}`);
  assert.ok(ck.clip && ck.clip.id !== sp.id, 'the speech without a text is not offered');
  const snd = await fetch(base + ck.clip.audio);
  assert.equal(snd.status, 200);
  assert.equal(snd.headers.get('content-type'), 'audio/webm');
  assert.equal((await fetch(base + ck.clip.audio.replace(/t=[^&]+/, 't=forged'))).status, 403);
  assert.equal((await fetch(`${base}/voice/api/audio/${r1.id}?e=${Date.now() + 1e6}&t=x`)).status, 403);

  // two agreeing checks decide
  assert.equal((await post('/voice/api/check', { code: b, clip: r1.id, verdict: 'yes' })).http, 200);
  assert.equal((await post('/voice/api/check', { code: b, clip: r1.id, verdict: 'yes' })).error, 'done', 'once per speaker');
  assert.equal((await post('/voice/api/check', { code: a.code, clip: r1.id, verdict: 'yes' })).error, 'clip', 'not one\'s own');
  assert.equal((await post('/voice/api/check', { code: c, clip: r1.id, verdict: 'yes' })).status, 'validated');
  // a dictation fixed by a checker starts over with the fixed text
  const fx = await post('/voice/api/check', { code: a.code, clip: dic.id, fixed: 'زه ښوونځي ته ځم' });
  assert.deepEqual([fx.yes, fx.no], [1, 0]);
  assert.equal((await post('/voice/api/check', { code: b, clip: dic.id, verdict: 'yes' })).status, 'validated');
  assert.equal((await post('/voice/api/check', { code: b, clip: r1.id, fixed: 'something' })).error, 'clip', 'decided already');

  // the owner: everything, with the profiles; drafts for the free speech; the sound itself
  const all = await admin('GET', '/admin/voice/clips?since=0');
  assert.equal(all.clips.length, 4);
  const rowSp = all.clips.find((x) => x.id === sp.id);
  assert.equal(rowSp.text, null);
  assert.equal(all.clips.find((x) => x.id === r1.id).dialect, 'southern');
  assert.equal((await admin('POST', '/admin/voice/drafts', { items: [{ id: sp.id, text: 'زما کلی ښکلی دی.' }] })).set, 1);
  const ck2 = await get(`/voice/api/check?code=${c}`);
  assert.ok([sp.id, r1.id, dic.id].includes(ck2.clip.id) || ck2.clip.kind === 'read');
  const file = await admin('GET', `/admin/voice/file/${r1.id}`);
  assert.equal(file.bytes.length, 4000);
  const st = await get('/voice/api/stats');
  assert.equal(st.clips, 4);
  assert.equal(st.speakers, 3);
  assert.deepEqual([st.seconds, st.validatedSeconds], [21, 7], 'all of it, and the decided ones (2.5 s read + 4 s dictation)');
  assert.ok(st.byDialect.southern > 0);
  assert.ok(!JSON.stringify(st).includes(a.code), 'no codes in the public totals');

  // a bad sentence reported three times is no longer offered
  for (const who of [a.code, b, c]) await post('/voice/api/report', { code: who, sentence: n1.id });
  const d = (await post('/voice/api/join', { consent: 1 })).code;
  for (let i = 0; i < 3; i++) {
    const nx = await get(`/voice/api/next?code=${d}`);
    if (nx.sentence) {
      assert.notEqual(nx.sentence.id, n1.id);
      await upload(d, { kind: 'read', sentence: nx.sentence.id, seconds: 2 });
    }
  }

  // forgetting: every recording of that code, its checks, the code itself
  const files = fs.readdirSync(path.join(tmp, 'voice', 'clips'), { recursive: true }).filter((f) => /\.\w+$/.test(f)).length;
  assert.equal((await post('/voice/api/forget', { code: a.code })).deleted, 2);
  assert.equal(fs.readdirSync(path.join(tmp, 'voice', 'clips'), { recursive: true }).filter((f) => /\.\w+$/.test(f)).length, files - 2);
  assert.equal((await get(`/voice/api/me?code=${a.code}`)).http, 404);
});

test('limits: too many sign-ups from one address wait', async () => {
  let last;
  for (let i = 0; i < 22; i++) last = await fetch(`${base}/voice/api/join`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.77' }, body: J({ consent: 1 }) });
  assert.equal(last.status, 429);
});
