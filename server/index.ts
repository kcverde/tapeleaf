import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { analyzeAudioFile, formatGeminiError, getGeminiModel, hasGeminiApiKey } from './gemini';
import {
  generateRecordingId,
  isValidRecordingId,
  noteStore,
} from './notes';
import {
  deleteAudioFile,
  mimeForExtension,
  resolveExistingAudioFile,
  saveAudioFile,
  streamAudioResponse,
} from './storage';

// Load local .env if present (Node 24 built-in)
try {
  if (fs.existsSync(path.resolve(process.cwd(), '.env'))) {
    process.loadEnvFile(path.resolve(process.cwd(), '.env'));
  }
} catch {
  // ignore missing or unreadable .env
}

const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100 MB raw audio cap
const MAX_UPLOAD_BODY_BYTES = MAX_AUDIO_BYTES + 2 * 1024 * 1024; // +2 MB multipart overhead
const SESSION_COOKIE_NAME = 'tapeleaf_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_LOGIN_ATTEMPTS = 10;
const MAX_TRACKED_CLIENTS = 1000;
const VALID_CLIENT_UPLOAD_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

const activeJobs = new Set<string>();
const failedLogins = new Map<string, { count: number; resetAt: number }>();

type AppBindings = {
  incoming?: IncomingMessage;
};

function getPasscode(): string {
  return process.env.APP_PASSCODE?.trim() || '';
}

function isPasscodeEnabled(): boolean {
  return getPasscode().length > 0;
}

function isTrustProxyEnabled(): boolean {
  const raw = process.env.TRUST_PROXY?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function getSigningKey(): Buffer {
  const material = process.env.SESSION_SECRET?.trim() || getPasscode();
  return crypto
    .createHmac('sha256', 'tapeleaf-session-key-v1')
    .update(material)
    .digest();
}

function signSessionToken(issuedAtMs = Date.now()): string {
  const payload = String(issuedAtMs);
  const sig = crypto
    .createHmac('sha256', getSigningKey())
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const issuedAt = Number.parseInt(payload, 10);
  if (!Number.isFinite(issuedAt)) return false;
  const age = Date.now() - issuedAt;
  if (age < -60_000 || age > SESSION_TTL_MS) return false;

  const expected = crypto
    .createHmac('sha256', getSigningKey())
    .update(payload)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

function verifyPasscode(candidate: string): boolean {
  const configured = getPasscode();
  if (!configured) return true;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}

function isRequestAuthenticated(c: Context<{ Bindings: AppBindings }>): boolean {
  if (!isPasscodeEnabled()) return true;
  const cookie = getCookie(c, SESSION_COOKIE_NAME);
  return verifySessionToken(cookie);
}

function isSecureRequest(c: Context<{ Bindings: AppBindings }>): boolean {
  if (c.req.url.startsWith('https://')) return true;
  if (isTrustProxyEnabled()) {
    const proto = c.req.header('x-forwarded-proto');
    if (proto) return proto.split(',')[0]?.trim().toLowerCase() === 'https';
  }
  return false;
}

function getClientKey(c: Context<{ Bindings: AppBindings }>): string {
  if (isTrustProxyEnabled()) {
    const realIp = c.req.header('x-real-ip')?.trim();
    if (realIp) return realIp;
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      const parts = forwarded
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      // Rightmost hop added by trusted proxy cannot be spoofed by client
      if (parts.length > 0) return parts[parts.length - 1];
    }
  }
  return c.env?.incoming?.socket?.remoteAddress || 'local';
}

function pruneLoginLimiter(now: number): void {
  for (const [key, val] of failedLogins) {
    if (now > val.resetAt) failedLogins.delete(key);
  }
  while (failedLogins.size >= MAX_TRACKED_CLIENTS) {
    const oldestKey = failedLogins.keys().next().value;
    if (!oldestKey) break;
    failedLogins.delete(oldestKey);
  }
}

function isRateLimited(clientKey: string): boolean {
  const entry = failedLogins.get(clientKey);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    failedLogins.delete(clientKey);
    return false;
  }
  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedLogin(clientKey: string): void {
  const now = Date.now();
  const entry = failedLogins.get(clientKey);
  if (!entry || now > entry.resetAt) {
    pruneLoginLimiter(now);
    failedLogins.set(clientKey, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

async function runReservedJob(id: string, mimeTypeHint?: string): Promise<void> {
  try {
    const entry = await noteStore.getEntry(id);
    if (!entry) return;

    const audio = await resolveExistingAudioFile(entry.recording.audioPath, id);
    if (!audio) {
      await noteStore.markFailed(id, 'Audio file could not be found on disk.');
      return;
    }

    const existingTags = await noteStore.getTopTags(15);
    const mimeType = mimeTypeHint || mimeForExtension(audio.absPath);

    const analysis = await analyzeAudioFile({
      absPath: audio.absPath,
      mimeType,
      durationSeconds: entry.recording.durationSeconds,
      existingTags,
    });

    await noteStore.applyAnalysis(id, {
      title: analysis.title,
      summary: analysis.summary,
      tags: analysis.tags,
      language: analysis.languageCode,
      languageName: analysis.detectedLanguage,
      isEnglish: analysis.isEnglish,
      englishTranscript: analysis.englishTranslation,
      originalTranscript: analysis.isEnglish ? undefined : analysis.originalTranscript,
    });
  } catch (err) {
    console.error(`Failed processing recording ${id}:`, err);
    await noteStore.markFailed(id, formatGeminiError(err));
  } finally {
    activeJobs.delete(id);
  }
}

function startBackgroundJob(id: string, mimeTypeHint?: string): boolean {
  if (activeJobs.has(id)) return false;
  activeJobs.add(id);
  void runReservedJob(id, mimeTypeHint);
  return true;
}

const app = new Hono<{ Bindings: AppBindings }>();

// Public health & auth routes
app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'tapeleaf',
    hasGeminiKey: hasGeminiApiKey(),
    model: getGeminiModel(),
    passcodeEnabled: isPasscodeEnabled(),
  }),
);

app.get('/api/auth/status', (c) =>
  c.json({
    passcodeEnabled: isPasscodeEnabled(),
    authenticated: isRequestAuthenticated(c),
  }),
);

app.post('/api/auth/login', async (c) => {
  if (!isPasscodeEnabled()) {
    return c.json({ ok: true, authenticated: true });
  }

  const clientKey = getClientKey(c);
  if (isRateLimited(clientKey)) {
    return c.json({ error: 'Too many attempts. Wait a few minutes and try again.' }, 429);
  }

  const body = await c.req.json<{ passcode?: unknown }>().catch(() => null);
  const candidate = typeof body?.passcode === 'string' ? body.passcode : '';

  if (!verifyPasscode(candidate)) {
    recordFailedLogin(clientKey);
    return c.json({ error: 'Incorrect passcode.' }, 401);
  }

  failedLogins.delete(clientKey);
  setCookie(c, SESSION_COOKIE_NAME, signSessionToken(), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(c),
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  return c.json({ ok: true, authenticated: true });
});

app.post('/api/auth/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  return c.json({ ok: true });
});

// Protect all remaining /api/* routes (including audio & .md downloads) when APP_PASSCODE is set
app.use('/api/*', async (c, next) => {
  const reqPath = c.req.path;
  if (reqPath === '/api/health' || reqPath.startsWith('/api/auth/')) {
    await next();
    return;
  }
  if (!isRequestAuthenticated(c)) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  await next();
});

app.get('/api/recordings', async (c) => {
  const q = c.req.query('q') ?? undefined;
  const tag = c.req.query('tag') ?? undefined;
  const result = await noteStore.list({ q, tag });
  return c.json(result);
});

app.get('/api/recordings/:id', async (c) => {
  const id = c.req.param('id');
  if (!isValidRecordingId(id)) {
    return c.json({ error: 'Invalid recording ID' }, 400);
  }
  const entry = await noteStore.getEntry(id);
  if (!entry) {
    return c.json({ error: 'Recording not found' }, 404);
  }
  const md = await noteStore.getMarkdown(id);
  return c.json({
    recording: entry.recording,
    filename: entry.filename,
    markdown: md?.markdown ?? '',
  });
});

app.post('/api/recordings', async (c) => {
  // Reject oversized requests before buffering multipart form data
  const contentLengthHeader = c.req.header('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BODY_BYTES) {
      return c.json({ error: 'Upload exceeds 100 MB limit' }, 413);
    }
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) {
    return c.json({ error: 'Expected multipart/form-data upload' }, 400);
  }

  const clientUploadField = form.get('clientUploadId');
  const clientUploadId =
    typeof clientUploadField === 'string' &&
    VALID_CLIENT_UPLOAD_ID_RE.test(clientUploadField.trim())
      ? clientUploadField.trim()
      : undefined;

  // Idempotent retry check before writing a new audio file
  if (clientUploadId) {
    const existing = await noteStore.findByClientUploadId(clientUploadId);
    if (existing) {
      return c.json(
        {
          recording: existing.recording,
          filename: existing.filename,
          deduplicated: true,
        },
        200,
      );
    }
  }

  const audioField = form.get('audio');
  if (!(audioField instanceof File)) {
    return c.json({ error: 'Missing audio file field' }, 400);
  }
  if (audioField.size === 0) {
    return c.json({ error: 'Audio file is empty' }, 400);
  }
  if (audioField.size > MAX_AUDIO_BYTES) {
    return c.json({ error: 'Audio file exceeds 100 MB limit' }, 413);
  }

  const durationField = form.get('durationSeconds');
  const durationSeconds =
    typeof durationField === 'string' && Number.isFinite(Number(durationField))
      ? Math.max(0, Math.round(Number(durationField)))
      : 0;

  const mimeField = form.get('mimeType');
  const mimeType =
    (typeof mimeField === 'string' && mimeField.trim()) ||
    audioField.type ||
    'audio/webm';

  const id = generateRecordingId();
  const arrayBuffer = await audioField.arrayBuffer();
  const savedAudio = await saveAudioFile(
    id,
    new Uint8Array(arrayBuffer),
    mimeType,
    audioField.name,
  );

  // Save first: persist playable audio + initial Markdown stub; clean up audio if stub fails
  try {
    const { entry, deduplicated } = await noteStore.createStub({
      id,
      audioPath: savedAudio.audioPath,
      durationSeconds,
      mimeType: savedAudio.mimeType,
      clientUploadId,
    });

    if (deduplicated) {
      await deleteAudioFile(savedAudio.audioPath, id).catch(() => {});
      return c.json(
        {
          recording: entry.recording,
          filename: entry.filename,
          deduplicated: true,
        },
        200,
      );
    }

    // Process second: reserve and run Gemini asynchronously
    startBackgroundJob(entry.recording.id, savedAudio.mimeType);

    return c.json(
      {
        recording: entry.recording,
        filename: entry.filename,
      },
      201,
    );
  } catch (err) {
    await deleteAudioFile(savedAudio.audioPath, id).catch(() => {});
    console.error(`Failed creating note stub for ${id}:`, err);
    return c.json({ error: 'Could not save note to disk. Please retry.' }, 500);
  }
});

app.patch('/api/recordings/:id', async (c) => {
  const id = c.req.param('id');
  if (!isValidRecordingId(id)) {
    return c.json({ error: 'Invalid recording ID' }, 400);
  }

  const body = await c.req.json<{ title?: unknown; tags?: unknown }>().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const patch: { title?: string; tags?: string[] } = {};
  if (typeof body.title === 'string') {
    const trimmed = body.title.trim();
    if (!trimmed) {
      return c.json({ error: 'Title cannot be empty' }, 400);
    }
    patch.title = trimmed.slice(0, 140);
  }
  if (Array.isArray(body.tags)) {
    patch.tags = body.tags.filter((t): t is string => typeof t === 'string');
  }

  const updated = await noteStore.updateUserEdits(id, patch);
  if (!updated) {
    return c.json({ error: 'Recording not found' }, 404);
  }

  const md = await noteStore.getMarkdown(id);
  return c.json({
    recording: updated.recording,
    filename: updated.filename,
    markdown: md?.markdown ?? '',
  });
});

app.post('/api/recordings/:id/reprocess', async (c) => {
  const id = c.req.param('id');
  if (!isValidRecordingId(id)) {
    return c.json({ error: 'Invalid recording ID' }, 400);
  }

  const entry = await noteStore.getEntry(id);
  if (!entry) {
    return c.json({ error: 'Recording not found' }, 404);
  }

  // Reserve job BEFORE flipping note status to processing
  if (activeJobs.has(id)) {
    return c.json({ recording: entry.recording, alreadyProcessing: true }, 202);
  }
  activeJobs.add(id);

  try {
    const updated = await noteStore.markProcessing(id);
    if (!updated) {
      activeJobs.delete(id);
      return c.json({ error: 'Recording not found' }, 404);
    }

    void runReservedJob(id, entry.recording.audioMimeType);
    return c.json({ recording: updated.recording });
  } catch (err) {
    activeJobs.delete(id);
    console.error(`Failed starting reprocess for ${id}:`, err);
    return c.json({ error: 'Could not start reprocessing.' }, 500);
  }
});

app.delete('/api/recordings/:id', async (c) => {
  const id = c.req.param('id');
  if (!isValidRecordingId(id)) {
    return c.json({ error: 'Invalid recording ID' }, 400);
  }
  const deleted = await noteStore.delete(id);
  if (!deleted) {
    return c.json({ error: 'Recording not found' }, 404);
  }
  return c.json({ ok: true });
});

async function handleAudioRequest(c: Context<{ Bindings: AppBindings }>) {
  const id = c.req.param('id') ?? '';
  if (!isValidRecordingId(id)) {
    return c.json({ error: 'Invalid recording ID' }, 400);
  }
  const entry = await noteStore.getEntry(id);
  if (!entry || !entry.recording.audioPath) {
    return c.json({ error: 'Recording audio not found' }, 404);
  }

  const wantsDownload = c.req.query('download') === '1';
  const ext = path.extname(entry.recording.audioPath) || '.webm';
  const baseName = entry.filename.replace(/\.md$/, '');
  return streamAudioResponse(
    c,
    entry.recording.audioPath,
    entry.recording.id,
    wantsDownload ? `${baseName}${ext}` : undefined,
  );
}

app.get('/api/recordings/:id/audio', handleAudioRequest);
app.on('HEAD', '/api/recordings/:id/audio', handleAudioRequest);

app.get('/api/recordings/:id/markdown', async (c) => {
  const id = c.req.param('id');
  if (!isValidRecordingId(id)) {
    return c.json({ error: 'Invalid recording ID' }, 400);
  }
  const note = await noteStore.getMarkdown(id);
  if (!note) {
    return c.json({ error: 'Recording not found' }, 404);
  }

  const safeFilename = note.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return new Response(note.markdown, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeFilename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
});

// Serve built frontend when dist/ exists
const distDir = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(distDir)) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not found' }, 404);
    }
    const html = await fs.promises.readFile(path.join(distDir, 'index.html'), 'utf8');
    return c.html(html);
  });
}

export { app };

export async function startServer() {
  await noteStore.init();
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '127.0.0.1';
  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(
      `Tapeleaf listening on http://${info.address}:${info.port} (Gemini: ${hasGeminiApiKey() ? getGeminiModel() : 'demo fallback'}, Passcode: ${isPasscodeEnabled() ? 'enabled' : 'off'})`,
    );
  });
}

const isDirectEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectEntry) {
  void startServer();
}
