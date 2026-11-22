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

export function slugifyTitle(title: string): string {
  const normalized = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || 'voice-note';
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

export function buildNoteFilename(recording: Recording): string {
  const datePart = recording.created.slice(0, 10) || new Date().toISOString().slice(0, 10);
  return `${datePart}-${slugifyTitle(recording.title)}.md`;
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`;
}

export function buildObsidianMarkdown(recording: Recording): string {
  const tagsBlock =
    recording.tags.length > 0
      ? `tags:\n${recording.tags.map((tag) => `  - ${tag}`).join('\n')}`
      : 'tags: []';

  const lines: string[] = [
    '---',
    `id: ${recording.id}`,
    `title: ${yamlQuote(recording.title)}`,
    `created: ${recording.created}`,
    `duration: ${yamlQuote(formatDuration(recording.durationSeconds))}`,
    `language: ${recording.language}`,
    `language_name: ${recording.languageName}`,
    `status: ${recording.status}`,
    `summary: ${yamlQuote(recording.summary)}`,
    tagsBlock,
    `audio: ${recording.audioPath}`,
    '---',
    '',
    `# ${recording.title}`,
    '',
  ];

  if (recording.summary.trim()) {
    lines.push(`> ${recording.summary.trim()}`, '');
  }

  lines.push(`![[${recording.audioPath}]]`, '');
  lines.push('## Transcript', '');
  lines.push(recording.englishTranscript.trim() || '_Transcript pending…_');

  if (!recording.isEnglish && recording.originalTranscript?.trim()) {
    lines.push('', `## Original (${recording.languageName})`, '');
    lines.push(recording.originalTranscript.trim());
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
