import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import YAML, { Scalar } from 'yaml';
import {
  atomicWriteFile,
  deleteAudioFile,
  ensureStorageDirs,
  getNotesDir,
  resolveSafeNotePath,
} from './storage';
import type { Recording, RecordingStatus } from '../src/types';
import {
  formatDuration,
  normalizeTag,
  slugifyTitle,
} from '../src/markdown';

export interface StoredNoteEntry {
  recording: Recording;
  filename: string;
}

interface FrontmatterData {
  id?: string;
  title?: string;
  created?: string;
  duration?: string | number;
  language?: string;
  language_name?: string;
  status?: string;
  summary?: string;
  tags?: unknown;
  audio?: string;
  error?: string;
}

const VALID_ID_RE = /^[a-zA-Z0-9_-]{6,64}$/;

export function isValidRecordingId(id: string): boolean {
  return VALID_ID_RE.test(id);
}

export function generateRecordingId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const suffix = crypto.randomBytes(2).toString('hex');
  return `rec_${date}_${time}_${suffix}`;
}

export function parseDurationToSeconds(raw: string | number | undefined): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.round(raw));
  }
  if (typeof raw !== 'string') return 0;
  const parts = raw
    .trim()
    .split(':')
    .map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] ?? 0;
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of tags) {
    if (typeof item !== 'string') continue;
    const clean = normalizeTag(item);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function doubleQuoted(value: string): Scalar<string> {
  const s = new Scalar(value);
  s.type = Scalar.QUOTE_DOUBLE;
  return s;
}

export function serializeObsidianNote(recording: Recording): string {
  const frontmatter: Record<string, unknown> = {
    id: recording.id,
    title: doubleQuoted(recording.title),
    created: recording.created,
    duration: doubleQuoted(formatDuration(recording.durationSeconds)),
    language: recording.language,
    language_name: recording.languageName,
    status: recording.status,
    summary: doubleQuoted(recording.summary),
    tags: recording.tags,
    audio: recording.audioPath,
  };

  if (recording.status === 'failed' && recording.errorMessage) {
    frontmatter.error = doubleQuoted(recording.errorMessage);
  }

  const yamlBlock = YAML.stringify(frontmatter, {
    lineWidth: 0,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  }).trimEnd();

  const sections: string[] = [
    '---',
    yamlBlock,
    '---',
    '',
    `# ${recording.title}`,
    '',
  ];

  if (recording.summary.trim()) {
    sections.push(`> ${recording.summary.trim().replace(/\r?\n+/g, ' ')}`, '');
  }

  sections.push(`![[${recording.audioPath}]]`, '');
  sections.push('## Transcript', '');
  sections.push(recording.englishTranscript.trim() || '_Transcript pending…_');

  if (!recording.isEnglish && recording.originalTranscript?.trim()) {
    sections.push('', `## Original (${recording.languageName})`, '');
    sections.push(recording.originalTranscript.trim());
  }

  return `${sections.join('\n')}\n`;
}

function parseSections(body: string): {
  englishTranscript: string;
  originalTranscript?: string;
} {
  const normalized = body.replace(/\r\n/g, '\n');
  const transcriptMatch = /^## Transcript\s*$/m.exec(normalized);
  if (!transcriptMatch || transcriptMatch.index === undefined) {
    return { englishTranscript: '' };
  }

  const afterTranscript = normalized.slice(transcriptMatch.index + transcriptMatch[0].length);
  const originalMatch = /^## Original(?:\s*\([^)]+\))?\s*$/m.exec(afterTranscript);

  const cleanText = (text: string) => {
    const trimmed = text.trim();
    return trimmed === '_Transcript pending…_' ? '' : trimmed;
  };

  if (!originalMatch || originalMatch.index === undefined) {
    return {
      englishTranscript: cleanText(afterTranscript),
    };
  }

  const englishPart = cleanText(afterTranscript.slice(0, originalMatch.index));
  const originalPart = cleanText(
    afterTranscript.slice(originalMatch.index + originalMatch[0].length),
  );

  return {
    englishTranscript: englishPart,
    originalTranscript: originalPart || undefined,
  };
}

export function parseObsidianNote(raw: string, filename: string): Recording | null {
  const normalized = raw.replace(/\r\n/g, '\n');
  const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!fmMatch) return null;

  let fm: FrontmatterData;
  try {
    const parsed = YAML.parse(fmMatch[1]);
    if (!parsed || typeof parsed !== 'object') return null;
    fm = parsed as FrontmatterData;
  } catch {
    return null;
  }

  const id = typeof fm.id === 'string' && isValidRecordingId(fm.id)
    ? fm.id
    : path.basename(filename, '.md').replace(/[^a-zA-Z0-9_-]/g, '_');

  const language = typeof fm.language === 'string' && fm.language.trim()
    ? fm.language.trim().toLowerCase()
    : 'en';
  const languageName = typeof fm.language_name === 'string' && fm.language_name.trim()
    ? fm.language_name.trim()
    : language === 'en'
      ? 'English'
      : language.toUpperCase();

  const statusRaw = typeof fm.status === 'string' ? fm.status.trim().toLowerCase() : 'ready';
  const status: RecordingStatus =
    statusRaw === 'processing' || statusRaw === 'failed' || statusRaw === 'ready'
      ? statusRaw
      : 'ready';

  const { englishTranscript, originalTranscript } = parseSections(fmMatch[2]);
  const audioPath = typeof fm.audio === 'string' ? fm.audio.trim() : '';

  return {
    id,
    filename,
    title: typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : 'Untitled voice note',
    created: typeof fm.created === 'string' && fm.created.trim()
      ? fm.created.trim()
      : new Date().toISOString(),
    durationSeconds: parseDurationToSeconds(fm.duration),
    language,
    languageName,
    isEnglish: language === 'en',
    status,
    summary: typeof fm.summary === 'string' ? fm.summary.trim() : '',
    tags: normalizeTags(fm.tags),
    audioPath,
    audioUrl: `/api/recordings/${encodeURIComponent(id)}/audio`,
    englishTranscript,
    originalTranscript,
    errorMessage: typeof fm.error === 'string' && fm.error.trim() ? fm.error.trim() : undefined,
  };
}

class NoteStore {
  private entries = new Map<string, StoredNoteEntry>();
  private initialized = false;

  async init(): Promise<void> {
    await ensureStorageDirs();
    const notesDir = getNotesDir();
    const files = await fsp.readdir(notesDir);
    const nextMap = new Map<string, StoredNoteEntry>();

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const absPath = resolveSafeNotePath(file);
      if (!absPath) continue;

      try {
        const raw = await fsp.readFile(absPath, 'utf8');
        const parsed = parseObsidianNote(raw, file);
        if (!parsed) continue;

        // Startup recovery: reset interrupted processing notes to failed (retryable)
        if (parsed.status === 'processing') {
          parsed.status = 'failed';
          parsed.errorMessage =
            'Processing was interrupted when the server restarted. Tap Reprocess to retry.';
          await atomicWriteFile(absPath, serializeObsidianNote(parsed));
        }

        nextMap.set(parsed.id, { recording: parsed, filename: file });
      } catch (err) {
        console.warn(`Skipping unreadable note ${file}:`, err);
      }
    }

    this.entries = nextMap;
    this.initialized = true;
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  private isFilenameTaken(filename: string, excludeId?: string): boolean {
    for (const [id, entry] of this.entries) {
      if (id !== excludeId && entry.filename === filename) {
        return true;
      }
    }
    return false;
  }

  private async pickAvailableFilename(
    recording: Recording,
    currentFilename?: string,
  ): Promise<string> {
    const datePart = recording.created.slice(0, 10) || new Date().toISOString().slice(0, 10);
    const baseSlug = slugifyTitle(recording.title);
    const desired = `${datePart}-${baseSlug}.md`;
    if (desired === currentFilename) return desired;

    for (let attempt = 1; attempt <= 999; attempt += 1) {
      const candidate =
        attempt === 1 ? desired : `${datePart}-${baseSlug}-${attempt}.md`;
      if (candidate === currentFilename) return candidate;
      if (this.isFilenameTaken(candidate, recording.id)) continue;

      const abs = resolveSafeNotePath(candidate);
      if (!abs) continue;
      try {
        await fsp.access(abs);
        // Exists on disk (possibly external file in vault), pick next suffix
      } catch {
        return candidate;
      }
    }

    return `${datePart}-${baseSlug}-${recording.id.slice(-4)}.md`;
  }

  async list(filters?: { q?: string; tag?: string }): Promise<{
    recordings: Recording[];
    tags: string[];
  }> {
    await this.ensureInit();
    const all = [...this.entries.values()]
      .map((e) => e.recording)
      .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));

    const tagCounts = new Map<string, number>();
    for (const rec of all) {
      for (const tag of rec.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const tags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);

    const q = filters?.q?.trim().toLowerCase() ?? '';
    const tagFilter = filters?.tag?.trim().toLowerCase() ?? '';

    const filtered = all.filter((rec) => {
      if (tagFilter && !rec.tags.includes(tagFilter)) return false;
      if (!q) return true;
      const haystack = [
        rec.title,
        rec.summary,
        rec.englishTranscript,
        rec.originalTranscript ?? '',
        rec.languageName,
        rec.tags.map((t) => `#${t}`).join(' '),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });

    return { recordings: filtered, tags };
  }

  async getTopTags(limit = 15): Promise<string[]> {
    const { tags } = await this.list();
    return tags.slice(0, limit);
  }

  async getEntry(id: string): Promise<StoredNoteEntry | null> {
    await this.ensureInit();
    return this.entries.get(id) ?? null;
  }

  async has(id: string): Promise<boolean> {
    await this.ensureInit();
    return this.entries.has(id);
  }

  async createStub(params: {
    id: string;
    audioPath: string;
    durationSeconds: number;
    mimeType?: string;
  }): Promise<StoredNoteEntry> {
    await this.ensureInit();
    const recording: Recording = {
      id: params.id,
      title: 'Voice note',
      created: new Date().toISOString(),
      durationSeconds: Math.max(0, Math.round(params.durationSeconds)),
      language: 'en',
      languageName: 'English',
      isEnglish: true,
      status: 'processing',
      summary: '',
      tags: [],
      audioPath: params.audioPath,
      audioUrl: `/api/recordings/${encodeURIComponent(params.id)}/audio`,
      audioMimeType: params.mimeType,
      englishTranscript: '',
    };

    const filename = await this.pickAvailableFilename(recording);
    recording.filename = filename;
    const absPath = resolveSafeNotePath(filename);
    if (!absPath) throw new Error('Invalid note filename');

    await atomicWriteFile(absPath, serializeObsidianNote(recording));
    const entry: StoredNoteEntry = { recording, filename };
    this.entries.set(recording.id, entry);
    return entry;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Recording,
        | 'title'
        | 'summary'
        | 'tags'
        | 'language'
        | 'languageName'
        | 'isEnglish'
        | 'status'
        | 'englishTranscript'
        | 'originalTranscript'
        | 'errorMessage'
        | 'durationSeconds'
      >
    >,
  ): Promise<StoredNoteEntry | null> {
    await this.ensureInit();
    const existing = this.entries.get(id);
    if (!existing) return null;

    const updated: Recording = {
      ...existing.recording,
      ...patch,
      title:
        patch.title !== undefined
          ? patch.title.trim() || existing.recording.title
          : existing.recording.title,
      tags: patch.tags !== undefined ? normalizeTags(patch.tags) : existing.recording.tags,
      audioUrl: `/api/recordings/${encodeURIComponent(id)}/audio`,
    };

    if (updated.status !== 'failed') {
      updated.errorMessage = undefined;
    }

    const oldFilename = existing.filename;
    const newFilename = await this.pickAvailableFilename(updated, oldFilename);
    updated.filename = newFilename;
    const newAbsPath = resolveSafeNotePath(newFilename);
    const oldAbsPath = resolveSafeNotePath(oldFilename);
    if (!newAbsPath) throw new Error('Invalid target note filename');

    await atomicWriteFile(newAbsPath, serializeObsidianNote(updated));

    if (oldFilename !== newFilename && oldAbsPath) {
      await fsp.unlink(oldAbsPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    }

    const entry: StoredNoteEntry = { recording: updated, filename: newFilename };
    this.entries.set(id, entry);
    return entry;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInit();
    const existing = this.entries.get(id);
    if (!existing) return false;

    this.entries.delete(id);

    const noteAbsPath = resolveSafeNotePath(existing.filename);
    if (noteAbsPath) {
      await fsp.unlink(noteAbsPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    }
    if (existing.recording.audioPath) {
      await deleteAudioFile(existing.recording.audioPath);
    }

    return true;
  }

  async getMarkdown(id: string): Promise<{ filename: string; markdown: string } | null> {
    const entry = await this.getEntry(id);
    if (!entry) return null;
    return {
      filename: entry.filename,
      markdown: serializeObsidianNote(entry.recording),
    };
  }
}

export const noteStore = new NoteStore();
