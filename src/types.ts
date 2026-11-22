export type RecordingStatus = 'processing' | 'ready' | 'failed';

export interface Recording {
  id: string;
  filename?: string;
  title: string;
  created: string;
  durationSeconds: number;
  language: string;
  languageName: string;
  isEnglish: boolean;
  status: RecordingStatus;
  summary: string;
  tags: string[];
  audioPath: string;
  audioUrl?: string;
  audioMimeType?: string;
  englishTranscript: string;
  originalTranscript?: string;
  errorMessage?: string;
}

export interface CapturedAudio {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  extension: string;
}
