import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Download,
  Pause,
  Play,
  RefreshCw,
  Square,
  Upload,
  X,
} from 'lucide-react';
import { useRecorder } from '../hooks/useRecorder';
import type { RecorderStatus } from '../hooks/useRecorder';
import {
  formatCodecLabel,
  readAudioDuration,
  triggerDownload,
  validateImportedAudioFile,
} from '../lib/audio';
import type { VaultPermissionState } from '../lib/vaultSync';
import { formatDuration, formatTimerMs } from '../markdown';
import type { CapturedAudio, RecoverableDraft, StoredVaultHandle } from '../types';

export interface UnsavedCapture {
  id: string;
  captured: CapturedAudio;
  error: string;
}

interface RecordDockProps {
  saving: boolean;
  vault: StoredVaultHandle | null;
  vaultPermission: VaultPermissionState;
  unsavedCaptures: UnsavedCapture[];
  recoveredDrafts: RecoverableDraft[];
  onCaptureReady: (captured: CapturedAudio, existingUnsavedId?: string) => Promise<void>;
  onDismissUnsaved: (id: string) => void;
  onRecoverDraftSave: (draft: RecoverableDraft) => Promise<void>;
  onRecoverDraftDiscard: (draftId: string) => Promise<void>;
  onRecorderStatusChange: (status: RecorderStatus) => void;
}

const DISCARD_CONFIRM_THRESHOLD_MS = 3000;

export function RecordDock({
  saving,
  vault,
  vaultPermission,
  unsavedCaptures,
  recoveredDrafts,
  onCaptureReady,
  onDismissUnsaved,
  onRecoverDraftSave,
  onRecoverDraftDiscard,
  onRecorderStatusChange,
}: RecordDockProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const recorder = useRecorder({
    onInterruptedCapture: (captured) => {
      void onCaptureReady(captured);
    },
    onStatusChange: onRecorderStatusChange,
  });

  const isActiveRecording =
    recorder.status === 'recording' ||
    recorder.status === 'paused' ||
    recorder.status === 'stopping';

  useEffect(() => {
    if (!isActiveRecording) {
      setConfirmDiscard(false);
    }
  }, [isActiveRecording]);

  const handleStopRecording = async () => {
    setConfirmDiscard(false);
    const captured = await recorder.stopRecording();
    if (captured) {
      await onCaptureReady(captured);
    }
  };

  const handleRequestDiscard = () => {
    if (recorder.status === 'stopping') return;
    if (recorder.elapsedMs >= DISCARD_CONFIRM_THRESHOLD_MS && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    recorder.cancelRecording();
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setImportError(null);
    const validation = validateImportedAudioFile(file);
    if (!validation.ok) {
      setImportError(validation.error);
      return;
    }

    const probe = await readAudioDuration(file);
    if (!probe.ok) {
      setImportError(probe.error);
      return;
    }

    await onCaptureReady({
      blob: file,
      mimeType: validation.mimeType,
      durationSeconds: probe.durationSeconds,
      extension: validation.extension,
    });
  };

  return (
    <div className="shrink-0 border-t border-[var(--border)] bg-[var(--canvas)]/95 backdrop-blur-md px-4 sm:px-5 pt-3 safe-bottom">
      {/* Recovered interrupted recordings from a prior OS kill / crash */}
      {recoveredDrafts.length > 0 && (
        <div className="mb-3 space-y-2 max-h-48 overflow-y-auto">
          {recoveredDrafts.map((item) => (
            <div
              key={item.draft.id}
              className="rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] p-3 text-[13px]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 text-[var(--vermilion)] mt-0.5" />
                  <div>
                    <p className="font-medium text-[var(--ink)]">
                      Recovered recording ({formatDuration(item.draft.durationSeconds)})
                    </p>
                    <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
                      Captured before the app was closed. Save to library or download the audio.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void onRecoverDraftDiscard(item.draft.id)}
                  aria-label="Discard recovered recording"
                  className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onRecoverDraftSave(item)}
                  disabled={saving}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl bg-[var(--ink)] px-3 text-[12.5px] font-medium text-[var(--canvas)] hover:opacity-90 disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Save to library
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const stamp = item.draft.created.replace(/[:.]/g, '-').slice(0, 19);
                    triggerDownload(
                      item.blob,
                      `tapeleaf-recovered-${stamp}.${item.draft.extension}`,
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

      {/* Unsaved captures (e.g. IndexedDB quota full) */}
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
                  onClick={() => onDismissUnsaved(item.id)}
                  aria-label="Discard unsaved clip"
                  className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onCaptureReady(item.captured, item.id)}
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

      {(recorder.error || importError) && (
        <div
          role="alert"
          className="mb-3 rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-[12.5px] text-[var(--ink-secondary)]"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="leading-snug">{importError || recorder.error}</p>
            <button
              type="button"
              onClick={() => {
                setImportError(null);
                recorder.clearError();
              }}
              aria-label="Dismiss notice"
              className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.m4a,.mp3,.webm,.ogg,.wav,.flac,.aac"
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
                {recorder.status === 'recording'
                  ? 'Recording'
                  : recorder.status === 'stopping'
                    ? 'Saving…'
                    : 'Paused'}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="font-mono text-[16px] font-medium tabular-nums text-[var(--ink)]">
                {formatTimerMs(recorder.elapsedMs)}
              </span>
              {confirmDiscard ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setConfirmDiscard(false)}
                    className="rounded-lg px-2 py-1 text-[12px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)] cursor-pointer"
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    onClick={handleRequestDiscard}
                    className="rounded-lg bg-[var(--vermilion)] px-2 py-1 text-[12px] font-medium text-white hover:bg-[var(--vermilion-hover)] cursor-pointer"
                  >
                    Discard
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={recorder.status === 'stopping'}
                  onClick={handleRequestDiscard}
                  aria-label="Discard recording"
                  title="Discard recording"
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors disabled:opacity-40 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
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
              disabled={recorder.status === 'stopping'}
              onClick={
                recorder.status === 'recording'
                  ? recorder.pauseRecording
                  : recorder.resumeRecording
              }
              className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] px-3 text-[14px] font-medium text-[var(--ink)] hover:bg-[var(--surface-hover)] transition-colors disabled:opacity-45 cursor-pointer"
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
              disabled={recorder.status === 'stopping'}
              onClick={() => void handleStopRecording()}
              className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[var(--vermilion)] px-3 text-[14px] font-medium text-white hover:bg-[var(--vermilion-hover)] transition-colors disabled:opacity-55 cursor-pointer"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
              {recorder.status === 'stopping' ? 'Finishing…' : 'Stop & Save'}
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
              className="group relative flex h-[52px] items-center gap-2.5 rounded-full bg-[var(--vermilion)] pl-4 pr-5 text-white shadow-[0_2px_10px_rgba(209,56,61,0.28)] hover:bg-[var(--vermilion-hover)] active:scale-[0.98] transition-all disabled:opacity-60 cursor-pointer shrink-0"
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
  );
}
