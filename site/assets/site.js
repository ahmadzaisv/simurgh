// The download box: the key goes to the download server (meta simurgh-api; a local test run serves the site itself,
// so there it is the same address), which answers with a download link - or why not. The version and size come
// from the same server.
(() => {
  const lang = document.documentElement.lang;
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API = local ? location.origin : (document.querySelector('meta[name="simurgh-api"]')?.content || '').replace(/\/$/, '');
  const T = {
    en: {
      empty: 'Enter your download key.',
      format: "That doesn't look like a download key. It has 20 letters and numbers, like ABCDE-12345-FGHJK-67890.",
      unknown: "This key isn't valid. Check it, or ask for a new one.",
      used: 'This key has already been used. Each key works once — ask for a new one.',
      wait: 'Too many wrong keys. Try again in an hour.',
      notready: "The download isn't ready yet. Your key wasn't used — try again later.",
      network: "Couldn't reach the download server. Check your internet and try again — your key wasn't used.",
      working: 'Checking your key…',
      ok: (size) => `Your download has started (Simurgh-Setup.exe, ${size} MB). If it didn't, `,
      link: 'click here',
      after: ' — the link works for 24 hours.',
      version: 'Version',
    },
    ps: {
      empty: 'خپله د ډاونلوډ کلي ولیکئ.',
      format: 'دا د ډاونلوډ کلي نه ښکاري. کلي ۲۰ توري او شمېرې لري، لکه ABCDE-12345-FGHJK-67890.',
      unknown: 'دا کلي سمه نه ده. وې ګورئ، یا نوې وغواړئ.',
      used: 'دا کلي مخکې کارول شوې ده. هره کلي یو ځل کار کوي — نوې وغواړئ.',
      wait: 'ډېرې ناسمې کلي. یو ساعت وروسته بیا هڅه وکړئ.',
      notready: 'ډاونلوډ لا چمتو نه دی. ستاسو کلي ونه کارول شوه — وروسته بیا هڅه وکړئ.',
      network: 'د ډاونلوډ سرور ته ونه رسېدو. خپل انټرنېټ وګورئ او بیا هڅه وکړئ — ستاسو کلي ونه کارول شوه.',
      working: 'کلي کتل کېږي…',
      ok: (size) => `ستاسو ډاونلوډ پیل شو (Simurgh-Setup.exe، ${size} MB). که پیل نه شو، `,
      link: 'دلته کلیک وکړئ',
      after: ' — دا لینک ۲۴ ساعته کار کوي.',
      version: 'نسخه',
    },
    fa: {
      empty: 'کلید دانلود خود را بنویسید.',
      format: 'این کلید دانلود به نظر نمی‌رسد. کلید ۲۰ حرف و عدد دارد، مانند ABCDE-12345-FGHJK-67890.',
      unknown: 'این کلید درست نیست. آن را بررسی کنید یا کلید تازه بخواهید.',
      used: 'این کلید قبلاً استفاده شده است. هر کلید یک بار کار می‌کند — کلید تازه بخواهید.',
      wait: 'کلیدهای نادرست زیاد. یک ساعت بعد دوباره کوشش کنید.',
      notready: 'دانلود هنوز آماده نیست. کلید شما استفاده نشد — بعداً دوباره کوشش کنید.',
      network: 'به سرور دانلود دسترسی نشد. انترنت خود را بررسی کنید و دوباره کوشش کنید — کلید شما استفاده نشد.',
      working: 'کلید بررسی می‌شود…',
      ok: (size) => `دانلود شما شروع شد (Simurgh-Setup.exe، ${size} MB). اگر شروع نشد، `,
      link: 'اینجا کلیک کنید',
      after: ' — این لینک ۲۴ ساعت کار می‌کند.',
      version: 'نسخه',
    },
  }[lang] || null;
  if (!T || !API) return;

  // the version and size next to the title (the version stays in Latin digits: ۰ looks like the dots between them)
  fetch(`${API}/api/latest`)
    .then((r) => (r.ok ? r.json() : null))
    .then((r) => {
      if (!r?.version) return;
      // the numbers each in their own direction, so they read right in Pashto and Dari too
      const word = T.version;
      const mb = Math.round(r.size / 1048576);
      for (const el of document.querySelectorAll('[data-version]')) {
        const v = document.createElement('bdi');
        v.textContent = r.version;
        const size = document.createElement('bdi');
        size.textContent = `${mb} MB`;
        el.replaceChildren(`${word} `, v, lang === 'en' ? ' · ' : '، ', size);
      }
    })
    .catch(() => {});

  const form = document.querySelector('[data-keybox]');
  if (!form) return;
  const input = form.querySelector('input');
  const button = form.querySelector('button');
  const msg = form.querySelector('.msg');
  const say = (text, kind = 'err', link = null) => {
    msg.className = `msg ${kind}`;
    msg.textContent = text;
    if (link) {
      const a = document.createElement('a');
      a.href = link;
      a.textContent = T.link;
      msg.append(a, T.after);
    }
  };
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  // what was typed, as the key's 20 characters (O reads as 0, I and L as 1) - or null
  const normalize = (s) => {
    const k = String(s).toUpperCase().replace(/[\s\-_.–—]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return k.length === 20 && [...k].every((c) => ALPHABET.includes(c)) ? k : null;
  };
  // tidy the key as it is typed or pasted: capitals, a dash after every five
  input.addEventListener('input', () => {
    const atEnd = input.selectionStart === input.value.length;
    const raw = input.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 20);
    const nice = raw.match(/.{1,5}/g)?.join('-') || '';
    if (nice !== input.value && atEnd) input.value = nice;
    if (msg.textContent) say('', '');
  });

  // what the browser tells about the computer (it knows Windows 11 from 10); nothing else
  const device = async () => {
    try {
      const d = navigator.userAgentData;
      if (!d) return {};
      const h = await d.getHighEntropyValues(['platformVersion', 'bitness']);
      return { platform: d.platform, platformVersion: h.platformVersion, bitness: h.bitness };
    } catch {
      return {};
    }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return say(T.empty);
    const key = normalize(input.value);
    if (!key) return say(T.format);
    button.disabled = true;
    say(T.working, 'busy');
    try {
      const r = await fetch(`${API}/api/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, device: await device() }) });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.url) {
        const url = `${API}${data.url}`;
        say(T.ok(Math.round((data.size || 0) / 1048576)), 'ok', url);
        input.value = '';
        location.href = url; // the download starts; the page stays
      } else say(T[{ format: 'format', unknown: 'unknown', used: 'used', wait: 'wait', 'not ready': 'notready' }[data.error] || 'network']);
    } catch {
      say(T.network);
    } finally {
      button.disabled = false;
    }
  });
})();
