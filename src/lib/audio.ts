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

/**
 * Deterministic calm fallback waveform bars derived from a recording ID,
 * used while decoding audio peaks or if a codec cannot be decoded via Web Audio.
 */
export function deterministicWaveformFallback(seed: string, barCount = 42): number[] {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const bars: number[] = [];
  for (let i = 0; i < barCount; i += 1) {
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    const raw = (hash >>> 0) / 0xffffffff;
    // Gentle voice-like contour: quieter at edges, varied cadence in middle
    const env = Math.sin(((i + 1) / (barCount + 1)) * Math.PI);
    const val = 0.2 + raw * 0.65 * (0.55 + 0.45 * env);
    bars.push(Math.max(0.18, Math.min(0.96, val)));
  }
  return bars;
}

const MAX_WAVEFORM_DECODE_BYTES = 25 * 1024 * 1024; // Avoid decoding huge files into PCM RAM

/**
 * Decodes real normalized RMS amplitude bars from an audio Blob via Web Audio API.
 * Falls back cleanly to a deterministic contour if Web Audio cannot decode the blob.
 */
export async function extractWaveformPeaks(
  blob: Blob,
  seed: string,
  barCount = 42,
): Promise<number[]> {
  const fallback = deterministicWaveformFallback(seed, barCount);
  if (
    typeof window === 'undefined' ||
    blob.size <= 0 ||
    blob.size > MAX_WAVEFORM_DECODE_BYTES
  ) {
    return fallback;
  }

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return fallback;

  let ctx: AudioContext | null = null;
  try {
    const buffer = await blob.arrayBuffer();
    ctx = new AudioCtx();
    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    const channel = decoded.getChannelData(0);
    if (!channel || channel.length === 0) return fallback;

    const blockSize = Math.max(1, Math.floor(channel.length / barCount));
    const rawPeaks: number[] = [];
    let maxPeak = 0;

    for (let i = 0; i < barCount; i += 1) {
      const start = i * blockSize;
      const end = Math.min(channel.length, start + blockSize);
      // Sample evenly across large blocks so decoding long clips stays instant
      const stride = Math.max(1, Math.floor((end - start) / 256));
      let sumSq = 0;
      let count = 0;
      for (let j = start; j < end; j += stride) {
        const s = channel[j];
        sumSq += s * s;
        count += 1;
      }
      const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
      rawPeaks.push(rms);
      if (rms > maxPeak) maxPeak = rms;
    }

    if (maxPeak <= 0.0001) return fallback;

    return rawPeaks.map((v) => {
      // Mild power curve keeps quiet speech legible without squashing peaks
      const norm = Math.pow(v / maxPeak, 0.72);
      return Math.max(0.16, Math.min(1, norm));
    });
  } catch {
    return fallback;
  } finally {
    if (ctx) {
      void ctx.close().catch(() => {});
    }
  }
}
