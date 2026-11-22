import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function normalizeBase(raw: string | undefined): string {
  const trimmed = raw?.trim() || '/';
  const withLead = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLead.endsWith('/') ? withLead : `${withLead}/`;
}

/**
 * Emits manifest.webmanifest and a release-atomic sw.js hashed from ALL final
 * shipped files (index.html, JS/CSS bundles, manifest, and public icons).
 * Namespaces cache lookup and cleanup by deployment scope, keeps the previous
 * release cache alive for tabs deferring reload, revalidates mutable URLs on
 * install, and never intercepts cross-origin calls (e.g. Gemini API).
 */
function tapeleafPwaPlugin(base: string): Plugin {
  let outDir = 'dist';

  return {
    name: 'tapeleaf-pwa',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const manifestObj = {
        name: 'Tapeleaf',
        short_name: 'Tapeleaf',
        description:
          'Calm offline-first voice recorder that writes Obsidian-ready Markdown notes and audio straight to your vault.',
        start_url: base,
        scope: base,
        display: 'standalone',
        background_color: '#FAF9F7',
        theme_color: '#1C1917',
        icons: [
          {
            src: `${base}icons/icon-192.png`,
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: `${base}icons/icon-512.png`,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: `${base}icons/icon.svg`,
            sizes: 'any',
            type: 'image/svg+xml',
          },
        ],
      };

      const manifestSource = `${JSON.stringify(manifestObj, null, 2)}\n`;
      fs.writeFileSync(path.join(outDir, 'manifest.webmanifest'), manifestSource, 'utf8');

      // Walk final outDir to collect every shipped asset and hash exact final bytes
      const files: string[] = [];
      const walk = (dir: string, rel = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          const relPath = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(abs, relPath);
          } else if (entry.isFile()) {
            if (relPath === 'sw.js' || relPath.endsWith('.map')) continue;
            files.push(relPath);
          }
        }
      };
      walk(outDir);
      files.sort();

      const buildHasher = crypto.createHash('sha256');
      buildHasher.update(`base:${base}\n`);
      const precacheUrls = new Set<string>([base]);
      for (const relPath of files) {
        const bytes = fs.readFileSync(path.join(outDir, relPath));
        buildHasher.update(relPath);
        buildHasher.update('\0');
        buildHasher.update(bytes);
        precacheUrls.add(`${base}${relPath}`);
      }

      const scopeHash = crypto.createHash('sha256').update(base).digest('hex').slice(0, 8);
      const buildHash = buildHasher.digest('hex').slice(0, 12);
      const scopePrefix = `tapeleaf-${scopeHash}-`;
      const cacheName = `${scopePrefix}${buildHash}`;
      const precacheList = [...precacheUrls];

      const swSource = `const SCOPE_PREFIX = ${JSON.stringify(scopePrefix)};
const CACHE_NAME = ${JSON.stringify(cacheName)};
const PRECACHE_URLS = ${JSON.stringify(precacheList, null, 2)};
const INDEX_URL = ${JSON.stringify(`${base}index.html`)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' }))
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      // Namespace cleanup strictly to this deployment scope; keep the previous
      // release cache alive so tabs deferring reload while recording stay intact.
      const scopedOther = keys.filter(
        (key) => key.startsWith(SCOPE_PREFIX) && key !== CACHE_NAME
      );
      const toDelete = scopedOther.slice(0, Math.max(0, scopedOther.length - 1));
      return Promise.all(toDelete.map((key) => caches.delete(key)));
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(INDEX_URL).then((cached) => cached || fetch(req))
      )
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(req).then((cached) => {
        if (cached) return cached;
        // Fallback to any retained scoped cache for tabs deferring reload
        return caches.keys().then((keys) => {
          const scoped = keys.filter(
            (k) => k.startsWith(SCOPE_PREFIX) && k !== CACHE_NAME
          );
          return scoped
            .reduce(
              (chain, key) =>
                chain.then((found) =>
                  found ? found : caches.open(key).then((c) => c.match(req))
                ),
              Promise.resolve(undefined)
            )
            .then((fallback) => fallback || fetch(req));
        });
      })
    )
  );
});
`;

      fs.writeFileSync(path.join(outDir, 'sw.js'), swSource, 'utf8');
    },
  };
}

export default defineConfig(() => {
  const base = normalizeBase(process.env.VITE_BASE_PATH);
  return {
    base,
    plugins: [react(), tailwindcss(), tapeleafPwaPlugin(base)],
    server: {
      port: 5173,
      host: '127.0.0.1',
    },
  };
});
