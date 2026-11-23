// Prefer explicit AAC/MP4 (.m4a) when supported & playable for broadest Obsidian Sync
// playback across Android, macOS, and iOS; fall back cleanly to WebM/Opus or Ogg/Opus.
export const MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

export const MAX_IMPORT_BYTES = 200 * 1024 * 1024; // 200 MiB (Obsidian Sync Plus cap)
const METADATA_PROBE_TIMEOUT_MS = 8_000;

export function probeSupportedMimeTypes(): string[] {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return [];
  }
  const probeAudio =
    typeof document !== 'undefined' ? document.createElement('audio') : null;

  const playable: string[] = [];
  const recorderOnly: string[] = [];

  for (const candidate of MIME_CANDIDATES) {
    if (!MediaRecorder.isTypeSupported(candidate)) continue;
    if (probeAudio) {
      if (probeAudio.canPlayType(candidate) !== '') {
        playable.push(candidate);
      } else {
        recorderOnly.push(candidate);
      }
    } else {
      playable.push(candidate);
    }
  }

  return [...playable, ...recorderOnly];
}

export function extensionForMimeType(mimeType: string, fallbackName?: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'm4a';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  if (lower.includes('flac')) return 'flac';
  if (lower.includes('webm')) return 'webm';

  if (fallbackName) {
    const ext = fallbackName.split('.').pop()?.toLowerCase() ?? '';
    if (['m4a', 'mp4', 'webm', 'ogg', 'wav', 'mp3', 'flac', 'aac'].includes(ext)) {
      return ext === 'mp4' ? 'm4a' : ext;
    }
  }
  return 'webm';
}

export function mimeTypeForExtension(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'aac':
      return 'audio/aac';
    case 'webm':
      return 'audio/webm';
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'audio/ogg';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    default:
      return null;
  }
}

export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatCodecLabel(mimeType: string): string {
  if (!mimeType) return 'AUDIO';
  const lower = mimeType.toLowerCase();
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'AAC · M4A';
  if (lower.includes('opus') && lower.includes('webm')) return 'OPUS · WEBM';
  if (lower.includes('ogg')) return 'OPUS · OGG';
  if (lower.includes('webm')) return 'WEBM';
  return 'AUDIO';
}

export function validateImportedAudioFile(file: File):
  | { ok: true; mimeType: string; extension: string }
  | { ok: false; error: string } {
  if (file.size <= 0) {
    return { ok: false, error: 'Selected audio file is empty.' };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      error: 'Selected file exceeds the 200 MB limit.',
    };
  }

  const inferredFromExt = mimeTypeForExtension(file.name);
  const rawType = file.type.trim().toLowerCase();

  if (
    rawType &&
    !rawType.startsWith('audio/') &&
    rawType !== 'video/webm' &&
    rawType !== 'video/mp4'
  ) {
    return {
      ok: false,
      error: `Unsupported file type (${file.type}). Choose an audio file (M4A, MP3, WebM, OGG, WAV, or FLAC).`,
    };
  }

  const resolvedMime =
    rawType && rawType.startsWith('audio/') ? rawType : inferredFromExt;

  if (!resolvedMime) {
    return {
      ok: false,
      error: 'Unrecognized audio format. Supported formats: M4A, MP3, WebM, OGG, WAV, AAC, FLAC.',
    };
  }

  return {
    ok: true,
    mimeType: resolvedMime,
    extension: extensionForMimeType(resolvedMime, file.name),
  };
}

export async function readAudioDuration(
  file: Blob,
): Promise<{ ok: true; durationSeconds: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';

    let settled = false;
    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ok: false,
        error: 'Timed out reading audio metadata. The file may be corrupted or unsupported.',
      });
    }, METADATA_PROBE_TIMEOUT_MS);

    const finish = (
      result: { ok: true; durationSeconds: number } | { ok: false; error: string },
    ) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    audio.onloadedmetadata = () => {
      const secs = audio.duration;
      finish({
        ok: true,
        durationSeconds: Number.isFinite(secs) && secs > 0 ? Math.round(secs) : 0,
      });
    };
    audio.onerror = () => {
      finish({
        ok: false,
        error:
          'This browser cannot decode that audio file. Choose a standard M4A, MP3, WebM, OGG, or WAV clip.',
      });
    };
    audio.src = url;
  });
}
