import YAML, { Scalar } from 'yaml';
import type { Recording } from './types';

export function formatDuration(seconds: number): string {
  const clamped = Math.max(0, Math.round(seconds));
  const hrs = Math.floor(clamped / 3600);
  const mins = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatTimerMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const tenths = Math.floor((ms % 1000) / 100);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
}

export function formatLocalDateTime(iso: string): {
  date: string;
  timeColon: string;
  timeFilename: string;
} {
  const d = new Date(iso);
  const valid = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${valid.getFullYear()}-${pad(valid.getMonth() + 1)}-${pad(valid.getDate())}`;
  const hh = pad(valid.getHours());
  const mm = pad(valid.getMinutes());
  return {
    date,
    timeColon: `${hh}:${mm}`,
    // Colon (:) is illegal on Android storage, Windows, and Obsidian Sync filenames
    timeFilename: `${hh}.${mm}`,
  };
}

/**
 * Cleans a concise subject for Obsidian / Android / macOS / Windows filenames
 * while preserving readable spaces and capitalization (e.g. "Dentist Visit").
 */
export function sanitizeFilenameSubject(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|#^\[\]\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 60)
    .trim();
  return cleaned || 'Voice Note';
}

/**
 * Neutralizes active Obsidian / HTML / plugin syntax in untrusted inline text
 * (titles, summaries, language names) and strips line breaks so headings and
 * blockquotes stay single-line.
 */
export function sanitizeMarkdownInline(raw: string): string {
  return raw
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/<(?=[a-zA-Z!/%?])/g, '&lt;')
    .replace(/\[\[/g, '\\[\\[')
    .replace(/\]\]/g, '\\]\\]')
    .replace(/`{3,}/g, '\\`\\`\\`')
    .replace(
      /\]\(\s*(?:javascript|data|vbscript|file|obsidian):/gi,
      '](blocked:',
    );
}

/**
 * Neutralizes active Markdown/HTML/Obsidian plugin syntax inside model-generated
 * transcript bodies (HTML tags, Templater `<%`, wikilink embeds `[[...]]`,
 * fenced code blocks like ` ```dataviewjs `, and dangerous URI schemes) while
 * keeping ordinary prose readable.
 */
export function sanitizeMarkdownBody(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/<(?=[a-zA-Z!/%?])/g, '&lt;')
    .replace(/\[\[/g, '\\[\\[')
    .replace(/\]\]/g, '\\]\\]')
    .replace(/^(\s*)(`{3,}|~{3,})/gm, (_match, indent: string, fence: string) =>
      `${indent}${fence.split('').map((ch) => `\\${ch}`).join('')}`,
    )
    .replace(
      /\]\(\s*(?:javascript|data|vbscript|file|obsidian):/gi,
      '](blocked:',
    );
}

/**
 * Human-readable note title matching "YYYY-MM-DD HH:MM - Concise Subject".
 */
export function formatNoteDisplayTitle(recording: Recording): string {
  const { date, timeColon } = formatLocalDateTime(recording.created);
  const subject = recording.title.replace(/\r?\n+/g, ' ').trim() || 'Voice Note';
  return `${date} ${timeColon} - ${subject}`;
}

/**
 * Desired Obsidian filename matching "YYYY-MM-DD HH.MM - Concise Subject.md".
 * Uses a dot in time (16.42) so the file syncs cleanly across Android, macOS,
 * Windows, and Obsidian Sync (which rejects ":" in filenames).
 */
export function buildDesiredNoteFilename(recording: Recording, collisionIndex = 1): string {
  const { date, timeFilename } = formatLocalDateTime(recording.created);
  const subject = sanitizeFilenameSubject(recording.title);
  const suffix = collisionIndex > 1 ? ` (${collisionIndex})` : '';
  return `${date} ${timeFilename} - ${subject}${suffix}.md`;
}

export function buildNoteFilename(recording: Recording, activeVaultId?: string | null): string {
  if (activeVaultId && recording.vaultExports?.[activeVaultId]?.filename) {
    return recording.vaultExports[activeVaultId].filename;
  }
  return buildDesiredNoteFilename(recording);
}

function doubleQuoted(value: string): Scalar<string> {
  const s = new Scalar(value);
  s.type = Scalar.QUOTE_DOUBLE;
  return s;
}

export function buildObsidianMarkdown(recording: Recording): string {
  const displayTitle = formatNoteDisplayTitle(recording);
  const safeHeadingTitle = sanitizeMarkdownInline(displayTitle);
  const safeLanguageName = sanitizeMarkdownInline(recording.languageName || 'Original');
  const cleanSummary = sanitizeMarkdownInline(recording.summary);

  const frontmatter: Record<string, unknown> = {
    id: recording.id,
    title: doubleQuoted(safeHeadingTitle),
    created: recording.created,
    duration: doubleQuoted(formatDuration(recording.durationSeconds)),
    language: recording.language,
    language_name: safeLanguageName,
    status: recording.status,
    summary: doubleQuoted(cleanSummary),
    tags: recording.tags,
    audio: recording.audioPath,
  };

  if (recording.status === 'failed' && recording.errorMessage) {
    frontmatter.error = doubleQuoted(recording.errorMessage.replace(/\r?\n+/g, ' ').trim());
  }

  const yamlBlock = YAML.stringify(frontmatter, {
    lineWidth: 0,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  }).trimEnd();

  // Shortest-path wikilink resolves from both vault root AND nested subfolders (e.g. MyVault/Tapeleaf/)
  const rawEmbed =
    recording.audioFilename || recording.audioPath.split('/').pop() || recording.audioPath;
  const embedTarget = rawEmbed.replace(/[\[\]\r\n]+/g, '');

  const lines: string[] = [
    '---',
    yamlBlock,
    '---',
    '',
    `# ${safeHeadingTitle}`,
    '',
  ];

  if (cleanSummary) {
    lines.push(`> ${sanitizeMarkdownInline(cleanSummary)}`, '');
  }

  lines.push(`![[${embedTarget}]]`, '');
  lines.push('## Transcript', '');
  const safeTranscript = sanitizeMarkdownBody(recording.englishTranscript);
  lines.push(safeTranscript || '_Transcript pending…_');

  if (!recording.isEnglish && recording.originalTranscript?.trim()) {
    const safeOriginal = sanitizeMarkdownBody(recording.originalTranscript);
    if (safeOriginal) {
      lines.push(
        '',
        '<!-- tapeleaf:original -->',
        `## Original (${safeLanguageName})`,
        '',
      );
      lines.push(safeOriginal);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function formatRelativeTime(iso: string, nowMs = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffSec = Math.round((nowMs - then) / 1000);
  if (diffSec < 45) return 'Just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function formatFullTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
