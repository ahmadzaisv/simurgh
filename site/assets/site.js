// The download: the button goes straight to the download server's newest installer (meta simurgh-api; a local test
// run serves the site itself, so there it is the same address); the version and size come from the same server.
(() => {
  const lang = document.documentElement.lang;
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API = local ? location.origin : (document.querySelector('meta[name="simurgh-api"]')?.content || '').replace(/\/$/, '');
  if (!API) return;
  for (const a of document.querySelectorAll('[data-download]')) a.href = `${API}/download`;
  const word = { en: 'Version', ps: 'نسخه', fa: 'نسخه' }[lang] || 'Version';

  // the version and size next to the title (the version stays in Latin digits: ۰ looks like the dots between them)
  fetch(`${API}/api/latest`)
    .then((r) => (r.ok ? r.json() : null))
    .then((r) => {
      if (!r?.version) return;
      // the numbers each in their own direction, so they read right in Pashto and Dari too
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
})();
