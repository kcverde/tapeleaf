import fsp from 'node:fs/promises';
import { GoogleGenAI, Type } from '@google/genai';
import { normalizeTag } from '../src/markdown';

const INLINE_LIMIT_BYTES = 12 * 1024 * 1024; // 12 MB raw (safe under 20 MB request cap after base64)
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const GENERATE_TIMEOUT_MS = 90_000;
const FILES_POLL_TIMEOUT_MS = 60_000;

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

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

export function hasGeminiApiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

/**
 * Normalize browser audio MIME types to formats documented by the Gemini Developer API.
 * Safari captures MP4/AAC containers as audio/mp4; map those to audio/m4a for Gemini while
 * storage.ts continues serving audio/mp4 to browsers for native <audio> playback.
 */
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

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    detectedLanguage: {
      type: Type.STRING,
      description:
        'Human-readable name of the primary spoken language in English, e.g. English, Spanish, French, Japanese.',
    },
    languageCode: {
      type: Type.STRING,
      description: 'Two-letter lowercase ISO 639-1 language code, e.g. en, es, fr, ja.',
    },
    isEnglish: {
      type: Type.BOOLEAN,
      description: 'True if the primary spoken language is English.',
    },
    title: {
      type: Type.STRING,
      description:
        'Concrete, scannable English title (3-8 words) capturing the actual topic, never generic like "Voice note".',
    },
    summary: {
      type: Type.STRING,
      description:
        'Crisp single-sentence English summary (max 24 words) capturing the main takeaway or action.',
    },
    tags: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '2 to 4 lowercase kebab-case Obsidian tags.',
    },
    originalTranscript: {
      type: Type.STRING,
      description:
        'Clean, punctuated verbatim transcript in the original spoken language, split into natural paragraphs.',
    },
    englishTranslation: {
      type: Type.STRING,
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

function demoFallback(durationSeconds: number, mimeType: string): AudioAnalysisResult {
  const secs = Math.max(1, Math.round(durationSeconds));
  return {
    detectedLanguage: 'English',
    languageCode: 'en',
    isEnglish: true,
    title: 'Local recording saved (demo mode)',
    summary:
      'Audio saved safely to disk; set GEMINI_API_KEY in .env and tap Reprocess for live transcription.',
    tags: ['demo', 'inbox'],
    originalTranscript: `Saved ${secs}s of audio (${mimeType}) locally in Obsidian Markdown format.\n\nNo GEMINI_API_KEY is configured yet, so Tapeleaf used the offline demo fallback. Add GEMINI_API_KEY to .env and tap Reprocess to transcribe and translate this clip with Gemini.`,
    englishTranslation: `Saved ${secs}s of audio (${mimeType}) locally in Obsidian Markdown format.\n\nNo GEMINI_API_KEY is configured yet, so Tapeleaf used the offline demo fallback. Add GEMINI_API_KEY to .env and tap Reprocess to transcribe and translate this clip with Gemini.`,
  };
}

export async function analyzeAudioFile(params: {
  absPath: string;
  mimeType: string;
  durationSeconds: number;
  existingTags: string[];
}): Promise<AudioAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return demoFallback(params.durationSeconds, params.mimeType);
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: GENERATE_TIMEOUT_MS },
  });
  const model = getGeminiModel();
  const mimeType = normalizeGeminiAudioMime(params.mimeType);
  const stat = await fsp.stat(params.absPath);
  const prompt = buildPrompt(params.existingTags);

  let uploadedFileName: string | undefined;

  try {
    let mediaPart:
      | { inlineData: { data: string; mimeType: string } }
      | { fileData: { fileUri: string; mimeType: string } };

    if (stat.size <= INLINE_LIMIT_BYTES) {
      const audioBytes = await fsp.readFile(params.absPath);
      mediaPart = {
        inlineData: {
          data: audioBytes.toString('base64'),
          mimeType,
        },
      };
    } else {
      const uploaded = await ai.files.upload({
        file: params.absPath,
        config: { mimeType },
      });
      uploadedFileName = uploaded.name;

      let activeFile = uploaded;
      const deadline = Date.now() + FILES_POLL_TIMEOUT_MS;
      while (activeFile.state === 'PROCESSING' && Date.now() < deadline && activeFile.name) {
        await new Promise((r) => setTimeout(r, 1500));
        activeFile = await ai.files.get({ name: activeFile.name });
      }
      if (!activeFile.uri || activeFile.state !== 'ACTIVE') {
        throw new Error(
          `Gemini Files API did not become ACTIVE in time (state: ${activeFile.state ?? 'unknown'}).`,
        );
      }

      mediaPart = {
        fileData: {
          fileUri: activeFile.uri,
          mimeType: activeFile.mimeType || mimeType,
        },
      };
    }

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
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.2,
        abortSignal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      },
    });

    const text = response.text?.trim();
    if (!text) {
      throw new Error('Gemini returned an empty response.');
    }

    const parsed = JSON.parse(text) as Partial<AudioAnalysisResult>;
    return sanitizeResult(parsed);
  } finally {
    if (uploadedFileName) {
      await ai.files.delete({ name: uploadedFileName }).catch(() => {});
    }
  }
}
