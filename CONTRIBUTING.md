# Contributing to Tapeleaf

Thanks for your interest in contributing to **Tapeleaf**! Bug reports, UX improvements, browser compatibility fixes, and documentation updates are all very welcome.

## Guiding Principles

Before making large changes, keep Tapeleaf's core design philosophy in mind:

1. **Zero server, offline-first:** Everything runs in the browser. Do not introduce a required backend, analytics, telemetry, or third-party tracking.
2. **Never lose audio:** Captures are saved locally in IndexedDB (with periodic mid-recording draft chunks) before transcription or vault writes run.
3. **Respect user edits in Obsidian:** Never silently overwrite or delete notes that the user modified outside Tapeleaf.
4. **Mobile-first hardware calm:** Prioritize one-thumb Android PWA ergonomics (`>= 44px` touch targets, `safe-area-inset-*`, uncluttered headers) alongside the desktop split view.
5. **Minimal dependencies:** Prefer native Web APIs (`MediaRecorder`, Web Audio, IndexedDB, File System Access API, Web Share, Service Workers) over heavy packages.

## Local Setup

Requires **Node.js 24+** (matching CI).

```bash
git clone https://github.com/kcverde/tapeleaf.git
cd tapeleaf
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. To test live transcription, paste a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) in **Settings** (keys stay in your browser only).

## Project Map

```text
src/
├── App.tsx                    # Top-level state, transcription queue, vault orchestration
├── index.css                  # Alabaster light & Obsidian dark hardware theme tokens
├── markdown.ts                # Obsidian YAML frontmatter, sanitization, speaker parsing
├── types.ts                   # Shared TypeScript interfaces
├── components/
│   ├── AudioPlayer.tsx        # Segmented waveform playback deck (Web Audio peaks)
│   ├── DetailPane.tsx         # Note reader, inline title/tag edit, mobile action sheet
│   ├── LibraryPane.tsx        # Search, tag filters, indexed hairline tape log
│   ├── MarkdownPreview.tsx    # Syntax-tinted Obsidian Markdown preview
│   ├── RecordDock.tsx         # Bottom REC bar + full-screen mobile Live Capture Bay
│   ├── SettingsModal.tsx      # Vault folder connection, Gemini key/model, storage stats
│   └── TapeleafMark.tsx       # Micro-cassette SVG brand mark
├── hooks/
│   └── useRecorder.ts         # MediaRecorder hook + live audio meter levels
└── lib/
    ├── audio.ts               # Codec probing, import validation, waveform peak extraction
    ├── db.ts                  # IndexedDB stores (recordings, audio, isolated draft chunks)
    ├── geminiClient.ts        # Direct browser calls to @google/genai + Files API cleanup
    ├── recorderController.ts  # Crash-safe recorder state machine
    ├── swRegistration.ts      # Release-atomic service worker update lifecycle
    └── vaultSync.ts           # File System Access API writes, renames, conflict checks
tests/
└── tapeleaf.test.ts           # Node built-in test runner unit tests
vite.config.ts                 # Static build + manifest.webmanifest + hashed sw.js plugin
```

## Verification Checklist

Run these before opening a pull request (CI runs all four):

```bash
npm run typecheck
npm test
npm run build
VITE_BASE_PATH=/tapeleaf/ npm run build
```

If you change storage, vault sync, Markdown formatting, or recorder lifecycle logic, add or update unit tests in [tests/tapeleaf.test.ts](./tests/tapeleaf.test.ts).

## Pull Requests

- Keep PRs focused on a single feature or fix.
- Include before/after screenshots (mobile and desktop, light and dark) for UI changes.
- Describe how you tested changes on real browsers/devices when touching audio capture, PWA caching, or File System Access API behavior.
