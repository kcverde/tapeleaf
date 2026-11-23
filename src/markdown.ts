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

export interface TranscriptBlock {
  speaker?: string;
  text: string;
}

const SPEAKER_NAME_PARTICLES = new Set([
  'de',
  'del',
  'la',
  'las',
  'los',
  'van',
  'von',
  'da',
  'di',
  'du',
  'al',
  'bin',
  'ibn',
  'of',
]);

const NON_SPEAKER_LABELS = new Set([
  'note',
  'notes',
  'quick note',
  'side note',
  'final note',
  'voice note',
  'reminder',
  'reminders',
  'todo',
  'to-do',
  'to do',
  'summary',
  'update',
  'warning',
  'caution',
  'tip',
  'tips',
  'pro tip',
  'example',
  'examples',
  'action',
  'actions',
  'action item',
  'next step',
  'key point',
  'key takeaway',
  'follow up',
  'follow-up',
  'open question',
  'step',
  'item',
  'link',
  'url',
  'context',
  'background',
  'topic',
  'subject',
  'date',
  'time',
  'location',
  'address',
  'phone',
  'email',
  'agenda',
  'goal',
  'goals',
  'idea',
  'ideas',
  'plan',
  'result',
  'results',
  'conclusion',
  'important',
  'first',
  'second',
  'third',
  'option',
  'part',
  'section',
  'chapter',
  'pros',
  'cons',
  'ps',
  'p.s.',
  'nb',
  'n.b.',
  'tldr',
  'tl;dr',
  'http',
  'https',
  'mailto',
  'file',
  'obsidian',
]);

const EXPLICIT_SPEAKER_RE = /^speaker\s+(?:\d{1,2}|[a-z])$/i;
const CAPITALIZED_WORD_RE = /^[\p{Lu}\p{Lt}][\p{L}\p{M}'’-]*\.?$/u;
const CASELESS_WORD_RE = /^[\p{Lo}][\p{Lo}\p{M}\p{Nd}'’-]*$/u;
const SPEAKER_NUMBER_RE = /^\d{1,2}$/;

function isValidSpeakerLabel(rawLabel: string): boolean {
  const label = rawLabel.replace(/\s+/g, ' ').trim();
  if (!label || label.length > 32) return false;

  const lower = label.toLowerCase();
  if (NON_SPEAKER_LABELS.has(lower)) return false;
  if (EXPLICIT_SPEAKER_RE.test(label)) return true;

  const words = label.split(' ');
  if (words.length > 3) return false;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (CAPITALIZED_WORD_RE.test(word) || CASELESS_WORD_RE.test(word)) {
      continue;
    }
    if (i > 0 && SPEAKER_NUMBER_RE.test(word)) {
      continue;
    }
    if (i > 0 && i < words.length - 1 && SPEAKER_NAME_PARTICLES.has(word.toLowerCase())) {
      continue;
    }
    return false;
  }

  return true;
}

function matchSpeakerPrefix(line: string): { speaker: string; text: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Accept plain ("Speaker 1: ...") or model-bolded ("**Speaker 1:** ...", "**Speaker 1**: ...")
  let rawLabel = '';
  let text = '';

  const boldColonInside = trimmed.match(/^\*\*([^*\n]{1,36}?)(?::|：)\*\*(?:\s+(.+)|(.+))$/);
  const boldColonOutside = !boldColonInside
    ? trimmed.match(/^\*\*([^*\n]{1,36}?)\*\*(?::\s+|：\s*)(.+)$/)
    : null;
  const plainPrefix =
    !boldColonInside && !boldColonOutside
      ? trimmed.match(/^([^:\n：*]{1,36}?)(?::\s+|：\s*)(.+)$/)
      : null;

  if (boldColonInside) {
    rawLabel = boldColonInside[1];
    text = (boldColonInside[2] ?? boldColonInside[3] ?? '').trim();
  } else if (boldColonOutside) {
    rawLabel = boldColonOutside[1];
    text = boldColonOutside[2].trim();
  } else if (plainPrefix) {
    rawLabel = plainPrefix[1];
    text = plainPrefix[2].trim();
  } else {
    return null;
  }

  const label = rawLabel.replace(/\s+/g, ' ').trim();
  if (!text || !isValidSpeakerLabel(label)) return null;
  return { speaker: label, text };
}

/**
 * Splits a transcript into paragraphs, promoting speaker-prefixed turns only when
 * the transcript shows coherent multi-speaker structure (preventing false positives
 * on single-speaker prose that happens to contain colons).
 */
export function parseTranscriptBlocks(raw: string): TranscriptBlock[] {
  const normalized = raw.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  const rawParagraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const candidates: Array<{ speaker?: string; lines: string[] }> = [];

  for (const para of rawParagraphs) {
    const lines = para.split('\n');
    let current: { speaker?: string; lines: string[] } | null = null;

    for (const line of lines) {
      const match = matchSpeakerPrefix(line);
      if (match) {
        if (current) candidates.push(current);
        current = { speaker: match.speaker, lines: [match.text] };
      } else if (current) {
        current.lines.push(line);
      } else {
        current = { lines: [line] };
      }
    }

    if (current) candidates.push(current);
  }

  const uniqueSpeakers = new Set<string>();
  let labeledCount = 0;
  let explicitSpeakerCount = 0;

  for (const c of candidates) {
    if (c.speaker) {
      labeledCount += 1;
      uniqueSpeakers.add(c.speaker.toLowerCase());
      if (EXPLICIT_SPEAKER_RE.test(c.speaker)) {
        explicitSpeakerCount += 1;
      }
    }
  }

  const isMultiSpeaker =
    labeledCount >= 2 &&
    (uniqueSpeakers.size >= 2 || explicitSpeakerCount >= 2) &&
    labeledCount / candidates.length >= 0.5;

  if (!isMultiSpeaker) {
    return rawParagraphs.map((text) => ({ text }));
  }

  return candidates.map((c) => ({
    ...(c.speaker ? { speaker: c.speaker } : {}),
    text: c.lines.join('\n').trim(),
  }));
}

/**
 * Sanitizes a transcript body for Obsidian Markdown and formats detected
 * multi-speaker turns cleanly as `**Speaker:** ...` separated by blank lines.
 */
export function formatTranscriptForMarkdown(raw: string): string {
  const sanitized = sanitizeMarkdownBody(raw);
  if (!sanitized) return '';

  const blocks = parseTranscriptBlocks(sanitized);
  if (!blocks.some((b) => b.speaker)) {
    return sanitized;
  }

  return blocks
    .map((b) => (b.speaker ? `**${b.speaker}:** ${b.text}` : b.text))
    .join('\n\n');
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
  const safeTranscript = formatTranscriptForMarkdown(recording.englishTranscript);
  lines.push(safeTranscript || '_Transcript pending…_');

  if (!recording.isEnglish && recording.originalTranscript?.trim()) {
    const safeOriginal = formatTranscriptForMarkdown(recording.originalTranscript);
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
