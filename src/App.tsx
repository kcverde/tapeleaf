import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileAudio,
  FileText,
  FolderCheck,
  FolderOpen,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  Share2,
  Square,
  Sun,
  Trash2,
  Upload,
  WifiOff,
  X,
} from 'lucide-react';
import { SettingsModal } from './components/SettingsModal';
import { extensionForMimeType, useRecorder } from './hooks/useRecorder';
import {
  applyGeminiResult,
  deleteRecordingLocal,
  generateRecordingId,
  getAudioRecord,
  getRecording,
  isQuotaError,
  listRecordings,
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
  loadGeminiSettings,
  saveGeminiSettings,
} from './lib/geminiClient';
import { registerServiceWorker } from './lib/swRegistration';
import type { SwUpdateHandle } from './lib/swRegistration';
import {
  deleteRecordingFromVault,
  disconnectVaultFolder,
  getVaultExportFor,
  loadVaultConnection,
  needsVaultWrite,
  pickVaultFolder,
  queryVaultPermission,
  requestVaultPermission,
  writeRecordingToVault,
} from './lib/vaultSync';
import type { VaultPermissionState } from './lib/vaultSync';
import {
  buildNoteFilename,
  buildObsidianMarkdown,
  formatBytes,
  formatDuration,
  formatFullTimestamp,
  formatRelativeTime,
  formatTimerMs,
  normalizeTag,
} from './markdown';
import type { CapturedAudio, Recording, StoredVaultHandle } from './types';

type DetailTab = 'english' | 'original' | 'markdown';
type ThemeMode = 'light' | 'dark';

interface UnsavedCapture {
  id: string;
  captured: CapturedAudio;
  error: string;
}

const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
const OBSIDIAN_STANDARD_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MB

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem('tapeleaf-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TapeleafMark() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <circle cx="12.5" cy="16" r="5" stroke="var(--canvas)" strokeWidth="2" />
      <circle cx="12.5" cy="16" r="1.6" fill="var(--vermilion)" />
      <path
        d="M19.5 11.5v9M23 13.5v5"
        stroke="var(--canvas)"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function formatCodecLabel(mimeType: string): string {
  if (!mimeType) return 'AUDIO';
  const lower = mimeType.toLowerCase();
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'AAC · M4A';
  if (lower.includes('opus') && lower.includes('webm')) return 'OPUS · WEBM';
  if (lower.includes('ogg')) return 'OPUS · OGG';
  if (lower.includes('webm')) return 'WEBM';
  return 'AUDIO';
}

async function readAudioDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const done = (secs: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(secs) && secs > 0 ? Math.round(secs) : 0);
    };
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(0);
    audio.src = url;
  });
}

function getSeekableEnd(el: HTMLAudioElement): number {
  if (el.seekable && el.seekable.length > 0) {
    const end = el.seekable.end(el.seekable.length - 1);
    if (Number.isFinite(end) && end > 0) return end;
  }
  return 0;
}

function AudioPlayer({ recording }: { recording: Recording }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [seekableEnd, setSeekableEnd] = useState(0);
  const [rateIndex, setRateIndex] = useState(0);

  const playbackRate = PLAYBACK_RATES[rateIndex];

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;

    setObjectUrl(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setMediaDuration(0);
    setSeekableEnd(0);

    void getAudioRecord(recording.id).then((rec) => {
      if (!active || !rec) return;
      createdUrl = URL.createObjectURL(rec.blob);
      setObjectUrl(createdUrl);
    });

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [recording.id]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, objectUrl]);

  const syncMetrics = (el: HTMLAudioElement) => {
    if (Number.isFinite(el.duration) && el.duration > 0) {
      setMediaDuration(el.duration);
    }
    const end = getSeekableEnd(el);
    if (end > 0) setSeekableEnd(end);
  };

  const togglePlay = async () => {
    const el = audioRef.current;
    if (!el || !objectUrl) return;
    if (el.paused) {
      try {
        await el.play();
      } catch {
        setIsPlaying(false);
      }
    } else {
      el.pause();
    }
  };

  const maxSeekable =
    seekableEnd > 0
      ? seekableEnd
      : mediaDuration > 0
        ? mediaDuration
        : recording.durationSeconds;

  const canSeek = Boolean(objectUrl) && (seekableEnd > 0 || mediaDuration > 0);

  const seekTo = (nextSeconds: number) => {
    const el = audioRef.current;
    if (!el || !canSeek) return;
    const liveEnd = getSeekableEnd(el);
    const upper = liveEnd > 0 ? liveEnd : maxSeekable;
    if (upper <= 0) return;
    const clamped = Math.max(0, Math.min(upper, nextSeconds));
    try {
      el.currentTime = clamped;
      setCurrentTime(clamped);
    } catch {
      // ignore if browser cannot seek yet
    }
  };

  const cycleRate = () => {
    setRateIndex((prev) => (prev + 1) % PLAYBACK_RATES.length);
  };

  const displayDuration = Math.max(mediaDuration, seekableEnd, recording.durationSeconds);
  const scrubberMax = Math.max(maxSeekable, 0.1);
  const progressPct =
    displayDuration > 0 ? Math.min(100, (currentTime / displayDuration) * 100) : 0;

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-subtle)]/75 px-3.5 py-3 sm:px-4 sm:py-3.5">
      <audio
        ref={audioRef}
        src={objectUrl ?? undefined}
        preload="metadata"
        onLoadedMetadata={(e) => syncMetrics(e.currentTarget)}
        onDurationChange={(e) => syncMetrics(e.currentTarget)}
        onProgress={(e) => syncMetrics(e.currentTarget)}
        onTimeUpdate={(e) => {
          setCurrentTime(e.currentTarget.currentTime);
          syncMetrics(e.currentTarget);
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setCurrentTime(0);
        }}
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void togglePlay()}
          disabled={!objectUrl}
          aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--ink)] text-[var(--canvas)] transition-transform hover:opacity-90 active:scale-[0.97] disabled:opacity-40 cursor-pointer"
        >
          {isPlaying ? (
            <Pause className="h-4 w-4 fill-current" />
          ) : (
            <Play className="h-4 w-4 fill-current translate-x-[1px]" />
          )}
        </button>

        <div className="hidden sm:flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => seekTo(currentTime - 10)}
            disabled={!canSeek}
            aria-label="Rewind 10 seconds"
            title="Back 10s"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] transition-colors disabled:opacity-40 cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => seekTo(currentTime + 10)}
            disabled={!canSeek}
            aria-label="Forward 10 seconds"
            title="Forward 10s"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] transition-colors disabled:opacity-40 cursor-pointer"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-w-0 flex-1">
          <input
            type="range"
            min={0}
            max={scrubberMax}
            step={0.05}
            disabled={!canSeek}
            value={Math.min(currentTime, scrubberMax)}
            onChange={(e) => seekTo(Number(e.target.value))}
            aria-label="Audio progress"
            className="tapeleaf-scrubber w-full block disabled:opacity-60"
            style={{
              background: `linear-gradient(to right, var(--ink) 0%, var(--ink) ${progressPct}%, var(--border-strong) ${progressPct}%, var(--border-strong) 100%)`,
              height: '4px',
              borderRadius: '9999px',
            }}
          />
          <div className="mt-1.5 flex items-center justify-between text-[12px] font-mono tabular-nums text-[var(--ink-muted)]">
            <span>{formatDuration(currentTime)}</span>
            <span>{formatDuration(displayDuration)}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={cycleRate}
          aria-label={`Playback speed ${playbackRate}x`}
          title="Change playback speed"
          className="flex h-9 min-w-[48px] shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 font-mono text-[12.5px] font-medium tabular-nums text-[var(--ink-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--ink)] transition-colors cursor-pointer"
        >
          {playbackRate}×
        </button>
      </div>
    </div>
  );
}

function MarkdownPreview({
  markdown,
  filename,
  copied,
  onCopy,
}: {
  markdown: string;
  filename: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const lines = useMemo(() => markdown.trimEnd().split('\n'), [markdown]);

  let inFrontmatter = false;
  let frontmatterClosed = false;

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--code-bg)] overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2.5 bg-[var(--surface-subtle)]/60">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-4 w-4 shrink-0 text-[var(--ink-muted)]" />
          <span className="truncate font-mono text-[12.5px] text-[var(--ink-secondary)]">
            {filename}
          </span>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] transition-colors shrink-0 cursor-pointer"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <pre className="p-4 sm:p-5 text-[13.5px] leading-[1.75] font-mono overflow-x-auto whitespace-pre-wrap break-words text-[var(--ink)]">
        {lines.map((line, index) => {
          if (index === 0 && line === '---') {
            inFrontmatter = true;
            return (
              <div key={index} className="text-[var(--ink-muted)]">
                {line}
              </div>
            );
          }
          if (inFrontmatter && !frontmatterClosed && line === '---') {
            inFrontmatter = false;
            frontmatterClosed = true;
            return (
              <div key={index} className="text-[var(--ink-muted)]">
                {line}
              </div>
            );
          }

          if (inFrontmatter) {
            const colonIdx = line.indexOf(':');
            if (colonIdx > 0 && !line.startsWith('  - ')) {
              const key = line.slice(0, colonIdx + 1);
              const val = line.slice(colonIdx + 1);
              return (
                <div key={index}>
                  <span className="text-[var(--ink-muted)]">{key}</span>
                  <span className="text-[var(--ink-secondary)]">{val}</span>
                </div>
              );
            }
            return (
              <div key={index} className="text-[var(--ink-secondary)]">
                {line}
              </div>
            );
          }

          if (line.startsWith('# ') || line.startsWith('## ')) {
            return (
              <div key={index} className="font-semibold text-[var(--ink)]">
                {line}
              </div>
            );
          }
          if (line.startsWith('> ')) {
            return (
              <div key={index} className="text-[var(--ink-secondary)]">
                {line}
              </div>
            );
          }
          if (line.startsWith('![[')) {
            return (
              <div
                key={index}
                className="text-[var(--ink-muted)] underline decoration-dotted underline-offset-4"
              >
                {line}
              </div>
            );
          }
          if (line.startsWith('<!--')) {
            return (
              <div key={index} className="text-[var(--ink-muted)]/70">
                {line}
              </div>
            );
          }
          return (
            <div key={index} className="text-[var(--ink)]">
              {line || '\u00A0'}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [selectedId, setSelectedId] = useState<string>('');
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('english');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteAlsoFromVault, setDeleteAlsoFromVault] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  const [geminiSettings, setGeminiSettings] = useState(loadGeminiSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [queuePausedReason, setQueuePausedReason] = useState<string | null>(null);

  const [vault, setVault] = useState<StoredVaultHandle | null>(null);
  const [vaultPermission, setVaultPermission] = useState<VaultPermissionState>('disconnected');
  const [vaultBannerError, setVaultBannerError] = useState<string | null>(null);

  const [savingCount, setSavingCount] = useState(0);
  const [savedToast, setSavedToast] = useState<string | null>(null);
  const [unsavedCaptures, setUnsavedCaptures] = useState<UnsavedCapture[]>([]);
  const [pendingSwUpdate, setPendingSwUpdate] = useState<SwUpdateHandle | null>(null);
  const [pendingSwReload, setPendingSwReload] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  const geminiSettingsRef = useRef(geminiSettings);
  geminiSettingsRef.current = geminiSettings;
  const queuePausedRef = useRef(queuePausedReason);
  queuePausedRef.current = queuePausedReason;
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const vaultPermRef = useRef(vaultPermission);
  vaultPermRef.current = vaultPermission;

  const drainActiveRef = useRef(false);
  const drainAgainRef = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    registerServiceWorker({
      onUpdateReady: (handle) => setPendingSwUpdate(handle),
      onControllerUpdated: () => setPendingSwReload(true),
    });
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  const flashToast = useCallback((label: string) => {
    setSavedToast(label);
    if (savedTimerRef.current) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => setSavedToast(null), 2600);
  }, []);

  const refreshLibrary = useCallback(async () => {
    const list = await listRecordings();
    setRecordings(list);
    setSelectedId((prev) => {
      if (prev && list.some((r) => r.id === prev)) return prev;
      return list[0]?.id ?? '';
    });
    return list;
  }, []);

  const recheckVaultPermission = useCallback(async (): Promise<VaultPermissionState> => {
    const current = vaultRef.current;
    if (!current) return vaultPermRef.current;
    const perm = await queryVaultPermission(current.handle);
    const next: VaultPermissionState = perm === 'granted' ? 'granted' : 'prompt';
    setVaultPermission(next);
    vaultPermRef.current = next;
    return next;
  }, []);

  const syncSingleToVault = useCallback(
    async (
      id: string,
      options?: {
        forceOverwrite?: boolean;
        deferMarkdown?: boolean;
        vaultOverride?: StoredVaultHandle | null;
      },
    ) => {
      const activeVault = options?.vaultOverride ?? vaultRef.current;
      const perm = options?.vaultOverride ? 'granted' : vaultPermRef.current;
      if (!activeVault || perm !== 'granted') return null;

      return withQueueLock(`vault:${id}`, async () => {
        const rec = await getRecording(id);
        if (!rec) return null;
        const audio = await getAudioRecord(id);
        const outcome = await writeRecordingToVault({
          vault: activeVault,
          recording: rec,
          audioBlob: audio?.blob ?? null,
          forceOverwrite: options?.forceOverwrite,
          deferMarkdown: options?.deferMarkdown,
          onReserveFilename: async (reserved) => {
            const saved = await updateRecordingVaultExport(id, reserved);
            if (saved) {
              setRecordings((prev) => prev.map((r) => (r.id === id ? saved : r)));
            }
          },
        });

        if (outcome.permissionLost) {
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
    async (vaultOverride?: StoredVaultHandle | null): Promise<{
      written: number;
      failed: number;
      permissionLost: boolean;
    }> => {
      const activeVault = vaultOverride ?? vaultRef.current;
      if (!activeVault) return { written: 0, failed: 0, permissionLost: false };

      if (!vaultOverride) {
        const currentPerm = await recheckVaultPermission();
        if (currentPerm !== 'granted') {
          return { written: 0, failed: 0, permissionLost: true };
        }
      }

      let written = 0;
      let failed = 0;
      let permissionLost = false;
      const current = await listRecordings();
      for (const rec of current) {
        if (!needsVaultWrite(rec, activeVault.vaultId)) continue;
        const defer =
          rec.status === 'processing' &&
          !getVaultExportFor(rec, activeVault.vaultId)?.filename;
        const outcome = await syncSingleToVault(rec.id, {
          vaultOverride: activeVault,
          deferMarkdown: defer,
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

  const drainTranscriptionQueue = useCallback(async () => {
    if (!navigator.onLine) return;
    if (drainActiveRef.current) {
      drainAgainRef.current = true;
      return;
    }

    drainActiveRef.current = true;
    try {
      do {
        drainAgainRef.current = false;
        await withQueueLock('processing', async () => {
          // Re-read credentials & pause state AFTER acquiring lock
          if (!navigator.onLine || queuePausedRef.current) return;
          const initialKey = geminiSettingsRef.current.apiKey.trim();
          if (!initialKey) return;

          const list = await listRecordings();
          const queued = list
            .filter((r) => r.status === 'queued')
            .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));

          if (queued.length === 0) return;

          const tagCounts = new Map<string, number>();
          for (const r of list) {
            for (const t of r.tags) {
              tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
            }
          }
          const existingTags = [...tagCounts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 15)
            .map(([t]) => t);

          for (const item of queued) {
            // Re-read latest settings & pause state before EVERY job so key clears/changes apply immediately
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
    } finally {
      drainActiveRef.current = false;
    }
  }, [refreshLibrary, syncSingleToVault]);

  // Initial boot: paint library immediately without waiting on processing lock,
  // then run non-blocking abandoned-job recovery & queue drains.
  useEffect(() => {
    let active = true;
    const boot = async () => {
      try {
        const [initialList, vaultConn] = await Promise.all([
          listRecordings(),
          loadVaultConnection(),
        ]);
        if (!active) return;

        setRecordings(initialList);
        setSelectedId((prev) => {
          if (prev && initialList.some((r) => r.id === prev)) return prev;
          return initialList[0]?.id ?? '';
        });

        setVault(vaultConn.stored);
        setVaultPermission(vaultConn.permission);
        vaultRef.current = vaultConn.stored;
        vaultPermRef.current = vaultConn.permission;
      } finally {
        if (active) setLoadingLibrary(false);
      }

      // Recover abandoned processing jobs asynchronously under the processing lock
      void recoverAbandonedJobs(navigator.onLine).then((recovered) => {
        if (!active) return;
        setRecordings(recovered);
        if (vaultRef.current && vaultPermRef.current === 'granted') {
          void flushVaultWrites(vaultRef.current);
        }
        void drainTranscriptionQueue();
      });
    };
    void boot();
    return () => {
      active = false;
    };
  }, [drainTranscriptionQueue, flushVaultWrites]);

  // Foreground-driven permission recheck + queue drain
  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      void drainTranscriptionQueue();
    };
    const onOffline = () => setIsOnline(false);
    const onResume = () => {
      void Promise.all([refreshLibrary(), recheckVaultPermission()]).then(([, perm]) => {
        void drainTranscriptionQueue();
        if (perm === 'granted') {
          void flushVaultWrites();
        }
      });
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

  // Keyboard shortcut: `/` focuses search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      if (e.key === '/' && !isInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

        void requestPersistentStorage();

        if (existingUnsavedId) {
          setUnsavedCaptures((prev) => prev.filter((u) => u.id !== existingUnsavedId));
        }

        setRecordings((prev) => [stub, ...prev.filter((r) => r.id !== id)]);
        setSelectedId(id);
        setSelectedTag(null);
        setSearchQuery('');
        setDetailTab('english');
        setMobileView('detail');
        flashToast('Saved');

        if (vaultRef.current && vaultPermRef.current === 'granted') {
          // If online with a Gemini key, write audio immediately and wait ~2-3s for the
          // concise subject before writing the .md file so it lands with the final filename.
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

  const recorder = useRecorder({
    onInterruptedCapture: (captured) => {
      void persistCapturedAudio(captured);
    },
  });

  // Only allow SW updates or controllerchange reloads when capture & persistence are completely safe
  const isSafeForReload =
    recorder.status === 'idle' && savingCount === 0 && unsavedCaptures.length === 0;

  useEffect(() => {
    if (pendingSwReload && isSafeForReload) {
      window.location.reload();
    }
  }, [pendingSwReload, isSafeForReload]);

  const handleStopRecording = async () => {
    const captured = await recorder.stopRecording();
    if (captured) {
      await persistCapturedAudio(captured);
    }
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const durationSeconds = await readAudioDuration(file);
    const mimeType = file.type || 'audio/mp4';
    await persistCapturedAudio({
      blob: file,
      mimeType,
      durationSeconds,
      extension: extensionForMimeType(mimeType, file.name),
    });
  };

  const handleConnectVault = async () => {
    setVaultBannerError(null);
    const { stored } = await pickVaultFolder(vaultRef.current);
    setVault(stored);
    setVaultPermission('granted');
    vaultRef.current = stored;
    vaultPermRef.current = 'granted';
    const summary = await flushVaultWrites(stored);
    if (summary.permissionLost) {
      throw new Error('Folder permission was lost while writing notes.');
    }
    if (summary.failed > 0) {
      throw new Error(`Connected, but ${summary.failed} note(s) failed to write.`);
    }
    flashToast('Vault connected');
  };

  const handleReconnectVault = async () => {
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

    setVaultPermission('granted');
    vaultPermRef.current = 'granted';
    const summary = await flushVaultWrites(current);
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
  };

  const handleDisconnectVault = async () => {
    await disconnectVaultFolder();
    setVault(null);
    setVaultPermission('disconnected');
    vaultRef.current = null;
    vaultPermRef.current = 'disconnected';
    setVaultBannerError(null);
  };

  const handleSyncVaultNow = async () => {
    const summary = await flushVaultWrites();
    if (summary.permissionLost) {
      throw new Error('Folder access needs reconnection.');
    }
    if (summary.failed > 0) {
      throw new Error(`${summary.failed} note(s) could not be written to the vault.`);
    }
  };

  const handleSaveGeminiSettings = (next: {
    apiKey: string;
    rememberOnDevice: boolean;
    model: string;
  }) => {
    saveGeminiSettings(next);
    setGeminiSettings(next);
    geminiSettingsRef.current = next;
    setQueuePausedReason(null);
    queuePausedRef.current = null;
    if (next.apiKey.trim()) {
      void drainTranscriptionQueue();
    }
  };

  const handleReprocess = async (recording: Recording) => {
    if (recording.status === 'processing') return;
    if (!geminiSettings.apiKey.trim()) {
      setSettingsOpen(true);
      return;
    }
    setQueuePausedReason(null);
    queuePausedRef.current = null;
    const queued = await markRecordingStatus(recording.id, 'queued');
    if (queued) {
      setRecordings((prev) => prev.map((r) => (r.id === recording.id ? queued : r)));
      void drainTranscriptionQueue();
    }
  };

  const handleDelete = async (recording: Recording, alsoVault: boolean) => {
    setDeleteError(null);

    // Serialize deletion against concurrent vault exports using the exact same lock
    const result = await withQueueLock(`vault:${recording.id}`, async () => {
      const latestRec = (await getRecording(recording.id)) ?? recording;
      if (alsoVault) {
        const activeVault = vaultRef.current;
        if (!activeVault) {
          return { ok: false as const, error: 'No vault folder is currently connected.' };
        }
        const perm = await recheckVaultPermission();
        if (perm !== 'granted') {
          return {
            ok: false as const,
            error: 'Reconnect the vault folder first to delete vault files.',
          };
        }
        const delRes = await deleteRecordingFromVault(activeVault, latestRec);
        if (!delRes.ok) {
          if (delRes.permissionLost) {
            setVaultPermission('prompt');
            vaultPermRef.current = 'prompt';
          }
          return { ok: false as const, error: delRes.error };
        }
      }

      await deleteRecordingLocal(recording.id);
      return { ok: true as const };
    });

    if (!result.ok) {
      setDeleteError(result.error);
      return;
    }

    setConfirmDeleteId(null);
    setDeleteAlsoFromVault(false);
    setRecordings((prev) => {
      const next = prev.filter((r) => r.id !== recording.id);
      if (selectedId === recording.id) {
        setSelectedId(next[0]?.id ?? '');
        setMobileView('list');
      }
      return next;
    });
  };

  const toggleTheme = () => {
    setTheme((prev) => {
      const next: ThemeMode = prev === 'light' ? 'dark' : 'light';
      window.localStorage.setItem('tapeleaf-theme', next);
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
      const haystack = [
        rec.title,
        rec.summary,
        rec.englishTranscript,
        rec.originalTranscript ?? '',
        rec.languageName,
        rec.tags.map((t) => `#${t}`).join(' '),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
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

  useEffect(() => {
    if (selectedRecording?.isEnglish && detailTab === 'original') {
      setDetailTab('english');
    }
  }, [selectedRecording?.id, selectedRecording?.isEnglish, detailTab]);

  useEffect(() => {
    setEditingTitle(false);
    setAddingTag(false);
    setTagDraft('');
    setConfirmDeleteId(null);
    setDeleteAlsoFromVault(false);
    setDeleteError(null);
  }, [selectedRecording?.id]);

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  useEffect(() => {
    if (addingTag) {
      tagInputRef.current?.focus();
    }
  }, [addingTag]);

  const startEditingTitle = () => {
    if (!selectedRecording || selectedRecording.status === 'processing') return;
    setTitleDraft(selectedRecording.title);
    setEditingTitle(true);
  };

  const commitTitleEdit = async () => {
    if (!selectedRecording) return;
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (trimmed && trimmed !== selectedRecording.title) {
      const updated = await updateRecordingUserEdits(selectedRecording.id, { title: trimmed });
      if (updated) {
        setRecordings((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        void syncSingleToVault(updated.id);
      }
    }
  };

  const handleAddTag = async () => {
    if (!selectedRecording) return;
    const clean = normalizeTag(tagDraft);
    setTagDraft('');
    setAddingTag(false);
    if (clean && !selectedRecording.tags.includes(clean)) {
      const nextTags = [...selectedRecording.tags, clean];
      const updated = await updateRecordingUserEdits(selectedRecording.id, { tags: nextTags });
      if (updated) {
        setRecordings((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        void syncSingleToVault(updated.id);
      }
    }
  };

  const handleRemoveTag = async (recording: Recording, tagToRemove: string) => {
    const nextTags = recording.tags.filter((t) => t !== tagToRemove);
    const updated = await updateRecordingUserEdits(recording.id, { tags: nextTags });
    if (updated) {
      setRecordings((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      void syncSingleToVault(updated.id);
    }
    if (selectedTag === tagToRemove) {
      const stillExists = recordings.some(
        (r) => r.id !== recording.id && r.tags.includes(tagToRemove),
      );
      if (!stillExists) setSelectedTag(null);
    }
  };

  const selectedMarkdown = useMemo(
    () => (selectedRecording ? buildObsidianMarkdown(selectedRecording) : ''),
    [selectedRecording],
  );

  const selectedFilename = useMemo(
    () => (selectedRecording ? buildNoteFilename(selectedRecording, vault?.vaultId) : 'note.md'),
    [selectedRecording, vault?.vaultId],
  );

  const handleCopyMarkdown = async () => {
    if (!selectedRecording) return;
    try {
      await navigator.clipboard.writeText(selectedMarkdown);
      setCopiedId(selectedRecording.id);
      window.setTimeout(() => {
        setCopiedId((cur) => (cur === selectedRecording.id ? null : cur));
      }, 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = selectedMarkdown;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      setCopiedId(selectedRecording.id);
      window.setTimeout(() => {
        setCopiedId((cur) => (cur === selectedRecording.id ? null : cur));
      }, 2000);
    }
  };

  const handleDownloadMarkdown = () => {
    if (!selectedRecording) return;
    const blob = new Blob([selectedMarkdown], { type: 'text/markdown;charset=utf-8' });
    triggerDownload(blob, selectedFilename);
  };

  const handleDownloadAudio = async () => {
    if (!selectedRecording) return;
    const audio = await getAudioRecord(selectedRecording.id);
    if (!audio) return;
    const ext = selectedRecording.audioFilename.split('.').pop() || 'm4a';
    const baseName = selectedFilename.replace(/\.md$/, '');
    triggerDownload(audio.blob, `${baseName}.${ext}`);
  };

  const handleShareAudio = async () => {
    if (!selectedRecording || typeof navigator.share !== 'function') return;
    const audio = await getAudioRecord(selectedRecording.id);
    if (!audio) return;
    const file = new File([audio.blob], selectedRecording.audioFilename, {
      type: audio.mimeType || selectedRecording.audioMimeType,
    });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: selectedRecording.title,
          text: selectedRecording.summary || selectedRecording.title,
          files: [file],
        });
      } else {
        await navigator.share({
          title: selectedRecording.title,
          text: selectedMarkdown,
        });
      }
    } catch {
      // User dismissed share sheet
    }
  };

  const handleKeepObsidianVersion = async (recording: Recording) => {
    const activeExport = getVaultExportFor(recording, vault?.vaultId);
    if (!activeExport) return;
    const updated = await updateRecordingVaultExport(recording.id, {
      ...activeExport,
      state: 'written',
      lastExportedRevision: recording.revision,
      error: undefined,
    });
    if (updated) {
      setRecordings((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    }
  };

  const canUseShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const saving = savingCount > 0;
  const isActiveRecording = recorder.status === 'recording' || recorder.status === 'paused';
  const canApplySwUpdate = Boolean(pendingSwUpdate) && isSafeForReload;

  const selectedVaultExport = selectedRecording
    ? getVaultExportFor(selectedRecording, vault?.vaultId)
    : undefined;

  const isSelectedWrittenToActiveVault =
    Boolean(vault) &&
    selectedVaultExport?.state === 'written' &&
    selectedVaultExport.audioWritten &&
    selectedVaultExport.lastExportedRevision >= (selectedRecording?.revision ?? 0);

  return (
    <div className="h-dvh w-full overflow-hidden bg-[var(--canvas)] text-[var(--ink)] flex flex-col lg:flex-row">
      {/* LEFT PANE: Library + Search + Tags + Record Dock */}
      <aside
        className={[
          'flex flex-col h-full w-full lg:w-[392px] xl:w-[420px] lg:shrink-0 lg:border-r border-[var(--border)] bg-[var(--canvas)]',
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
            {savedToast && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-subtle)] px-2.5 py-1 text-[12px] font-medium text-[var(--ink-secondary)]">
                <Check className="h-3 w-3" />
                {savedToast}
              </span>
            )}
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
              {(!geminiSettings.apiKey.trim() ||
                (vault && vaultPermission === 'prompt')) && (
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
          {canApplySwUpdate && (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[12.5px]">
              <span className="text-[var(--ink-secondary)]">New version ready</span>
              <button
                type="button"
                onClick={() => pendingSwUpdate?.applyUpdate()}
                className="rounded-lg bg-[var(--ink)] px-2.5 py-1 text-[12px] font-medium text-[var(--canvas)] cursor-pointer"
              >
                Update
              </button>
            </div>
          )}

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
                  onClick={() => void handleReconnectVault().catch(() => {})}
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
                    onClick={() => void handleConnectVault().catch(() => {})}
                    className="shrink-0 underline font-medium cursor-pointer"
                  >
                    Choose folder
                  </button>
                </div>
              )}
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

        {/* Search Bar + Tag Filter Pills */}
        <div className="px-4 sm:px-5 pb-3 shrink-0 space-y-2.5">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-[var(--ink-muted)]" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search titles, transcripts, #tags…"
              aria-label="Search voice notes"
              className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-9 text-[14.5px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--border-strong)] focus:outline-none transition-colors"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="absolute right-2 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <kbd className="pointer-events-none hidden lg:inline-flex absolute right-2.5 items-center rounded border border-[var(--border)] bg-[var(--surface-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ink-muted)]">
                /
              </kbd>
            )}
          </div>

          {allTags.length > 0 && (
            <div
              className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5"
              role="tablist"
              aria-label="Filter by tag"
            >
              <button
                type="button"
                onClick={() => setSelectedTag(null)}
                className={[
                  'shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors cursor-pointer',
                  selectedTag === null
                    ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-ink)]'
                    : 'bg-[var(--surface-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]',
                ].join(' ')}
              >
                All
              </button>
              {allTags.map((tag) => {
                const active = selectedTag === tag;
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setSelectedTag(active ? null : tag)}
                    className={[
                      'shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors cursor-pointer',
                      active
                        ? 'bg-[var(--pill-active-bg)] text-[var(--pill-active-ink)]'
                        : 'bg-[var(--surface-subtle)] text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)]',
                    ].join(' ')}
                  >
                    #{tag}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Scannable Library Card Feed */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 pb-4 space-y-2">
          {loadingLibrary ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-2.5"
                >
                  <div className="shimmer-bar h-3.5 w-3/5 rounded-full" />
                  <div className="shimmer-bar h-3 w-11/12 rounded-full" />
                  <div className="shimmer-bar h-2.5 w-1/3 rounded-full" />
                </div>
              ))}
            </div>
          ) : filteredRecordings.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--border-strong)] px-5 py-9 text-center space-y-2.5">
              {recordings.length === 0 ? (
                <>
                  <p className="text-[15px] font-medium text-[var(--ink)]">No voice notes yet</p>
                  <p className="text-[13.5px] leading-relaxed text-[var(--ink-muted)]">
                    Tap <strong>Record</strong> below. Notes save locally on your phone and write
                    straight to your Obsidian vault folder.
                  </p>
                  <div className="pt-1 flex flex-wrap items-center justify-center gap-2">
                    {!geminiSettings.apiKey.trim() && (
                      <button
                        type="button"
                        onClick={() => setSettingsOpen(true)}
                        className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-[var(--ink)] px-3.5 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
                      >
                        <Settings className="h-3.5 w-3.5" />
                        Set up Gemini &amp; Vault
                      </button>
                    )}
                    {geminiSettings.apiKey.trim() &&
                      !vault &&
                      vaultPermission !== 'unsupported' && (
                        <button
                          type="button"
                          onClick={() => void handleConnectVault().catch(() => {})}
                          className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[13px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] cursor-pointer"
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                          Connect Obsidian folder
                        </button>
                      )}
                  </div>
                </>
              ) : (
                <>
                  <p className="text-[14.5px] font-medium text-[var(--ink)]">
                    No matching voice notes
                  </p>
                  <p className="text-[13.5px] text-[var(--ink-muted)]">
                    Try clearing your search or choosing another tag.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedTag(null);
                    }}
                    className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[13px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] cursor-pointer"
                  >
                    Reset filters
                  </button>
                </>
              )}
            </div>
          ) : (
            filteredRecordings.map((rec) => {
              const isSelected = selectedRecording?.id === rec.id;
              const isProcessing = rec.status === 'processing';
              const isQueued = rec.status === 'queued';
              const isFailed = rec.status === 'failed';
              const recVaultExport = getVaultExportFor(rec, vault?.vaultId);
              const writtenToVault =
                Boolean(vault) &&
                recVaultExport?.state === 'written' &&
                recVaultExport.audioWritten &&
                recVaultExport.lastExportedRevision >= rec.revision;
              const hasConflict = Boolean(vault) && recVaultExport?.state === 'conflict';

              return (
                <button
                  key={rec.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(rec.id);
                    setMobileView('detail');
                  }}
                  className={[
                    'group relative w-full text-left rounded-2xl border p-3.5 transition-all cursor-pointer',
                    isSelected
                      ? 'bg-[var(--surface)] border-[var(--ink)]/35 shadow-[0_1px_6px_rgba(0,0,0,0.05)]'
                      : 'bg-[var(--surface)] border-[var(--border)] hover:border-[var(--border-strong)]',
                  ].join(' ')}
                >
                  {isSelected && (
                    <span
                      aria-hidden="true"
                      className="hidden lg:block absolute left-0 top-3.5 bottom-3.5 w-[2.5px] rounded-r-full bg-[var(--ink)]"
                    />
                  )}

                  {isProcessing ? (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--ink)]">
                          <span className="h-2 w-2 rounded-full bg-[var(--vermilion)] animate-pulse" />
                          Listening &amp; organizing…
                        </span>
                        <span className="font-mono text-[12px] tabular-nums text-[var(--ink-muted)]">
                          {formatDuration(rec.durationSeconds)}
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        <div className="shimmer-bar h-3 w-11/12 rounded-full" />
                        <div className="shimmer-bar h-3 w-7/12 rounded-full" />
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-2.5">
                        <h2 className="text-[15.5px] font-medium leading-[1.35] tracking-[-0.01em] text-[var(--ink)]">
                          {rec.title}
                        </h2>
                        <span className="shrink-0 pt-0.5 text-[12px] tabular-nums text-[var(--ink-muted)]">
                          {formatRelativeTime(rec.created)}
                        </span>
                      </div>

                      {isQueued ? (
                        <p className="mt-1.5 text-[13.5px] text-[var(--ink-muted)]">
                          {!geminiSettings.apiKey.trim()
                            ? 'Audio saved · add Gemini key in Settings to transcribe'
                            : !isOnline
                              ? 'Saved offline · will transcribe when back online'
                              : 'Queued for transcription…'}
                        </p>
                      ) : isFailed ? (
                        <p className="mt-1.5 inline-flex items-center gap-1.5 text-[13.5px] text-[var(--vermilion)]">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                          Audio saved · tap to retry transcription
                        </p>
                      ) : (
                        rec.summary && (
                          <p className="mt-1.5 text-[14px] leading-[1.48] text-[var(--ink-secondary)] line-clamp-2">
                            {rec.summary}
                          </p>
                        )
                      )}

                      <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="font-mono text-[12px] tabular-nums text-[var(--ink-muted)]">
                          {formatDuration(rec.durationSeconds)}
                        </span>

                        {!rec.isEnglish && rec.status === 'ready' && (
                          <span className="rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 font-mono text-[11px] font-medium tracking-wide text-[var(--ink-secondary)]">
                            {rec.language.toUpperCase()} → EN
                          </span>
                        )}

                        {writtenToVault && (
                          <span
                            title="Written to Obsidian vault folder"
                            className="inline-flex items-center gap-1 text-[11.5px] text-[var(--ink-muted)]"
                          >
                            <FolderCheck className="h-3 w-3" />
                            Vault
                          </span>
                        )}

                        {hasConflict && (
                          <span className="text-[11.5px] font-medium text-[var(--vermilion)]">
                            Edited in Obsidian
                          </span>
                        )}

                        {rec.tags.slice(0, 4).map((tag) => (
                          <span key={tag} className="text-[12px] text-[var(--ink-muted)]">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Bottom Record Dock */}
        <div className="shrink-0 border-t border-[var(--border)] bg-[var(--canvas)]/95 backdrop-blur-md px-4 sm:px-5 pt-3 safe-bottom">
          {unsavedCaptures.length > 0 && (
            <div className="mb-3 space-y-2 max-h-48 overflow-y-auto">
              {unsavedCaptures.map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] p-3 text-[13px]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="h-4 w-4 shrink-0 text-[var(--vermilion)] mt-0.5" />
                      <div>
                        <p className="font-medium text-[var(--ink)]">
                          Unsaved clip ({formatDuration(item.captured.durationSeconds)})
                        </p>
                        <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">{item.error}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setUnsavedCaptures((prev) => prev.filter((p) => p.id !== item.id))
                      }
                      aria-label="Discard unsaved clip"
                      className="shrink-0 rounded p-0.5 text-[var(--ink-muted)] hover:text-[var(--ink)] cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void persistCapturedAudio(item.captured, item.id)}
                      disabled={saving}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-[var(--ink)] px-3 text-[12.5px] font-medium text-[var(--canvas)] hover:opacity-90 disabled:opacity-50 cursor-pointer"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                        triggerDownload(
                          item.captured.blob,
                          `tapeleaf-unsaved-${stamp}.${item.captured.extension}`,
                        );
                      }}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] px-3 text-[12.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download Audio
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {recorder.error && (
            <div className="mb-3 rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-[12.5px] text-[var(--ink-secondary)]">
              <div className="flex items-start justify-between gap-2">
                <p className="leading-snug">{recorder.error}</p>
                <button
                  type="button"
                  onClick={recorder.clearError}
                  aria-label="Dismiss microphone notice"
                  className="shrink-0 rounded p-0.5 text-[var(--ink-muted)] hover:text-[var(--ink)] cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            onChange={(e) => void handleFileImport(e)}
            className="hidden"
          />

          {isActiveRecording ? (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3.5 shadow-[0_2px_10px_rgba(0,0,0,0.04)]">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      'h-2.5 w-2.5 rounded-full',
                      recorder.status === 'recording'
                        ? 'bg-[var(--vermilion)] record-pulse'
                        : 'bg-[var(--ink-muted)]',
                    ].join(' ')}
                  />
                  <span className="font-mono text-[11.5px] font-medium uppercase tracking-wider text-[var(--ink-muted)]">
                    {recorder.status === 'recording' ? 'Recording' : 'Paused'}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="font-mono text-[16px] font-medium tabular-nums text-[var(--ink)]">
                    {formatTimerMs(recorder.elapsedMs)}
                  </span>
                  <button
                    type="button"
                    onClick={recorder.cancelRecording}
                    aria-label="Discard recording"
                    title="Discard recording"
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div
                className="my-3 flex h-8 items-center justify-between gap-[3px] px-0.5"
                aria-hidden="true"
              >
                {recorder.levels.map((level, i) => {
                  const isRecent =
                    i >= recorder.levels.length - 4 && recorder.status === 'recording';
                  const heightPct = Math.round(Math.max(12, Math.min(100, level * 100)));
                  return (
                    <span
                      key={i}
                      className="flex-1 rounded-full transition-[height] duration-75"
                      style={{
                        height: `${heightPct}%`,
                        backgroundColor: isRecent ? 'var(--vermilion)' : 'var(--border-strong)',
                        opacity: recorder.status === 'paused' ? 0.45 : isRecent ? 0.95 : 0.75,
                      }}
                    />
                  );
                })}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={
                    recorder.status === 'recording'
                      ? recorder.pauseRecording
                      : recorder.resumeRecording
                  }
                  className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] px-3 text-[14px] font-medium text-[var(--ink)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
                >
                  {recorder.status === 'recording' ? (
                    <>
                      <Pause className="h-4 w-4" />
                      Pause
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 fill-current" />
                      Resume
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => void handleStopRecording()}
                  className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[var(--vermilion)] px-3 text-[14px] font-medium text-white hover:bg-[var(--vermilion-hover)] transition-colors cursor-pointer"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                  Stop &amp; Save
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2.5">
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium text-[var(--ink)]">
                  {saving
                    ? 'Saving audio…'
                    : recorder.status === 'requesting'
                      ? 'Requesting mic…'
                      : 'Ready to record'}
                </p>
                <p className="font-mono text-[11.5px] tracking-wide text-[var(--ink-muted)] truncate">
                  {formatCodecLabel(recorder.supportedMimeType)}
                  {vault && vaultPermission === 'granted'
                    ? ` · ${vault.folderName}`
                    : ' · On-device'}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={saving || recorder.status === 'requesting'}
                  title="Import audio file"
                  aria-label="Import audio file"
                  className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--ink-muted)] hover:border-[var(--border-strong)] hover:text-[var(--ink)] transition-colors disabled:opacity-50 cursor-pointer"
                >
                  <Upload className="h-4 w-4" />
                </button>

                <button
                  type="button"
                  onClick={() => void recorder.startRecording()}
                  disabled={saving || recorder.status === 'requesting'}
                  aria-label="Start recording"
                  className="group relative flex h-[52px] items-center gap-2.5 rounded-full bg-[var(--vermilion)] pl-4 pr-5 text-white shadow-[0_2px_10px_rgba(229,72,77,0.28)] hover:bg-[var(--vermilion-hover)] active:scale-[0.98] transition-all disabled:opacity-60 cursor-pointer shrink-0"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full border border-white/45">
                    <span className="h-2.5 w-2.5 rounded-full bg-white" />
                  </span>
                  <span className="text-[15px] font-medium tracking-[-0.01em]">Record</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* RIGHT PANE: Calm Editorial Detail View */}
      <main
        className={[
          'flex-1 flex flex-col min-w-0 h-full bg-[var(--surface)]',
          mobileView === 'list' ? 'hidden lg:flex' : 'flex',
        ].join(' ')}
      >
        {selectedRecording ? (
          <>
            {/* Detail Utility Bar */}
            <header className="shrink-0 flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)]/92 backdrop-blur-md px-3.5 sm:px-6 h-14">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => setMobileView('list')}
                  aria-label="Back to library"
                  className="lg:hidden flex h-11 items-center gap-1 rounded-xl pl-1.5 pr-2.5 text-[14px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer shrink-0"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Notes
                </button>

                <span className="hidden sm:inline text-[13.5px] text-[var(--ink-muted)] truncate">
                  {formatFullTimestamp(selectedRecording.created)}
                </span>

                {!selectedRecording.isEnglish && selectedRecording.status === 'ready' && (
                  <span className="hidden md:inline-flex items-center rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[12px] font-medium text-[var(--ink-secondary)] shrink-0">
                    {selectedRecording.languageName} → English
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {confirmDeleteId === selectedRecording.id ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-subtle)] px-2.5 py-1.5">
                    {vault && vaultPermission === 'granted' && Boolean(selectedVaultExport) && (
                      <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--ink-secondary)] cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={deleteAlsoFromVault}
                          onChange={(e) => setDeleteAlsoFromVault(e.target.checked)}
                          className="h-3.5 w-3.5 accent-[var(--vermilion)] cursor-pointer"
                        />
                        Also delete from vault
                      </label>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDeleteId(null);
                        setDeleteAlsoFromVault(false);
                        setDeleteError(null);
                      }}
                      className="rounded-lg px-2.5 py-1 text-[12.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(selectedRecording, deleteAlsoFromVault)}
                      className="rounded-lg bg-[var(--vermilion)] px-2.5 py-1 text-[12.5px] font-medium text-white hover:bg-[var(--vermilion-hover)] cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleCopyMarkdown()}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2.5 sm:px-3 text-[13.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] transition-colors cursor-pointer"
                    >
                      {copiedId === selectedRecording.id ? (
                        <>
                          <Check className="h-3.5 w-3.5" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                          <span>Copy MD</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={handleDownloadMarkdown}
                      title={`Download ${selectedFilename}`}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2.5 sm:px-3 text-[13.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] transition-colors cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                      <span className="hidden sm:inline">.md</span>
                    </button>

                    {canUseShare && (
                      <button
                        type="button"
                        onClick={() => void handleShareAudio()}
                        title="Share audio (Google Drive / Files)"
                        aria-label="Share audio"
                        className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors cursor-pointer"
                      >
                        <Share2 className="h-4 w-4" />
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => void handleDownloadAudio()}
                      title="Download audio"
                      aria-label="Download audio"
                      className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors cursor-pointer"
                    >
                      <FileAudio className="h-4 w-4" />
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleReprocess(selectedRecording)}
                      disabled={selectedRecording.status === 'processing'}
                      title="Reprocess with Gemini"
                      aria-label="Reprocess with Gemini"
                      className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors disabled:opacity-40 cursor-pointer"
                    >
                      <RefreshCw
                        className={[
                          'h-4 w-4',
                          selectedRecording.status === 'processing' ? 'animate-spin' : '',
                        ].join(' ')}
                      />
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setDeleteError(null);
                        setConfirmDeleteId(selectedRecording.id);
                      }}
                      title="Delete note"
                      aria-label="Delete note"
                      className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--vermilion)] transition-colors cursor-pointer"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
            </header>

            {/* Detail Scrollable Reading Surface */}
            <div className="flex-1 overflow-y-auto">
              <article className="mx-auto max-w-[680px] px-5 sm:px-8 py-6 sm:py-9 space-y-6">
                {deleteError && (
                  <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--canvas)] px-4 py-3 text-[13px] text-[var(--vermilion)] flex items-center justify-between gap-2">
                    <span>{deleteError}</span>
                    <button
                      type="button"
                      onClick={() => setDeleteError(null)}
                      aria-label="Dismiss delete error"
                      className="shrink-0 p-0.5 text-[var(--ink-muted)] hover:text-[var(--ink)] cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                {/* Mobile Timestamp & Language Meta */}
                <div className="flex flex-wrap items-center gap-2 sm:hidden text-[12.5px] text-[var(--ink-muted)]">
                  <span>{formatFullTimestamp(selectedRecording.created)}</span>
                  {!selectedRecording.isEnglish && selectedRecording.status === 'ready' && (
                    <span className="rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--ink-secondary)]">
                      {selectedRecording.languageName} → English
                    </span>
                  )}
                </div>

                {/* Inline Editable Title */}
                <div>
                  {editingTitle ? (
                    <input
                      ref={titleInputRef}
                      type="text"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onBlur={() => void commitTitleEdit()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitTitleEdit();
                        if (e.key === 'Escape') setEditingTitle(false);
                      }}
                      aria-label="Edit note title"
                      className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--canvas)] px-3 py-1.5 -mx-3 text-[26px] sm:text-[30px] font-semibold leading-[1.2] tracking-[-0.025em] text-[var(--ink)] focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={startEditingTitle}
                      disabled={selectedRecording.status === 'processing'}
                      className="group inline-flex items-baseline gap-2.5 text-left rounded-lg -mx-1.5 px-1.5 py-0.5 hover:bg-[var(--surface-subtle)]/70 transition-colors disabled:hover:bg-transparent cursor-pointer"
                    >
                      <h2 className="text-[26px] sm:text-[30px] font-semibold leading-[1.2] tracking-[-0.025em] text-[var(--ink)]">
                        {selectedRecording.status === 'processing'
                          ? 'Listening & organizing…'
                          : selectedRecording.title}
                      </h2>
                      {selectedRecording.status !== 'processing' && (
                        <Pencil className="h-4 w-4 shrink-0 text-[var(--ink-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </button>
                  )}

                  {/* Editorial 1-line Summary */}
                  {selectedRecording.status === 'ready' && selectedRecording.summary && (
                    <p className="mt-3.5 border-l-2 border-[var(--border-strong)] pl-4 text-[16px] leading-[1.62] text-[var(--ink-secondary)]">
                      {selectedRecording.summary}
                    </p>
                  )}

                  {/* Inline Editable Tags */}
                  {selectedRecording.status !== 'processing' && (
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      {selectedRecording.tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-subtle)] pl-3 pr-2 py-1 text-[13px] font-medium text-[var(--ink-secondary)]"
                        >
                          <span>#{tag}</span>
                          <button
                            type="button"
                            onClick={() => void handleRemoveTag(selectedRecording, tag)}
                            aria-label={`Remove tag ${tag}`}
                            className="flex h-4 w-4 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] cursor-pointer"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}

                      {addingTag ? (
                        <input
                          ref={tagInputRef}
                          type="text"
                          value={tagDraft}
                          onChange={(e) => setTagDraft(e.target.value)}
                          onBlur={() => void handleAddTag()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleAddTag();
                            }
                            if (e.key === 'Escape') {
                              setTagDraft('');
                              setAddingTag(false);
                            }
                          }}
                          placeholder="new-tag"
                          aria-label="New tag name"
                          className="h-7 w-28 rounded-full border border-[var(--border-strong)] bg-[var(--canvas)] px-2.5 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setAddingTag(true)}
                          className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-[var(--border-strong)] px-3 text-[12.5px] font-medium text-[var(--ink-muted)] hover:border-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors cursor-pointer"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          tag
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Clean Native Audio Playback Deck */}
                <AudioPlayer recording={selectedRecording} />

                {/* Vault Write Status & Conflict Handling */}
                {vault && selectedVaultExport?.state === 'conflict' ? (
                  <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--canvas)] p-4 space-y-3">
                    <div className="space-y-1">
                      <p className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--ink)]">
                        <AlertCircle className="h-4 w-4 text-[var(--vermilion)]" />
                        Modified in Obsidian
                      </p>
                      <p className="text-[13px] text-[var(--ink-muted)]">
                        {selectedVaultExport.error}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          void syncSingleToVault(selectedRecording.id, { forceOverwrite: true })
                        }
                        className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-[var(--ink)] px-3.5 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
                      >
                        Overwrite vault note
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleKeepObsidianVersion(selectedRecording)}
                        className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[13px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] cursor-pointer"
                      >
                        Keep Obsidian version
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5 text-[12.5px] text-[var(--ink-muted)]">
                    <div className="flex flex-wrap items-center gap-2">
                      {isSelectedWrittenToActiveVault ? (
                        <span className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)]">
                          <FolderCheck className="h-3.5 w-3.5" />
                          Written to {vault?.folderName} (.md + audio)
                        </span>
                      ) : vault && vaultPermission === 'granted' ? (
                        <button
                          type="button"
                          onClick={() => void syncSingleToVault(selectedRecording.id)}
                          className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)] hover:text-[var(--ink)] underline underline-offset-4 cursor-pointer"
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                          Write to {vault.folderName}
                        </button>
                      ) : vault && vaultPermission === 'prompt' ? (
                        <button
                          type="button"
                          onClick={() => void handleReconnectVault().catch(() => {})}
                          className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)] hover:text-[var(--ink)] underline underline-offset-4 cursor-pointer"
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                          Reconnect {vault.folderName} to write
                        </button>
                      ) : vaultPermission !== 'unsupported' ? (
                        <button
                          type="button"
                          onClick={() => setSettingsOpen(true)}
                          className="inline-flex items-center gap-1.5 hover:text-[var(--ink)] cursor-pointer"
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                          Connect Obsidian vault folder
                        </button>
                      ) : null}

                      {selectedRecording.audioSizeBytes > OBSIDIAN_STANDARD_LIMIT_BYTES && (
                        <span className="rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[11.5px] text-[var(--ink-secondary)]">
                          {formatBytes(selectedRecording.audioSizeBytes)} · exceeds Obsidian Sync
                          Standard 5 MB file limit (Plus: 200 MB)
                        </span>
                      )}
                    </div>
                    {selectedVaultExport?.state === 'error' && selectedVaultExport.error && (
                      <p className="text-[12.5px] text-[var(--vermilion)]">
                        {selectedVaultExport.error}
                      </p>
                    )}
                  </div>
                )}

                {/* Queued / Failed Transcription Banner */}
                {selectedRecording.status === 'queued' && (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--canvas)] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <p className="text-[14px] font-medium text-[var(--ink)]">
                        {!geminiSettings.apiKey.trim()
                          ? 'Audio saved — Gemini API key needed'
                          : !isOnline
                            ? 'Audio saved offline'
                            : 'Queued for transcription'}
                      </p>
                      <p className="text-[13px] text-[var(--ink-muted)]">
                        {!geminiSettings.apiKey.trim()
                          ? 'Add your Gemini API key in Settings to transcribe and organize this clip.'
                          : !isOnline
                            ? 'Tapeleaf will transcribe this note automatically once you are back online.'
                            : 'Starting transcription shortly…'}
                      </p>
                    </div>
                    {!geminiSettings.apiKey.trim() ? (
                      <button
                        type="button"
                        onClick={() => setSettingsOpen(true)}
                        className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[var(--ink)] px-3.5 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
                      >
                        <Settings className="h-3.5 w-3.5" />
                        Open Settings
                      </button>
                    ) : isOnline ? (
                      <button
                        type="button"
                        onClick={() => {
                          setQueuePausedReason(null);
                          queuePausedRef.current = null;
                          void drainTranscriptionQueue();
                        }}
                        className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[var(--ink)] px-3.5 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Transcribe now
                      </button>
                    ) : null}
                  </div>
                )}

                {selectedRecording.status === 'failed' && (
                  <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--canvas)] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <p className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--ink)]">
                        <AlertCircle className="h-4 w-4 text-[var(--vermilion)]" />
                        Audio is saved, but transcription didn’t finish
                      </p>
                      <p className="text-[13px] text-[var(--ink-muted)]">
                        {selectedRecording.errorMessage ||
                          'Tap Retry processing to transcribe this audio clip.'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleReprocess(selectedRecording)}
                      className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[var(--ink)] px-3.5 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Retry processing
                    </button>
                  </div>
                )}

                {/* Segmented Toggle: English / Original / Markdown */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <div
                    role="tablist"
                    aria-label="Note view"
                    className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] p-1"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={detailTab === 'english'}
                      onClick={() => setDetailTab('english')}
                      className={[
                        'rounded-lg px-3.5 py-1.5 text-[13.5px] font-medium transition-all cursor-pointer',
                        detailTab === 'english'
                          ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                          : 'text-[var(--ink-muted)] hover:text-[var(--ink)]',
                      ].join(' ')}
                    >
                      English
                    </button>

                    {!selectedRecording.isEnglish && (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={detailTab === 'original'}
                        onClick={() => setDetailTab('original')}
                        className={[
                          'rounded-lg px-3.5 py-1.5 text-[13.5px] font-medium transition-all cursor-pointer',
                          detailTab === 'original'
                            ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]',
                        ].join(' ')}
                      >
                        Original
                      </button>
                    )}

                    <button
                      type="button"
                      role="tab"
                      aria-selected={detailTab === 'markdown'}
                      onClick={() => setDetailTab('markdown')}
                      className={[
                        'rounded-lg px-3.5 py-1.5 text-[13.5px] font-medium transition-all cursor-pointer',
                        detailTab === 'markdown'
                          ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                          : 'text-[var(--ink-muted)] hover:text-[var(--ink)]',
                      ].join(' ')}
                    >
                      Markdown
                    </button>
                  </div>

                  <span className="font-mono text-[12px] text-[var(--ink-muted)] truncate">
                    {selectedFilename}
                  </span>
                </div>

                {/* Body Content */}
                {selectedRecording.status === 'processing' ? (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--canvas)] p-5 space-y-3.5">
                    <div className="flex items-center gap-2.5 text-[14.5px] font-medium text-[var(--ink)]">
                      <span className="h-2 w-2 rounded-full bg-[var(--vermilion)] animate-pulse" />
                      Listening &amp; organizing…
                    </div>
                    <p className="text-[14px] leading-relaxed text-[var(--ink-muted)]">
                      Your audio is safely saved on this device. Detecting language, transcribing,
                      summarizing, and formatting your Obsidian note.
                    </p>
                    <div className="space-y-2 pt-1">
                      <div className="shimmer-bar h-3.5 w-full rounded-full" />
                      <div className="shimmer-bar h-3.5 w-11/12 rounded-full" />
                      <div className="shimmer-bar h-3.5 w-4/5 rounded-full" />
                    </div>
                  </div>
                ) : detailTab === 'markdown' ? (
                  <MarkdownPreview
                    markdown={selectedMarkdown}
                    filename={selectedFilename}
                    copied={copiedId === selectedRecording.id}
                    onCopy={() => void handleCopyMarkdown()}
                  />
                ) : detailTab === 'original' && !selectedRecording.isEnglish ? (
                  <section lang={selectedRecording.language} className="space-y-4 pt-1">
                    <p className="font-mono text-[12px] uppercase tracking-wider text-[var(--ink-muted)]">
                      Original · {selectedRecording.languageName}
                    </p>
                    <div className="space-y-4 text-[17px] leading-[1.82] text-[var(--ink)]">
                      {(selectedRecording.originalTranscript ?? '')
                        .split(/\n{2,}/)
                        .filter(Boolean)
                        .map((para, idx) => (
                          <p key={idx}>{para}</p>
                        ))}
                    </div>
                  </section>
                ) : (
                  <section className="space-y-4 pt-1">
                    {selectedRecording.englishTranscript ? (
                      <div className="space-y-4 text-[17px] leading-[1.78] text-[var(--ink)]">
                        {selectedRecording.englishTranscript
                          .split(/\n{2,}/)
                          .filter(Boolean)
                          .map((para, idx) => (
                            <p key={idx}>{para}</p>
                          ))}
                      </div>
                    ) : (
                      <p className="text-[15px] text-[var(--ink-muted)]">
                        No transcript yet.
                      </p>
                    )}
                  </section>
                )}
              </article>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <TapeleafMark />
            <h2 className="mt-4 text-[17px] font-medium text-[var(--ink)]">
              Tap Record to capture a thought
            </h2>
            <p className="mt-1.5 max-w-xs text-[14px] leading-relaxed text-[var(--ink-muted)]">
              Zero server needed. Notes save on your device and write both Markdown and audio
              straight into your Obsidian vault folder.
            </p>
          </div>
        )}
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
        onConnectVault={handleConnectVault}
        onReconnectVault={handleReconnectVault}
        onDisconnectVault={handleDisconnectVault}
        onSyncVaultNow={handleSyncVaultNow}
      />
    </div>
  );
}
