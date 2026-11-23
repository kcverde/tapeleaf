import {
  buildDesiredNoteFilename,
  buildObsidianMarkdown,
} from '../markdown';
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

export async function readVaultNoteHash(
  vault: StoredVaultHandle,
  filename: string,
): Promise<string | null> {
  if (!filename.trim()) return null;
  const read = await readFileStrict(vault.handle, filename);
  if (read.status !== 'exists') return null;
  return sha256Text(read.text);
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

/**
 * Returns true if `prevFilename` already matches `desiredBase` or a numeric
 * collision variant of it (e.g. "Foo (2).md"), without falsely matching
 * distinct titles containing parentheses (like "Foo (bar).md").
 */
export function matchesDesiredFilename(prevFilename: string, desiredBase: string): boolean {
  if (!prevFilename) return false;
  if (prevFilename === desiredBase) return true;
  const stem = desiredBase.replace(/\.md$/, '');
  if (!prevFilename.startsWith(stem)) return false;
  const tail = prevFilename.slice(stem.length);
  return /^ \(\d+\)\.md$/.test(tail);
}

async function pickNonCollidingFilename(
  dir: FileSystemDirectoryHandle,
  recording: Recording,
  currentOwnedFilename?: string,
): Promise<string> {
  for (let i = 1; i <= 99; i += 1) {
    const candidate = buildDesiredNoteFilename(recording, i);
    if (candidate === currentOwnedFilename) return candidate;
    const read = await readFileStrict(dir, candidate);
    if (read.status === 'error') throw read.error;
    if (read.status === 'missing') return candidate;
  }

  const stem = buildDesiredNoteFilename(recording).replace(/\.md$/, '');
  const idSuffix = recording.id.slice(-6) || 'note';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const extra = attempt === 0 ? idSuffix : `${idSuffix}-${attempt + 1}`;
    const candidate = `${stem} (${extra}).md`;
    if (candidate === currentOwnedFilename) return candidate;
    const read = await readFileStrict(dir, candidate);
    if (read.status === 'error') throw read.error;
    if (read.status === 'missing') return candidate;
  }

  throw new Error('Could not find a unique filename in the Obsidian vault folder.');
}

export function getVaultExportFor(
  recording: Recording,
  vaultId: string | null | undefined,
): VaultExportState | undefined {
  if (!vaultId) return undefined;
  return recording.vaultExports?.[vaultId];
}

export function hasDeletableVaultArtifacts(
  recording: Recording,
  vaultId: string | null | undefined,
): boolean {
  const v = getVaultExportFor(recording, vaultId);
  if (!v) return false;
  return Boolean(v.filename.trim()) || Boolean(v.audioWritten);
}

export function needsVaultWrite(recording: Recording, activeVaultId: string | null): boolean {
  if (!activeVaultId) return false;
  const v = getVaultExportFor(recording, activeVaultId);
  if (!v) return true;
  if (v.state === 'conflict' || v.state === 'kept-vault') return false;
  if (v.state !== 'written') return true;
  if (!v.audioWritten) return true;
  return v.lastExportedRevision < recording.revision;
}

export interface VaultWriteOutcome {
  vaultState: VaultExportState;
  permissionLost: boolean;
  aborted?: boolean;
}

/**
 * Writes audio first (and closes it) before writing the Markdown note.
 * Filenames follow "YYYY-MM-DD HH.MM - Concise Subject.md". Callers MUST hold
 * a per-destination lock (`vault:${vault.vaultId}`) so filename allocation and
 * renames cannot race across recordings.
 */
export async function writeRecordingToVault(params: {
  vault: StoredVaultHandle;
  recording: Recording;
  audioBlob: Blob | null;
  forceOverwrite?: boolean;
  deferMarkdown?: boolean;
  isStillActive?: () => boolean;
  onReserveFilename: (reserved: VaultExportState) => Promise<void>;
}): Promise<VaultWriteOutcome> {
  const {
    vault,
    recording,
    audioBlob,
    forceOverwrite = false,
    deferMarkdown = false,
    isStillActive,
    onReserveFilename,
  } = params;

  const existingForVault = getVaultExportFor(recording, vault.vaultId);
  const prevFilename = existingForVault?.filename || '';
  const desiredBase = buildDesiredNoteFilename(recording);

  const audioFilename =
    recording.audioFilename ||
    recording.audioPath.split('/').pop() ||
    `${recording.id}.m4a`;

  const abortedResult = (): VaultWriteOutcome => ({
    aborted: true,
    permissionLost: false,
    vaultState: existingForVault ?? {
      vaultId: vault.vaultId,
      filename: '',
      audioWritten: false,
      lastExportedRevision: -1,
      lastExportedHash: '',
      state: 'unsynced',
    },
  });

  if (isStillActive && !isStillActive()) {
    return abortedResult();
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
            filename: prevFilename,
            audioWritten: false,
            lastExportedRevision: existingForVault?.lastExportedRevision ?? -1,
            lastExportedHash: existingForVault?.lastExportedHash ?? '',
            state: 'error',
            error: 'Local audio blob is missing and could not be written to the vault.',
          },
        };
      }
      if (isStillActive && !isStillActive()) return abortedResult();
      await writeBlobToFile(audioDir, audioFilename, audioBlob);
      audioStatus = await checkAttachmentNonEmpty(audioDir, audioFilename);
      if (audioStatus !== 'present') {
        throw new Error('Audio file appeared empty after writing to the vault folder.');
      }
    }

    // If online transcription is about to title a brand-new clip, stop after saving audio
    // so the .md file lands on first write with its real "YYYY-MM-DD HH.MM - Subject.md" name.
    if (deferMarkdown && !existingForVault?.lastExportedHash) {
      return {
        permissionLost: false,
        vaultState: {
          vaultId: vault.vaultId,
          filename: '',
          audioWritten: true,
          lastExportedRevision: -1,
          lastExportedHash: '',
          state: 'unsynced',
        },
      };
    }

    // 2. Build exact Markdown content & compute SHA-256
    const markdown = buildObsidianMarkdown(recording);
    const nextHash = await sha256Text(markdown);

    // 3. Reconcile any interrupted rename intent from a prior crash before choosing target
    const pendingFromPrior = existingForVault?.pendingFilename || '';
    if (pendingFromPrior && pendingFromPrior !== prevFilename) {
      const pendingRead = await readFileStrict(vault.handle, pendingFromPrior);
      if (pendingRead.status === 'exists') {
        const pendingHash = await sha256Text(pendingRead.text);
        if (pendingHash === nextHash && matchesDesiredFilename(pendingFromPrior, desiredBase)) {
          // Previous write landed right before crash; finish committing and clean old untouched file
          const committedState: VaultExportState = {
            vaultId: vault.vaultId,
            filename: pendingFromPrior,
            pendingFilename: undefined,
            audioWritten: true,
            lastExportedRevision: recording.revision,
            lastExportedHash: nextHash,
            state: 'written',
            writtenAt: new Date().toISOString(),
          };
          await onReserveFilename(committedState);
          if (prevFilename && prevFilename !== pendingFromPrior) {
            await removeOldFileIfUntouched(
              vault.handle,
              prevFilename,
              existingForVault?.lastExportedHash || '',
              forceOverwrite,
            );
          }
          return { permissionLost: false, vaultState: committedState };
        }
      }
    }

    // 4. Determine whether we're updating in place or renaming to match the new subject
    const wantsRename =
      Boolean(prevFilename) && !matchesDesiredFilename(prevFilename, desiredBase);

    if (wantsRename && prevFilename) {
      // Check old file for external edits inside Obsidian before replacing/renaming
      const oldRead = await readFileStrict(vault.handle, prevFilename);
      if (oldRead.status === 'error') throw oldRead.error;
      if (oldRead.status === 'exists' && !forceOverwrite) {
        const oldHash = await sha256Text(oldRead.text);
        const lastKnownHash = existingForVault?.lastExportedHash || '';
        if (!lastKnownHash || oldHash !== lastKnownHash) {
          return {
            permissionLost: false,
            vaultState: {
              vaultId: vault.vaultId,
              filename: prevFilename,
              audioWritten: true,
              lastExportedRevision: existingForVault?.lastExportedRevision ?? -1,
              lastExportedHash: lastKnownHash,
              state: 'conflict',
              error:
                'This note was edited in Obsidian since Tapeleaf last wrote it. Choose whether to overwrite or keep the Obsidian version.',
              writtenAt: existingForVault?.writtenAt,
            },
          };
        }
      }

      const targetFilename = await pickNonCollidingFilename(
        vault.handle,
        recording,
        prevFilename,
      );

      if (isStillActive && !isStillActive()) return abortedResult();

      // Persist rename intent BEFORE writing the new file so a crash can reconcile cleanly
      if (targetFilename !== prevFilename) {
        await onReserveFilename({
          vaultId: vault.vaultId,
          filename: prevFilename,
          pendingFilename: targetFilename,
          audioWritten: true,
          lastExportedRevision: existingForVault?.lastExportedRevision ?? -1,
          lastExportedHash: existingForVault?.lastExportedHash ?? '',
          state: 'unsynced',
          writtenAt: existingForVault?.writtenAt,
        });
      }

      // Re-verify target does not unexpectedly exist right before writing
      if (targetFilename !== prevFilename) {
        const preCheck = await readFileStrict(vault.handle, targetFilename);
        if (preCheck.status === 'error') throw preCheck.error;
        if (preCheck.status === 'exists' && !forceOverwrite) {
          throw new Error(`Target filename "${targetFilename}" appeared concurrently in the vault.`);
        }
      }

      await writeBlobToFile(vault.handle, targetFilename, markdown);

      const nextState: VaultExportState = {
        vaultId: vault.vaultId,
        filename: targetFilename,
        pendingFilename: undefined,
        audioWritten: true,
        lastExportedRevision: recording.revision,
        lastExportedHash: nextHash,
        state: 'written',
        writtenAt: new Date().toISOString(),
      };
      await onReserveFilename(nextState);

      if (targetFilename !== prevFilename) {
        const removeWarn = await removeOldFileIfUntouched(
          vault.handle,
          prevFilename,
          existingForVault?.lastExportedHash || '',
          forceOverwrite,
        );
        if (removeWarn) {
          return {
            permissionLost: false,
            vaultState: {
              ...nextState,
              error: removeWarn,
            },
          };
        }
      }

      return { permissionLost: false, vaultState: nextState };
    }

    // 5. First-time write or same-filename update
    let targetFilename = prevFilename;
    if (!targetFilename) {
      targetFilename = await pickNonCollidingFilename(vault.handle, recording);
      if (isStillActive && !isStillActive()) return abortedResult();
      await onReserveFilename({
        vaultId: vault.vaultId,
        filename: targetFilename,
        audioWritten: true,
        lastExportedRevision: -1,
        lastExportedHash: '',
        state: 'unsynced',
      });
    }

    const diskRead = await readFileStrict(vault.handle, targetFilename);
    if (diskRead.status === 'error') throw diskRead.error;

    if (diskRead.status === 'exists' && !forceOverwrite) {
      const diskHash = await sha256Text(diskRead.text);
      if (diskHash === nextHash) {
        return {
          permissionLost: false,
          vaultState: {
            vaultId: vault.vaultId,
            filename: targetFilename,
            audioWritten: true,
            lastExportedRevision: recording.revision,
            lastExportedHash: nextHash,
            state: 'written',
            writtenAt: new Date().toISOString(),
          },
        };
      }

      const lastKnownHash = existingForVault?.lastExportedHash || '';
      if (!lastKnownHash || diskHash !== lastKnownHash) {
        return {
          permissionLost: false,
          vaultState: {
            vaultId: vault.vaultId,
            filename: targetFilename,
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

    if (isStillActive && !isStillActive()) return abortedResult();
    await writeBlobToFile(vault.handle, targetFilename, markdown);

    return {
      permissionLost: false,
      vaultState: {
        vaultId: vault.vaultId,
        filename: targetFilename,
        pendingFilename: undefined,
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
        filename: prevFilename,
        pendingFilename: existingForVault?.pendingFilename,
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

async function removeOldFileIfUntouched(
  dir: FileSystemDirectoryHandle,
  oldFilename: string,
  lastKnownHash: string,
  forceOverwrite: boolean,
): Promise<string | null> {
  try {
    if (!forceOverwrite) {
      const check = await readFileStrict(dir, oldFilename);
      if (check.status === 'missing') return null;
      if (check.status === 'error') {
        return `Renamed note, but could not verify old file (${oldFilename}).`;
      }
      const currentHash = await sha256Text(check.text);
      if (!lastKnownHash || currentHash !== lastKnownHash) {
        return `Renamed note, but kept "${oldFilename}" because it changed in Obsidian.`;
      }
    }
    await dir.removeEntry(oldFilename);
    return null;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    return `Renamed note, but could not remove old file "${oldFilename}".`;
  }
}

export type VaultDeleteResult =
  | { ok: true; deletedNote: boolean; deletedAudio: boolean }
  | {
      ok: false;
      permissionLost: boolean;
      modifiedInVault?: boolean;
      deletedNote: boolean;
      deletedAudio: boolean;
      error: string;
    };

/**
 * Deletes only verified, previously exported files belonging to this recording
 * in the active vault. Never guesses a fallback Markdown filename, and refuses
 * to delete externally modified Obsidian notes unless `forceDeleteModified` is set.
 */
export async function deleteRecordingFromVault(
  vault: StoredVaultHandle,
  recording: Recording,
  options?: { forceDeleteModified?: boolean },
): Promise<VaultDeleteResult> {
  const existing = getVaultExportFor(recording, vault.vaultId);
  if (!existing) {
    return { ok: true, deletedNote: false, deletedAudio: false };
  }

  const recordedFilename = existing.filename.trim();
  const forceDeleteModified = Boolean(options?.forceDeleteModified);

  // Verify Markdown note hasn't been externally modified in Obsidian before deleting anything
  if (recordedFilename && !forceDeleteModified) {
    const read = await readFileStrict(vault.handle, recordedFilename);
    if (read.status === 'error') {
      const permLost = isPermissionError(read.error);
      return {
        ok: false,
        permissionLost: permLost,
        deletedNote: false,
        deletedAudio: false,
        error: permLost
          ? 'Folder permission was revoked. Reconnect the vault folder before deleting vault files.'
          : `Could not verify "${recordedFilename}" before deleting. Local copy was kept.`,
      };
    }

    if (read.status === 'exists') {
      const diskHash = await sha256Text(read.text);
      const unmodified =
        existing.state === 'written' &&
        Boolean(existing.lastExportedHash) &&
        diskHash === existing.lastExportedHash;

      if (!unmodified) {
        return {
          ok: false,
          permissionLost: false,
          modifiedInVault: true,
          deletedNote: false,
          deletedAudio: false,
          error: `"${recordedFilename}" was modified in Obsidian since Tapeleaf last wrote it. Confirm to delete the modified Obsidian note, or delete locally only.`,
        };
      }
    }
  }

  const errors: string[] = [];
  let permissionLost = false;
  let deletedNote = false;
  let deletedAudio = false;

  if (recordedFilename) {
    try {
      await vault.handle.removeEntry(recordedFilename);
      deletedNote = true;
    } catch (err) {
      if (!isNotFoundError(err)) {
        if (isPermissionError(err)) permissionLost = true;
        errors.push(
          `note (${recordedFilename}): ${err instanceof Error ? err.message : 'delete failed'}`,
        );
      }
    }
  }

  if (existing.audioWritten) {
    try {
      const audioDir = await vault.handle.getDirectoryHandle('audio');
      const audioName = recording.audioFilename || recording.audioPath.split('/').pop();
      if (audioName) {
        await audioDir.removeEntry(audioName);
        deletedAudio = true;
      }
    } catch (err) {
      if (!isNotFoundError(err)) {
        if (isPermissionError(err)) permissionLost = true;
        errors.push(`audio: ${err instanceof Error ? err.message : 'delete failed'}`);
      }
    }
  }

  if (errors.length > 0) {
    const partialNote =
      deletedNote && !deletedAudio
        ? ' The Markdown note was deleted, but its audio attachment could not be removed.'
        : !deletedNote && deletedAudio
          ? ' The audio attachment was deleted, but the Markdown note could not be removed.'
          : '';
    return {
      ok: false,
      permissionLost,
      deletedNote,
      deletedAudio,
      error: permissionLost
        ? `Folder permission was revoked.${partialNote} Reconnect the vault folder to finish deleting.`
        : `Could not delete from vault (${errors.join('; ')}).${partialNote} Local copy was kept.`,
    };
  }

  return { ok: true, deletedNote, deletedAudio };
}
