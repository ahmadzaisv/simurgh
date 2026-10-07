// پښتو غږ: join (consent + optional profile -> a private code kept on this device), read sentences, speak about a
// topic, check others' recordings, see and delete one's own. The server is the download server's /voice/api.
(() => {
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API = local ? location.origin : (document.querySelector('meta[name="simurgh-api"]')?.content || '').replace(/\/$/, '');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const keep = {
    get: (k) => {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
      } catch {}
    },
  };
  let code = keep.get('pashto-voice-code');
  const api = async (path, opts = {}) => {
    const r = await fetch(API + path, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
    return j;
  };
  const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ps = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  const say = (el, text, kind = '') => {
    if (!el) return;
    el.textContent = text;
    el.className = `msg ${kind}`;
  };
  const OFFLINE = 'انټرنېټ ته ونه رسېدو. بیا هڅه وکړئ.';
  const WAIT = 'ډېر ژر ژر — یوه شېبه وروسته بیا هڅه وکړئ.';
  const amount = (s) => (s < 90 ? `${ps(Math.round(s))} ثانیې` : s < 3600 ? `${ps(Math.round(s / 60))} دقیقې` : `${ps((s / 3600).toFixed(1))} ساعته`);

  // ---------------------------------------------------------------- everyone's totals
  const totals = async () => {
    try {
      const s = await api('/voice/api/stats', { cache: 'no-cache' });
      $('[data-total]').textContent = `${amount(s.seconds)} غږ`;
      $('[data-stats]').textContent = `تر اوسه ${ps(s.speakers)} کسانو ${amount(s.seconds)} غږ ورکړی؛ ${amount(s.validatedSeconds)} یې کتل شوی او سم دی.`;
    } catch {}
  };

  // ---------------------------------------------------------------- the recorder
  const pickType = () => ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';

  /** A recorder in `host`: one tap starts, one tap (or `max` seconds) stops; listen, then send or record again. */
  function recorder(host, { max, min, onSend }) {
    host.replaceChildren($('#recorder').content.cloneNode(true));
    const mic = $('[data-mic]', host);
    const state = $('[data-state]', host);
    const meter = $('[data-meter] i', host);
    const after = $('[data-after]', host);
    const play = $('[data-play]', host);
    const send = $('[data-send]', host);
    const IDLE = 'د ثبتولو لپاره ټک ووهئ';
    let rec = null;
    let chunks = [];
    let started = 0;
    let blob = null;
    let seconds = 0;
    let frame = 0;
    let ctx = null;
    const release = () => {
      cancelAnimationFrame(frame);
      ctx?.close().catch(() => {});
      ctx = null;
      meter.style.width = '0';
      rec?.stream.getTracks().forEach((t) => t.stop()); // the browser's microphone light goes off between recordings
    };
    const reset = () => {
      blob = null;
      if (play.src) URL.revokeObjectURL(play.src);
      play.removeAttribute('src');
      after.hidden = true;
      mic.hidden = false;
      mic.classList.remove('on');
      state.textContent = IDLE;
    };
    const stop = () => rec?.state === 'recording' && rec.stop();
    mic.onclick = async () => {
      if (rec?.state === 'recording') return stop();
      if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
        state.textContent = 'دا براوزر غږ نه شي ثبتولی. Chrome، Edge، Firefox یا Safari وکاروئ.';
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
        const type = pickType();
        rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32000 });
      } catch (e) {
        state.textContent = /NotAllowed|Permission|Security/i.test(e?.name || '') ? 'مایکروفون ته اجازه ورنکړل شوه. د براوزر په تنظیماتو کې اجازه ورکړئ.' : 'مایکروفون ونه موندل شو.';
        return;
      }
      chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        seconds = Math.min(max, (Date.now() - started) / 1000);
        release();
        mic.classList.remove('on');
        if (seconds < min) {
          state.textContent = 'ډېر لنډ و — بیا یې ثبت کړئ.';
          return;
        }
        blob = new Blob(chunks, { type: rec.mimeType || chunks[0]?.type || 'audio/webm' });
        play.src = URL.createObjectURL(blob);
        mic.hidden = true;
        after.hidden = false;
        state.textContent = `${ps(seconds.toFixed(1))} ثانیې — واورئ یې، بیا یې ولېږئ.`;
      };
      rec.start(250);
      started = Date.now();
      mic.classList.add('on');
      // a level meter, so the speaker sees the microphone hears them
      try {
        ctx = new AudioContext();
        ctx.resume().catch(() => {});
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(rec.stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        const tick = () => {
          if (rec.state !== 'recording') return;
          an.getFloatTimeDomainData(buf);
          let e = 0;
          for (const v of buf) e += v * v;
          // decibels, -60 (silence) to -12 (loud), so a quiet voice still moves it
          const db = 10 * Math.log10(e / buf.length + 1e-10);
          meter.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 48) * 100))}%`;
          const left = max - (Date.now() - started) / 1000;
          state.textContent = `ثبتېږي… ${ps(Math.max(0, Math.ceil(left)))} — چې خلاص شوئ، بیا ټک ووهئ`;
          if (left <= 0) return stop();
          frame = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        setTimeout(stop, max * 1000);
      }
    };
    $('[data-redo]', host).onclick = reset;
    send.onclick = async () => {
      if (!blob) return;
      send.disabled = true;
      state.textContent = 'لېږل کېږي…';
      try {
        await onSend(blob, seconds);
        reset();
        state.textContent = 'ولېږل شو، مننه! ✓';
      } catch (err) {
        state.textContent = err.status === 429 ? WAIT : err.status === 413 ? 'ډېر اوږد و — لنډ یې کړئ.' : OFFLINE;
      } finally {
        send.disabled = false;
      }
    };
    return { reset };
  }

  const upload = async (blob, q) => {
    const r = await fetch(`${API}/voice/api/clip?${new URLSearchParams({ code, ...q })}`, { method: 'POST', headers: { 'content-type': blob.type.split(';')[0] || 'audio/webm' }, body: blob });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status });
    return j;
  };

  // ---------------------------------------------------------------- read a sentence
  let sentence = null;
  const nextSentence = async (skip = false) => {
    const box = $('[data-sentence]');
    try {
      const r = await api(`/voice/api/next?code=${code}${skip && sentence ? `&not=${sentence.id}` : ''}`);
      sentence = r.sentence || null;
      box.textContent = sentence ? sentence.text : 'تاسو ټولې جملې لوستې دي — مننه! اوس «خبرې وکړئ» یا «وګورئ» وکاروئ.';
      $('[data-rec="read"]').hidden = !sentence;
    } catch (e) {
      if (e.status === 404) return leave();
      box.textContent = OFFLINE;
    }
  };

  // ---------------------------------------------------------------- speak about a topic
  let topic = '';
  const nextTopic = async () => {
    try {
      topic = (await api(`/voice/api/next?code=${code}&kind=speak`)).prompt;
      $('[data-prompt]').textContent = topic;
    } catch (e) {
      if (e.status === 404) return leave();
      $('[data-prompt]').textContent = OFFLINE;
    }
  };

  // ---------------------------------------------------------------- check someone else's
  let checking = null;
  const fixBtn = () => $('[data-fix-btn]');
  const nextCheck = async () => {
    const audio = $('[data-audio]');
    const text = $('[data-check-text]');
    say($('[data-check-msg]'), '');
    $('[data-fix]').hidden = true;
    fixBtn().textContent = '✎ متن سم کړئ';
    try {
      const r = await api(`/voice/api/check?code=${code}`);
      checking = r.clip || null;
      audio.hidden = !checking;
      $('[data-yes]').hidden = !checking;
      $('[data-no]').hidden = !checking;
      fixBtn().hidden = !checking || checking.kind === 'read';
      if (!checking) {
        audio.removeAttribute('src');
        text.textContent = 'اوس د کتلو لپاره څه نشته. وروسته بیا راشئ — یا پخپله څه ثبت کړئ.';
        return;
      }
      audio.src = API + checking.audio;
      text.textContent = checking.text;
      $('[data-fix]').value = checking.text;
    } catch (e) {
      if (e.status === 404) return leave();
      text.textContent = OFFLINE;
    }
  };
  const vote = async (verdict, fixed) => {
    if (!checking) return;
    try {
      await post('/voice/api/check', { code, clip: checking.id, verdict, ...(fixed ? { fixed } : {}) });
      checking = null;
      say($('[data-check-msg]'), 'مننه! ✓', 'ok');
      setTimeout(nextCheck, 600);
    } catch (e) {
      say($('[data-check-msg]'), e.status === 429 ? WAIT : e.status === 400 ? 'دا غږ نور کتل شوی — بل یې.' : OFFLINE, 'err');
      if (e.status === 400) setTimeout(nextCheck, 900);
    }
  };

  // ---------------------------------------------------------------- mine
  const showMe = async () => {
    $('[data-code]').textContent = code;
    try {
      const m = await api(`/voice/api/me?code=${code}`);
      const p = document.createElement('p');
      p.textContent = m.clips
        ? `تاسو ${ps(m.clips)} غږونه (${amount(m.seconds)}) ورکړي، ${ps(m.validated)} یې کتل شوي او سم دي. د نورو ${ps(m.checks)} غږونه مو کتلي. مننه!`
        : m.checks
          ? `د نورو ${ps(m.checks)} غږونه مو کتلي. مننه! اوس خپل غږ هم ورکړئ.`
          : 'تر اوسه مو غږ نه دی ورکړی. له «ولولئ» نه پیل وکړئ — هره جمله یوازې څو ثانیې ده.';
      $('[data-mine]').replaceChildren(p);
    } catch (e) {
      if (e.status === 404) leave();
    }
  };

  // ---------------------------------------------------------------- the pages
  const tab = (name) => {
    $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
    keep.set('pashto-voice-tab', name);
    if (name === 'read' && !sentence) nextSentence();
    if (name === 'speak' && !topic) nextTopic();
    if (name === 'check') nextCheck();
    if (name === 'me') showMe();
  };
  let ready = false;
  const enter = () => {
    $('[data-page="intro"]').hidden = true;
    $('[data-page="work"]').hidden = false;
    if (!ready) {
      ready = true;
      recorder($('[data-rec="read"]'), {
        max: 20,
        min: 0.8,
        onSend: async (blob, seconds) => {
          if (!sentence) throw new Error('no sentence');
          await upload(blob, { kind: 'read', sentence: sentence.id, seconds: seconds.toFixed(2) });
          totals();
          await nextSentence();
        },
      });
      recorder($('[data-rec="speak"]'), {
        max: 60,
        min: 2,
        onSend: async (blob, seconds) => {
          await upload(blob, { kind: 'speak', seconds: seconds.toFixed(2), prompt: topic });
          totals();
          await nextTopic();
        },
      });
    }
    tab(keep.get('pashto-voice-tab') || 'read');
  };
  const leave = () => {
    code = null;
    sentence = null;
    topic = '';
    keep.set('pashto-voice-code', null);
    keep.set('pashto-voice-tab', null);
    $('[data-page="intro"]').hidden = false;
    $('[data-page="work"]').hidden = true;
  };

  $('[data-join]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (!f.get('consent')) return say($('[data-msg]'), 'لطفاً لومړی موافقه وکړئ.', 'err');
    const btn = $('button[type="submit"]', e.target);
    btn.disabled = true;
    try {
      const r = await post('/voice/api/join', { consent: 1, profile: { dialect: f.get('dialect'), region: f.get('region'), gender: f.get('gender'), age: f.get('age') } });
      code = r.code;
      keep.set('pashto-voice-code', code);
      keep.set('pashto-voice-tab', 'me'); // first the code to keep, then the reading
      say($('[data-msg]'), '');
      enter();
    } catch (err) {
      say($('[data-msg]'), err.status === 429 ? WAIT : OFFLINE, 'err');
    } finally {
      btn.disabled = false;
    }
  });
  $('[data-have-code]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const c = String(new FormData(e.target).get('code') || '').trim().toLowerCase();
    if (!/^[a-z0-9]{12}$/.test(c)) return say($('[data-code-msg]'), 'کوډ ۱۲ توري او شمېرې لري.', 'err');
    try {
      await api(`/voice/api/me?code=${c}`);
      code = c;
      keep.set('pashto-voice-code', code);
      say($('[data-code-msg]'), '');
      enter();
    } catch (err) {
      say($('[data-code-msg]'), err.status === 404 ? 'دا کوډ ونه موندل شو.' : OFFLINE, 'err');
    }
  });
  $$('[data-tab]').forEach((b) => (b.onclick = () => tab(b.dataset.tab)));
  $('[data-skip]').onclick = () => nextSentence(true);
  $('[data-report]').onclick = async () => {
    if (sentence) await post('/voice/api/report', { code, sentence: sentence.id }).catch(() => {});
    nextSentence(true);
  };
  $('[data-other-topic]').onclick = () => nextTopic();
  $('[data-yes]').onclick = () => vote('yes');
  $('[data-no]').onclick = () => vote('no');
  fixBtn().onclick = () => {
    const fix = $('[data-fix]');
    if (fix.hidden) {
      fix.hidden = false;
      fix.focus();
      fixBtn().textContent = '✓ سم شوی متن ولېږئ';
    } else if (fix.value.trim()) {
      vote('fix', fix.value.trim());
    }
  };
  $('[data-copy-code]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      $('[data-copy-code]').textContent = 'کاپي شو ✓';
    } catch {
      getSelection().selectAllChildren($('[data-code]'));
    }
  };
  $('[data-share]').onclick = async () => {
    const data = { title: 'پښتو غږ', text: 'خپل غږ د پښتو ژبې لپاره ورکړئ — څو جملې ولولئ، چې کمپیوټر پښتو ښه واوري او ولیکي.', url: location.origin + location.pathname };
    if (navigator.share) return navigator.share(data).catch(() => {});
    try {
      await navigator.clipboard.writeText(`${data.text}\n${data.url}`);
      $('[data-share]').textContent = 'لینک کاپي شو ✓';
    } catch {}
  };
  $('[data-forget]').onclick = async () => {
    try {
      await post('/voice/api/forget', { code });
      leave();
      say($('[data-msg]'), 'ستاسو ټول غږونه او کوډ ړنګ شول.', 'ok');
      totals();
    } catch {
      say($('[data-forget-msg]'), OFFLINE, 'err');
    }
  };

  // Simurgh's Notepad opens this page with its code after the # (a browser never sends that part to a server)
  const fromApp = /^#code=([a-z0-9]{12})$/.exec(location.hash);
  if (fromApp) {
    code = fromApp[1];
    keep.set('pashto-voice-code', code);
    keep.set('pashto-voice-tab', 'me');
    history.replaceState(null, '', location.pathname);
  }
  totals();
  if (code) enter();
})();
