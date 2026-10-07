# پښتو غږ — the Pashto voice project

Pashtuns give their voices so that Simurgh (and, through it, computers and phones) hear and write Pashto well.
Started 2026-10-07. The owner's decisions: the recordings are **private to Simurgh** (the models trained on them may
be shared), contributors are **anonymous with a private code**, the download server's disk is **10 GB**.

## How it works

```
speakers ── simurgh.onrender.com/voice/ ──┐                         ┌── owner's PC (daily, 04:00)
            (read · speak · check · mine)  ├─► simurgh-download ───┤   Documents\Pashto Voice\
Simurgh ── Notepad "Share with پښتو غږ" ───┘    /voice/api + disk   │   recordings, Recordings.csv,
            (Pashto dictations + final text)    (SQLite, clips)     │   dataset\ (train/dev/test)
                                                                    └── drafts: Omnilingual ASR writes the free
                                                                        speech; checkers on the site correct it
```

- **Read**: a sentence from the list (least-read first), up to 20 s. Its text is the sentence.
- **Speak**: free speech on a topic, 2–60 s. No text at first; the owner's PC writes a draft (`drafts`), checkers fix it.
- **Dictation**: from Simurgh's Notepad, only after the person agreed; only Pashto; the text the person left.
- **Check**: anyone checks others' recordings — yes / no / fix the text. Two agreeing votes decide (yes ≥ 2 and more
  yes than no → validated). A fixed text starts over with the fixer's yes. A recording is never checked by its speaker.
- **Mine / delete**: the code shows a speaker's counts; "delete everything" removes their recordings, checks and code.
  The owner's next sync removes them from the PC and the dataset too.

Privacy: no names, phones or emails; the profile (dialect, region, gender, age) is optional; checkers get a 10-minute
signed link to one recording; everything else only through the owner's signed requests (`owner-private.pem` stays on
the PC). The local files name speakers by a number made from the code, not the code.

## Files

| | |
|---|---|
| `server/voice.mjs` | the API (`/voice/api/*`), rate limits, the owner's `/admin/voice/*` |
| `site/voice/` | the contributor page (phone first, Pashto, right to left) |
| `tools/pashto-voice.mjs` | the owner's tool: `stats`, `sentences <file>`, `sync`, `drafts`, `export`, `daily` |
| `data/sentences/` | sentences to read (CC0), one per line |
| `tools/voice-check.mjs` | the page end to end in a headless Edge with a fake microphone (`npm run check:voice`) |

The owner's PC: the tool and its settings in `%LOCALAPPDATA%\Simurgh Keys\` (`pashto-voice.mjs`, `pashto-voice.json`),
the scheduled task **Pashto Voice daily**, the data in `Documents\Pashto Voice\`.

## Sentences

`node tools/pashto-voice.mjs sentences <file.txt>` cleans each line (Pashto kaf/gaf, inner ye, Pashto punctuation, the
checker's word list) and refuses doubtful ones into `<file>.refused.txt`: old spelling with ى, Urdu letters, Dari
words, broken words, digits (read differently by each speaker), too short or long. Write new ones in standard Afghan
spelling with the five ye letters by grammar; include questions (their tune matters for dictation) and everyday,
office, phone and computer language. Common Voice's Pashto sentences (CC0) were not added: about a fifth use old
spelling, and Common Voice already has 82 validated hours of them read aloud.

## The model

Today Simurgh uses Meta's Omnilingual ASR (1B: 36 % of words wrong on FLEURS Pashto, 26 % after Claude's pass).
The plan, as the hours grow:

1. **Measure first**: a fixed test set — FLEURS Pashto plus `dataset/test.tsv` (speakers never in training).
2. **~20 checked hours** (with Common Voice Pashto's 82 h, CC0 — downloading it means accepting Mozilla's terms, the
   owner's decision): fine-tune Omnilingual 300M CTC on Pashto (Meta's omnilingual-asr training recipes, a rented GPU
   for a few hours — the owner's decision, roughly tens of dollars), export to ONNX for sherpa-onnx, and ship it in
   Notepad as a third model only if it beats the current one on the test set.
3. **~100 hours**: the same for the 1B model; dialect-by-dialect results (the profile's dialect) to see who is
   served badly and ask those regions for more voices.
