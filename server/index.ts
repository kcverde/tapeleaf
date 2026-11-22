import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { analyzeAudioFile, getGeminiModel, hasGeminiApiKey } from './gemini';
import {
  generateRecordingId,
  isValidRecordingId,
  noteStore,
  serializeObsidianNote,
} from './notes';
import {
  mimeForExtension,
  resolveSafeNotePath,
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

const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100 MB safety cap
const activeJobs = new Set<string>();

async function processRecordingInBackground(id: string, mimeTypeHint?: string): Promise<void> {
  if (activeJobs.has(id)) return;
  activeJobs.add(id);

  try {
    const entry = await noteStore.getEntry(id);
    if (!entry) return;

    const absPath = resolveSafeNotePath(entry.recording.audioPath);
    if (!absPath) {
      await noteStore.update(id, {
        status: 'failed',
        errorMessage: 'Audio file path is invalid.',
      });
      return;
    }

    const existingTags = await noteStore.getTopTags(15);
    const mimeType = mimeTypeHint || mimeForExtension(absPath);

    const analysis = await analyzeAudioFile({
      absPath,
      mimeType,
      durationSeconds: entry.recording.durationSeconds,
      existingTags,
    });

    // Guard against note deletion while Gemini was running
    if (!(await noteStore.has(id))) return;

    await noteStore.update(id, {
      status: 'ready',
      title: analysis.title,
      summary: analysis.summary,
      tags: analysis.tags,
      language: analysis.languageCode,
      languageName: analysis.detectedLanguage,
      isEnglish: analysis.isEnglish,
      englishTranscript: analysis.englishTranslation,
      originalTranscript: analysis.isEnglish ? undefined : analysis.originalTranscript,
      errorMessage: undefined,
    });
  } catch (err) {
    console.error(`Failed processing recording ${id}:`, err);
    if (await noteStore.has(id)) {
      const message =
        err instanceof Error ? err.message : 'Transcription failed. Tap Reprocess to try again.';
      await noteStore.update(id, {
        status: 'failed',
        errorMessage: message.slice(0, 260),
      });
    }
  } finally {
    activeJobs.delete(id);
  }
}

const app = new Hono();

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'tapeleaf',
    hasGeminiKey: hasGeminiApiKey(),
    model: getGeminiModel(),
  }),
);

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
  return c.json({
    recording: entry.recording,
    filename: entry.filename,
    markdown: serializeObsidianNote(entry.recording),
  });
});

app.post('/api/recordings', async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) {
    return c.json({ error: 'Expected multipart/form-data upload' }, 400);
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

  // Save first: persist playable audio + initial Markdown stub before calling Gemini
  const entry = await noteStore.createStub({
    id,
    audioPath: savedAudio.audioPath,
    durationSeconds,
    mimeType: savedAudio.mimeType,
  });

  // Process second: kick off Gemini transcription/translation asynchronously
  void processRecordingInBackground(id, savedAudio.mimeType);

  return c.json(
    {
      recording: entry.recording,
      filename: entry.filename,
    },
    201,
  );
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

  const updated = await noteStore.update(id, patch);
  if (!updated) {
    return c.json({ error: 'Recording not found' }, 404);
  }

  return c.json({
    recording: updated.recording,
    filename: updated.filename,
    markdown: serializeObsidianNote(updated.recording),
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

  const updated = await noteStore.update(id, {
    status: 'processing',
    errorMessage: undefined,
  });
  if (!updated) {
    return c.json({ error: 'Recording not found' }, 404);
  }

  void processRecordingInBackground(id, entry.recording.audioMimeType);

  return c.json({ recording: updated.recording });
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

app.get('/api/recordings/:id/audio', async (c) => {
  const id = c.req.param('id');
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
    wantsDownload ? `${baseName}${ext}` : undefined,
  );
});

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
      `Tapeleaf listening on http://${info.address}:${info.port} (Gemini: ${hasGeminiApiKey() ? getGeminiModel() : 'demo fallback'})`,
    );
  });
}

const isDirectEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectEntry) {
  void startServer();
}
