import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Context } from 'hono';

export function getDataDir(): string {
  return path.resolve(process.env.DATA_DIR?.trim() || path.join(process.cwd(), 'data'));
}

export function getNotesDir(): string {
  return path.join(getDataDir(), 'notes');
}

export function getAudioDir(): string {
  return path.join(getNotesDir(), 'audio');
}

export async function ensureStorageDirs(): Promise<void> {
  await fsp.mkdir(getAudioDir(), { recursive: true });
}

export function extensionForMime(mimeType: string, fallbackName?: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'm4a';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  if (lower.includes('flac')) return 'flac';
  if (lower.includes('webm')) return 'webm';

  if (fallbackName) {
    const ext = path.extname(fallbackName).replace(/^\./, '').toLowerCase();
    if (['webm', 'm4a', 'mp4', 'ogg', 'wav', 'mp3', 'flac', 'aac'].includes(ext)) {
      return ext === 'mp4' ? 'm4a' : ext;
    }
  }
  return 'webm';
}

export function mimeForExtension(filePath: string): string {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  switch (ext) {
    case 'webm':
      return 'audio/webm';
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'ogg':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    default:
      return 'application/octet-stream';
  }
}

export function resolveSafeNotePath(relativePath: string): string | null {
  const notesDir = getNotesDir();
  const resolved = path.resolve(notesDir, relativePath);
  if (resolved === notesDir || !resolved.startsWith(`${notesDir}${path.sep}`)) {
    return null;
  }
  return resolved;
}

export async function atomicWriteFile(targetPath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(targetPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmpPath, data);
    await fsp.rename(tmpPath, targetPath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export interface SavedAudio {
  audioPath: string;
  absPath: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
}

export async function saveAudioFile(
  id: string,
  buffer: Uint8Array,
  mimeType: string,
  originalFilename?: string,
): Promise<SavedAudio> {
  await ensureStorageDirs();
  const extension = extensionForMime(mimeType, originalFilename);
  const audioPath = `audio/${id}.${extension}`;
  const absPath = resolveSafeNotePath(audioPath);
  if (!absPath) {
    throw new Error('Invalid audio storage path');
  }
  await atomicWriteFile(absPath, buffer);
  return {
    audioPath,
    absPath,
    extension,
    mimeType: mimeType || mimeForExtension(absPath),
    sizeBytes: buffer.byteLength,
  };
}

export async function deleteAudioFile(audioPath: string): Promise<void> {
  const absPath = resolveSafeNotePath(audioPath);
  if (!absPath) return;
  await fsp.unlink(absPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

function parseRangeHeader(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return null;

  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return null;

  let start: number;
  let end: number;

  if (!startStr) {
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    end = endStr ? Number.parseInt(endStr, 10) : fileSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end >= fileSize) end = fileSize - 1;
  }

  if (start < 0 || start >= fileSize || start > end) {
    return null;
  }

  return { start, end };
}

export async function streamAudioResponse(
  c: Context,
  audioPath: string,
  downloadFilename?: string,
): Promise<Response> {
  const absPath = resolveSafeNotePath(audioPath);
  if (!absPath) {
    return c.json({ error: 'Invalid audio path' }, 400);
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    return c.json({ error: 'Audio file not found' }, 404);
  }

  const fileSize = stat.size;
  const contentType = mimeForExtension(absPath);
  const headers = new Headers({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
  });

  if (downloadFilename) {
    const safeName = downloadFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
    headers.set('Content-Disposition', `attachment; filename="${safeName}"`);
  }

  const rangeHeader = c.req.header('range');
  if (rangeHeader) {
    if (fileSize === 0) {
      headers.set('Content-Range', 'bytes */0');
      return new Response(null, { status: 416, headers });
    }
    const range = parseRangeHeader(rangeHeader, fileSize);
    if (!range) {
      headers.set('Content-Range', `bytes */${fileSize}`);
      return new Response(null, { status: 416, headers });
    }

    const chunkLength = range.end - range.start + 1;
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${fileSize}`);
    headers.set('Content-Length', String(chunkLength));

    const nodeStream = fs.createReadStream(absPath, {
      start: range.start,
      end: range.end,
    });
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    return new Response(webStream, { status: 206, headers });
  }

  headers.set('Content-Length', String(fileSize));
  const nodeStream = fs.createReadStream(absPath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new Response(webStream, { status: 200, headers });
}
