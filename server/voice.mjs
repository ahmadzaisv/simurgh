// پښتو غږ - the Pashto voice project. Pashtuns record their voices on simurgh.onrender.com/voice/ (or from Simurgh's
// Notepad), anonymously, under a private code; other speakers check the recordings; the owner's PC takes them to
// train Simurgh's Pashto speech models. The recordings are private to Simurgh (the owner's decision, 2026-10-07):
// nothing here hands audio to anyone but a checker (a short-lived link) and the owner (signed requests).
//   POST /voice/api/join            consent + an optional profile (dialect, region, gender, age) -> a private code
//   GET  /voice/api/me              the speaker's own counts and profile          POST /voice/api/profile
//   GET  /voice/api/next            a sentence to read, or a topic to speak about
//   POST /voice/api/clip            a recording (raw audio in the body; code, kind, sentence or prompt, seconds)
//   GET  /voice/api/check           someone else's recording to check (+ a 10-minute link to its sound)
//   POST /voice/api/check           right / wrong / the text fixed
//   POST /voice/api/report          a sentence that is wrong or bad
//   POST /voice/api/forget          everything recorded with this code, deleted
//   GET  /voice/api/stats           totals for everyone to see
//   /admin/voice/...                the owner (signed): clips, their sound, sentences, draft texts, deletions
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const CONSENT_VERSION = 1;
const MAX_BYTES = 2 * 1024 * 1024;
const LIMITS = { read: [0.8, 20], speak: [2, 60], dictation: [0.8, 30] };
const PROFILE = {
  dialect: ['southern', 'northern', 'central', 'eastern', 'karlani', 'other', ''],
  gender: ['female', 'male', ''],
  age: ['13-17', '18-29', '30-44', '45-59', '60+', ''],
};
const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3' };

/** Topics to talk about freely - everyday Afghan Pashto, and questions on purpose (their tune matters for dictation). */
export const PROMPTS = [
  'د نن ورځې په اړه ووایاست: سهار مو څه وکړل او ماښام به څه کوئ؟',
  'خپل کلی یا ښار راته وپېژنئ: چېرته دی او څه ځانګړتیاوې لري؟',
  'ستاسو غوره خواړه کوم دي او څنګه پخېږي؟',
  'یوه کیسه ووایاست چې له خپلې انا یا نیکه مو اورېدلې ده.',
  'د خپل کار یا زده کړو په اړه وغږېږئ.',
  'یو متل ووایاست او بیا یې مانا په خپلو خبرو کې تشریح کړئ.',
  'که سبا رخصتي وي، څه به کوئ؟',
  'یو داسې کس راته وپېژنئ چې ډېر مو خوښېږي.',
  'د دې موسم په اړه خبرې وکړئ: هوا څنګه ده او خلک څه کوي؟',
  'درې پوښتنې وکړئ، لکه له یوه دوکاندار څخه چې یې کوئ.',
  'درې پوښتنې وکړئ، لکه له یوه ډاکټر څخه چې یې کوئ.',
  'خپل یوه ملګري ته یو غږیز پیغام ورکړئ چې سبا ورسره ووینئ.',
  'د یوه کتاب، فلم یا سندرې په اړه ووایاست چې خوښ مو دي.',
  'خپل کور ته د تګ لاره یوه مېلمه ته تشریح کړئ.',
  'د خپلې کوچنیوالي یوه خاطره ووایاست.',
  'د اختر او ودونو دودونه په خپلو سیمو کې څنګه دي؟',
  'یو خبر چې په دې ورځو کې مو اورېدلی، په خپلو خبرو کې ووایاست.',
  'یو لیک په خوله ووایاست، لکه خپل مدیر ته چې د رخصتۍ لپاره یې لیکئ.',
];

const now0 = () => Date.now();

export function createVoice({ dir, now = now0, log = () => {} }) {
  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
  const secretFile = path.join(dir, 'secret');
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
  const secret = fs.readFileSync(secretFile, 'utf8').trim();
  const db = new DatabaseSync(path.join(dir, 'voice.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS speakers (code TEXT PRIMARY KEY, created INTEGER, consent INTEGER, dialect TEXT, region TEXT, gender TEXT, age TEXT, via TEXT);
    CREATE TABLE IF NOT EXISTS sentences (id INTEGER PRIMARY KEY, text TEXT UNIQUE, source TEXT, domain TEXT, recorded INTEGER DEFAULT 0, reports INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS clips (id TEXT PRIMARY KEY, code TEXT, kind TEXT, sentence INTEGER, prompt TEXT, text TEXT, text_by TEXT, mime TEXT, bytes INTEGER, seconds REAL, created INTEGER, status TEXT DEFAULT 'new', yes INTEGER DEFAULT 0, no INTEGER DEFAULT 0, file TEXT);
    CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY, clip TEXT, code TEXT, verdict TEXT, fixed TEXT, created INTEGER);
    CREATE INDEX IF NOT EXISTS clips_code ON clips(code);
    CREATE INDEX IF NOT EXISTS clips_status ON clips(status, created);
    CREATE INDEX IF NOT EXISTS checks_clip ON checks(clip, code);
  `);
  const q = (sql) => db.prepare(sql);
  const limits = new Map(); // "kind:key" -> [times]
  const tooMany = (kind, key, max, perMs = 3600e3) => {
    const k = `${kind}:${key}`;
    const t = now();
    const list = (limits.get(k) || []).filter((x) => t - x < perMs);
    if (list.length >= max) return true;
    list.push(t);
    limits.set(k, list);
    return false;
  };
  const speaker = (code) => (/^[a-z0-9]{12}$/.test(String(code || '')) ? q('SELECT * FROM speakers WHERE code = ?').get(code) : null);
  const clean = (profile = {}) => ({
    dialect: PROFILE.dialect.includes(profile.dialect) ? profile.dialect : '',
    region: String(profile.region || '').slice(0, 40),
    gender: PROFILE.gender.includes(profile.gender) ? profile.gender : '',
    age: PROFILE.age.includes(profile.age) ? profile.age : '',
  });
  const sign = (id, exp) => crypto.createHmac('sha256', secret).update(`${id}.${exp}`).digest('base64url');
  const fileOf = (row) => path.join(dir, 'clips', row.file);
  const newCode = () => {
    const a = 'abcdefghjkmnpqrstuvwxyz23456789';
    const b = crypto.randomBytes(12);
    return [...b].map((x) => a[x % a.length]).join('');
  };

  // ---------------------------------------------------------------- the speakers' side
  async function handle(req, res, url, { send, readBody, sendFile, ip, cors }) {
    const p = url.pathname;
    const json = async () => {
      try {
        return JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      } catch {
        return null;
      }
    };
    if (p === '/voice/api/stats' && req.method === 'GET') return send(res, 200, stats(), { ...cors, 'cache-control': 'public, max-age=30' });

    if (p === '/voice/api/join' && req.method === 'POST') {
      if (tooMany('join', ip, 20)) return send(res, 429, { error: 'wait' }, cors);
      const b = await json();
      if (!b || Number(b.consent) !== CONSENT_VERSION) return send(res, 400, { error: 'consent' }, cors);
      const code = newCode();
      const pr = clean(b.profile);
      q('INSERT INTO speakers (code, created, consent, dialect, region, gender, age, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(code, now(), CONSENT_VERSION, pr.dialect, pr.region, pr.gender, pr.age, b.via === 'simurgh' ? 'simurgh' : 'web');
      return send(res, 200, { code }, cors);
    }

    const code = url.searchParams.get('code') || req.headers['x-voice-code'];
    if (p === '/voice/api/me' && req.method === 'GET') {
      const s = speaker(code);
      if (!s) return send(res, 404, { error: 'code' }, cors);
      const mine = q("SELECT COUNT(*) n, COALESCE(SUM(seconds), 0) secs, COALESCE(SUM(status = 'validated'), 0) ok FROM clips WHERE code = ?").get(code);
      const checked = q('SELECT COUNT(*) n FROM checks WHERE code = ?').get(code);
      return send(res, 200, { profile: clean(s), clips: mine.n, seconds: Math.round(mine.secs), validated: mine.ok, checks: checked.n }, cors);
    }
    if (p === '/voice/api/profile' && req.method === 'POST') {
      const b = await json();
      const s = speaker(b?.code);
      if (!s) return send(res, 404, { error: 'code' }, cors);
      const pr = clean(b.profile);
      q('UPDATE speakers SET dialect = ?, region = ?, gender = ?, age = ? WHERE code = ?').run(pr.dialect, pr.region, pr.gender, pr.age, s.code);
      return send(res, 200, { profile: pr }, cors);
    }
    if (p === '/voice/api/next' && req.method === 'GET') {
      const s = speaker(code);
      if (!s) return send(res, 404, { error: 'code' }, cors);
      if (url.searchParams.get('kind') === 'speak') return send(res, 200, { prompt: PROMPTS[Math.floor(Math.random() * PROMPTS.length)] }, cors);
      // the sentences read least, not yet by this speaker; not the one just skipped, unless it is the last one
      const pick = q(`SELECT id, text FROM sentences WHERE active = 1 AND reports < 3 AND id != ? AND id NOT IN (SELECT sentence FROM clips WHERE code = ? AND sentence IS NOT NULL)
                      ORDER BY recorded ASC, RANDOM() LIMIT 1`);
      const skipped = Number(url.searchParams.get('not')) || 0;
      const row = pick.get(skipped, s.code) || (skipped ? pick.get(0, s.code) : null);
      return send(res, 200, row ? { sentence: row } : { done: true }, cors);
    }
    if (p === '/voice/api/clip' && req.method === 'POST') {
      const s = speaker(code);
      if (!s) return send(res, 404, { error: 'code' }, cors);
      if (tooMany('clip', s.code, 240) || tooMany('clipip', ip, 600)) return send(res, 429, { error: 'wait' }, cors);
      const kind = url.searchParams.get('kind');
      const secs = Number(url.searchParams.get('seconds'));
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!LIMITS[kind] || !(secs >= LIMITS[kind][0] && secs <= LIMITS[kind][1]) || !EXT[mime]) return send(res, 400, { error: 'clip' }, cors);
      let sentence = null;
      let text = null;
      let textBy = null;
      if (kind === 'read') {
        sentence = q('SELECT id, text FROM sentences WHERE id = ? AND active = 1').get(Number(url.searchParams.get('sentence')));
        if (!sentence) return send(res, 400, { error: 'sentence' }, cors);
        text = sentence.text;
        textBy = 'sentence';
      }
      let body;
      try {
        body = await readBody(req, MAX_BYTES);
      } catch {
        return send(res, 413, { error: 'too big' }, cors);
      }
      if (body.length < 500) return send(res, 400, { error: 'empty' }, cors);
      if (kind === 'dictation') {
        text = String(req.headers['x-voice-text'] ? decodeURIComponent(req.headers['x-voice-text']) : '').slice(0, 2000) || null;
        textBy = text ? 'speaker' : null;
      }
      const id = crypto.randomUUID();
      const month = new Date(now()).toISOString().slice(0, 7);
      const file = `${month}/${id}.${EXT[mime]}`;
      fs.mkdirSync(path.join(dir, 'clips', month), { recursive: true });
      fs.writeFileSync(path.join(dir, 'clips', file), body);
      const prompt = kind === 'speak' ? String(url.searchParams.get('prompt') || '').slice(0, 300) : null;
      q('INSERT INTO clips (id, code, kind, sentence, prompt, text, text_by, mime, bytes, seconds, created, file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, s.code, kind, sentence?.id ?? null, prompt, text, textBy, mime, body.length, secs, now(), file);
      if (sentence) q('UPDATE sentences SET recorded = recorded + 1 WHERE id = ?').run(sentence.id);
      return send(res, 200, { id }, cors);
    }
    if (p === '/voice/api/check' && req.method === 'GET') {
      const s = speaker(code);
      if (!s) return send(res, 404, { error: 'code' }, cors);
      // someone else's, not checked by this speaker yet, with a text to check; the ones nearly decided first
      const row = q(`SELECT id, kind, text, prompt, mime, seconds FROM clips c WHERE c.code != ? AND c.status = 'new' AND c.text IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM checks k WHERE k.clip = c.id AND k.code = ?)
                     ORDER BY (c.yes + c.no) DESC, c.created ASC LIMIT 1`).get(s.code, s.code);
      if (!row) return send(res, 200, { none: true }, cors);
      const exp = now() + 10 * 60 * 1000;
      return send(res, 200, { clip: { id: row.id, kind: row.kind, text: row.text, prompt: row.prompt, seconds: row.seconds, audio: `/voice/api/audio/${row.id}?e=${exp}&t=${sign(row.id, exp)}` } }, cors);
    }
    const au = /^\/voice\/api\/audio\/([0-9a-f-]{36})$/.exec(p);
    if (au && req.method === 'GET') {
      const exp = Number(url.searchParams.get('e'));
      const t = String(url.searchParams.get('t') || '');
      const want = sign(au[1], exp);
      const good = exp > now() && t.length === want.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(t));
      const row = good && q('SELECT file, mime FROM clips WHERE id = ?').get(au[1]);
      if (!row) return send(res, 403, { error: 'link' }, cors);
      return sendFile(req, res, fileOf(row), { type: row.mime, extra: { ...cors, 'cache-control': 'private, no-store' } });
    }
    if (p === '/voice/api/check' && req.method === 'POST') {
      const b = await json();
      const s = speaker(b?.code);
      if (!s) return send(res, 404, { error: 'code' }, cors);
      if (tooMany('check', s.code, 900)) return send(res, 429, { error: 'wait' }, cors);
      const c = q('SELECT * FROM clips WHERE id = ?').get(String(b.clip || ''));
      if (!c || c.code === s.code || c.status !== 'new') return send(res, 400, { error: 'clip' }, cors);
      if (q('SELECT 1 FROM checks WHERE clip = ? AND code = ?').get(c.id, s.code)) return send(res, 400, { error: 'done' }, cors);
      const fixed = typeof b.fixed === 'string' ? b.fixed.trim().slice(0, 2000) : '';
      const verdict = b.verdict === 'yes' ? 'yes' : b.verdict === 'no' ? 'no' : fixed ? 'fix' : null;
      if (!verdict || (verdict === 'fix' && c.kind === 'read')) return send(res, 400, { error: 'verdict' }, cors);
      q('INSERT INTO checks (clip, code, verdict, fixed, created) VALUES (?, ?, ?, ?, ?)').run(c.id, s.code, verdict, fixed || null, now());
      let { yes, no, status, text } = c;
      if (verdict === 'fix' && fixed !== c.text) {
        // a corrected text starts over: the one who fixed it vouches for it
        text = fixed;
        yes = 1;
        no = 0;
        q("UPDATE clips SET text = ?, text_by = 'checker', yes = 1, no = 0 WHERE id = ?").run(text, c.id);
      } else {
        if (verdict === 'no') no++;
        else yes++;
        if (yes >= 2 && yes > no) status = 'validated';
        else if (no >= 2 && no > yes) status = 'rejected';
        q('UPDATE clips SET yes = ?, no = ?, status = ? WHERE id = ?').run(yes, no, status, c.id);
      }
      return send(res, 200, { status, yes, no }, cors);
    }
    if (p === '/voice/api/report' && req.method === 'POST') {
      const b = await json();
      if (!speaker(b?.code)) return send(res, 404, { error: 'code' }, cors);
      q('UPDATE sentences SET reports = reports + 1 WHERE id = ?').run(Number(b.sentence));
      return send(res, 200, { ok: true }, cors);
    }
    if (p === '/voice/api/forget' && req.method === 'POST') {
      const b = await json();
      const s = speaker(b?.code);
      if (!s) return send(res, 404, { error: 'code' }, cors);
      const n = forget(s.code);
      return send(res, 200, { deleted: n }, cors);
    }
    return false;
  }

  function forget(code) {
    const rows = q('SELECT id, file FROM clips WHERE code = ?').all(code);
    for (const r of rows) fs.rmSync(fileOf(r), { force: true });
    q('DELETE FROM checks WHERE clip IN (SELECT id FROM clips WHERE code = ?)').run(code);
    q('DELETE FROM clips WHERE code = ?').run(code);
    q('DELETE FROM checks WHERE code = ?').run(code);
    q('DELETE FROM speakers WHERE code = ?').run(code);
    return rows.length;
  }

  function stats() {
    const all = q("SELECT COUNT(*) n, COALESCE(SUM(seconds), 0) secs, COALESCE(SUM(CASE WHEN status = 'validated' THEN seconds END), 0) ok FROM clips").get();
    const speakers = q('SELECT COUNT(DISTINCT code) n FROM clips').get().n;
    const byDialect = Object.fromEntries(q("SELECT s.dialect d, COALESCE(SUM(c.seconds), 0) secs FROM clips c JOIN speakers s ON s.code = c.code GROUP BY s.dialect").all().map((r) => [r.d || 'unknown', Math.round(r.secs)]));
    const today = q('SELECT COUNT(*) n FROM clips WHERE created > ?').get(now() - 24 * 3600e3).n;
    return { clips: all.n, seconds: Math.round(all.secs), validatedSeconds: Math.round(all.ok), hours: +(all.secs / 3600).toFixed(2), validatedHours: +(all.ok / 3600).toFixed(2), speakers, byDialect, today, sentences: q('SELECT COUNT(*) n FROM sentences WHERE active = 1').get().n };
  }

  // ---------------------------------------------------------------- the owner (already signed)
  function admin(req, res, url, body, { send, sendFile }) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/admin/voice/clips') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Math.min(5000, Number(url.searchParams.get('limit') || 1000));
      const rows = q(`SELECT c.id, c.code, c.kind, c.sentence, c.prompt, c.text, c.text_by, c.mime, c.bytes, c.seconds, c.created, c.status, c.yes, c.no,
                      s.dialect, s.region, s.gender, s.age, s.via FROM clips c LEFT JOIN speakers s ON s.code = c.code WHERE c.created > ? ORDER BY c.created LIMIT ?`).all(since, limit);
      return send(res, 200, { clips: rows, stats: stats() });
    }
    const f = /^\/admin\/voice\/file\/([0-9a-f-]{36})$/.exec(p);
    if (req.method === 'GET' && f) {
      const row = q('SELECT file, mime FROM clips WHERE id = ?').get(f[1]);
      if (!row) return send(res, 404, { error: 'missing' });
      return sendFile(req, res, fileOf(row), { type: row.mime });
    }
    if (req.method === 'POST' && p === '/admin/voice/sentences') {
      let added = 0;
      const ins = q('INSERT OR IGNORE INTO sentences (text, source, domain) VALUES (?, ?, ?)');
      for (const s of Array.isArray(body.add) ? body.add : []) {
        const text = String(s.text || '').trim();
        if (text.length < 3 || text.length > 300) continue;
        added += ins.run(text, String(s.source || ''), String(s.domain || '')).changes;
      }
      return send(res, 200, { added, sentences: q('SELECT COUNT(*) n FROM sentences').get().n });
    }
    if (req.method === 'POST' && p === '/admin/voice/drafts') {
      let set = 0;
      const up = q("UPDATE clips SET text = ?, text_by = 'model' WHERE id = ? AND text IS NULL");
      for (const d of Array.isArray(body.items) ? body.items : []) set += up.run(String(d.text || '').slice(0, 2000), String(d.id)).changes;
      return send(res, 200, { set });
    }
    if (req.method === 'POST' && p === '/admin/voice/delete') {
      let n = 0;
      for (const id of Array.isArray(body.ids) ? body.ids : []) {
        const r = q('SELECT file FROM clips WHERE id = ?').get(String(id));
        if (!r) continue;
        fs.rmSync(fileOf(r), { force: true });
        q('DELETE FROM checks WHERE clip = ?').run(String(id));
        n += q('DELETE FROM clips WHERE id = ?').run(String(id)).changes;
      }
      return send(res, 200, { deleted: n });
    }
    return false;
  }

  return { handle, admin, stats, db, forget };
}
