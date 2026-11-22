# Tapeleaf

Calm, Markdown-first personal voice recorder built for **Obsidian**. Tap **Record**, tap **Stop**, and your clip is saved to disk first, then language-detected, transcribed, translated to English (when non-English), titled, summarized, tagged, and written out as a clean `.md` note with YAML frontmatter.

## Quick Start (Local)

```bash
npm install
cp .env.example .env
# Add GEMINI_API_KEY to .env (or leave blank to test offline demo mode)
```

**Production-style single process (recommended):**

```bash
npm run build
npm start
# Open http://127.0.0.1:3001
```

**Development (hot-reload UI + API):**

```bash
# Terminal 1
npm run dev:server

# Terminal 2
npm run dev
# Open http://127.0.0.1:5173
```

## Obsidian Integration & Sync

Every recording is stored directly as a standard Obsidian note inside `DATA_DIR/notes/`:

```text
data/notes/
├── 2026-11-22-weekend-trip-ideas-for-lisbon.md
└── audio/
    └── rec_20261122_143502_a1b2.webm
```

* **Use directly as an Obsidian folder:** Point `DATA_DIR` inside your vault (or sync `DATA_DIR/notes/` via Syncthing, Obsidian Sync, or iCloud Drive). Audio embeds use `![[audio/<stable-id>.<ext>]]`, so renaming a note title never breaks playback.
* **One-tap export:** Click **Copy MD** to paste straight into any Obsidian note, or **`.md`** to download the exact file.

## Recording from Your Phone (HTTPS Requirement)

Mobile browsers (`Safari` on iOS and `Chrome` on Android) require a **secure context (HTTPS)** to grant microphone access (`navigator.mediaDevices.getUserMedia`) on any non-`localhost` origin.

* **Private home/Tailscale setup:** Run Tapeleaf locally or on a home box and expose it privately over HTTPS with `tailscale serve 3001`.
* **Public deployment:** Always set `APP_PASSCODE` in your environment and serve over HTTPS (set `TRUST_PROXY=1` when behind a reverse proxy like Caddy, Railway, or Fly.io that strips inbound forwarded headers).

On iOS Safari or Android Chrome, use **Add to Home Screen** to launch Tapeleaf as a clean standalone web app.

## Deployment

Tapeleaf ships as a single-container Node 24 image with zero external database dependencies. Mount a persistent volume at `/data` and set `GEMINI_API_KEY` + `APP_PASSCODE`.

### Docker

```bash
docker build -t tapeleaf .
docker run -d \
  --name tapeleaf \
  -p 127.0.0.1:3000:3000 \
  -v tapeleaf_data:/data \
  -e GEMINI_API_KEY="your-key" \
  -e APP_PASSCODE="choose-a-strong-passcode" \
  -e TRUST_PROXY=1 \
  tapeleaf
```

### Railway / Fly.io

* **Railway:** Connect the repo (uses `Dockerfile`), attach a persistent volume mounted at `/data`, and configure `GEMINI_API_KEY` and `APP_PASSCODE` in Variables. Railway handles HTTPS automatically.
* **Fly.io:** Create a volume (`fly volumes create tapeleaf_data --size 5`), mount it at `/data` in `fly.toml` (`internal_port = 3000`), and set secrets via `fly secrets set GEMINI_API_KEY=... APP_PASSCODE=...`.
* **VPS (Caddy):** Run the Docker container bound to `127.0.0.1:3000` and reverse-proxy your domain through Caddy for automatic Let's Encrypt TLS.

## Backups

Because Tapeleaf stores everything as plain `.md` files and audio blobs inside `DATA_DIR/notes/`, backing up your entire library is just copying that folder (e.g. `rsync`, `restic`, or your cloud sync tool)—no database dumps required.
