// The newest release's version and size next to the download button (from GitHub; the links work without it).
(() => {
  const link = document.querySelector('[data-download]');
  const m = link && /github\.com\/([^/]+)\/([^/]+)\/releases/.exec(link.href);
  if (!m || m[1] === 'OWNER') return;
  const rtl = document.documentElement.dir === 'rtl';
  const digits = (s) => (rtl ? String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]) : String(s));
  const words = { en: ['version', 'MB'], ps: ['نسخه', 'MB'], fa: ['نسخه', 'MB'] }[document.documentElement.lang] || ['Version', 'MB'];
  fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => (r.ok ? r.json() : null))
    .then((rel) => {
      if (!rel) return;
      const exe = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
      const version = String(rel.tag_name || '').replace(/^v/, '');
      for (const el of document.querySelectorAll('[data-version]')) {
        el.textContent = `${words[0]} ${version}${exe ? `${rtl ? '، ' : ' · '}${Math.round(exe.size / 1048576)} ${words[1]}` : ''}`;
      }
    })
    .catch(() => {});
})();
