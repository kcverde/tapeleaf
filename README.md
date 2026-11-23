# Tapeleaf

Calm, zero-server, offline-first personal voice recorder built for **Android + Obsidian Sync**. Tap **Record**, tap **Stop**, and your clip is saved on-device in IndexedDB, transcribed & translated to English (when non-English) via Gemini, and written directly—both the `.md` note and `audio/` attachment—straight into your Obsidian vault folder on Android.

## How It Works (Zero Server)

* **Offline-first PWA:** Release-atomic Service Worker caches the app shell so Tapeleaf launches from your Android Home Screen even in Airplane Mode. Periodic audio chunks save to a local IndexedDB draft while recording for crash recovery, and completed clips queue offline and transcribe automatically once Tapeleaf is open online.
* **Direct Obsidian Vault Folder Sync (Android Chrome 132+ / Desktop Chrome):**
  * Uses the File System Access API (`showDirectoryPicker`) to write both `YYYY-MM-DD HH.MM - Concise Subject.md` and `audio/<id>.<ext>` directly into a subfolder of your Obsidian vault in **Device storage**.
  * Uses shortest-path embeds (`![[rec_....m4a]]`) so playback works whether you connect the vault root or a subfolder like `MyVault/Tapeleaf/`. Manual **Download Audio** uses the same embedded filename so manual `.md` + audio pairs resolve cleanly in Obsidian.
  * Automatically renames notes cleanly when Gemini titles an offline stub or when you rename a note inline—persisting rename intent first, verifying the old file wasn't edited inside Obsidian before removing it, and checking hashes before deleting or overwriting externally modified Obsidian notes.
  * Keeps local deletion separate from vault deletion by default.
  * **Android folder permission note:** Reopening an installed Android PWA after the OS restarts it may require a single tap on the **Reconnect** banner to re-authorize folder access—all notes stay safe in IndexedDB and flush to your vault folder automatically on reconnect.
  * **Obsidian Sync** picks up both the note and audio attachment automatically and syncs them across all your devices.
* **BYO Gemini API Key:** Enter your key once in **Settings**. Session-only by default (held in JS memory only—clears on reload/close), with an opt-in **Remember key on this device** (`localStorage`) toggle. Calls Google’s Gemini API (`gemini-3.5-flash-lite` by default) directly from your browser.
  * *Large clips (> 12 MB)* temporarily upload via the Gemini Files API and are deleted immediately after transcription (if interrupted, Google auto-expires uploads after 48 hours and Tapeleaf retries cleanup on your next session).
  * *Origin isolation tip:* Because `localStorage` and IndexedDB are scoped per browser origin, prefer hosting Tapeleaf on its **own dedicated origin** (e.g., Cloudflare Pages / Vercel / custom domain) rather than a shared `<user>.github.io/<repo>/` subpath if you host other sites under the same GitHub Pages account, and apply API key restrictions in Google AI Studio.

## Setup on Android

1. Host Tapeleaf over HTTPS (see **Deploy Free** below) and open it in **Chrome for Android (v132+)**.
2. Tap Chrome’s menu → **Add to Home Screen** (installs as a standalone app).
3. Open **Settings** (gear icon):
   * Paste your **Gemini API Key** from [Google AI Studio](https://aistudio.google.com/apikey) and optionally check **Remember key on this device**.
   * Tap **Connect vault folder** and choose a subfolder (e.g. `Tapeleaf`) inside your Obsidian vault located in **Device storage** *(Android blocks top-level Downloads/Documents and Obsidian’s private App storage)*.
4. In Obsidian → **Settings → Sync**, make sure **Audio** is toggled on so voice attachments sync with your notes *(Sync Standard caps single files at 5 MB; Sync Plus at 200 MB)*.

## Local Development

Requires **Node.js 24+** (matching CI).

```bash
npm install
npm run dev
# Open http://127.0.0.1:5173
```

Run checks & tests:

```bash
npm run typecheck
npm test
npm run build
```

## Deploy Free (Static Hosting, Automatic HTTPS)

Because Tapeleaf is a 100% static Vite build (`dist/`), you can host it anywhere for free with zero backend maintenance:

* **Cloudflare Pages / Vercel / Netlify (Recommended — dedicated origin):** Connect the `kcverde/tapeleaf` repo with build command `npm run build` and output directory `dist`.
* **GitHub Pages (subpath `/tapeleaf/`):** Build with `VITE_BASE_PATH=/tapeleaf/ npm run build` and publish `dist/` (both `manifest.webmanifest` and `sw.js` automatically adapt to `VITE_BASE_PATH`; note that `<user>.github.io` shares browser storage across all repos published on that host).
