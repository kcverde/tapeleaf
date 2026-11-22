import { normalizeTag } from '../markdown';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const AVAILABLE_MODELS = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (Recommended)' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
] as const;

const INLINE_LIMIT_BYTES = 12 * 1024 * 1024; // 12 MiB mobile-safe inline base64 cutoff
const GENERATE_TIMEOUT_MS = 90_000;
const FILES_POLL_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [1500, 3500];

const KEY_SESSION_STORAGE = 'tapeleaf-gemini-key-session';
const KEY_LOCAL_STORAGE = 'tapeleaf-gemini-key-local';
const KEY_REMEMBER_STORAGE = 'tapeleaf-gemini-remember';
const MODEL_STORAGE = 'tapeleaf-gemini-model';

export interface StoredKeyState {
  apiKey: string;
  rememberOnDevice: boolean;
  model: string;
}

export function loadGeminiSettings(): StoredKeyState {
  if (typeof window === 'undefined') {
    return { apiKey: '', rememberOnDevice: false, model: DEFAULT_GEMINI_MODEL };
  }
  const rememberOnDevice = window.localStorage.getItem(KEY_REMEMBER_STORAGE) === '1';
  const apiKey =
    (rememberOnDevice ? window.localStorage.getItem(KEY_LOCAL_STORAGE) : null) ||
    window.sessionStorage.getItem(KEY_SESSION_STORAGE) ||
    '';
  const storedModel = window.localStorage.getItem(MODEL_STORAGE)?.trim() || DEFAULT_GEMINI_MODEL;
  return {
    apiKey,
    rememberOnDevice,
    model: storedModel,
  };
}

export function saveGeminiSettings(next: {
  apiKey: string;
  rememberOnDevice: boolean;
  model: string;
}): void {
  const cleanKey = next.apiKey.trim();
  const cleanModel = next.model.trim() || DEFAULT_GEMINI_MODEL;
  window.localStorage.setItem(MODEL_STORAGE, cleanModel);

  if (!cleanKey) {
    window.sessionStorage.removeItem(KEY_SESSION_STORAGE);
    window.localStorage.removeItem(KEY_LOCAL_STORAGE);
    window.localStorage.removeItem(KEY_REMEMBER_STORAGE);
    return;
  }

  window.sessionStorage.setItem(KEY_SESSION_STORAGE, cleanKey);
  if (next.rememberOnDevice) {
    window.localStorage.setItem(KEY_REMEMBER_STORAGE, '1');
    window.localStorage.setItem(KEY_LOCAL_STORAGE, cleanKey);
  } else {
    window.localStorage.removeItem(KEY_REMEMBER_STORAGE);
    window.localStorage.removeItem(KEY_LOCAL_STORAGE);
  }
}

export interface AudioAnalysisResult {
  detectedLanguage: string;
  languageCode: string;
  isEnglish: boolean;
  title: string;
  summary: string;
  tags: string[];
  originalTranscript: string;
  englishTranslation: string;
}

export type GeminiErrorKind = 'auth' | 'quota' | 'transient' | 'network' | 'other';

export class GeminiClientError extends Error {
  readonly kind: GeminiErrorKind;
  constructor(kind: GeminiErrorKind, message: string) {
    super(message);
    this.name = 'GeminiClientError';
    this.kind = kind;
  }
}

export function normalizeGeminiAudioMime(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() || 'audio/webm';
  switch (base) {
    case 'audio/x-m4a':
    case 'audio/m4a':
    case 'audio/mp4':
      return 'audio/m4a';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'audio/mp3';
    case 'audio/x-wav':
    case 'audio/wave':
    case 'audio/wav':
      return 'audio/wav';
    case 'audio/ogg':
      return 'audio/ogg';
    case 'audio/flac':
      return 'audio/flac';
    case 'audio/aac':
      return 'audio/aac';
    case 'audio/webm':
    default:
      return 'audio/webm';
  }
}

function buildResponseSchema(TypeEnum: typeof import('@google/genai').Type) {
  return {
    type: TypeEnum.OBJECT,
    properties: {
      detectedLanguage: {
        type: TypeEnum.STRING,
        description:
          'Human-readable name of the primary spoken language in English, e.g. English, Spanish, French, Japanese.',
      },
      languageCode: {
        type: TypeEnum.STRING,
        description: 'Two-letter lowercase ISO 639-1 language code, e.g. en, es, fr, ja.',
      },
      isEnglish: {
        type: TypeEnum.BOOLEAN,
        description: 'True if the primary spoken language is English.',
      },
      title: {
        type: TypeEnum.STRING,
        description:
          'Concrete, scannable English title (3-8 words) capturing the actual topic, never generic like "Voice note".',
      },
      summary: {
        type: TypeEnum.STRING,
        description:
          'Crisp single-sentence English summary (max 24 words) capturing the main takeaway or action.',
      },
      tags: {
        type: TypeEnum.ARRAY,
        items: { type: TypeEnum.STRING },
        description: '2 to 4 lowercase kebab-case Obsidian tags.',
      },
      originalTranscript: {
        type: TypeEnum.STRING,
        description:
          'Clean, punctuated verbatim transcript in the original spoken language, split into natural paragraphs.',
      },
      englishTranslation: {
        type: TypeEnum.STRING,
        description:
          'Clean, natural English translation of the full transcript (if spoken in English, match originalTranscript cleanly).',
      },
    },
    required: [
      'detectedLanguage',
      'languageCode',
      'isEnglish',
      'title',
      'summary',
      'tags',
      'originalTranscript',
      'englishTranslation',
    ],
  };
}

function buildPrompt(existingTags: string[]): string {
  const tagGuidance =
    existingTags.length > 0
      ? `Reuse relevant existing Obsidian tags when appropriate to keep the vault consistent: ${existingTags.map((t) => `#${t}`).join(', ')}.`
      : 'Choose simple, durable Obsidian tags (e.g. ideas, work, personal, travel, journal, errands).';

  return [
    'You are transcribing and organizing a personal voice memo into an Obsidian Markdown note.',
    'Listen carefully to the attached audio and return a single JSON object matching the schema:',
    '- Detect the spoken language accurately (detectedLanguage + 2-letter lowercase languageCode + isEnglish).',
    '- Write a concrete, human, scannable English title (3 to 8 words). Avoid filler like "Voice Memo" or dates.',
    '- Write a crisp 1-sentence English summary capturing the core point or next step.',
    `- Assign 2 to 4 lowercase kebab-case tags. ${tagGuidance}`,
    '- Write a clean, well-punctuated transcript in originalTranscript (in the spoken language, using natural paragraph breaks and removing only meaningless stutter noise while staying faithful to what was said).',
    '- Write a clean, natural English transcript in englishTranslation. If the clip is already in English, englishTranslation should be the clean English transcript.',
    '- If the audio is silent or unintelligible, return languageCode "en", isEnglish true, a brief honest title like "Silent or unclear audio clip", a short summary explaining that no clear speech was detected, tags ["unclear"], and empty/brief transcript.',
  ].join('\n');
}

function sanitizeResult(raw: Partial<AudioAnalysisResult>): AudioAnalysisResult {
  const code = (raw.languageCode || 'en').trim().toLowerCase().slice(0, 8) || 'en';
  const isEnglish = typeof raw.isEnglish === 'boolean' ? raw.isEnglish : code === 'en';
  const detectedLanguage =
    raw.detectedLanguage?.trim() || (isEnglish ? 'English' : code.toUpperCase());

  const cleanTags: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.tags)) {
    for (const item of raw.tags) {
      if (typeof item !== 'string') continue;
      const clean = normalizeTag(item);
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        cleanTags.push(clean);
        if (cleanTags.length >= 4) break;
      }
    }
  }

  const originalTranscript = (raw.originalTranscript || '').trim();
  const englishTranslation = (raw.englishTranslation || originalTranscript).trim();

  return {
    detectedLanguage,
    languageCode: isEnglish ? 'en' : code,
    isEnglish,
    title: (raw.title || 'Voice note').trim().slice(0, 120),
    summary: (raw.summary || '').trim().replace(/\r?\n+/g, ' ').slice(0, 280),
    tags: cleanTags.length > 0 ? cleanTags : ['inbox'],
    originalTranscript: originalTranscript || englishTranslation,
    englishTranslation: englishTranslation || originalTranscript,
  };
}

function classifyGeminiError(err: unknown): GeminiClientError {
  if (err instanceof GeminiClientError) return err;

  const errName = err instanceof Error || err instanceof DOMException ? err.name : '';
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  const trimmed = raw.trim();

  // Explicitly classify fetch/AbortSignal timeouts as transient so bounded retries run
  if (errName === 'TimeoutError' || errName === 'AbortError') {
    return new GeminiClientError(
      'transient',
      'Gemini request timed out. Your audio is safe — tap Retry in a moment.',
    );
  }

  let code: number | undefined;
  let status: string | undefined;
  let message = trimmed;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: { code?: number; status?: string; message?: string };
        code?: number;
        status?: string;
        message?: string;
      };
      const inner = parsed.error ?? parsed;
      if (inner && typeof inner === 'object') {
        if (typeof inner.code === 'number') code = inner.code;
        if (typeof inner.status === 'string') status = inner.status;
        if (typeof inner.message === 'string' && inner.message.trim()) {
          message = inner.message.trim();
        }
      }
    } catch {
      // keep raw message
    }
  }

  const lower = message.toLowerCase();

  if (
    !navigator.onLine ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('load failed')
  ) {
    return new GeminiClientError(
      'network',
      'Offline or unreachable. Your clip is queued and will transcribe when back online.',
    );
  }

  if (
    code === 401 ||
    code === 403 ||
    status === 'PERMISSION_DENIED' ||
    status === 'UNAUTHENTICATED' ||
    lower.includes('api key not valid') ||
    lower.includes('api_key_invalid')
  ) {
    return new GeminiClientError(
      'auth',
      'Gemini rejected your API key. Open Settings to check it, then tap Retry.',
    );
  }

  if (code === 429 || status === 'RESOURCE_EXHAUSTED' || lower.includes('quota')) {
    return new GeminiClientError(
      'quota',
      'Gemini quota or rate limit reached. Queue paused — tap Retry in a moment.',
    );
  }

  if (
    code === 500 ||
    code === 503 ||
    code === 504 ||
    status === 'UNAVAILABLE' ||
    status === 'INTERNAL' ||
    status === 'DEADLINE_EXCEEDED' ||
    lower.includes('high demand') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('timed out') ||
    lower.includes('timeout')
  ) {
    return new GeminiClientError(
      'transient',
      'Gemini is temporarily busy or timed out. Your audio is safe — tap Retry in a moment.',
    );
  }

  return new GeminiClientError(
    'other',
    message.slice(0, 240) || 'Transcription failed. Tap Retry to try again.',
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read audio blob'));
    reader.readAsDataURL(blob);
  });
}

export async function analyzeAudioBlob(params: {
  apiKey: string;
  model: string;
  blob: Blob;
  mimeType: string;
  existingTags: string[];
}): Promise<AudioAnalysisResult> {
  const apiKey = params.apiKey.trim();
  if (!apiKey) {
    throw new GeminiClientError(
      'auth',
      'Add your Gemini API key in Settings to transcribe voice notes.',
    );
  }

  const { GoogleGenAI, Type } = await import('@google/genai');
  const responseSchema = buildResponseSchema(Type);

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: GENERATE_TIMEOUT_MS },
  });
  const model = params.model.trim() || DEFAULT_GEMINI_MODEL;
  const mimeType = normalizeGeminiAudioMime(params.mimeType || params.blob.type);
  const prompt = buildPrompt(params.existingTags);

  let uploadedFileName: string | undefined;

  try {
    let mediaPart:
      | { inlineData: { data: string; mimeType: string } }
      | { fileData: { fileUri: string; mimeType: string } };

    if (params.blob.size <= INLINE_LIMIT_BYTES) {
      const base64 = await blobToBase64(params.blob);
      mediaPart = {
        inlineData: {
          data: base64,
          mimeType,
        },
      };
    } else {
      // Large clip (> 12 MiB): upload once via Gemini Files API and reuse across retries
      const uploadBlob =
        params.blob.type === mimeType
          ? params.blob
          : new Blob([params.blob], { type: mimeType });

      const uploaded = await ai.files.upload({
        file: uploadBlob,
        config: {
          mimeType,
          abortSignal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
        },
      });
      uploadedFileName = uploaded.name;

      let activeFile = uploaded;
      const deadline = Date.now() + FILES_POLL_TIMEOUT_MS;
      while (activeFile.state === 'PROCESSING' && activeFile.name) {
        const remainingBeforeSleep = deadline - Date.now();
        if (remainingBeforeSleep <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(1500, remainingBeforeSleep)));

        const remainingForGet = deadline - Date.now();
        if (remainingForGet <= 0) break;
        try {
          activeFile = await ai.files.get({
            name: activeFile.name,
            config: {
              abortSignal: AbortSignal.timeout(Math.max(1000, remainingForGet)),
            },
          });
        } catch (pollErr) {
          const classified = classifyGeminiError(pollErr);
          // Retry transient polling failures against the existing uploaded file while time remains
          if (classified.kind === 'transient' && deadline - Date.now() > 1500) {
            continue;
          }
          throw classified;
        }
      }

      if (!activeFile.uri || activeFile.state !== 'ACTIVE') {
        throw new GeminiClientError(
          'transient',
          `Gemini Files API did not finish preparing audio in time (state: ${activeFile.state ?? 'unknown'}).`,
        );
      }

      mediaPart = {
        fileData: {
          fileUri: activeFile.uri,
          mimeType: activeFile.mimeType || mimeType,
        },
      };
    }

    let lastError: GeminiClientError | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [mediaPart, { text: prompt }],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema,
            abortSignal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
          },
        });

        const text = response.text?.trim();
        if (!text) {
          throw new GeminiClientError('transient', 'Gemini returned an empty response.');
        }

        const parsed = JSON.parse(text) as Partial<AudioAnalysisResult>;
        return sanitizeResult(parsed);
      } catch (err) {
        const classified = classifyGeminiError(err);
        lastError = classified;
        // Stop immediately on auth, quota, network offline, or non-transient errors
        if (classified.kind !== 'transient') {
          throw classified;
        }
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError ?? new GeminiClientError('other', 'Transcription failed.');
  } catch (err) {
    throw classifyGeminiError(err);
  } finally {
    if (uploadedFileName) {
      await ai.files
        .delete({
          name: uploadedFileName,
          config: { abortSignal: AbortSignal.timeout(10_000) },
        })
        .catch(() => {});
    }
  }
}

export async function verifyGeminiApiKey(apiKey: string): Promise<{ ok: boolean; message: string }> {
  const clean = apiKey.trim();
  if (!clean) return { ok: false, message: 'Enter an API key first.' };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(DEFAULT_GEMINI_MODEL)}`,
      {
        method: 'GET',
        headers: { 'x-goog-api-key': clean },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.ok) {
      return { ok: true, message: 'Key verified with Gemini.' };
    }
    const text = await res.text().catch(() => '');
    const classified = classifyGeminiError(new Error(text || `HTTP ${res.status}`));
    return { ok: false, message: classified.message };
  } catch (err) {
    const classified = classifyGeminiError(err);
    return { ok: false, message: classified.message };
  }
}
