import { buildNoteFilename, buildObsidianMarkdown } from '../markdown';
import type { Recording, StoredVaultHandle, VaultExportState } from '../types';
import {
  clearStoredVaultHandle,
  getStoredVaultHandle,
  getVaultHandleHistory,
  rememberVaultHandleHistory,
  saveStoredVaultHandle,
} from './db';

export type VaultPermissionState = 'unsupported' | 'disconnected' | 'prompt' | 'granted';

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<FileSystemDirectoryHandle>;
}

interface PermissionHandle extends FileSystemDirectoryHandle {
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

export function supportsVaultPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'
  );
}

function generateVaultId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `vault_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function isNotFoundError(err: unknown): boolean {
  return (
    (err instanceof DOMException || err instanceof Error) &&
    err.name === 'NotFoundError'
  );
}

export function isPermissionError(err: unknown): boolean {
  return (
    (err instanceof DOMException || err instanceof Error) &&
    (err.name === 'NotAllowedError' || err.name === 'SecurityError')
  );
}

export async function sha256Text(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function queryVaultPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const permHandle = handle as PermissionHandle;
  if (typeof permHandle.queryPermission === 'function') {
    try {
      return await permHandle.queryPermission({ mode: 'readwrite' });
    } catch {
      return 'prompt';
    }
  }
  return 'granted';
}

export async function requestVaultPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const permHandle = handle as PermissionHandle;
  if (typeof permHandle.requestPermission === 'function') {
    try {
      return await permHandle.requestPermission({ mode: 'readwrite' });
    } catch {
      return 'denied';
    }
  }
  return 'granted';
}

export async function loadVaultConnection(): Promise<{
  stored: StoredVaultHandle | null;
  permission: VaultPermissionState;
}> {
  if (!supportsVaultPicker()) {
    return { stored: null, permission: 'unsupported' };
  }
  const stored = await getStoredVaultHandle();
  if (!stored) {
    return { stored: null, permission: 'disconnected' };
  }
  const state = await queryVaultPermission(stored.handle);
  return {
    stored,
    permission: state === 'granted' ? 'granted' : 'prompt',
  };
}

/**
 * Prompts the user to pick an Obsidian vault folder (ideally a dedicated
 * Tapeleaf subfolder inside Device storage). Checks all previously connected
 * handles via isSameEntry() so disconnecting and reselecting the same folder
 * preserves its vaultId and external-edit hash baselines.
 */
export async function pickVaultFolder(
  previous: StoredVaultHandle | null,
): Promise<{ stored: StoredVaultHandle; isNewDestination: boolean }> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new Error('Folder access is not supported in this browser.');
  }

  const handle = await picker({
    id: 'tapeleaf-obsidian',
    mode: 'readwrite',
  });

  const perm = await requestVaultPermission(handle);
  if (perm !== 'granted') {
    throw new Error('Read/write permission was not granted for the selected folder.');
  }

  let matchedVaultId: string | null = null;
  if (previous) {
    try {
      if (await handle.isSameEntry(previous.handle)) {
        matchedVaultId = previous.vaultId;
      }
    } catch {
      // ignore
    }
  }

  if (!matchedVaultId) {
    const history = await getVaultHandleHistory();
    for (const entry of history) {
      try {
        if (await handle.isSameEntry(entry.handle)) {
          matchedVaultId = entry.vaultId;
          break;
        }
      } catch {
        // ignore invalid historical handle
      }
    }
  }

  const vaultId = matchedVaultId ?? generateVaultId();
  const connectedAt = new Date().toISOString();
  const stored: StoredVaultHandle = {
    key: 'obsidian-vault',
    vaultId,
    folderName: handle.name || 'Obsidian Vault',
    handle,
    connectedAt,
  };

  await saveStoredVaultHandle(stored);
  await rememberVaultHandleHistory({
    vaultId,
    folderName: stored.folderName,
    handle,
    connectedAt,
  });

  return { stored, isNewDestination: !matchedVaultId };
}

export async function disconnectVaultFolder(): Promise<void> {
  // Keep vault history so reconnecting the same folder restores hash baselines
  await clearStoredVaultHandle();
}

type FileReadResult =
  | { status: 'missing' }
  | { status: 'exists'; text: string }
  | { status: 'error'; error: unknown };

async function readFileStrict(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<FileReadResult> {
  try {
    const fileHandle = await dir.getFileHandle(name);
    const file = await fileHandle.getFile();
    return { status: 'exists', text: await file.text() };
  } catch (err) {
    if (isNotFoundError(err)) {
      return { status: 'missing' };
    }
    return { status: 'error', error: err };
  }
}

async function checkAttachmentNonEmpty(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<'present' | 'missing'> {
  try {
    const fileHandle = await dir.getFileHandle(name);
    const file = await fileHandle.getFile();
    return file.size > 0 ? 'present' : 'missing';
  } catch (err) {
    if (isNotFoundError(err)) return 'missing';
    throw err;
  }
}

async function writeBlobToFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: Blob | string,
): Promise<void> {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
}

export function getVaultExportFor(
  recording: Recording,
  vaultId: string | null | undefined,
): VaultExportState | undefined {
  if (!vaultId) return undefined;
  return recording.vaultExports?.[vaultId];
}

export function needsVaultWrite(recording: Recording, activeVaultId: string | null): boolean {
  if (!activeVaultId) return false;
  const v = getVaultExportFor(recording, activeVaultId);
  if (!v) return true;
  if (v.state === 'conflict') return false; // Wait for explicit user choice
  if (v.state !== 'written') return true;
  if (!v.audioWritten) return true;
  return v.lastExportedRevision < recording.revision;
}

export interface VaultWriteOutcome {
  vaultState: VaultExportState;
  permissionLost: boolean;
}

/**
 * Reserves the frozen filename via onReserveFilename BEFORE touching disk,
 * writes and closes audio before Markdown, treats only NotFoundError as file
 * absence, and requires explicit forceOverwrite whenever an existing vault note
 * differs from a trusted baseline (or has no baseline).
 */
export async function writeRecordingToVault(params: {
  vault: StoredVaultHandle;
  recording: Recording;
  audioBlob: Blob | null;
  forceOverwrite?: boolean;
  onReserveFilename: (reserved: VaultExportState) => Promise<void>;
}): Promise<VaultWriteOutcome> {
  const { vault, recording, audioBlob, forceOverwrite = false, onReserveFilename } = params;
  const existingForVault = getVaultExportFor(recording, vault.vaultId);
  const frozenFilename =
    existingForVault?.filename || buildNoteFilename(recording, vault.vaultId);

  const audioFilename =
    recording.audioFilename ||
    recording.audioPath.split('/').pop() ||
    `${recording.id}.m4a`;

  // Persist chosen filename BEFORE first filesystem write so a crash + title change cannot create a duplicate note
  if (!existingForVault) {
    await onReserveFilename({
      vaultId: vault.vaultId,
      filename: frozenFilename,
      audioWritten: false,
      lastExportedRevision: -1,
      lastExportedHash: '',
      state: 'unsynced',
    });
  }

  try {
    // 1. Ensure audio/ subfolder exists and verify attachment is present & non-empty
    const audioDir = await vault.handle.getDirectoryHandle('audio', { create: true });
    let audioStatus = await checkAttachmentNonEmpty(audioDir, audioFilename);

    if (audioStatus === 'missing') {
      if (!audioBlob) {
        return {
          permissionLost: false,
          vaultState: {
            vaultId: vault.vaultId,
            filename: frozenFilename,
            audioWritten: false,
            lastExportedRevision: existingForVault?.lastExportedRevision ?? -1,
            lastExportedHash: existingForVault?.lastExportedHash ?? '',
            state: 'error',
            error: 'Local audio blob is missing and could not be written to the vault.',
          },
        };
      }
      await writeBlobToFile(audioDir, audioFilename, audioBlob);
      audioStatus = await checkAttachmentNonEmpty(audioDir, audioFilename);
      if (audioStatus !== 'present') {
        throw new Error('Audio file appeared empty after writing to the vault folder.');
      }
    }

    // 2. Build exact Markdown content & compute SHA-256
    const markdown = buildObsidianMarkdown(recording);
    const nextHash = await sha256Text(markdown);

    // 3. Strictly inspect disk note before overwriting
    const diskRead = await readFileStrict(vault.handle, frozenFilename);
    if (diskRead.status === 'error') {
      throw diskRead.error;
    }

    if (diskRead.status === 'exists' && !forceOverwrite) {
      const diskHash = await sha256Text(diskRead.text);
      if (diskHash === nextHash) {
        // Already identical on disk (e.g. crash between close() and IDB commit)
        return {
          permissionLost: false,
          vaultState: {
            vaultId: vault.vaultId,
            filename: frozenFilename,
            audioWritten: true,
            lastExportedRevision: recording.revision,
            lastExportedHash: nextHash,
            state: 'written',
            writtenAt: new Date().toISOString(),
          },
        };
      }

      const lastKnownHash = existingForVault?.lastExportedHash || '';
      // Require confirmation if file has no trusted baseline OR changed externally in Obsidian
      if (!lastKnownHash || diskHash !== lastKnownHash) {
        return {
          permissionLost: false,
          vaultState: {
            vaultId: vault.vaultId,
            filename: frozenFilename,
            audioWritten: true,
            lastExportedRevision: existingForVault?.lastExportedRevision ?? -1,
            lastExportedHash: lastKnownHash,
            state: 'conflict',
            error: lastKnownHash
              ? 'This note was edited in Obsidian since Tapeleaf last wrote it. Choose whether to overwrite or keep the Obsidian version.'
              : 'A note with this filename already exists in the vault with different content. Choose whether to overwrite or keep the Obsidian version.',
            writtenAt: existingForVault?.writtenAt,
          },
        };
      }
    }

    // 4. Write Markdown note cleanly
    await writeBlobToFile(vault.handle, frozenFilename, markdown);

    return {
      permissionLost: false,
      vaultState: {
        vaultId: vault.vaultId,
        filename: frozenFilename,
        audioWritten: true,
        lastExportedRevision: recording.revision,
        lastExportedHash: nextHash,
        state: 'written',
        writtenAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    const permissionLost = isPermissionError(err);
    const message = permissionLost
      ? 'Folder permission was revoked or expired. Tap Reconnect folder to resume writing.'
      : err instanceof Error
        ? err.message
        : 'Could not write files to Obsidian folder.';
    return {
      permissionLost,
      vaultState: {
        vaultId: vault.vaultId,
        filename: frozenFilename,
        audioWritten: existingForVault?.audioWritten ?? false,
        lastExportedRevision: existingForVault?.lastExportedRevision ?? -1,
        lastExportedHash: existingForVault?.lastExportedHash ?? '',
        state: 'error',
        error: message,
        writtenAt: existingForVault?.writtenAt,
      },
    };
  }
}

/**
 * Explicit opt-in deletion from the connected Obsidian folder. Treats ONLY
 * NotFoundError as already removed; surfaces permission or I/O failures so
 * partial deletions are never hidden.
 */
export async function deleteRecordingFromVault(
  vault: StoredVaultHandle,
  recording: Recording,
): Promise<{ ok: true } | { ok: false; permissionLost: boolean; error: string }> {
  const filename =
    getVaultExportFor(recording, vault.vaultId)?.filename ||
    buildNoteFilename(recording, vault.vaultId);

  const errors: string[] = [];
  let permissionLost = false;

  try {
    await vault.handle.removeEntry(filename);
  } catch (err) {
    if (!isNotFoundError(err)) {
      if (isPermissionError(err)) permissionLost = true;
      errors.push(`note (${filename}): ${err instanceof Error ? err.message : 'delete failed'}`);
    }
  }

  try {
    const audioDir = await vault.handle.getDirectoryHandle('audio');
    const audioName = recording.audioFilename || recording.audioPath.split('/').pop();
    if (audioName) {
      await audioDir.removeEntry(audioName);
    }
  } catch (err) {
    if (!isNotFoundError(err)) {
      if (isPermissionError(err)) permissionLost = true;
      errors.push(`audio: ${err instanceof Error ? err.message : 'delete failed'}`);
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      permissionLost,
      error: permissionLost
        ? 'Folder permission was revoked. Reconnect the vault folder before deleting vault files.'
        : `Could not delete from vault (${errors.join('; ')}). Local copy was kept.`,
    };
  }

  return { ok: true };
}
