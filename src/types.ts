export type RecordingStatus = 'queued' | 'processing' | 'ready' | 'failed';

export type VaultSyncState = 'unsynced' | 'written' | 'conflict' | 'kept-vault' | 'error';

export interface VaultExportState {
  vaultId: string;
  filename: string;
  /** Target filename reserved prior to a rename write for crash-safe recovery */
  pendingFilename?: string;
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
  /** Draft ID in IndexedDB to clear once persisted to recordings/audio stores */
  draftId?: string;
}

export interface RecordingDraft {
  id: string;
  created: string;
  mimeType: string;
  extension: string;
  durationSeconds: number;
  updatedAt: string;
}

export interface DraftChunkRecord {
  key: string;
  draftId: string;
  seq: number;
  blob: Blob;
}

export interface RecoverableDraft {
  draft: RecordingDraft;
  blob: Blob;
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

export interface StoredRemoteDeletes {
  key: 'gemini-pending-deletes';
  names: string[];
}
