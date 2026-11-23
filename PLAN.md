# Tapeleaf — Lean Markdown-First Voice Recorder Plan

> **Historical note:** This document reflects Tapeleaf's initial Hono + Docker + server-storage design prior to the zero-server Android PWA rewrite (`abc019d`). See [README.md](./README.md) for the current client-only PWA architecture, Obsidian File System Access sync, and deployment instructions.

**Tapeleaf** is a calm, low-friction personal replacement for `recorder.google.com` built around **Obsidian-ready Markdown files**. Tap **Record**, tap **Stop**, and within seconds your clip is safely saved, language-detected, transcribed, translated to English (when non-English), titled, summarized in one line, tagged, and written out as a clean `.md` note with YAML frontmatter—ready to use directly with Obsidian.

> Refined with Codex (`gpt-6.2-sol`). Keep it simple, beautiful, and easy to maintain. Do **not** over-engineer; extensive automated testing is not required.

---

## 1. Orchestration Rules (For T3 Code)

### Autonomy & Stop Conditions
* **Default to action.** Make strong, pragmatic engineering and design choices autonomously without asking about routine details.
* **Stop ONLY for:**
  1. **Visual Gate 1 (End of Phase 1 — Look & Feel Review):** Start the dev server, open Tapeleaf in T3 Code's Preview pane (`preview_open`) with realistic multilingual fixture clips + live mic capture, and **pause for the user's visual & layout feedback** before building Phase 2.
  2. **Visual Gate 2 (End of Phase 3 — Final Review):** Open the finished app in Preview after the final Codex review, build, and smoke check so the user can approve the complete experience and choose a deployment target.
  3. **Secrets & External Setup:** Request `GEMINI_API_KEY` via `request_secret` (never plain chat) when ready for the live Gemini smoke check if not already in `.env`. Confirm deployment host before deploying publicly.
  4. **Genuine Blockers:** Unrecoverable failures or destructive actions.

### Codex Review Cadence
* **Review 1 (Plan Review):** Already completed before repo creation.
* **Review 2 (Final Code Review — Phase 3):** Call `orchestrator_capabilities`, then delegate one fresh `delegate_task` (`providerInstanceId: "codex"`, top available model e.g. `gpt-6.2-sol`, `role: "review"`, `options: { reasoningEffort: "high" }`) over the finished codebase before Visual Gate 2. Fix valid findings directly, re-run typecheck & build, then present Visual Gate 2.

### Git Commit & Push Cadence
* Repo `kcverde/tapeleaf` (`origin` = `git@github.com:kcverde/tapeleaf.git`, branch `main`) is already initialized.
* Add `.gitignore` excluding `node_modules/`, `dist/`, `.env`, `data/`, `.DS_Store`.
* Commit cleanly and push to `origin main` at each verified milestone (after `npm run typecheck && npm run build` passes):
  1. `feat(ui): scaffold Tapeleaf and interactive recorder prototype`
  2. `style(ui): apply layout and look-and-feel refinements` *(if requested at Visual Gate 1)*
  3. `feat(app): add Hono backend, Markdown/Obsidian storage, and Gemini audio pipeline`
  4. `feat(ops): add passcode lock, Dockerfile, and final review fixes`

---

## 2. Obsidian-Native Markdown Format

Every recording is stored directly as a readable `.md` file inside `DATA_DIR/notes/` (with its audio in `DATA_DIR/notes/audio/`), so the folder itself works out-of-the-box inside an Obsidian vault—and every note can also be copied or downloaded as `.md` in one tap from the UI.

* **Note filename:** `YYYY-MM-DD-<title-slug>.md` (renamed cleanly once Gemini titles the clip, with collision suffix if needed).
* **Audio filename:** `audio/<stable-id>.<ext>` (stable ID so `![[audio/...]]` embeds and player URLs never break when you rename a title).
* **Markdown template:**

```markdown
---
id: rec_20261122_143502_a1b2
title: "Weekend trip ideas for Lisbon"
created: 2026-11-22T14:35:02Z
duration: "1:24"
language: es
language_name: Spanish
status: ready
summary: "Look into flights for next month and ask Ana for neighborhood recommendations."
tags:
  - travel
  - personal
audio: audio/rec_20261122_143502_a1b2.webm
---

# Weekend trip ideas for Lisbon

> Look into flights for next month and ask Ana for neighborhood recommendations.

![[audio/rec_20261122_143502_a1b2.webm]]

## Transcript

...clean English transcript...

## Original (Spanish)

...original Spanish transcript (omitted when spoken in English)...
```

---

## 3. Experience & Visual Design

### Core Flow
1. **1-tap capture, zero popups:** Tactile Record button anchored in the mobile thumb-zone (and clean dock on desktop). While recording: gentle live mic level bars, tabular elapsed timer, Pause/Resume, and Stop.
2. **Scannable library (never a wall of dates):** Each card shows:
   * Concrete English **title** (e.g., *"Dentist reschedule & pharmacy pickup"*)
   * Crisp **1-line English summary**
   * Quiet metadata row: relative time, duration, subtle language badge when non-English (`ES → EN`), and **2–4 soft tags**
   * Calm `"Listening & organizing…"` shimmer while Gemini runs (~2–4s)
3. **Calm detail view:**
   * Clean audio playback built directly on native `<audio>` for rock-solid mobile reliability, with speed control
   * Readable English transcript by default, with a one-tap **`English` / `Original` / `Markdown`** toggle (`Original` shown only for non-English clips; `Markdown` previews the exact Obsidian note)
   * Light inline editing (tap title to rename, add/remove tags—updates the `.md` file directly)
   * One-tap **Copy Markdown** (instant paste into Obsidian), **Download `.md`**, **Download Audio**, **Reprocess**, and **Delete**
4. **Instant recall:**
   * Single search bar matching titles, summaries, English text, original text, and tags
   * Horizontal scrollable tag filter pills (`All`, `#ideas`, `#work`, …)

### Aesthetic: Calm Editorial Utility
* **Inspiration:** Braun / Teenage Engineering meets Google Recorder & Things 3—quiet, tactile, ultra-legible, zero "AI sparkle" clutter.
* **Light mode (default/system):** Warm stone canvas `#FAF9F7`, crisp white cards `#FFFFFF`, hairline borders `#E7E5E4`, deep charcoal ink `#1C1917`, muted metadata `#78716C`.
* **Dark mode (system + toggle):** Deep charcoal canvas `#111113`, elevated cards `#1A1A1D`, hairline borders `#27272A`, crisp ink `#F4F4F5`, muted metadata `#A1A1AA`.
* **One signature accent:** Warm vermilion `#E5484D` strictly for the Record button and active recording pulse.
* **Responsive geometry:** Single-column mobile stack (`< 1024px`, respecting `env(safe-area-inset-bottom)` and `>= 44px` touch targets); clean two-pane master-detail on desktop (`>= 1024px`, inspired by `recorder.google.com`).

---

## 4. Lean Technical Architecture

* **Frontend:** React 19 + TypeScript + Vite + Tailwind CSS v4 + `manifest.webmanifest` + minimalist Tapeleaf icons. No custom service worker cache or IndexedDB sync engine—keep failed uploads safely in the open tab with explicit **Retry** and **Download Audio** buttons, show **Saved** only after server confirmation, and refresh on window focus for phone ↔ desktop sync.
* **Backend:** Single Node 24 + Hono (`@hono/node-server`) process serving both `/api/*` and the built frontend. Zero native binary dependencies.
* **Storage (Markdown-First, No Database Server):**
  * `DATA_DIR/notes/*.md` holds every note (parsed/serialized cleanly via `yaml` with atomic temp-file → rename writes so crashes never corrupt notes).
  * `DATA_DIR/notes/audio/<id>.<ext>` holds every audio file, served via authenticated `GET /api/recordings/:id/audio` with proper `Content-Type` and HTTP `206 Partial Content` (`Range` / `Content-Range`) headers.
  * Server scans `DATA_DIR/notes/*.md` into a fast in-memory index on boot (refreshing cleanly), resetting any interrupted `status: processing` notes to `status: failed` (retryable) on restart.
  * Direct Obsidian integration: sync or copy `DATA_DIR/notes/` straight into any Obsidian vault, or use one-tap **Copy Markdown** / **Download `.md`** (`GET /api/recordings/:id/markdown`).
* **Gemini Pipeline:** `@google/genai` defaulting to `gemini-3.5-flash-lite` (configurable via `GEMINI_MODEL`).
  * Single structured JSON call returning `{ detectedLanguage, languageCode, isEnglish, title, summary, tags, originalTranscript, englishTranslation }`.
  * Passes the top ~15 existing tags in the prompt to keep Obsidian tags consistent (lowercase kebab-case).
  * Inline base64 for clips `<= 12 MB` raw (under the 20 MB request cap after base64 encoding); falls back to Gemini Files API (with post-call deletion) for larger files.
  * Maps browser MIME types cleanly (verifying Safari `audio/mp4` → `audio/m4a` compatibility).
  * **Save first, process second:** Always persist playable audio + initial `.md` stub before calling Gemini. Includes a clean demo fallback when `GEMINI_API_KEY` is unset.
* **Auth:** Optional `APP_PASSCODE` HTTP-only signed cookie protecting all `/api/*` routes including audio and `.md` downloads (disabled locally when unset; required for public deployment).

### Lean File Layout
```text
.
├── PLAN.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── Dockerfile
├── .env.example
├── .gitignore
├── README.md                  # Local run, Obsidian sync tips, phone HTTPS, deploy & backup
├── public/
│   ├── manifest.webmanifest
│   └── icons/
├── server/
│   ├── index.ts               # Hono server, static serving, passcode auth & API routes
│   ├── notes.ts               # Obsidian Markdown read/write/rename, YAML frontmatter, search
│   ├── storage.ts             # Disk audio save/delete & authenticated 206 Range streaming
│   └── gemini.ts              # Single-call structured audio analysis + demo fallback
└── src/
    ├── main.tsx
    ├── App.tsx                # Responsive master-detail UI, search, tags, detail & dock
    ├── index.css              # Warm stone light / charcoal dark design tokens
    ├── types.ts               # Shared Recording type
    ├── fixtures.ts            # Realistic multilingual clips for Phase 1 Visual Gate
    └── hooks/
        └── useRecorder.ts     # Runtime MIME probe, final dataavailable, live level meter
```

---

## 5. Three-Phase Execution Plan

### Phase 1 — Interactive Prototype & Visual Gate 1
1. Add `.gitignore` and scaffold Tapeleaf (Vite + React + TypeScript + Tailwind v4 + Hono).
2. Build the responsive light/dark UI: scannable card feed, search bar, tag pills, detail view (`English / Original / Markdown` toggle, Copy Markdown, Download `.md`, clean audio playback), and bottom Record Dock with live mic level bars + real `MediaRecorder` probing.
3. Populate realistic multilingual fixture recordings (Spanish, French, Japanese, and English) so every state—including the live Obsidian Markdown preview—is immediately tangible.
4. Run `npm run typecheck && npm run build`, commit (`feat(ui): scaffold Tapeleaf and interactive recorder prototype`), and push to `origin main`.
5. **VISUAL GATE 1 (STOP):** Start the dev server, open Tapeleaf in T3 Code Preview (`preview_open`), and pause for look-and-feel feedback. Apply any requested tweaks, commit (`style(ui): apply layout and look-and-feel refinements`), and push.

### Phase 2 — Full End-to-End Flow
1. Implement `server/notes.ts` (atomic Obsidian `.md` + YAML frontmatter storage, slug renaming, startup recovery, search), `server/storage.ts` (save-first + `206` Range streaming), `server/gemini.ts` (`gemini-3.5-flash-lite` structured output + Files API fallback for `> 12 MB` + demo fallback), and `server/index.ts`.
2. Wire `src/App.tsx` and `src/hooks/useRecorder.ts` to live `/api/recordings` endpoints, upload failure **Retry / Download Audio**, Copy Markdown / Download `.md`, inline title/tag edits (persisting straight back to `.md`), search, tag filter, and refresh-on-focus sync.
3. Run `npm run typecheck && npm run build`.
4. Smoke-test end-to-end (request `GEMINI_API_KEY` via `request_secret` if needed): record/upload a short non-English clip → inspect generated `.md` file & YAML frontmatter, verify `English / Original / Markdown` views, search hit, and `206` audio playback.
5. Commit (`feat(app): add Hono backend, Markdown/Obsidian storage, and Gemini audio pipeline`) and push to `origin main`.

### Phase 3 — Ship-Ready Polish, Final Codex Review & Visual Gate 2
1. Add optional `APP_PASSCODE` signed cookie auth covering all `/api/*` endpoints (including audio and `.md` downloads) + minimal unlock screen.
2. Add `public/manifest.webmanifest`, minimalist Tapeleaf icons, single-container `Dockerfile` (persistent `/data` volume holding `notes/` + `notes/audio/`), `.env.example`, and a concise `README.md` covering Obsidian vault syncing, phone HTTPS requirements, deployment (Railway / Fly.io / VPS), and backups.
3. Verify restart persistence + `npm run typecheck && npm run build`.
4. Run **Final Codex Review** (`delegate_task` → `codex`, `role: "review"`), apply valid fixes, re-verify build/typecheck, commit (`feat(ops): add passcode lock, Dockerfile, and final review fixes`), and push to `origin main`.
5. **VISUAL GATE 2 (STOP):** Open the running app in Preview (`preview_open`) for final sign-off, real-phone testing notes, and deployment choice.
