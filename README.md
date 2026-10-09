# Simurgh

The website for Simurgh — https://simurgh.onrender.com — where Simurgh is downloaded, free.

- `site/` — the website (English, Pashto, Dari), a static site on Render. Its Download button goes straight to the
  newest installer.
- `server/` — the download server on Render (`simurgh-download`): `/download` (the newest installer, counted per
  version - a number, nothing about who), the installed app's updates (`/u/<channel>`), and پښتو غږ. The owner's PC
  signs its requests (`server/owner-public.pem` is the public half). `npm test` runs its tests.
- `tools/simurgh-release.mjs` — the owner's tool: uploads a new version (`release <dir> <version>`) and shows the
  release and the download counts (`status`). `tools/site-check.mjs` tries the site and the server together
  locally; `tools/live-check.mjs` the live site.

Until 2026-10-09 a download needed a one-time key; that is gone (the server erases the old key data on start).

`render.yaml` describes both services.
