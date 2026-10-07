// پښتو غږ on the owner's PC: the sentences people read, everyone's recordings brought home, draft texts for the free
// speech (so others can check them), and the training set built from what was checked. The requests are signed with
// the owner's key (%LOCALAPPDATA%\Simurgh Keys\owner-private.pem), like simurgh-keys.mjs.
//   node pashto-voice.mjs stats
//   node pashto-voice.mjs sentences <file.txt> [--source name] [--domain name] [--dry]
//                         cleans each line (letters, punctuation, the checker's word list), refuses the doubtful ones
//                         (old or Pakistani spelling, Dari words, broken words) into <file>.refused.txt, adds the rest
//   node pashto-voice.mjs sync      every recording and its details into Documents\Pashto Voice\ (recordings a
//                                   speaker deleted are deleted here too)
//   node pashto-voice.mjs drafts    free speech without a text: Omnilingual ASR (the model Simurgh's Notepad
//                                   downloaded) writes a draft, the checkers on the website correct it
//   node pashto-voice.mjs export    the checked recordings as 16 kHz WAV + train/dev/test lists (no speaker in two)
//   node pashto-voice.mjs daily     sync, drafts, export (the scheduled task)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = process.env.SIMURGH_KEYS_HOME || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Simurgh Keys');
const PRIVATE = path.join(HOME, 'owner-private.pem');
const here = path.dirname(fileURLToPath(import.meta.url));
const lib = fs.existsSync(path.join(here, 'lib', 'auth.mjs')) ? path.join(here, 'lib') : path.join(here, '..', 'server');
const { signHeaders, sha256 } = await import(pathToFileURL(path.join(lib, 'auth.mjs')).href);

const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};
const cfg = {
  server: 'https://simurgh-download.onrender.com',
  folder: path.join(os.homedir(), 'Documents', 'Pashto Voice'),
  simurgh: path.join(os.homedir(), 'Projects', 'simurgh'), // sherpa-onnx-node lives in Simurgh's own packages
  models: path.join(process.env.APPDATA || '', 'Simurgh', 'voice', 'models'),
  ffmpeg: ['C:/ProgramData/chocolatey/bin/ffmpeg.exe'].find((f) => fs.existsSync(f)) || 'ffmpeg',
  ...(readJson(path.join(HOME, 'config.json'), {}).server ? { server: readJson(path.join(HOME, 'config.json'), {}).server } : {}), // the keys' server; not their folder
  ...readJson(path.join(HOME, 'pashto-voice.json'), {}),
};
const LOG = path.join(cfg.folder, 'log.txt');
const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`;
  console.log(line);
  try {
    fs.mkdirSync(cfg.folder, { recursive: true });
    fs.appendFileSync(LOG, `${line}\n`);
  } catch {}
};

/** A signed request (the private key never leaves this PC). Returns JSON, or the bytes of a file. */
async function call(method, p, json, timeoutMs = 120000) {
  const body = json === undefined ? undefined : Buffer.from(JSON.stringify(json));
  const headers = { ...signHeaders(fs.readFileSync(PRIVATE, 'utf8'), method, p, sha256(body || Buffer.alloc(0))), ...(body ? { 'content-type': 'application/json' } : {}) };
  const r = await fetch(new URL(p, cfg.server), { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : Buffer.from(await r.arrayBuffer());
}

// ---------------------------------------------------------------- sentences
const cp = (...c) => String.fromCodePoint(...c);
const WORD = '[\\p{L}\\p{M}]';
const word = (w) => new RegExp(`(?<!${WORD})${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!${WORD})`, 'gu');
/** The checker's own list (Simurgh's pashto-check.words.tsv): fixed spellings, wrong endings, Dari words. */
function wordList() {
  const f = path.join(cfg.simurgh, 'electron', 'skills', 'pashto', 'pashto-check.words.tsv');
  const out = { fix: [], refuse: [] };
  if (!fs.existsSync(f)) return out;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const [kind, wrong, right] = line.split('\t').map((s) => s?.trim());
    if (!kind || kind.startsWith('#') || !right) continue;
    if (kind === 'spelling' || kind === 'ye') out.fix.push([word(wrong), right]);
    else if (kind === 'dari') out.refuse.push(word(wrong));
    else if (kind === 'ey') out.refuse.push(new RegExp(`(?<!${WORD})${right.slice(0, -1)}[${cp(0x6cc, 0x64a, 0x626)}](?!${WORD})`, 'u'));
  }
  return out;
}
const PS_WORDS = new Set(['د', 'زه', 'ته', 'مو', 'دی', 'ده', 'یم', 'یې', 'کې', 'چې', 'په', 'له', 'موږ', 'تاسو', 'هغه', 'دا', 'شته']);
const DARI = ['است', 'نیست', 'هست', 'از', 'برای', 'این', 'آن', 'یک', 'بود', 'شد', 'میباشد', 'همچنین', 'نمود', 'گردید', 'چه', 'کښې', 'ئې'].map(word);

/** One line -> { text } (cleaned) or { refused: why }. Only changes that are right in every context are made. */
export function cleanSentence(line, list = { fix: [], refuse: [] }) {
  let t = String(line).normalize('NFC').replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return { refused: 'empty' };
  if (/[A-Za-z0-9\u0660-\u0669\u06F0-\u06F9]/.test(t)) return { refused: 'Latin letters or digits (a reader says numbers differently)' };
  if (/[\u0679\u0688\u0691\u06D2\u06BA\u06BE\u06C1\u06C0\u0640]/.test(t)) return { refused: 'Urdu or Pakistani letters' };
  if (/\u0649/.test(t)) return { refused: 'alef maksura (old spelling: the ye must be decided by grammar)' };
  if (DARI.some((r) => (r.lastIndex = 0, r.test(t)))) return { refused: 'a Dari word or Pakistani spelling' };
  if (list.refuse.some((r) => (r.lastIndex = 0, r.test(t)))) return { refused: 'the checker\'s list: a Dari word or a wrong -ey ending' };
  // letters: Arabic kaf, Persian gaf, an inner ye in its Arabic form (inside a word both forms look the same)
  t = t.replace(/\u0643/g, cp(0x6a9)).replace(/\u06AF/g, cp(0x6ab)).replace(/\u064A(?=[\p{L}\p{M}])/gu, cp(0x6cc));
  for (const [re, right] of list.fix) t = t.replace(re, right);
  // punctuation: Pashto marks, no space before them, one after
  t = t.replace(/(?<=[\u0600-\u06FF]\s?),/g, '،').replace(/(?<=[\u0600-\u06FF]\s?)\?/g, '؟').replace(/(?<=[\u0600-\u06FF]\s?);/g, '؛');
  t = t.replace(/\s+([،؛؟.!:])/g, '$1').replace(/([،؛])(?=\p{L})/gu, '$1 ').replace(/[«»"']/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^[،؛.!:\s]+/, '');
  if (!/[.؟!]$/.test(t)) t = `${t.replace(/[،؛:]$/, '')}.`;
  const words = t.match(/[\p{L}\p{M}]+/gu) || [];
  if (words.length < 3 || words.length > 18) return { refused: `${words.length} words (3 to 18 read well)` };
  if (t.length < 8 || t.length > 120) return { refused: `${t.length} letters` };
  const lone = words.filter((w) => w.length === 1 && w !== 'د' && w !== 'و');
  if (lone.length) return { refused: `a broken word (${lone.join(' ')})` };
  // Pashto letters, a Pashto-keyboard ye, or Pashto's little words - else it may well be Dari
  const pashto = /[\u067C\u0689\u0693\u0696\u069A\u0681\u0685\u06BC\u06D0\u06CD\u06AB\u0626\u064A]/.test(t) || words.some((w) => PS_WORDS.has(w));
  if (!pashto) return { refused: 'no Pashto letters or words (Dari?)' };
  return { text: t };
}

async function sentences(file, { source = path.basename(file, path.extname(file)), domain = '', dry = false } = {}) {
  const list = wordList();
  const seen = new Set();
  const ok = [];
  const refused = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const r = cleanSentence(line, list);
    if (r.refused) refused.push(`${r.refused}\t${line.trim()}`);
    else if (!seen.has(r.text)) seen.add(r.text), ok.push(r.text);
  }
  fs.writeFileSync(`${file}.refused.txt`, refused.join('\n') + '\n');
  fs.writeFileSync(`${file}.clean.txt`, ok.join('\n') + '\n');
  console.log(`${ok.length} sentences kept, ${refused.length} refused (${path.basename(file)}.refused.txt)`);
  if (dry) return;
  let added = 0;
  for (let i = 0; i < ok.length; i += 400) added += (await call('POST', '/admin/voice/sentences', { add: ok.slice(i, i + 400).map((text) => ({ text, source, domain })) })).added;
  log(`sentences: ${added} new from ${path.basename(file)} (${ok.length - added} were there already)`);
}

// ---------------------------------------------------------------- the recordings
const speakerId = (code) => crypto.createHash('sha256').update(`pashto-voice:${code}`).digest('hex').slice(0, 12); // not the code itself
const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3' };
const clipFile = (c) => path.join(cfg.folder, 'recordings', new Date(c.created).toISOString().slice(0, 7), `${c.id}.${EXT[c.mime] || 'bin'}`);
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function sync() {
  const clips = [];
  for (let since = 0; ; ) {
    const r = await call('GET', `/admin/voice/clips?since=${since}&limit=5000`);
    clips.push(...r.clips);
    if (r.clips.length < 5000) break;
    since = r.clips.at(-1).created;
  }
  let got = 0;
  for (const c of clips) {
    const f = clipFile(c);
    if (fs.existsSync(f) && fs.statSync(f).size === c.bytes) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.part`, await call('GET', `/admin/voice/file/${c.id}`));
    fs.renameSync(`${f}.part`, f);
    got++;
  }
  // a speaker who deleted their recordings: gone here too
  const keep = new Set(clips.map(clipFile));
  let removed = 0;
  const recDir = path.join(cfg.folder, 'recordings');
  if (fs.existsSync(recDir)) {
    for (const f of fs.readdirSync(recDir, { recursive: true })) {
      const full = path.join(recDir, f);
      if (fs.statSync(full).isFile() && !keep.has(full)) fs.rmSync(full), removed++;
    }
  }
  const rows = clips.map((c) => ({ id: c.id, speaker: speakerId(c.code), kind: c.kind, text: c.text, text_by: c.text_by, status: c.status, yes: c.yes, no: c.no, seconds: c.seconds, created: new Date(c.created).toISOString(), dialect: c.dialect, region: c.region, gender: c.gender, age: c.age, via: c.via, prompt: c.prompt, file: path.relative(cfg.folder, clipFile(c)) }));
  fs.writeFileSync(path.join(cfg.folder, 'recordings.json'), JSON.stringify(rows, null, 1));
  const cols = Object.keys(rows[0] || { id: 0 });
  fs.writeFileSync(path.join(cfg.folder, 'Recordings.csv'), '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((k) => csv(r[k])).join(','))].join('\r\n'));
  const st = (await call('GET', '/admin/voice/clips?since=' + Date.now())).stats;
  fs.writeFileSync(path.join(cfg.folder, 'Read me.txt'), readMe(st));
  log(`sync: ${clips.length} recordings (${got} new here, ${removed} deleted by their speakers); ${st.hours} h in all, ${st.validatedHours} h checked, ${st.speakers} speakers`);
  return rows;
}

const readMe = (st) => `پښتو غږ - the Pashto voice recordings (private: for training Simurgh's Pashto speech models only)
Updated ${new Date().toLocaleString()}: ${st.clips} recordings, ${st.hours} hours (${st.validatedHours} hours checked by two people), ${st.speakers} speakers.

recordings\\         the sound, as the speakers' browsers recorded it (webm/ogg/m4a), one folder per month
Recordings.csv      every recording: speaker (a number made from their private code, not the code), kind
                    (read = a sentence, speak = free speech, dictation = from Simurgh's Notepad), text, who wrote the
                    text (sentence / model draft / speaker / checker), status (new / validated / rejected), votes,
                    seconds, dialect, region, gender, age
dataset\\            made by "export": the checked recordings as 16 kHz mono WAV, and train.tsv / dev.tsv / test.tsv
                    (each speaker in one list only, so the test is honest)
log.txt             what the daily task did

The website: https://simurgh.onrender.com/voice/   The tool: %LOCALAPPDATA%\\Simurgh Keys\\pashto-voice.mjs
A speaker who deletes their recordings on the website has them deleted here at the next sync.
`;

// ---------------------------------------------------------------- drafts: the recognizer writes, people check
const decode16k = (file) => {
  const r = spawnSync(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${String(r.stderr).slice(0, 200)}`);
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4);
};

async function drafts(rows) {
  rows ||= readJson(path.join(cfg.folder, 'recordings.json'), []);
  const todo = rows.filter((r) => !r.text && r.kind !== 'read' && r.status === 'new');
  if (!todo.length) return log('drafts: nothing to write');
  const model = path.join(cfg.models, 'accurate', 'model.int8.onnx');
  const tokens = path.join(cfg.models, 'accurate', 'tokens.txt');
  const vadModel = path.join(cfg.simurgh, 'electron', 'voice', 'silero_vad.onnx');
  if (!fs.existsSync(model)) return log(`drafts: the Accurate model is not at ${model} (download it in Simurgh's Notepad: Voice typing)`);
  const sherpa = createRequire(path.join(cfg.simurgh, 'package.json'))('sherpa-onnx-node');
  const rec = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { omnilingual: { model }, tokens, numThreads: Number(cfg.threads) || 2, provider: 'cpu', debug: 0 } });
  const said = (samples) => {
    const s = rec.createStream();
    s.acceptWaveform({ samples, sampleRate: 16000 });
    rec.decode(s);
    return rec.getResult(s).text.trim();
  };
  const items = [];
  for (const r of todo) {
    try {
      const all = decode16k(path.join(cfg.folder, r.file));
      // the speech pieces (the recognizer reads up to ~20 s well), joined
      const vad = new sherpa.Vad({ sileroVad: { model: vadModel, threshold: 0.5, minSilenceDuration: 0.45, minSpeechDuration: 0.2, maxSpeechDuration: 18, windowSize: 512 }, sampleRate: 16000, numThreads: 1, debug: 0 }, 120);
      const parts = [];
      for (let i = 0; i + 512 <= all.length; i += 512) {
        vad.acceptWaveform(all.subarray(i, i + 512));
        while (!vad.isEmpty()) parts.push(said(vad.front(false).samples)), vad.pop();
      }
      vad.flush();
      while (!vad.isEmpty()) parts.push(said(vad.front(false).samples)), vad.pop();
      const text = parts.filter(Boolean).join(' ');
      if (text) items.push({ id: r.id, text });
    } catch (e) {
      log(`drafts: ${r.id}: ${e.message}`);
    }
  }
  const set = items.length ? (await call('POST', '/admin/voice/drafts', { items })).set : 0;
  log(`drafts: ${set} written for the checkers (${todo.length} without a text)`);
}

// ---------------------------------------------------------------- the training set
async function exportSet(rows) {
  rows ||= readJson(path.join(cfg.folder, 'recordings.json'), []);
  const good = rows.filter((r) => r.status === 'validated' && r.text);
  const out = path.join(cfg.folder, 'dataset');
  const wavDir = path.join(out, 'wav');
  fs.mkdirSync(wavDir, { recursive: true });
  // a speaker's place (train 90 %, dev 5 %, test 5 %) follows from their number, so it never changes
  const split = (sp) => {
    const n = parseInt(sp.slice(0, 8), 16) % 100;
    return n < 90 ? 'train' : n < 95 ? 'dev' : 'test';
  };
  const lists = { train: [], dev: [], test: [] };
  let made = 0;
  for (const r of good) {
    const wav = path.join(wavDir, `${r.id}.wav`);
    if (!fs.existsSync(wav)) {
      const x = spawnSync(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(cfg.folder, r.file), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
      if (x.status !== 0) continue;
      made++;
    }
    lists[split(r.speaker)].push([`wav/${r.id}.wav`, r.text.replace(/\s+/g, ' '), r.seconds, r.kind, r.speaker, r.dialect || '', r.gender || '', r.age || ''].join('\t'));
  }
  const keep = new Set(good.map((r) => `${r.id}.wav`));
  for (const f of fs.readdirSync(wavDir)) if (!keep.has(f)) fs.rmSync(path.join(wavDir, f));
  const head = 'path\ttext\tseconds\tkind\tspeaker\tdialect\tgender\tage';
  for (const [k, v] of Object.entries(lists)) fs.writeFileSync(path.join(out, `${k}.tsv`), [head, ...v].join('\n') + '\n');
  const hours = (k) => (lists[k].reduce((s, l) => s + Number(l.split('\t')[2]), 0) / 3600).toFixed(2);
  log(`export: ${good.length} checked recordings (${made} new WAVs) - train ${hours('train')} h, dev ${hours('dev')} h, test ${hours('test')} h`);
}

// ---------------------------------------------------------------- run
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n) => {
    const i = rest.indexOf(`--${n}`);
    return i < 0 ? undefined : rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true;
  };
  try {
    if (cmd === 'stats') console.log(JSON.stringify((await call('GET', `/admin/voice/clips?since=${Date.now()}`)).stats, null, 1));
    else if (cmd === 'sentences') await sentences(path.resolve(rest[0]), { source: flag('source'), domain: flag('domain') || '', dry: !!flag('dry') });
    else if (cmd === 'sync') await sync();
    else if (cmd === 'drafts') await drafts();
    else if (cmd === 'export') await exportSet();
    else if (cmd === 'daily') {
      const rows = await sync();
      await drafts(rows);
      await exportSet(await sync()); // the drafts' texts in the list too
    } else console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0]);
  } catch (e) {
    log(`${cmd}: ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}
