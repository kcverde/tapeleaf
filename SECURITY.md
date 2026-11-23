# Security Policy

## Architecture & Trust Model

Tapeleaf is a **100% client-side static web app** with no backend server, no user accounts, and no telemetry:

- **Audio & notes** stay on your device in IndexedDB and (optionally) in the local Obsidian vault folder you explicitly authorize via the File System Access API.
- **Gemini API keys** are held in JS memory for the current session by default. If you opt into **Remember key on this device**, the key is stored in `localStorage` scoped to the browser origin.
  - Because `localStorage` and IndexedDB are scoped per origin, prefer self-hosting on a **dedicated origin** (e.g., Cloudflare Pages, Vercel, Netlify, or a custom domain) over a shared `<user>.github.io` host, and apply API key restrictions in Google AI Studio.
- **Audio transcription** sends audio directly from your browser to `https://generativelanguage.googleapis.com` using your key. Clips larger than 12 MB temporarily upload via the Gemini Files API and are deleted immediately after transcription (with retry cleanup on next session and Google's 48-hour auto-expiry as a backstop).
- **Obsidian Markdown safety:** AI-generated titles, summaries, tags, and transcripts are neutralized before writing `.md` files (stripping raw HTML, Templater tags, DataviewJS fences, wikilinks, and `obsidian://` URIs) so untrusted speech cannot inject executable syntax into your vault.
- **Strict Content Security Policy:** Configured in `index.html` to allow network requests only to `'self'` and `https://generativelanguage.googleapis.com`.

## Reporting a Vulnerability

If you discover a security issue (such as CSP bypass, Markdown/Obsidian injection, API key exposure, or unsafe file deletion outside the authorized folder), please **do not open a public issue**.

Instead, report it privately via GitHub's **Security Advisories** ("Report a vulnerability" under the **Security** tab of `kcverde/tapeleaf`). Please include steps to reproduce, affected browser/OS versions, and any suggested fix.
