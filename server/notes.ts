import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import YAML, { Scalar } from 'yaml';
import {
  atomicWriteFile,
  deleteAudioFile,
  ensureStorageDirs,
  getNotesDir,
  isValidAudioRelPath,
  isValidId,
  resolveExistingRegularFile,
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
  userEditedTitle?: boolean;
  userEditedTags?: boolean;
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

const MAX_UPLOAD_ID_CACHE = 250;

export function isValidRecordingId(id: string): boolean {
  return isValidId(id);
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

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    sections.push(
      '',
      '<!-- tapeleaf:original -->',
      `## Original (${recording.languageName})`,
      '',
    );
    sections.push(recording.originalTranscript.trim());
  }

  return `${sections.join('\n')}\n`;
}

function parseSections(
  body: string,
  isEnglish: boolean,
  languageName: string,
): {
  englishTranscript: string;
  originalTranscript?: string;
} {
  const normalized = body.replace(/\r\n/g, '\n');
  const transcriptMatch = /^## Transcript\s*$/m.exec(normalized);
  if (!transcriptMatch || transcriptMatch.index === undefined) {
    return { englishTranscript: '' };
  }

  const afterTranscript = normalized.slice(transcriptMatch.index + transcriptMatch[0].length);
  const cleanText = (text: string) => {
    const trimmed = text.trim();
    return trimmed === '_Transcript pending…_' ? '' : trimmed;
  };

  // English notes never have an Original section; never split on literal headings inside transcript
  if (isEnglish) {
    return { englishTranscript: cleanText(afterTranscript) };
  }

  // Prefer unambiguous marker written by Tapeleaf
  const markerPattern = /\n<!-- tapeleaf:original -->\n## Original(?:\s*\([^)]+\))?\s*\n/;
  const markerMatch = markerPattern.exec(afterTranscript);
  if (markerMatch && markerMatch.index !== undefined) {
    const englishPart = cleanText(afterTranscript.slice(0, markerMatch.index));
    const originalPart = cleanText(
      afterTranscript.slice(markerMatch.index + markerMatch[0].length),
    );
    return {
      englishTranscript: englishPart,
      originalTranscript: originalPart || undefined,
    };
  }

  // Backward-compatible fallback for notes without the marker: match the exact language heading
  const langHeadingRe = new RegExp(
    `^## Original \\(${escapeRegExp(languageName)}\\)\\s*$`,
    'gm',
  );
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = langHeadingRe.exec(afterTranscript)) !== null) {
    lastMatch = m;
  }

  if (!lastMatch || lastMatch.index === undefined) {
    return { englishTranscript: cleanText(afterTranscript) };
  }

  const englishPart = cleanText(afterTranscript.slice(0, lastMatch.index));
  const originalPart = cleanText(
    afterTranscript.slice(lastMatch.index + lastMatch[0].length),
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

  // Strictly require valid Tapeleaf metadata before indexing or rewriting any note
  if (typeof fm.id !== 'string' || !isValidRecordingId(fm.id.trim())) {
    return null;
  }
  const id = fm.id.trim();

  if (typeof fm.audio !== 'string' || !isValidAudioRelPath(fm.audio.trim(), id)) {
    return null;
  }
  const audioPath = fm.audio.trim();

  const statusRaw = typeof fm.status === 'string' ? fm.status.trim().toLowerCase() : '';
  if (statusRaw !== 'processing' && statusRaw !== 'failed' && statusRaw !== 'ready') {
    return null;
  }
  const status: RecordingStatus = statusRaw;

  const language =
    typeof fm.language === 'string' && fm.language.trim()
      ? fm.language.trim().toLowerCase()
      : 'en';
  const languageName =
    typeof fm.language_name === 'string' && fm.language_name.trim()
      ? fm.language_name.trim()
      : language === 'en'
        ? 'English'
        : language.toUpperCase();
  const isEnglish = language === 'en';

  const { englishTranscript, originalTranscript } = parseSections(
    fmMatch[2],
    isEnglish,
    languageName,
  );

  return {
    id,
    filename,
    title:
      typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : 'Untitled voice note',
    created:
      typeof fm.created === 'string' && fm.created.trim()
        ? fm.created.trim()
        : new Date().toISOString(),
    durationSeconds: parseDurationToSeconds(fm.duration),
    language,
    languageName,
    isEnglish,
    status,
    summary: typeof fm.summary === 'string' ? fm.summary.trim() : '',
    tags: normalizeTags(fm.tags),
    audioPath,
    audioUrl: `/api/recordings/${encodeURIComponent(id)}/audio`,
    englishTranscript,
    originalTranscript,
    errorMessage:
      typeof fm.error === 'string' && fm.error.trim() ? fm.error.trim() : undefined,
  };
}

class NoteStore {
  private entries = new Map<string, StoredNoteEntry>();
  private uploadIdToRecId = new Map<string, string>();
  private initialized = false;
  private writeQueue: Promise<unknown> = Promise.resolve();

  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(fn, fn);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private rememberUploadId(clientUploadId: string | undefined, recId: string): void {
    if (!clientUploadId) return;
    this.uploadIdToRecId.set(clientUploadId, recId);
    if (this.uploadIdToRecId.size > MAX_UPLOAD_ID_CACHE) {
      const oldestKey = this.uploadIdToRecId.keys().next().value;
      if (oldestKey) this.uploadIdToRecId.delete(oldestKey);
    }
  }

  async init(): Promise<void> {
    await this.withWriteLock(async () => {
      await ensureStorageDirs();
      const notesDir = getNotesDir();
      const files = await fsp.readdir(notesDir);
      const nextMap = new Map<string, StoredNoteEntry>();

      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const resolved = await resolveExistingRegularFile(file);
        if (!resolved) continue;

        try {
          const raw = await fsp.readFile(resolved.absPath, 'utf8');
          const parsed = parseObsidianNote(raw, file);
          if (!parsed) continue;

          // Startup recovery: reset interrupted processing notes to failed (retryable)
          if (parsed.status === 'processing') {
            parsed.status = 'failed';
            parsed.errorMessage =
              'Processing was interrupted when the server restarted. Tap Reprocess to retry.';
            await atomicWriteFile(resolved.absPath, serializeObsidianNote(parsed));
          }

          nextMap.set(parsed.id, { recording: parsed, filename: file });
        } catch (err) {
          console.warn(`Skipping unreadable note ${file}:`, err);
        }
      }

      this.entries = nextMap;
      this.initialized = true;
    });
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
      } catch {
        return candidate;
      }
    }

    return `${datePart}-${baseSlug}-${recording.id.slice(-4)}.md`;
  }

  async findByClientUploadId(clientUploadId: string): Promise<StoredNoteEntry | null> {
    await this.ensureInit();
    const recId = this.uploadIdToRecId.get(clientUploadId);
    if (!recId) return null;
    return this.entries.get(recId) ?? null;
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

  async createStub(params: {
    id: string;
    audioPath: string;
    durationSeconds: number;
    mimeType?: string;
    clientUploadId?: string;
  }): Promise<{ entry: StoredNoteEntry; deduplicated: boolean }> {
    await this.ensureInit();
    return this.withWriteLock(async () => {
      if (params.clientUploadId) {
        const existingId = this.uploadIdToRecId.get(params.clientUploadId);
        const existing = existingId ? this.entries.get(existingId) : undefined;
        if (existing) {
          return { entry: existing, deduplicated: true };
        }
      }

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
      this.rememberUploadId(params.clientUploadId, recording.id);
      return { entry, deduplicated: false };
    });
  }

  private async writeUpdatedEntry(
    id: string,
    existing: StoredNoteEntry,
    updated: Recording,
    flags?: { userEditedTitle?: boolean; userEditedTags?: boolean },
  ): Promise<StoredNoteEntry> {
    if (updated.status !== 'failed') {
      updated.errorMessage = undefined;
    }

    const oldFilename = existing.filename;
    const newFilename = await this.pickAvailableFilename(updated, oldFilename);
    updated.filename = newFilename;
    const newAbsPath = resolveSafeNotePath(newFilename);
    if (!newAbsPath) throw new Error('Invalid target note filename');

    await atomicWriteFile(newAbsPath, serializeObsidianNote(updated));

    if (oldFilename !== newFilename) {
      const oldResolved = await resolveExistingRegularFile(oldFilename);
      if (oldResolved) {
        await fsp.unlink(oldResolved.absPath).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        });
      }
    }

    const entry: StoredNoteEntry = {
      recording: updated,
      filename: newFilename,
      userEditedTitle: flags?.userEditedTitle ?? existing.userEditedTitle,
      userEditedTags: flags?.userEditedTags ?? existing.userEditedTags,
    };
    this.entries.set(id, entry);
    return entry;
  }

  async updateUserEdits(
    id: string,
    patch: { title?: string; tags?: string[] },
  ): Promise<StoredNoteEntry | null> {
    await this.ensureInit();
    return this.withWriteLock(async () => {
      const existing = this.entries.get(id);
      if (!existing) return null;

      const updated: Recording = {
        ...existing.recording,
        title:
          patch.title !== undefined
            ? patch.title.trim() || existing.recording.title
            : existing.recording.title,
        tags: patch.tags !== undefined ? normalizeTags(patch.tags) : existing.recording.tags,
        audioUrl: `/api/recordings/${encodeURIComponent(id)}/audio`,
      };

      return this.writeUpdatedEntry(id, existing, updated, {
        userEditedTitle:
          patch.title !== undefined ? true : existing.userEditedTitle,
        userEditedTags:
          patch.tags !== undefined ? true : existing.userEditedTags,
      });
    });
  }

  async markProcessing(id: string): Promise<StoredNoteEntry | null> {
    await this.ensureInit();
    return this.withWriteLock(async () => {
      const existing = this.entries.get(id);
      if (!existing) return null;

      const updated: Recording = {
        ...existing.recording,
        status: 'processing',
        errorMessage: undefined,
        audioUrl: `/api/recordings/${encodeURIComponent(id)}/audio`,
      };

      return this.writeUpdatedEntry(id, existing, updated);
    });
  }

  async applyAnalysis(
    id: string,
    analysis: {
      title: string;
      summary: string;
      tags: string[];
      language: string;
      languageName: string;
      isEnglish: boolean;
      englishTranscript: string;
      originalTranscript?: string;
    },
  ): Promise<StoredNoteEntry | null> {
    await this.ensureInit();
    return this.withWriteLock(async () => {
      const existing = this.entries.get(id);
      if (!existing) return null; // Deleted while Gemini was running; never resurrect

      const updated: Recording = {
        ...existing.recording,
        status: 'ready',
        // Preserve any title or tags the user explicitly edited while processing ran
        title: existing.userEditedTitle
          ? existing.recording.title
          : analysis.title.trim() || existing.recording.title,
        tags: existing.userEditedTags
          ? existing.recording.tags
          : normalizeTags(analysis.tags),
        summary: analysis.summary,
        language: analysis.language,
        languageName: analysis.languageName,
        isEnglish: analysis.isEnglish,
        englishTranscript: analysis.englishTranscript,
        originalTranscript: analysis.isEnglish ? undefined : analysis.originalTranscript,
        errorMessage: undefined,
        audioUrl: `/api/recordings/${encodeURIComponent(id)}/audio`,
      };

      return this.writeUpdatedEntry(id, existing, updated);
    });
  }

  async markFailed(id: string, errorMessage: string): Promise<StoredNoteEntry | null> {
    await this.ensureInit();
    return this.withWriteLock(async () => {
      const existing = this.entries.get(id);
      if (!existing) return null; // Deleted while running; never resurrect

      const updated: Recording = {
        ...existing.recording,
        status: 'failed',
        errorMessage,
        audioUrl: `/api/recordings/${encodeURIComponent(id)}/audio`,
      };

      return this.writeUpdatedEntry(id, existing, updated);
    });
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureInit();
    return this.withWriteLock(async () => {
      const existing = this.entries.get(id);
      if (!existing) return false;

      this.entries.delete(id);

      const noteResolved = await resolveExistingRegularFile(existing.filename);
      if (noteResolved) {
        await fsp.unlink(noteResolved.absPath).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        });
      }
      if (existing.recording.audioPath) {
        await deleteAudioFile(existing.recording.audioPath, existing.recording.id);
      }

      return true;
    });
  }

  async getMarkdown(id: string): Promise<{ filename: string; markdown: string } | null> {
    const entry = await this.getEntry(id);
    if (!entry) return null;
    const resolved = await resolveExistingRegularFile(entry.filename);
    if (resolved) {
      try {
        const diskMarkdown = await fsp.readFile(resolved.absPath, 'utf8');
        return { filename: entry.filename, markdown: diskMarkdown };
      } catch {
        // fall through to serializer
      }
    }
    return {
      filename: entry.filename,
      markdown: serializeObsidianNote(entry.recording),
    };
  }
}

export const noteStore = new NoteStore();
