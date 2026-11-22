export type RecordingStatus = 'queued' | 'processing' | 'ready' | 'failed';

export type VaultSyncState = 'unsynced' | 'written' | 'conflict' | 'error';

export interface VaultExportState {
  vaultId: string;
  filename: string;
  audioWritten: boolean;
  lastExportedRevision: number;
  lastExportedHash: string;
  state: VaultSyncState;
  error?: string;
  writtenAt?: string;
}

export interface Recording {
  id: string;
  title: string;
  created: string;
  durationSeconds: number;
  language: string;
  languageName: string;
  isEnglish: boolean;
  status: RecordingStatus;
  summary: string;
  tags: string[];
  /** Relative path inside the vault folder, e.g. audio/rec_...m4a */
  audioPath: string;
  /** Stable basename of the audio file, e.g. rec_...m4a */
  audioFilename: string;
  audioMimeType: string;
  audioSizeBytes: number;
  englishTranscript: string;
  originalTranscript?: string;
  errorMessage?: string;
  revision: number;
  userEditedTitle?: boolean;
  userEditedTags?: boolean;
  /** Per-destination vault export history keyed by vaultId */
  vaultExports?: Record<string, VaultExportState>;
}

export interface AudioRecord {
  id: string;
  blob: Blob;
  mimeType: string;
  sizeBytes: number;
}

export interface CapturedAudio {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  extension: string;
}

export interface StoredVaultHandle {
  key: 'obsidian-vault';
  vaultId: string;
  folderName: string;
  handle: FileSystemDirectoryHandle;
  connectedAt: string;
}

export interface VaultHistoryEntry {
  vaultId: string;
  folderName: string;
  handle: FileSystemDirectoryHandle;
  connectedAt: string;
}

export interface StoredVaultHistory {
  key: 'obsidian-vault-history';
  entries: VaultHistoryEntry[];
}
