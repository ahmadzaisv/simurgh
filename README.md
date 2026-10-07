# Simurgh

The website for Simurgh — https://simurgh.onrender.com — where Simurgh is downloaded with a download key.

- `site/` — the website (English, Pashto, Dari), a static site on Render.
- `server/` — the download server on Render (`simurgh-download`): a download key gives one download link; the
  installed app gets its updates from it. It keeps only hashes of the keys; the owner's PC signs its requests
  (`server/owner-public.pem` is the public half). `npm test` runs its tests.
- `tools/simurgh-keys.mjs` — the owner's tool: keeps the list of keys on the owner's PC, takes used ones off it,
  makes new ones, and uploads new versions. `tools/site-check.mjs` tries the site and the server together locally.

`render.yaml` describes both services.
