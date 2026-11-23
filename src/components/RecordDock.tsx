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
import { formatTapeIndex } from './LibraryPane';

export interface UnsavedCapture {
  id: string;
  captured: CapturedAudio;
  error: string;
}

interface RecordDockProps {
  saving: boolean;
  nextTapeNumber: number;
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

function splitTimerTenths(formatted: string): { main: string; tenths: string } {
  const dot = formatted.lastIndexOf('.');
  if (dot < 0) return { main: formatted, tenths: '' };
  return { main: formatted.slice(0, dot), tenths: formatted.slice(dot) };
}

export function RecordDock({
  saving,
  nextTapeNumber,
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

  const timerParts = splitTimerTenths(formatTimerMs(recorder.elapsedMs));
  const codecLabel = formatCodecLabel(recorder.supportedMimeType);
  const tapeLabel = `TAPE ${formatTapeIndex(nextTapeNumber)}`;

  const renderWaveformBars = (tall: boolean) => (
    <div
      className={[
        'flex w-full items-center justify-between gap-[3px]',
        tall ? 'h-20' : 'h-9',
      ].join(' ')}
      aria-hidden="true"
    >
      {recorder.levels.map((level, i) => {
        const tailLen = recorder.levels.length;
        const isRecent = i >= tailLen - 5 && recorder.status === 'recording';
        const isMid = i >= Math.floor(tailLen * 0.35) && !isRecent;
        const heightPct = Math.round(Math.max(14, Math.min(100, level * 100)));
        return (
          <span
            key={i}
            className="flex-1 rounded-[1.5px] transition-[height] duration-75"
            style={{
              height: `${heightPct}%`,
              backgroundColor: isRecent
                ? 'var(--vermilion)'
                : isMid
                  ? 'var(--deck-ink)'
                  : 'var(--deck-wave-idle)',
              opacity: recorder.status === 'paused' ? 0.42 : isRecent ? 1 : isMid ? 0.78 : 0.7,
            }}
          />
        );
      })}
    </div>
  );

  return (
    <div className="shrink-0">
      {/* Recovered interrupted recordings & unsaved captures stay above the dark hardware deck */}
      {(recoveredDrafts.length > 0 ||
        unsavedCaptures.length > 0 ||
        recorder.error ||
        importError) && (
        <div className="border-t border-[var(--border)] bg-[var(--panel)] px-4 py-3 space-y-2.5 max-h-60 overflow-y-auto">
          {recoveredDrafts.map((item) => (
            <div
              key={item.draft.id}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] p-3 text-[13px]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 text-[var(--vermilion)] mt-0.5" />
                  <div>
                    <p className="font-semibold text-[var(--ink)]">
                      Recovered tape ({formatDuration(item.draft.durationSeconds)})
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
                  className="shrink-0 flex h-7 w-7 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onRecoverDraftSave(item)}
                  disabled={saving}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md bg-[var(--ink)] px-3 font-mono text-[11.5px] font-semibold uppercase tracking-wider text-[var(--surface)] hover:opacity-90 disabled:opacity-50 cursor-pointer"
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
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--canvas)] px-3 font-mono text-[11.5px] font-semibold uppercase tracking-wider text-[var(--ink)] hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </button>
              </div>
            </div>
          ))}

          {unsavedCaptures.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] p-3 text-[13px]"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 text-[var(--vermilion)] mt-0.5" />
                  <div>
                    <p className="font-semibold text-[var(--ink)]">
                      Unsaved clip ({formatDuration(item.captured.durationSeconds)})
                    </p>
                    <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">{item.error}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onDismissUnsaved(item.id)}
                  aria-label="Discard unsaved clip"
                  className="shrink-0 flex h-7 w-7 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onCaptureReady(item.captured, item.id)}
                  disabled={saving}
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md bg-[var(--ink)] px-3 font-mono text-[11.5px] font-semibold uppercase tracking-wider text-[var(--surface)] hover:opacity-90 disabled:opacity-50 cursor-pointer"
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
                  className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--canvas)] px-3 font-mono text-[11.5px] font-semibold uppercase tracking-wider text-[var(--ink)] hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </button>
              </div>
            </div>
          ))}

          {(recorder.error || importError) && (
            <div
              role="alert"
              className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-[12.5px] text-[var(--ink-secondary)]"
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
                  className="shrink-0 flex h-7 w-7 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
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
        <>
          {/* MOBILE (< lg): Full-screen distraction-free Braun Live Capture Bay */}
          <div
            role="region"
            aria-label="Live audio capture"
            className="lg:hidden fixed inset-0 z-40 flex flex-col justify-between bg-[var(--deck-bg)] text-[var(--deck-ink)] px-5 safe-top safe-bottom"
          >
            {/* Top Hardware Status Bar */}
            <div className="flex items-center justify-between gap-3 border-b border-[var(--deck-border)] pb-3.5">
              <div className="flex items-center gap-2.5">
                <span
                  className={[
                    'h-2.5 w-2.5 rounded-full',
                    recorder.status === 'recording'
                      ? 'bg-[var(--vermilion)] record-pulse'
                      : 'bg-[var(--deck-muted)]',
                  ].join(' ')}
                />
                <span className="font-mono text-[12px] font-bold uppercase tracking-[0.1em]">
                  {recorder.status === 'recording'
                    ? `REC · ${tapeLabel}`
                    : recorder.status === 'stopping'
                      ? 'SAVING TAPE…'
                      : `PAUSED · ${tapeLabel}`}
                </span>
              </div>

              {confirmDiscard ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setConfirmDiscard(false)}
                    className="rounded-md border border-[var(--deck-border)] bg-[var(--deck-surface)] px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--deck-ink)] cursor-pointer"
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    onClick={handleRequestDiscard}
                    className="rounded-md bg-[var(--vermilion)] px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-white cursor-pointer"
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
                  className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--deck-border)] bg-[var(--deck-surface)] px-3 font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--deck-muted)] hover:text-[var(--deck-ink)] disabled:opacity-40 cursor-pointer"
                >
                  <X className="h-3.5 w-3.5" />
                  Discard
                </button>
              )}
            </div>

            {/* Center Precision Timer + Ruled Live Waveform */}
            <div className="flex flex-col items-center gap-6 py-4">
              <span className="rounded border border-[var(--deck-border)] bg-[var(--deck-surface)] px-3 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--deck-muted)]">
                {codecLabel} · DRAFT SAVED LOCALLY
              </span>

              <div className="font-mono text-[56px] sm:text-[64px] font-medium leading-none tracking-[-0.03em] tabular-nums">
                <span>{timerParts.main}</span>
                {timerParts.tenths && (
                  <span className="text-[40px] sm:text-[46px] text-[var(--vermilion)]">
                    {timerParts.tenths}
                  </span>
                )}
              </div>

              <div className="w-full border-y border-[var(--deck-border)] py-5 space-y-2.5">
                {renderWaveformBars(true)}
                <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-[var(--deck-muted)]">
                  <span>−15s</span>
                  <span>−10s</span>
                  <span>−5s</span>
                  <span className="font-semibold text-[var(--vermilion)]">NOW</span>
                </div>
              </div>

              <p className="max-w-[260px] text-center text-[13px] leading-relaxed text-[var(--deck-muted)]">
                Safe offline. Auto-transcribes and writes to{' '}
                {vault && vaultPermission === 'granted' ? vault.folderName : 'your library'} when
                stopped.
              </p>
            </div>

            {/* Bottom Full-Thumb Machined Transport Keys */}
            <div className="grid grid-cols-[1fr_1.5fr] gap-3 pt-2">
              <button
                type="button"
                disabled={recorder.status === 'stopping'}
                onClick={
                  recorder.status === 'recording'
                    ? recorder.pauseRecording
                    : recorder.resumeRecording
                }
                className="flex h-14 items-center justify-center gap-2 rounded-lg border border-[var(--deck-border)] bg-[var(--deck-surface)] px-3 font-mono text-[13px] font-bold uppercase tracking-wider text-[var(--deck-ink)] hover:bg-[var(--deck-surface-hover)] active:scale-[0.98] transition-all disabled:opacity-45 cursor-pointer"
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
                className="hardware-rec-key flex h-14 items-center justify-center gap-2.5 rounded-lg bg-[var(--vermilion)] px-4 font-mono text-[13px] font-bold uppercase tracking-wider text-white hover:bg-[var(--vermilion-hover)] active:scale-[0.98] transition-all disabled:opacity-55 cursor-pointer"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                {recorder.status === 'stopping' ? 'Saving…' : 'Stop & Save'}
              </button>
            </div>
          </div>

          {/* DESKTOP (lg+): Compact inline dark hardware capture deck inside left sidebar */}
          <div className="hidden lg:block border-t border-[var(--deck-border)] bg-[var(--deck-bg)] text-[var(--deck-ink)] px-4 py-3.5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={[
                    'h-2.5 w-2.5 rounded-full',
                    recorder.status === 'recording'
                      ? 'bg-[var(--vermilion)] record-pulse'
                      : 'bg-[var(--deck-muted)]',
                  ].join(' ')}
                />
                <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em]">
                  {recorder.status === 'recording'
                    ? `REC · ${tapeLabel}`
                    : recorder.status === 'stopping'
                      ? 'SAVING…'
                      : `PAUSED · ${tapeLabel}`}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="font-mono text-[16px] font-medium tabular-nums">
                  <span>{timerParts.main}</span>
                  {timerParts.tenths && (
                    <span className="text-[13px] text-[var(--vermilion)]">{timerParts.tenths}</span>
                  )}
                </span>
                {confirmDiscard ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmDiscard(false)}
                      className="rounded border border-[var(--deck-border)] bg-[var(--deck-surface)] px-2 py-1 font-mono text-[10.5px] font-semibold uppercase text-[var(--deck-ink)] cursor-pointer"
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      onClick={handleRequestDiscard}
                      className="rounded bg-[var(--vermilion)] px-2 py-1 font-mono text-[10.5px] font-bold uppercase text-white cursor-pointer"
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
                    className="flex h-8 w-8 items-center justify-center rounded border border-[var(--deck-border)] bg-[var(--deck-surface)] text-[var(--deck-muted)] hover:text-[var(--deck-ink)] disabled:opacity-40 cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            <div className="border-y border-[var(--deck-border)] py-2.5">
              {renderWaveformBars(false)}
            </div>

            <div className="grid grid-cols-[1fr_1.4fr] gap-2">
              <button
                type="button"
                disabled={recorder.status === 'stopping'}
                onClick={
                  recorder.status === 'recording'
                    ? recorder.pauseRecording
                    : recorder.resumeRecording
                }
                className="flex h-11 items-center justify-center gap-2 rounded-md border border-[var(--deck-border)] bg-[var(--deck-surface)] px-3 font-mono text-[11.5px] font-bold uppercase tracking-wider text-[var(--deck-ink)] hover:bg-[var(--deck-surface-hover)] transition-colors disabled:opacity-45 cursor-pointer"
              >
                {recorder.status === 'recording' ? (
                  <>
                    <Pause className="h-3.5 w-3.5" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5 fill-current" />
                    Resume
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={recorder.status === 'stopping'}
                onClick={() => void handleStopRecording()}
                className="hardware-rec-key flex h-11 items-center justify-center gap-2 rounded-md bg-[var(--vermilion)] px-3 font-mono text-[11.5px] font-bold uppercase tracking-wider text-white hover:bg-[var(--vermilion-hover)] transition-colors disabled:opacity-55 cursor-pointer"
              >
                <Square className="h-3 w-3 fill-current" />
                {recorder.status === 'stopping' ? 'Finishing…' : 'Stop & Save'}
              </button>
            </div>
          </div>
        </>
      ) : (
        /* IDLE: Anchored Dark Hardware Transport Module */
        <div className="border-t border-[var(--deck-border)] bg-[var(--deck-bg)] text-[var(--deck-ink)] px-4 pt-3 safe-bottom">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--deck-ink)] truncate">
                {saving
                  ? 'SAVING TAPE…'
                  : recorder.status === 'requesting'
                    ? 'REQUESTING MIC…'
                    : `READY · ${codecLabel}`}
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-[var(--deck-muted)] truncate">
                {vault && vaultPermission === 'granted'
                  ? `Obsidian / ${vault.folderName}`
                  : 'On-device storage'}
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={saving || recorder.status === 'requesting'}
                title="Import audio file"
                aria-label="Import audio file"
                className="flex h-12 w-11 items-center justify-center rounded-lg border border-[var(--deck-border)] bg-[var(--deck-surface)] text-[var(--deck-ink)] hover:bg-[var(--deck-surface-hover)] active:scale-[0.98] transition-all disabled:opacity-50 cursor-pointer"
              >
                <Upload className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => void recorder.startRecording()}
                disabled={saving || recorder.status === 'requesting'}
                aria-label="Start recording"
                className="hardware-rec-key flex h-12 items-center gap-2.5 rounded-lg bg-[var(--vermilion)] px-5 font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-white hover:bg-[var(--vermilion-hover)] active:scale-[0.98] transition-all disabled:opacity-60 cursor-pointer shrink-0"
              >
                <span className="h-2.5 w-2.5 rounded-full bg-white" />
                <span>REC</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
