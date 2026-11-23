import type {
  AudioRecord,
  DraftChunkRecord,
  RecoverableDraft,
  Recording,
  RecordingDraft,
  StoredRemoteDeletes,
  StoredVaultHandle,
  StoredVaultHistory,
  VaultExportState,
  VaultHistoryEntry,
} from '../types';

const DB_NAME = 'tapeleaf-pwa-v1';
const DB_VERSION = 2;
const STORE_RECORDINGS = 'recordings';
const STORE_AUDIO = 'audio';
const STORE_META = 'meta';
const STORE_DRAFTS = 'drafts';
const STORE_DRAFT_CHUNKS = 'draft_chunks';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      dbPromise = null;
      reject(new Error('IndexedDB is not available in this browser context.'));
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction;
      let recordingsStore: IDBObjectStore;
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        recordingsStore = db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
      } else if (tx) {
        recordingsStore = tx.objectStore(STORE_RECORDINGS);
      } else {
        return;
      }

      if (!recordingsStore.indexNames.contains('by_status')) {
        recordingsStore.createIndex('by_status', 'status', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        db.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
        db.createObjectStore(STORE_DRAFTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_DRAFT_CHUNKS)) {
        const chunkStore = db.createObjectStore(STORE_DRAFT_CHUNKS, { keyPath: 'key' });
        chunkStore.createIndex('by_draftId', 'draftId', { unique: false });
      }
    };

    req.onblocked = () => {
      dbPromise = null;
      reject(
        new Error(
          'Local database upgrade is blocked by another open Tapeleaf tab. Close other tabs and retry.',
        ),
      );
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };

    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Could not open local Tapeleaf database.'));
    };
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function isQuotaError(err: unknown): boolean {
  if (!(err instanceof DOMException || err instanceof Error)) return false;
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.message.toLowerCase().includes('quota')
  );
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    // ignore
  }
  return false;
}

export async function getStorageStats(): Promise<{
  persisted: boolean;
  usageBytes: number;
  quotaBytes: number;
}> {
  let persisted = false;
  let usageBytes = 0;
  let quotaBytes = 0;
  try {
    if (navigator.storage?.persisted) {
      persisted = await navigator.storage.persisted();
    }
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      usageBytes = est.usage ?? 0;
      quotaBytes = est.quota ?? 0;
    }
  } catch {
    // ignore
  }
  return { persisted, usageBytes, quotaBytes };
}

/**
 * Cross-tab lock using Web Locks API when available, falling back to a
 * per-name in-memory promise chain so queue drains and vault ops never race.
 */
const fallbackLocks = new Map<string, Promise<unknown>>();

export async function withQueueLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(`tapeleaf:${name}`, () => fn());
  }
  const prev = fallbackLocks.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  fallbackLocks.set(name, tail);
  void tail.finally(() => {
    if (fallbackLocks.get(name) === tail) {
      fallbackLocks.delete(name);
    }
  });
  return next;
}

/**
 * High-entropy recording ID: UTC timestamp + 64-bit (16 hex) random suffix so
 * collisions are effectively impossible across concurrent saves and filenames.
 */
export function generateRecordingId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `rec_${date}_${time}_${suffix}`;
}

export async function listRecordings(): Promise<Recording[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDINGS, 'readonly');
  const all = await reqToPromise<Recording[]>(tx.objectStore(STORE_RECORDINGS).getAll());
  return all.sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
}

export async function listRecordingsByStatus(
  status: Recording['status'],
): Promise<Recording[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDINGS, 'readonly');
  const store = tx.objectStore(STORE_RECORDINGS);
  const rows = store.indexNames.contains('by_status')
    ? await reqToPromise<Recording[]>(store.index('by_status').getAll(status))
    : (await reqToPromise<Recording[]>(store.getAll())).filter((r) => r.status === status);
  return rows.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
}

export async function getRecording(id: string): Promise<Recording | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDINGS, 'readonly');
  const rec = await reqToPromise<Recording | undefined>(
    tx.objectStore(STORE_RECORDINGS).get(id),
  );
  return rec ?? null;
}

export async function getAudioRecord(id: string): Promise<AudioRecord | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_AUDIO, 'readonly');
  const rec = await reqToPromise<AudioRecord | undefined>(
    tx.objectStore(STORE_AUDIO).get(id),
  );
  return rec ?? null;
}

/**
 * Atomically inserts a brand-new recording and its audio Blob using IDB `add`
 * (never silently overwriting an existing ID). Resolves only after tx.oncomplete.
 */
export async function saveRecordingAtomic(
  recording: Recording,
  audio: AudioRecord,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_RECORDINGS, STORE_AUDIO], 'readwrite');
  tx.objectStore(STORE_RECORDINGS).add(recording);
  tx.objectStore(STORE_AUDIO).add(audio);
  await txDone(tx);
}

/**
 * Recovers any recordings abandoned mid-processing (e.g., phone killed tab).
 * Runs under the processing lock so it never collides with an active job in another tab.
 */
export async function recoverAbandonedJobs(isOnline: boolean): Promise<Recording[]> {
  return withQueueLock('processing', async () => {
    const db = await openDb();
    const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDINGS);
    const processing = store.indexNames.contains('by_status')
      ? await reqToPromise<Recording[]>(store.index('by_status').getAll('processing'))
      : (await reqToPromise<Recording[]>(store.getAll())).filter((r) => r.status === 'processing');

    for (const rec of processing) {
      const updated: Recording = {
        ...rec,
        status: isOnline ? 'failed' : 'queued',
        errorMessage: isOnline
          ? 'Interrupted before transcription finished. Tap Retry processing.'
          : undefined,
        revision: (rec.revision ?? 0) + 1,
      };
      store.put(updated);
    }
    await txDone(tx);
    return listRecordings();
  });
}

export async function updateRecordingUserEdits(
  id: string,
  patch: { title?: string; tags?: string[] },
): Promise<Recording | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
  const store = tx.objectStore(STORE_RECORDINGS);
  const existing = await reqToPromise<Recording | undefined>(store.get(id));
  if (!existing) return null;

  const updated: Recording = {
    ...existing,
    title:
      patch.title !== undefined ? patch.title.trim() || existing.title : existing.title,
    tags: patch.tags !== undefined ? patch.tags : existing.tags,
    userEditedTitle: patch.title !== undefined ? true : existing.userEditedTitle,
    userEditedTags: patch.tags !== undefined ? true : existing.userEditedTags,
    revision: (existing.revision ?? 0) + 1,
  };
  store.put(updated);
  await txDone(tx);
  return updated;
}

export async function markRecordingStatus(
  id: string,
  status: Recording['status'],
  errorMessage?: string,
): Promise<Recording | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
  const store = tx.objectStore(STORE_RECORDINGS);
  const existing = await reqToPromise<Recording | undefined>(store.get(id));
  if (!existing) return null;

  const updated: Recording = {
    ...existing,
    status,
    errorMessage: status === 'failed' ? errorMessage : undefined,
    revision: (existing.revision ?? 0) + 1,
  };
  store.put(updated);
  await txDone(tx);
  return updated;
}

/**
 * Applies Gemini transcription results safely: checks the recording still exists
 * (never resurrects deleted notes) and preserves any title/tag edits made while
 * transcription was in flight.
 */
export async function applyGeminiResult(
  id: string,
  analysis: {
    title: string;
    summary: string;
    tags: string[];
    language: string;
    languageName: string;
    isEnglish: boolean;
    englishTranscript: string;
    originalTranscript?: string;
  },
): Promise<Recording | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
  const store = tx.objectStore(STORE_RECORDINGS);
  const existing = await reqToPromise<Recording | undefined>(store.get(id));
  if (!existing) return null;

  const updated: Recording = {
    ...existing,
    status: 'ready',
    title: existing.userEditedTitle
      ? existing.title
      : analysis.title.trim() || existing.title,
    tags: existing.userEditedTags ? existing.tags : analysis.tags,
    summary: analysis.summary,
    language: analysis.language,
    languageName: analysis.languageName,
    isEnglish: analysis.isEnglish,
    englishTranscript: analysis.englishTranscript,
    originalTranscript: analysis.isEnglish ? undefined : analysis.originalTranscript,
    errorMessage: undefined,
    revision: (existing.revision ?? 0) + 1,
  };
  store.put(updated);
  await txDone(tx);
  return updated;
}

/**
 * Updates per-destination vault export state without losing history for other
 * previously connected vault folders.
 */
export async function updateRecordingVaultExport(
  id: string,
  vaultExport: VaultExportState,
): Promise<Recording | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDINGS, 'readwrite');
  const store = tx.objectStore(STORE_RECORDINGS);
  const existing = await reqToPromise<Recording | undefined>(store.get(id));
  if (!existing) return null;

  const updated: Recording = {
    ...existing,
    vaultExports: {
      ...(existing.vaultExports ?? {}),
      [vaultExport.vaultId]: vaultExport,
    },
  };
  store.put(updated);
  await txDone(tx);
  return updated;
}

export async function deleteRecordingLocal(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_RECORDINGS, STORE_AUDIO], 'readwrite');
  tx.objectStore(STORE_RECORDINGS).delete(id);
  tx.objectStore(STORE_AUDIO).delete(id);
  await txDone(tx);
}

// --- Mid-recording draft chunk persistence (crash/OS-kill recovery) ---

export async function upsertRecordingDraft(draft: RecordingDraft): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_DRAFTS, 'readwrite');
  tx.objectStore(STORE_DRAFTS).put(draft);
  await txDone(tx);
}

export async function appendDraftChunk(
  draftId: string,
  seq: number,
  blob: Blob,
  durationSeconds: number,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_DRAFTS, STORE_DRAFT_CHUNKS], 'readwrite');
  const chunkRecord: DraftChunkRecord = {
    key: `${draftId}:${String(seq).padStart(6, '0')}`,
    draftId,
    seq,
    blob,
  };
  tx.objectStore(STORE_DRAFT_CHUNKS).put(chunkRecord);

  const draftStore = tx.objectStore(STORE_DRAFTS);
  const existing = await reqToPromise<RecordingDraft | undefined>(draftStore.get(draftId));
  if (existing) {
    draftStore.put({
      ...existing,
      durationSeconds: Math.max(existing.durationSeconds, Math.round(durationSeconds)),
      updatedAt: new Date().toISOString(),
    });
  }
  await txDone(tx);
}

export async function listRecoverableDrafts(): Promise<RecoverableDraft[]> {
  const db = await openDb();
  const tx = db.transaction([STORE_DRAFTS, STORE_DRAFT_CHUNKS], 'readonly');
  const drafts = await reqToPromise<RecordingDraft[]>(tx.objectStore(STORE_DRAFTS).getAll());
  if (drafts.length === 0) return [];

  const chunkIndex = tx.objectStore(STORE_DRAFT_CHUNKS).index('by_draftId');
  const results: RecoverableDraft[] = [];

  for (const draft of drafts) {
    const chunks = await reqToPromise<DraftChunkRecord[]>(chunkIndex.getAll(draft.id));
    chunks.sort((a, b) => a.seq - b.seq);
    const blobs = chunks.map((c) => c.blob).filter((b) => b && b.size > 0);
    if (blobs.length === 0) continue;
    const combined = new Blob(blobs, { type: draft.mimeType || 'audio/webm' });
    if (combined.size > 0) {
      results.push({ draft, blob: combined });
    }
  }

  return results.sort((a, b) => Date.parse(b.draft.updatedAt) - Date.parse(a.draft.updatedAt));
}

export async function deleteRecordingDraft(draftId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_DRAFTS, STORE_DRAFT_CHUNKS], 'readwrite');
  tx.objectStore(STORE_DRAFTS).delete(draftId);
  const chunkStore = tx.objectStore(STORE_DRAFT_CHUNKS);
  const keys = await reqToPromise<IDBValidKey[]>(
    chunkStore.index('by_draftId').getAllKeys(draftId),
  );
  for (const key of keys) {
    chunkStore.delete(key);
  }
  await txDone(tx);
}

// --- Vault handle & history persistence ---

export async function getStoredVaultHandle(): Promise<StoredVaultHandle | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readonly');
  const rec = await reqToPromise<StoredVaultHandle | undefined>(
    tx.objectStore(STORE_META).get('obsidian-vault'),
  );
  return rec ?? null;
}

export async function saveStoredVaultHandle(record: StoredVaultHandle): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).put(record);
  await txDone(tx);
}

export async function clearStoredVaultHandle(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  tx.objectStore(STORE_META).delete('obsidian-vault');
  await txDone(tx);
}

export async function getVaultHandleHistory(): Promise<VaultHistoryEntry[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readonly');
  const rec = await reqToPromise<StoredVaultHistory | undefined>(
    tx.objectStore(STORE_META).get('obsidian-vault-history'),
  );
  return rec?.entries ?? [];
}

export async function rememberVaultHandleHistory(entry: VaultHistoryEntry): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_META, 'readwrite');
  const store = tx.objectStore(STORE_META);
  const existing = await reqToPromise<StoredVaultHistory | undefined>(
    store.get('obsidian-vault-history'),
  );
  const prevEntries = existing?.entries ?? [];
  const nextEntries = [
    entry,
    ...prevEntries.filter((e) => e.vaultId !== entry.vaultId),
  ].slice(0, 12);
  store.put({
    key: 'obsidian-vault-history',
    entries: nextEntries,
  } satisfies StoredVaultHistory);
  await txDone(tx);
}

// --- Pending Gemini Files API remote delete queue ---

export async function getPendingRemoteDeletes(): Promise<string[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_META, 'readonly');
    const rec = await reqToPromise<StoredRemoteDeletes | undefined>(
      tx.objectStore(STORE_META).get('gemini-pending-deletes'),
    );
    return rec?.names ?? [];
  } catch {
    return [];
  }
}

export async function addPendingRemoteDelete(fileName: string): Promise<void> {
  if (!fileName) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    const existing = await reqToPromise<StoredRemoteDeletes | undefined>(
      store.get('gemini-pending-deletes'),
    );
    const next = Array.from(new Set([...(existing?.names ?? []), fileName])).slice(-50);
    store.put({
      key: 'gemini-pending-deletes',
      names: next,
    } satisfies StoredRemoteDeletes);
    await txDone(tx);
  } catch {
    // best effort
  }
}

export async function removePendingRemoteDelete(fileName: string): Promise<void> {
  if (!fileName) return;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    const existing = await reqToPromise<StoredRemoteDeletes | undefined>(
      store.get('gemini-pending-deletes'),
    );
    if (!existing) return;
    const next = existing.names.filter((n) => n !== fileName);
    store.put({
      key: 'gemini-pending-deletes',
      names: next,
    } satisfies StoredRemoteDeletes);
    await txDone(tx);
  } catch {
    // best effort
  }
}
