import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, FolderOpen, Moon, Settings, Sun, WifiOff } from 'lucide-react';
import { DetailPane } from './components/DetailPane';
import type { DeleteRequestOutcome } from './components/DetailPane';
import { LibraryPane } from './components/LibraryPane';
import { RecordDock } from './components/RecordDock';
import type { UnsavedCapture } from './components/RecordDock';
import { SettingsModal } from './components/SettingsModal';
import { TapeleafMark } from './components/TapeleafMark';
import type { RecorderStatus } from './hooks/useRecorder';
import {
  applyGeminiResult,
  deleteRecordingDraft,
  deleteRecordingLocal,
  generateRecordingId,
  getAudioRecord,
  getRecording,
  isQuotaError,
  listRecordings,
  listRecordingsByStatus,
  listRecoverableDrafts,
  markRecordingStatus,
  recoverAbandonedJobs,
  requestPersistentStorage,
  saveRecordingAtomic,
  updateRecordingUserEdits,
  updateRecordingVaultExport,
  withQueueLock,
} from './lib/db';
import {
  GeminiClientError,
  analyzeAudioBlob,
  flushPendingRemoteDeletes,
  loadGeminiSettings,
  saveGeminiSettings,
} from './lib/geminiClient';
import { registerServiceWorker } from './lib/swRegistration';
import type { SwRegistrationStatus, SwUpdateHandle } from './lib/swRegistration';
import {
  deleteRecordingFromVault,
  disconnectVaultFolder,
  getVaultExportFor,
  loadVaultConnection,
  needsVaultWrite,
  pickVaultFolder,
  queryVaultPermission,
  readVaultNoteHash,
  requestVaultPermission,
  writeRecordingToVault,
} from './lib/vaultSync';
import type { VaultPermissionState } from './lib/vaultSync';
import type { CapturedAudio, RecoverableDraft, Recording, StoredVaultHandle } from './types';

type ThemeMode = 'light' | 'dark';

const NETWORK_BACKOFF_MS = [15_000, 30_000, 60_000] as const;

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage.getItem('tapeleaf-theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // ignore storage restrictions
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function syncThemeColorMeta(theme: ThemeMode) {
  const color = theme === 'dark' ? '#0E0E10' : '#FAF9F7';
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length > 0) {
    for (const meta of metas) {
      meta.content = color;
    }
  }
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string>('');
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [geminiSettings, setGeminiSettings] = useState(loadGeminiSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [queuePausedReason, setQueuePausedReason] = useState<string | null>(null);
  const [geminiUnreachable, setGeminiUnreachable] = useState(false);

  const [vault, setVault] = useState<StoredVaultHandle | null>(null);
  const [vaultPermission, setVaultPermission] = useState<VaultPermissionState>('disconnected');
  const [vaultBannerError, setVaultBannerError] = useState<string | null>(null);

  const [savingCount, setSavingCount] = useState(0);
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>('idle');
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const [unsavedCaptures, setUnsavedCaptures] = useState<UnsavedCapture[]>([]);
  const [recoveredDrafts, setRecoveredDrafts] = useState<RecoverableDraft[]>([]);
  const [pendingSwUpdate, setPendingSwUpdate] = useState<SwUpdateHandle | null>(null);
  const [pendingSwReload, setPendingSwReload] = useState(false);
  const [swStatus, setSwStatus] = useState<SwRegistrationStatus | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const savedTimerRef = useRef<number | null>(null);
  const networkRetryTimerRef = useRef<number | null>(null);
  const networkRetryAttemptRef = useRef(0);
  const lastResumeTsRef = useRef(0);

  const geminiSettingsRef = useRef(geminiSettings);
  geminiSettingsRef.current = geminiSettings;
  const queuePausedRef = useRef(queuePausedReason);
  queuePausedRef.current = queuePausedReason;
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const vaultPermRef = useRef(vaultPermission);
  vaultPermRef.current = vaultPermission;
  const vaultGenRef = useRef(0);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const drainActiveRef = useRef(false);
  const drainAgainRef = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    syncThemeColorMeta(theme);
  }, [theme]);

  useEffect(() => {
    return registerServiceWorker({
      onUpdateReady: (handle) => setPendingSwUpdate(handle),
      onControllerUpdated: () => setPendingSwReload(true),
      onStatusChange: (status) => setSwStatus(status),
    });
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
      if (networkRetryTimerRef.current) window.clearTimeout(networkRetryTimerRef.current);
    };
  }, []);

  const flashToast = useCallback((label: string) => {
    setSavedToast(label);
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => setSavedToast(null), 2600);
  }, []);

  const refreshLibrary = useCallback(async () => {
    const list = await listRecordings();
    setStorageError(null);
    setRecordings(list);
    setSelectedId((prev) => {
      if (prev && list.some((r) => r.id === prev)) return prev;
      return list[0]?.id ?? '';
    });
    return list;
  }, []);

  const recheckVaultPermission = useCallback(async (): Promise<VaultPermissionState> => {
    const current = vaultRef.current;
    const gen = vaultGenRef.current;
    if (!current) return vaultPermRef.current;
    const perm = await queryVaultPermission(current.handle);
    // Ignore stale result if the user connected/disconnected while checking
    if (vaultGenRef.current !== gen || vaultRef.current?.vaultId !== current.vaultId) {
      return vaultPermRef.current;
    }
    const next: VaultPermissionState = perm === 'granted' ? 'granted' : 'prompt';
    setVaultPermission(next);
    vaultPermRef.current = next;
    return next;
  }, []);

  /**
   * All vault writes serialize under a per-destination lock (`vault:${vaultId}`)
   * and check the active vault connection generation before touching disk.
   */
  const syncSingleToVault = useCallback(
    async (
      id: string,
      options?: {
        forceOverwrite?: boolean;
        deferMarkdown?: boolean;
        expectedGen?: number;
      },
    ) => {
      const expectedGen = options?.expectedGen ?? vaultGenRef.current;
      const activeVault = vaultRef.current;
      if (!activeVault || vaultPermRef.current !== 'granted') return null;

      return withQueueLock(`vault:${activeVault.vaultId}`, async () => {
        // Re-check inside lock so disconnect/folder-switch aborts cleanly
        if (
          vaultGenRef.current !== expectedGen ||
          vaultRef.current?.vaultId !== activeVault.vaultId ||
          vaultPermRef.current !== 'granted'
        ) {
          return null;
        }

        const rec = await getRecording(id);
        if (!rec) return null;
        const audio = await getAudioRecord(id);
        const outcome = await writeRecordingToVault({
          vault: activeVault,
          recording: rec,
          audioBlob: audio?.blob ?? null,
          forceOverwrite: options?.forceOverwrite,
          deferMarkdown: options?.deferMarkdown,
          isStillActive: () =>
            vaultGenRef.current === expectedGen &&
            vaultRef.current?.vaultId === activeVault.vaultId &&
            vaultPermRef.current === 'granted',
          onReserveFilename: async (reserved) => {
            const saved = await updateRecordingVaultExport(id, reserved);
            if (saved) {
              setRecordings((prev) => prev.map((r) => (r.id === id ? saved : r)));
            }
          },
        });

        if (outcome.aborted) return null;

        if (outcome.permissionLost && vaultGenRef.current === expectedGen) {
          setVaultPermission('prompt');
          vaultPermRef.current = 'prompt';
          setVaultBannerError('Folder access expired. Tap Reconnect to resume writing.');
        }

        const updated = await updateRecordingVaultExport(id, outcome.vaultState);
        if (updated) {
          setRecordings((prev) => prev.map((r) => (r.id === id ? updated : r)));
        }
        return outcome;
      });
    },
    [],
  );

  const flushVaultWrites = useCallback(
    async (expectedGenOverride?: number): Promise<{
      written: number;
      failed: number;
      permissionLost: boolean;
    }> => {
      const activeVault = vaultRef.current;
      const gen = expectedGenOverride ?? vaultGenRef.current;
      if (!activeVault) return { written: 0, failed: 0, permissionLost: false };

      if (expectedGenOverride === undefined) {
        const currentPerm = await recheckVaultPermission();
        if (currentPerm !== 'granted' || vaultGenRef.current !== gen) {
          return { written: 0, failed: 0, permissionLost: currentPerm !== 'granted' };
        }
      }

      let written = 0;
      let failed = 0;
      let permissionLost = false;
      const current = await listRecordings();
      for (const rec of current) {
        if (
          vaultGenRef.current !== gen ||
          vaultRef.current?.vaultId !== activeVault.vaultId ||
          vaultPermRef.current !== 'granted'
        ) {
          break;
        }
        if (!needsVaultWrite(rec, activeVault.vaultId)) continue;
        const defer =
          rec.status === 'processing' &&
          !getVaultExportFor(rec, activeVault.vaultId)?.filename;
        const outcome = await syncSingleToVault(rec.id, {
          deferMarkdown: defer,
          expectedGen: gen,
        });
        if (!outcome) continue;
        if (outcome.permissionLost) {
          permissionLost = true;
          failed += 1;
          break;
        }
        if (outcome.vaultState.state === 'written') written += 1;
        else if (outcome.vaultState.state === 'error') failed += 1;
      }
      return { written, failed, permissionLost };
    },
    [recheckVaultPermission, syncSingleToVault],
  );

  const scheduleNetworkRetryRef = useRef<() => void>(() => {});

  const drainTranscriptionQueue = useCallback(async () => {
    if (!navigator.onLine) return;
    if (drainActiveRef.current) {
      drainAgainRef.current = true;
      return;
    }

    if (networkRetryTimerRef.current) {
      window.clearTimeout(networkRetryTimerRef.current);
      networkRetryTimerRef.current = null;
    }

    drainActiveRef.current = true;
    try {
      do {
        drainAgainRef.current = false;
        await withQueueLock('processing', async () => {
          if (!navigator.onLine || queuePausedRef.current) return;
          const initialKey = geminiSettingsRef.current.apiKey.trim();
          if (!initialKey) return;

          // Best-effort cleanup of any interrupted Files API uploads
          void flushPendingRemoteDeletes(initialKey);

          const queued = await listRecordingsByStatus('queued');
          if (queued.length === 0) {
            networkRetryAttemptRef.current = 0;
            setGeminiUnreachable(false);
            return;
          }

          const allForTags = await listRecordings();
          const tagCounts = new Map<string, number>();
          for (const r of allForTags) {
            for (const t of r.tags) {
              tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
            }
          }
          const existingTags = [...tagCounts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 15)
            .map(([t]) => t);

          for (const item of queued) {
            if (!navigator.onLine || queuePausedRef.current) break;
            const { apiKey, model } = geminiSettingsRef.current;
            if (!apiKey.trim()) break;

            const latest = await getRecording(item.id);
            if (!latest || latest.status !== 'queued') continue;

            const audio = await getAudioRecord(item.id);
            if (!audio) {
              await markRecordingStatus(item.id, 'failed', 'Local audio blob is missing.');
              await refreshLibrary();
              continue;
            }

            const marked = await markRecordingStatus(item.id, 'processing');
            if (!marked) continue;
            setRecordings((prev) => prev.map((r) => (r.id === item.id ? marked : r)));

            try {
              const analysis = await analyzeAudioBlob({
                apiKey,
                model,
                blob: audio.blob,
                mimeType: audio.mimeType || latest.audioMimeType,
                existingTags,
              });

              networkRetryAttemptRef.current = 0;
              setGeminiUnreachable(false);
              setQueuePausedReason(null);
              queuePausedRef.current = null;

              const updated = await applyGeminiResult(item.id, {
                title: analysis.title,
                summary: analysis.summary,
                tags: analysis.tags,
                language: analysis.languageCode,
                languageName: analysis.detectedLanguage,
                isEnglish: analysis.isEnglish,
                englishTranscript: analysis.englishTranslation,
                originalTranscript: analysis.isEnglish
                  ? undefined
                  : analysis.originalTranscript,
              });

              if (updated) {
                setRecordings((prev) => prev.map((r) => (r.id === item.id ? updated : r)));
                void syncSingleToVault(item.id);
              }
            } catch (err) {
              const gErr =
                err instanceof GeminiClientError
                  ? err
                  : new GeminiClientError(
                      'other',
                      err instanceof Error ? err.message : 'Transcription failed.',
                    );

              if (gErr.kind === 'network') {
                const requeued = await markRecordingStatus(item.id, 'queued');
                if (requeued) {
                  setRecordings((prev) => prev.map((r) => (r.id === item.id ? requeued : r)));
                  void syncSingleToVault(item.id);
                }
                if (navigator.onLine) {
                  setGeminiUnreachable(true);
                  scheduleNetworkRetryRef.current();
                }
                break;
              }

              const failed = await markRecordingStatus(item.id, 'failed', gErr.message);
              if (failed) {
                setRecordings((prev) => prev.map((r) => (r.id === item.id ? failed : r)));
                void syncSingleToVault(item.id);
              }

              if (gErr.kind === 'auth' || gErr.kind === 'quota') {
                setQueuePausedReason(gErr.message);
                queuePausedRef.current = gErr.message;
                break;
              }
            }
          }
        });
      } while (drainAgainRef.current);
    } catch {
      // IndexedDB or lock failure during background drain
    } finally {
      drainActiveRef.current = false;
    }
  }, [refreshLibrary, syncSingleToVault]);

  scheduleNetworkRetryRef.current = () => {
    if (networkRetryTimerRef.current) return;
    const idx = Math.min(networkRetryAttemptRef.current, NETWORK_BACKOFF_MS.length - 1);
    const delay = NETWORK_BACKOFF_MS[idx];
    networkRetryAttemptRef.current += 1;
    networkRetryTimerRef.current = window.setTimeout(() => {
      networkRetryTimerRef.current = null;
      if (navigator.onLine && !queuePausedRef.current) {
        void drainTranscriptionQueue();
      }
    }, delay);
  };

  // Initial boot: paint library immediately, surface DB errors, and load recoverable drafts
  useEffect(() => {
    let active = true;
    const boot = async () => {
      setLoadingLibrary(true);
      setStorageError(null);
      try {
        const [initialList, vaultConn, drafts] = await Promise.all([
          listRecordings(),
          loadVaultConnection(),
          listRecoverableDrafts().catch(() => [] as RecoverableDraft[]),
        ]);
        if (!active) return;

        setRecordings(initialList);
        setSelectedId((prev) => {
          if (prev && initialList.some((r) => r.id === prev)) return prev;
          return initialList[0]?.id ?? '';
        });

        vaultGenRef.current += 1;
        const bootGen = vaultGenRef.current;
        setVault(vaultConn.stored);
        setVaultPermission(vaultConn.permission);
        vaultRef.current = vaultConn.stored;
        vaultPermRef.current = vaultConn.permission;
        setRecoveredDrafts(drafts);

        // Recover abandoned processing jobs asynchronously under the processing lock
        void recoverAbandonedJobs(navigator.onLine)
          .then((recovered) => {
            if (!active) return;
            setRecordings(recovered);
            if (vaultRef.current && vaultPermRef.current === 'granted') {
              void flushVaultWrites(bootGen);
            }
            void drainTranscriptionQueue();
          })
          .catch(() => {});
      } catch (err) {
        if (!active) return;
        setStorageError(
          err instanceof Error
            ? err.message
            : 'Could not open local Tapeleaf database. Check browser storage permissions.',
        );
      } finally {
        if (active) setLoadingLibrary(false);
      }
    };
    void boot();
    return () => {
      active = false;
    };
  }, [bootAttempt, drainTranscriptionQueue, flushVaultWrites]);

  // Foreground-driven permission recheck + queue drain (coalesced across focus & visibilitychange)
  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      networkRetryAttemptRef.current = 0;
      setGeminiUnreachable(false);
      void drainTranscriptionQueue();
    };
    const onOffline = () => setIsOnline(false);

    const onResume = () => {
      const now = Date.now();
      if (now - lastResumeTsRef.current < 600) return;
      lastResumeTsRef.current = now;

      void Promise.all([refreshLibrary(), recheckVaultPermission()])
        .then(([, perm]) => {
          void drainTranscriptionQueue();
          if (perm === 'granted') {
            void flushVaultWrites();
          }
        })
        .catch(() => {});
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') onResume();
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [drainTranscriptionQueue, flushVaultWrites, recheckVaultPermission, refreshLibrary]);

  // Keyboard shortcut: `/` focuses search (disabled while Settings dialog is open)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (settingsOpen) return;
      const target = e.target as HTMLElement | null;
      const isInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;
      if (e.key === '/' && !isInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settingsOpen]);

  // Guard against accidental tab close / reload while recording or holding unsaved audio
  const isSafeForReload =
    recorderStatus === 'idle' && savingCount === 0 && unsavedCaptures.length === 0;

  useEffect(() => {
    if (isSafeForReload) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isSafeForReload]);

  useEffect(() => {
    if (pendingSwReload && isSafeForReload) {
      window.location.reload();
    }
  }, [pendingSwReload, isSafeForReload]);

  const persistCapturedAudio = useCallback(
    async (captured: CapturedAudio, existingUnsavedId?: string) => {
      setSavingCount((c) => c + 1);
      const id = generateRecordingId();
      const audioFilename = `${id}.${captured.extension}`;
      const audioPath = `audio/${audioFilename}`;

      const stub: Recording = {
        id,
        title: 'Voice note',
        created: new Date().toISOString(),
        durationSeconds: Math.max(0, Math.round(captured.durationSeconds)),
        language: 'en',
        languageName: 'English',
        isEnglish: true,
        status: 'queued',
        summary: '',
        tags: [],
        audioPath,
        audioFilename,
        audioMimeType: captured.mimeType || 'audio/mp4',
        audioSizeBytes: captured.blob.size,
        englishTranscript: '',
        revision: 1,
      };

      try {
        await saveRecordingAtomic(stub, {
          id,
          blob: captured.blob,
          mimeType: stub.audioMimeType,
          sizeBytes: captured.blob.size,
        });

        if (captured.draftId) {
          void deleteRecordingDraft(captured.draftId).catch(() => {});
        }

        void requestPersistentStorage();

        if (existingUnsavedId) {
          setUnsavedCaptures((prev) => prev.filter((u) => u.id !== existingUnsavedId));
        }

        setRecordings((prev) => [stub, ...prev.filter((r) => r.id !== id)]);
        setSelectedId(id);
        setSelectedTag(null);
        setSearchQuery('');
        setMobileView('detail');
        flashToast('Saved');

        if (vaultRef.current && vaultPermRef.current === 'granted') {
          const willTranscribeNow =
            navigator.onLine &&
            Boolean(geminiSettingsRef.current.apiKey.trim()) &&
            !queuePausedRef.current;
          void syncSingleToVault(id, { deferMarkdown: willTranscribeNow });
        }

        void drainTranscriptionQueue();
      } catch (err) {
        const message = isQuotaError(err)
          ? 'Device storage is full. Download this audio clip now or free up space and retry.'
          : err instanceof Error
            ? err.message
            : 'Could not save audio to local storage.';
        const unsavedId = existingUnsavedId || `unsaved_${Date.now()}`;
        setUnsavedCaptures((prev) => [
          { id: unsavedId, captured, error: message },
          ...prev.filter((u) => u.id !== unsavedId),
        ]);
      } finally {
        setSavingCount((c) => Math.max(0, c - 1));
      }
    },
    [drainTranscriptionQueue, flashToast, syncSingleToVault],
  );

  const handleRecoverDraftSave = useCallback(
    async (item: RecoverableDraft) => {
      await persistCapturedAudio({
        blob: item.blob,
        mimeType: item.draft.mimeType,
        durationSeconds: item.draft.durationSeconds,
        extension: item.draft.extension,
        draftId: item.draft.id,
      });
      setRecoveredDrafts((prev) => prev.filter((d) => d.draft.id !== item.draft.id));
    },
    [persistCapturedAudio],
  );

  const handleRecoverDraftDiscard = useCallback(async (draftId: string) => {
    await deleteRecordingDraft(draftId).catch(() => {});
    setRecoveredDrafts((prev) => prev.filter((d) => d.draft.id !== draftId));
  }, []);

  const handleConnectVault = useCallback(async () => {
    setVaultBannerError(null);
    const { stored } = await pickVaultFolder(vaultRef.current);
    vaultGenRef.current += 1;
    const nextGen = vaultGenRef.current;
    setVault(stored);
    setVaultPermission('granted');
    vaultRef.current = stored;
    vaultPermRef.current = 'granted';
    const summary = await flushVaultWrites(nextGen);
    if (summary.permissionLost) {
      throw new Error('Folder permission was lost while writing notes.');
    }
    if (summary.failed > 0) {
      throw new Error(`Connected, but ${summary.failed} note(s) failed to write.`);
    }
    flashToast('Vault connected');
  }, [flashToast, flushVaultWrites]);

  const handleReconnectVault = useCallback(async () => {
    setVaultBannerError(null);
    const current = vaultRef.current;
    if (!current) {
      await handleConnectVault();
      return;
    }
    const perm = await requestVaultPermission(current.handle);
    if (perm !== 'granted') {
      const msg =
        'Permission was not granted for the saved folder. Choose the folder again to reconnect.';
      setVaultBannerError(msg);
      throw new Error(msg);
    }

    vaultGenRef.current += 1;
    const nextGen = vaultGenRef.current;
    setVaultPermission('granted');
    vaultPermRef.current = 'granted';
    const summary = await flushVaultWrites(nextGen);
    if (summary.permissionLost) {
      const msg = 'Folder permission was revoked during sync. Choose the folder again.';
      setVaultBannerError(msg);
      throw new Error(msg);
    }
    if (summary.failed > 0) {
      const msg = `Reconnected, but ${summary.failed} note(s) could not be written.`;
      setVaultBannerError(msg);
      throw new Error(msg);
    }
    flashToast(summary.written > 0 ? 'Written to vault' : 'Vault reconnected');
  }, [flashToast, flushVaultWrites, handleConnectVault]);

  const handleConnectVaultInline = useCallback(() => {
    void handleConnectVault().catch((err) => {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setVaultBannerError(
        err instanceof Error ? err.message : 'Could not connect Obsidian folder.',
      );
    });
  }, [handleConnectVault]);

  const handleReconnectVaultInline = useCallback(() => {
    void handleReconnectVault().catch((err) => {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setVaultBannerError(
        err instanceof Error ? err.message : 'Could not reconnect Obsidian folder.',
      );
    });
  }, [handleReconnectVault]);

  const handleDisconnectVault = useCallback(async () => {
    // Bump generation FIRST so any in-flight flush/write loop aborts immediately
    vaultGenRef.current += 1;
    await disconnectVaultFolder();
    setVault(null);
    setVaultPermission('disconnected');
    vaultRef.current = null;
    vaultPermRef.current = 'disconnected';
    setVaultBannerError(null);
  }, []);

  const handleSyncVaultNow = useCallback(async () => {
    const summary = await flushVaultWrites();
    if (summary.permissionLost) {
      throw new Error('Folder access needs reconnection.');
    }
    if (summary.failed > 0) {
      throw new Error(`${summary.failed} note(s) could not be written to the vault.`);
    }
  }, [flushVaultWrites]);

  const handleSaveGeminiSettings = useCallback(
    (next: { apiKey: string; rememberOnDevice: boolean; model: string }) => {
      saveGeminiSettings(next);
      setGeminiSettings(next);
      geminiSettingsRef.current = next;
      setQueuePausedReason(null);
      queuePausedRef.current = null;
      setGeminiUnreachable(false);
      networkRetryAttemptRef.current = 0;
      if (next.apiKey.trim()) {
        void drainTranscriptionQueue();
      }
    },
    [drainTranscriptionQueue],
  );

  const handleReprocess = useCallback(
    async (recording: Recording) => {
      if (recording.status === 'processing') return;
      if (!geminiSettingsRef.current.apiKey.trim()) {
        setSettingsOpen(true);
        return;
      }
      setQueuePausedReason(null);
      queuePausedRef.current = null;
      setGeminiUnreachable(false);
      networkRetryAttemptRef.current = 0;
      const queued = await markRecordingStatus(recording.id, 'queued');
      if (queued) {
        setRecordings((prev) => prev.map((r) => (r.id === recording.id ? queued : r)));
        void drainTranscriptionQueue();
      }
    },
    [drainTranscriptionQueue],
  );

  const handleEditTitle = useCallback(
    async (recording: Recording, nextTitle: string) => {
      const updated = await updateRecordingUserEdits(recording.id, { title: nextTitle });
      if (updated) {
        setRecordings((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        void syncSingleToVault(updated.id);
      }
    },
    [syncSingleToVault],
  );

  const handleAddTag = useCallback(
    async (recording: Recording, tag: string) => {
      const nextTags = [...recording.tags, tag];
      const updated = await updateRecordingUserEdits(recording.id, { tags: nextTags });
      if (updated) {
        setRecordings((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        void syncSingleToVault(updated.id);
      }
    },
    [syncSingleToVault],
  );

  const handleRemoveTag = useCallback(
    async (recording: Recording, tagToRemove: string) => {
      const nextTags = recording.tags.filter((t) => t !== tagToRemove);
      const updated = await updateRecordingUserEdits(recording.id, { tags: nextTags });
      if (updated) {
        setRecordings((prev) => {
          const next = prev.map((r) => (r.id === updated.id ? updated : r));
          return next;
        });
        void syncSingleToVault(updated.id);
      }
      if (selectedTag === tagToRemove) {
        const stillExists = recordings.some(
          (r) => r.id !== recording.id && r.tags.includes(tagToRemove),
        );
        if (!stillExists) setSelectedTag(null);
      }
    },
    [recordings, selectedTag, syncSingleToVault],
  );

  const handleKeepObsidianVersion = useCallback(async (recording: Recording) => {
    const activeVault = vaultRef.current;
    const activeExport = getVaultExportFor(recording, activeVault?.vaultId);
    if (!activeVault || !activeExport) return;

    const observedHash =
      vaultPermRef.current === 'granted' && activeExport.filename
        ? await readVaultNoteHash(activeVault, activeExport.filename)
        : null;

    const updated = await updateRecordingVaultExport(recording.id, {
      ...activeExport,
      state: 'kept-vault',
      lastExportedHash: observedHash ?? activeExport.lastExportedHash,
      lastExportedRevision: recording.revision,
      error: undefined,
    });
    if (updated) {
      setRecordings((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    }
  }, []);

  const handleDelete = useCallback(
    async (
      recording: Recording,
      options: { alsoVault: boolean; forceDeleteModified?: boolean },
    ): Promise<DeleteRequestOutcome> => {
      const activeVault = vaultRef.current;
      const lockName = activeVault ? `vault:${activeVault.vaultId}` : `local:${recording.id}`;

      const result = await withQueueLock(lockName, async (): Promise<DeleteRequestOutcome> => {
        const latestRec = (await getRecording(recording.id)) ?? recording;

        if (options.alsoVault) {
          const currentVault = vaultRef.current;
          if (!currentVault) {
            return { ok: false, error: 'No vault folder is currently connected.' };
          }
          const perm = await recheckVaultPermission();
          if (perm !== 'granted') {
            return {
              ok: false,
              error: 'Reconnect the vault folder first to delete vault files.',
            };
          }
          const delRes = await deleteRecordingFromVault(currentVault, latestRec, {
            forceDeleteModified: options.forceDeleteModified,
          });
          if (!delRes.ok) {
            if (delRes.permissionLost) {
              setVaultPermission('prompt');
              vaultPermRef.current = 'prompt';
            }
            return {
              ok: false,
              error: delRes.error,
              modifiedInVault: delRes.modifiedInVault,
            };
          }
        }

        await deleteRecordingLocal(recording.id);
        return { ok: true };
      });

      if (!result.ok) {
        return result;
      }

      // Reload fresh list from IndexedDB so concurrent transcription updates are never clobbered
      const remaining = await listRecordings();
      setRecordings(remaining);
      if (selectedIdRef.current === recording.id) {
        setSelectedId(remaining[0]?.id ?? '');
        setMobileView('list');
      }
      flashToast('Deleted');
      return { ok: true };
    },
    [flashToast, recheckVaultPermission],
  );

  const toggleTheme = () => {
    setTheme((prev) => {
      const next: ThemeMode = prev === 'light' ? 'dark' : 'light';
      try {
        window.localStorage.setItem('tapeleaf-theme', next);
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rec of recordings) {
      for (const tag of rec.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag]) => tag);
  }, [recordings]);

  const filteredRecordings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return recordings.filter((rec) => {
      if (selectedTag && !rec.tags.includes(selectedTag)) return false;
      if (!q) return true;
      return (
        rec.title.toLowerCase().includes(q) ||
        rec.summary.toLowerCase().includes(q) ||
        rec.languageName.toLowerCase().includes(q) ||
        rec.tags.some((t) => `#${t}`.includes(q)) ||
        rec.englishTranscript.toLowerCase().includes(q) ||
        (rec.originalTranscript?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [recordings, searchQuery, selectedTag]);

  const selectedRecording = useMemo(() => {
    return (
      recordings.find((r) => r.id === selectedId) ??
      filteredRecordings[0] ??
      recordings[0] ??
      null
    );
  }, [recordings, selectedId, filteredRecordings]);

  const pendingVaultCount = useMemo(() => {
    if (!vault) return 0;
    return recordings.filter((r) => needsVaultWrite(r, vault.vaultId)).length;
  }, [recordings, vault]);

  const saving = savingCount > 0;
  const canApplySwUpdate = Boolean(pendingSwUpdate) && isSafeForReload;
  const hasUrgentCaptureUi =
    recorderStatus !== 'idle' || unsavedCaptures.length > 0 || recoveredDrafts.length > 0;

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[var(--canvas)] text-[var(--ink)] flex flex-col-reverse lg:flex-row">
      {/* Viewport-level live region toast + update pill (visible in both mobile list & detail views) */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed top-3 left-1/2 -translate-x-1/2 z-40 flex flex-col items-center gap-2"
      >
        {savedToast && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--ink)] shadow-md">
            <Check className="h-3.5 w-3.5" />
            {savedToast}
          </span>
        )}
        {canApplySwUpdate && (
          <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] pl-3.5 pr-1.5 py-1 text-[12.5px] shadow-md">
            <span className="text-[var(--ink-secondary)]">New version ready</span>
            <button
              type="button"
              onClick={() => pendingSwUpdate?.applyUpdate()}
              className="rounded-full bg-[var(--ink)] px-3 py-1 text-[12px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
            >
              Update
            </button>
          </div>
        )}
      </div>

      {/* LEFT PANE: Library + Search + Tags + Record Dock
          On mobile detail view, stays mounted as a bottom dock if recording/unsaved/recovered */}
      <aside
        className={[
          'flex-col w-full lg:w-[392px] xl:w-[420px] lg:shrink-0 lg:h-full lg:border-r border-[var(--border)] bg-[var(--canvas)]',
          mobileView === 'detail'
            ? hasUrgentCaptureUi
              ? 'flex shrink-0 lg:flex-1 lg:min-h-0'
              : 'hidden lg:flex'
            : 'flex flex-1 min-h-0',
        ].join(' ')}
      >
        {/* Library Chrome & Feed (hidden on mobile detail view so only RecordDock remains docked) */}
        <div
          className={[
            'flex-1 min-h-0 flex-col',
            mobileView === 'detail' ? 'hidden lg:flex' : 'flex',
          ].join(' ')}
        >
          {/* Brand Header */}
          <header className="flex items-center justify-between px-4 sm:px-5 pt-4 pb-3 shrink-0">
            <div className="flex items-center gap-2.5">
              <TapeleafMark />
              <div className="flex items-baseline gap-2">
                <h1 className="text-[17.5px] font-semibold tracking-[-0.02em] text-[var(--ink)]">
                  Tapeleaf
                </h1>
                <span className="text-[12.5px] font-mono tabular-nums text-[var(--ink-muted)]">
                  {recordings.length}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1">
              {!isOnline && (
                <span
                  title="Offline — clips save locally and transcribe when back online"
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-subtle)] px-2.5 py-1 text-[12px] font-medium text-[var(--ink-muted)]"
                >
                  <WifiOff className="h-3 w-3" />
                  Offline
                </span>
              )}
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                aria-label="Open settings"
                title="Settings (Gemini key & Obsidian folder)"
                className="relative flex h-10 w-10 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors cursor-pointer"
              >
                <Settings className="h-[18px] w-[18px]" />
                {(!geminiSettings.apiKey.trim() || (vault && vaultPermission === 'prompt')) && (
                  <span
                    aria-hidden="true"
                    className="absolute top-2 right-2 h-2 w-2 rounded-full bg-[var(--vermilion)]"
                  />
                )}
              </button>
              <button
                type="button"
                onClick={toggleTheme}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
                className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors cursor-pointer"
              >
                {theme === 'dark' ? (
                  <Sun className="h-[18px] w-[18px]" />
                ) : (
                  <Moon className="h-[18px] w-[18px]" />
                )}
              </button>
            </div>
          </header>

          {/* Quiet Contextual Banners */}
          <div className="px-4 sm:px-5 space-y-2 shrink-0">
            {vault && vaultPermission === 'prompt' && (
              <div className="mb-2 rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2.5 text-[13px] space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-[var(--ink)] truncate">
                      Reconnect {vault.folderName}
                    </p>
                    <p className="text-[12px] text-[var(--ink-muted)]">
                      {pendingVaultCount > 0
                        ? `${pendingVaultCount} ${pendingVaultCount === 1 ? 'note' : 'notes'} waiting to write`
                        : 'Tap once to resume writing .md & audio'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleReconnectVaultInline}
                    className="shrink-0 inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-[var(--ink)] px-3 text-[12.5px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    Reconnect
                  </button>
                </div>
                {vaultBannerError && (
                  <div className="flex items-center justify-between gap-2 pt-1 text-[12px] text-[var(--vermilion)]">
                    <span>{vaultBannerError}</span>
                    <button
                      type="button"
                      onClick={handleConnectVaultInline}
                      className="shrink-0 underline font-medium cursor-pointer"
                    >
                      Choose folder
                    </button>
                  </div>
                )}
              </div>
            )}

            {!vault && vaultBannerError && (
              <div
                role="alert"
                className="mb-2 rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2.5 text-[12.5px] flex items-center justify-between gap-2"
              >
                <span className="text-[var(--vermilion)] leading-snug">{vaultBannerError}</span>
                <button
                  type="button"
                  onClick={() => setVaultBannerError(null)}
                  className="shrink-0 text-[12px] font-medium text-[var(--ink-muted)] hover:text-[var(--ink)] cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            )}

            {queuePausedReason && (
              <div className="mb-2 rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2.5 text-[12.5px] flex items-center justify-between gap-2">
                <span className="text-[var(--vermilion)] leading-snug">{queuePausedReason}</span>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[12px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] cursor-pointer"
                >
                  Settings
                </button>
              </div>
            )}
          </div>

          <LibraryPane
            recordings={recordings}
            filteredRecordings={filteredRecordings}
            loadingLibrary={loadingLibrary}
            storageError={storageError}
            onRetryBoot={() => setBootAttempt((n) => n + 1)}
            selectedId={selectedRecording?.id ?? ''}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            searchInputRef={searchInputRef}
            allTags={allTags}
            selectedTag={selectedTag}
            onSelectTag={setSelectedTag}
            onSelectRecording={(id) => {
              setSelectedId(id);
              setMobileView('detail');
            }}
            hasApiKey={Boolean(geminiSettings.apiKey.trim())}
            isOnline={isOnline}
            vault={vault}
            vaultPermission={vaultPermission}
            onOpenSettings={() => setSettingsOpen(true)}
            onConnectVault={handleConnectVaultInline}
          />
        </div>

        {/* Isolated Record Dock (owns useRecorder so live meter never re-renders the library) */}
        <RecordDock
          saving={saving}
          vault={vault}
          vaultPermission={vaultPermission}
          unsavedCaptures={unsavedCaptures}
          recoveredDrafts={recoveredDrafts}
          onCaptureReady={persistCapturedAudio}
          onDismissUnsaved={(id) =>
            setUnsavedCaptures((prev) => prev.filter((p) => p.id !== id))
          }
          onRecoverDraftSave={handleRecoverDraftSave}
          onRecoverDraftDiscard={handleRecoverDraftDiscard}
          onRecorderStatusChange={setRecorderStatus}
        />
      </aside>

      {/* RIGHT PANE: Calm Editorial Detail View */}
      <main
        className={[
          'flex-1 flex-col min-w-0 min-h-0 lg:h-full bg-[var(--surface)]',
          mobileView === 'list' ? 'hidden lg:flex' : 'flex',
        ].join(' ')}
      >
        <DetailPane
          recording={selectedRecording}
          vault={vault}
          vaultPermission={vaultPermission}
          hasApiKey={Boolean(geminiSettings.apiKey.trim())}
          isOnline={isOnline}
          geminiUnreachable={geminiUnreachable}
          onBackToList={() => setMobileView('list')}
          onOpenSettings={() => setSettingsOpen(true)}
          onReconnectVault={handleReconnectVaultInline}
          onSyncSingleToVault={async (id, opts) => {
            await syncSingleToVault(id, opts);
          }}
          onKeepObsidianVersion={handleKeepObsidianVersion}
          onReprocess={handleReprocess}
          onDrainQueueNow={() => {
            setQueuePausedReason(null);
            queuePausedRef.current = null;
            setGeminiUnreachable(false);
            networkRetryAttemptRef.current = 0;
            void drainTranscriptionQueue();
          }}
          onEditTitle={handleEditTitle}
          onAddTag={handleAddTag}
          onRemoveTag={handleRemoveTag}
          onDelete={handleDelete}
        />
      </main>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        apiKey={geminiSettings.apiKey}
        rememberKey={geminiSettings.rememberOnDevice}
        model={geminiSettings.model}
        onSaveGemini={handleSaveGeminiSettings}
        vault={vault}
        vaultPermission={vaultPermission}
        pendingVaultCount={pendingVaultCount}
        recordingCount={recordings.length}
        swStatus={swStatus}
        onConnectVault={handleConnectVault}
        onReconnectVault={handleReconnectVault}
        onDisconnectVault={handleDisconnectVault}
        onSyncVaultNow={handleSyncVaultNow}
      />
    </div>
  );
}
