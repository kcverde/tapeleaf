import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileAudio,
  FolderCheck,
  FolderOpen,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Share2,
  Trash2,
  X,
} from 'lucide-react';
import { AudioPlayer } from './AudioPlayer';
import { MarkdownPreview } from './MarkdownPreview';
import { TapeleafMark } from './TapeleafMark';
import { triggerDownload } from '../lib/audio';
import { getAudioRecord } from '../lib/db';
import {
  getVaultExportFor,
  hasDeletableVaultArtifacts,
} from '../lib/vaultSync';
import type { VaultPermissionState } from '../lib/vaultSync';
import {
  buildNoteFilename,
  buildObsidianMarkdown,
  formatBytes,
  formatFullTimestamp,
  normalizeTag,
} from '../markdown';
import type { Recording, StoredVaultHandle } from '../types';

type DetailTab = 'english' | 'original' | 'markdown';

const OBSIDIAN_STANDARD_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MB

export interface DeleteRequestOutcome {
  ok: boolean;
  error?: string;
  modifiedInVault?: boolean;
}

interface DetailPaneProps {
  recording: Recording | null;
  vault: StoredVaultHandle | null;
  vaultPermission: VaultPermissionState;
  hasApiKey: boolean;
  isOnline: boolean;
  geminiUnreachable: boolean;
  onBackToList: () => void;
  onOpenSettings: () => void;
  onReconnectVault: () => void;
  onSyncSingleToVault: (id: string, opts?: { forceOverwrite?: boolean }) => Promise<void>;
  onKeepObsidianVersion: (recording: Recording) => Promise<void>;
  onReprocess: (recording: Recording) => Promise<void>;
  onDrainQueueNow: () => void;
  onEditTitle: (recording: Recording, nextTitle: string) => Promise<void>;
  onAddTag: (recording: Recording, tag: string) => Promise<void>;
  onRemoveTag: (recording: Recording, tag: string) => Promise<void>;
  onDelete: (
    recording: Recording,
    options: { alsoVault: boolean; forceDeleteModified?: boolean },
  ) => Promise<DeleteRequestOutcome>;
}

export function DetailPane({
  recording,
  vault,
  vaultPermission,
  hasApiKey,
  isOnline,
  geminiUnreachable,
  onBackToList,
  onOpenSettings,
  onReconnectVault,
  onSyncSingleToVault,
  onKeepObsidianVersion,
  onReprocess,
  onDrainQueueNow,
  onEditTitle,
  onAddTag,
  onRemoveTag,
  onDelete,
}: DetailPaneProps) {
  const [detailTab, setDetailTab] = useState<DetailTab>('english');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [addingTag, setAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState('');

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteAlsoFromVault, setDeleteAlsoFromVault] = useState(false);
  const [confirmForceModified, setConfirmForceModified] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Pre-loaded audio blob for synchronous Web Share user activation
  const loadedAudioRef = useRef<{ blob: Blob; mimeType: string } | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const tabRefs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (recording?.isEnglish && detailTab === 'original') {
      setDetailTab('english');
    }
  }, [recording?.id, recording?.isEnglish, detailTab]);

  useEffect(() => {
    setEditingTitle(false);
    setAddingTag(false);
    setTagDraft('');
    setConfirmDeleteOpen(false);
    setDeleteAlsoFromVault(false);
    setConfirmForceModified(false);
    setDeleteError(null);
    setCopyError(null);
    setShareError(null);
    loadedAudioRef.current = null;
  }, [recording?.id]);

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

  const handleAudioLoaded = useCallback((blob: Blob | null, mimeType?: string) => {
    loadedAudioRef.current = blob ? { blob, mimeType: mimeType || blob.type } : null;
  }, []);

  const selectedMarkdown = useMemo(
    () => (recording ? buildObsidianMarkdown(recording) : ''),
    [recording],
  );

  const selectedFilename = useMemo(
    () => (recording ? buildNoteFilename(recording, vault?.vaultId) : 'note.md'),
    [recording, vault?.vaultId],
  );

  const availableTabs: DetailTab[] = useMemo(() => {
    if (!recording) return ['english', 'markdown'];
    return recording.isEnglish
      ? ['english', 'markdown']
      : ['english', 'original', 'markdown'];
  }, [recording]);

  const handleTabKeyDown = (e: React.KeyboardEvent, current: DetailTab) => {
    const idx = availableTabs.indexOf(current);
    if (idx < 0) return;
    let nextIdx = idx;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % availableTabs.length;
    else if (e.key === 'ArrowLeft')
      nextIdx = (idx - 1 + availableTabs.length) % availableTabs.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = availableTabs.length - 1;
    else return;

    e.preventDefault();
    const nextTab = availableTabs[nextIdx];
    setDetailTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  if (!recording) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <TapeleafMark />
        <h2 className="mt-4 text-[17px] font-medium text-[var(--ink)]">
          Tap Record to capture a thought
        </h2>
        <p className="mt-1.5 max-w-xs text-[14px] leading-relaxed text-[var(--ink-muted)]">
          Zero server needed. Notes save on your device and write both Markdown and audio straight
          into your Obsidian vault folder.
        </p>
      </div>
    );
  }

  const selectedVaultExport = getVaultExportFor(recording, vault?.vaultId);
  const canDeleteFromVault =
    Boolean(vault) &&
    vaultPermission === 'granted' &&
    hasDeletableVaultArtifacts(recording, vault?.vaultId);

  const isSelectedWrittenToActiveVault =
    Boolean(vault) &&
    selectedVaultExport?.state === 'written' &&
    selectedVaultExport.audioWritten &&
    selectedVaultExport.lastExportedRevision >= recording.revision;

  const isSelectedKeptObsidian = Boolean(vault) && selectedVaultExport?.state === 'kept-vault';

  const canShareFiles =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const markCopied = (id: string) => {
    setCopiedId(id);
    setCopyError(null);
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      setCopiedId((cur) => (cur === id ? null : cur));
    }, 2000);
  };

  const handleCopyMarkdown = async () => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(selectedMarkdown);
      markCopied(recording.id);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = selectedMarkdown;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) {
        markCopied(recording.id);
      } else {
        setCopyError('Could not access clipboard. Use Download .md instead.');
      }
    }
  };

  const handleDownloadMarkdown = () => {
    const blob = new Blob([selectedMarkdown], { type: 'text/markdown;charset=utf-8' });
    triggerDownload(blob, selectedFilename);
  };

  const handleDownloadAudio = async () => {
    const audio = loadedAudioRef.current ?? (await getAudioRecord(recording.id));
    if (!audio) return;
    // Save under the exact embedded filename (rec_....m4a) so manual Obsidian imports resolve ![[...]]
    const targetName =
      recording.audioFilename ||
      recording.audioPath.split('/').pop() ||
      `${recording.id}.m4a`;
    triggerDownload(audio.blob, targetName);
  };

  const handleShareAudio = async () => {
    setShareError(null);
    if (typeof navigator.share !== 'function') return;

    const audio = loadedAudioRef.current;
    if (!audio) {
      setShareError('Audio is still loading. Try again in a moment or use Download Audio.');
      return;
    }

    const file = new File([audio.blob], recording.audioFilename, {
      type: audio.mimeType || recording.audioMimeType,
    });

    if (navigator.canShare && !navigator.canShare({ files: [file] })) {
      setShareError(
        'This browser does not support sharing audio files directly. Use Download Audio instead.',
      );
      return;
    }

    try {
      await navigator.share({
        title: recording.title,
        text: recording.summary || recording.title,
        files: [file],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return; // User cancelled share sheet
      }
      setShareError(
        err instanceof Error
          ? `Could not share audio: ${err.message}`
          : 'Could not share audio file on this browser.',
      );
    }
  };

  const startEditingTitle = () => {
    if (recording.status === 'processing') return;
    setTitleDraft(recording.title);
    setEditingTitle(true);
  };

  const commitTitleEdit = async () => {
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    if (trimmed && trimmed !== recording.title) {
      await onEditTitle(recording, trimmed);
    }
  };

  const commitAddTag = async () => {
    const clean = normalizeTag(tagDraft);
    setTagDraft('');
    setAddingTag(false);
    if (clean && !recording.tags.includes(clean)) {
      await onAddTag(recording, clean);
    }
  };

  const executeDelete = async (options: {
    alsoVault: boolean;
    forceDeleteModified?: boolean;
  }) => {
    setDeleteBusy(true);
    setDeleteError(null);
    const res = await onDelete(recording, options);
    setDeleteBusy(false);

    if (!res.ok) {
      setDeleteError(res.error || 'Could not delete recording.');
      if (res.modifiedInVault) {
        setConfirmForceModified(true);
      }
      return;
    }

    setConfirmDeleteOpen(false);
    setDeleteAlsoFromVault(false);
    setConfirmForceModified(false);
  };

  return (
    <>
      {/* Detail Utility Bar */}
      <header className="shrink-0 flex items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface)]/92 backdrop-blur-md px-3.5 sm:px-6 h-14">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBackToList}
            aria-label="Back to library"
            className="lg:hidden flex h-11 items-center gap-1 rounded-xl pl-1.5 pr-2.5 text-[14px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
            Notes
          </button>

          <span className="hidden sm:inline text-[13.5px] text-[var(--ink-muted)] truncate">
            {formatFullTimestamp(recording.created)}
          </span>

          {!recording.isEnglish && recording.status === 'ready' && (
            <span className="hidden md:inline-flex items-center rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[12px] font-medium text-[var(--ink-secondary)] shrink-0">
              {recording.languageName} → English
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void handleCopyMarkdown()}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2.5 sm:px-3 text-[13.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] transition-colors cursor-pointer"
          >
            {copiedId === recording.id ? (
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

          {canShareFiles && (
            <button
              type="button"
              onClick={() => void handleShareAudio()}
              title="Share audio file"
              aria-label="Share audio file"
              className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors cursor-pointer"
            >
              <Share2 className="h-4 w-4" />
            </button>
          )}

          <button
            type="button"
            onClick={() => void handleDownloadAudio()}
            title={`Download audio (${recording.audioFilename})`}
            aria-label="Download audio"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors cursor-pointer"
          >
            <FileAudio className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => void onReprocess(recording)}
            disabled={recording.status === 'processing'}
            title="Reprocess with Gemini"
            aria-label="Reprocess with Gemini"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors disabled:opacity-40 cursor-pointer"
          >
            <RefreshCw
              className={[
                'h-4 w-4',
                recording.status === 'processing' ? 'animate-spin' : '',
              ].join(' ')}
            />
          </button>

          <button
            type="button"
            onClick={() => {
              setDeleteError(null);
              setConfirmForceModified(false);
              setConfirmDeleteOpen((prev) => !prev);
            }}
            aria-expanded={confirmDeleteOpen}
            title="Delete note"
            aria-label="Delete note"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--vermilion)] transition-colors cursor-pointer"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Detail Scrollable Reading Surface */}
      <div className="flex-1 overflow-y-auto">
        <article className="mx-auto max-w-[680px] px-5 sm:px-8 py-6 sm:py-9 space-y-6">
          {/* Responsive Delete Confirmation Panel (never overflows header on mobile) */}
          {confirmDeleteOpen && (
            <div
              role="region"
              aria-label="Confirm deletion"
              className="rounded-2xl border border-[var(--border-strong)] bg-[var(--canvas)] p-4 space-y-3"
            >
              <div className="space-y-1">
                <p className="text-[14px] font-medium text-[var(--ink)]">
                  Delete this voice note?
                </p>
                <p className="text-[13px] text-[var(--ink-muted)]">
                  Removes the recording and audio from Tapeleaf on this device.
                  {canDeleteFromVault
                    ? ' Your Obsidian vault copy stays untouched unless checked below.'
                    : ''}
                </p>
              </div>

              {canDeleteFromVault && (
                <label className="flex items-center gap-2 text-[13px] text-[var(--ink-secondary)] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={deleteAlsoFromVault}
                    onChange={(e) => {
                      setDeleteAlsoFromVault(e.target.checked);
                      setConfirmForceModified(false);
                      setDeleteError(null);
                    }}
                    className="h-4 w-4 accent-[var(--vermilion)] cursor-pointer"
                  />
                  <span>
                    Also delete exported{' '}
                    {selectedVaultExport?.filename ? 'note & audio' : 'audio'} from{' '}
                    <strong>{vault?.folderName}</strong>
                  </span>
                </label>
              )}

              {deleteError && (
                <p role="alert" className="text-[12.5px] text-[var(--vermilion)] leading-snug">
                  {deleteError}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {confirmForceModified ? (
                  <>
                    <button
                      type="button"
                      disabled={deleteBusy}
                      onClick={() =>
                        void executeDelete({ alsoVault: true, forceDeleteModified: true })
                      }
                      className="inline-flex min-h-[38px] items-center rounded-xl bg-[var(--vermilion)] px-3.5 text-[13px] font-medium text-white hover:bg-[var(--vermilion-hover)] disabled:opacity-50 cursor-pointer"
                    >
                      Delete modified vault note anyway
                    </button>
                    <button
                      type="button"
                      disabled={deleteBusy}
                      onClick={() => void executeDelete({ alsoVault: false })}
                      className="inline-flex min-h-[38px] items-center rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[13px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] disabled:opacity-50 cursor-pointer"
                    >
                      Delete local copy only
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={deleteBusy}
                    onClick={() => void executeDelete({ alsoVault: deleteAlsoFromVault })}
                    className="inline-flex min-h-[38px] items-center rounded-xl bg-[var(--vermilion)] px-3.5 text-[13px] font-medium text-white hover:bg-[var(--vermilion-hover)] disabled:opacity-50 cursor-pointer"
                  >
                    {deleteBusy ? 'Deleting…' : 'Delete'}
                  </button>
                )}

                <button
                  type="button"
                  disabled={deleteBusy}
                  onClick={() => {
                    setConfirmDeleteOpen(false);
                    setDeleteAlsoFromVault(false);
                    setConfirmForceModified(false);
                    setDeleteError(null);
                  }}
                  className="inline-flex min-h-[38px] items-center rounded-xl px-3 text-[13px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {(copyError || shareError) && (
            <div
              role="alert"
              className="rounded-2xl border border-[var(--border-strong)] bg-[var(--canvas)] px-4 py-3 text-[13px] text-[var(--vermilion)] flex items-center justify-between gap-2"
            >
              <span>{copyError || shareError}</span>
              <button
                type="button"
                onClick={() => {
                  setCopyError(null);
                  setShareError(null);
                }}
                aria-label="Dismiss error"
                className="shrink-0 p-1 text-[var(--ink-muted)] hover:text-[var(--ink)] cursor-pointer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Mobile Timestamp & Language Meta */}
          <div className="flex flex-wrap items-center gap-2 sm:hidden text-[12.5px] text-[var(--ink-muted)]">
            <span>{formatFullTimestamp(recording.created)}</span>
            {!recording.isEnglish && recording.status === 'ready' && (
              <span className="rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--ink-secondary)]">
                {recording.languageName} → English
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
                disabled={recording.status === 'processing'}
                className="group inline-flex items-baseline gap-2.5 text-left rounded-lg -mx-1.5 px-1.5 py-0.5 hover:bg-[var(--surface-subtle)]/70 transition-colors disabled:hover:bg-transparent cursor-pointer"
              >
                <span className="block text-[26px] sm:text-[30px] font-semibold leading-[1.2] tracking-[-0.025em] text-[var(--ink)]">
                  {recording.status === 'processing'
                    ? 'Listening & organizing…'
                    : recording.title}
                </span>
                {recording.status !== 'processing' && (
                  <Pencil className="h-4 w-4 shrink-0 text-[var(--ink-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </button>
            )}

            {/* Editorial 1-line Summary */}
            {recording.status === 'ready' && recording.summary && (
              <p className="mt-3.5 border-l-2 border-[var(--border-strong)] pl-4 text-[16px] leading-[1.62] text-[var(--ink-secondary)]">
                {recording.summary}
              </p>
            )}

            {/* Inline Editable Tags */}
            {recording.status !== 'processing' && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {recording.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-subtle)] pl-3 pr-1.5 py-1 text-[13px] font-medium text-[var(--ink-secondary)]"
                  >
                    <span>#{tag}</span>
                    <button
                      type="button"
                      onClick={() => void onRemoveTag(recording, tag)}
                      aria-label={`Remove tag ${tag}`}
                      className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] cursor-pointer"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}

                {addingTag ? (
                  <input
                    ref={tagInputRef}
                    type="text"
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onBlur={() => void commitAddTag()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void commitAddTag();
                      }
                      if (e.key === 'Escape') {
                        setTagDraft('');
                        setAddingTag(false);
                      }
                    }}
                    placeholder="new-tag"
                    aria-label="New tag name"
                    className="h-8 w-32 rounded-full border border-[var(--border-strong)] bg-[var(--canvas)] px-3 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingTag(true)}
                    className="inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-[var(--border-strong)] px-3 text-[12.5px] font-medium text-[var(--ink-muted)] hover:border-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors cursor-pointer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    tag
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Clean Native Audio Playback Deck */}
          <AudioPlayer recording={recording} onAudioLoaded={handleAudioLoaded} />

          {/* Vault Write Status & Conflict Handling */}
          {vault && selectedVaultExport?.state === 'conflict' ? (
            <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--canvas)] p-4 space-y-3">
              <div className="space-y-1">
                <p className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--ink)]">
                  <AlertCircle className="h-4 w-4 text-[var(--vermilion)]" />
                  Modified in Obsidian
                </p>
                <p className="text-[13px] text-[var(--ink-muted)]">{selectedVaultExport.error}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onSyncSingleToVault(recording.id, { forceOverwrite: true })}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-[var(--ink)] px-3.5 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
                >
                  Overwrite vault note
                </button>
                <button
                  type="button"
                  onClick={() => void onKeepObsidianVersion(recording)}
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
                ) : isSelectedKeptObsidian ? (
                  <span className="inline-flex flex-wrap items-center gap-2 text-[var(--ink-secondary)]">
                    <span className="inline-flex items-center gap-1.5">
                      <FolderCheck className="h-3.5 w-3.5" />
                      Kept Obsidian version in {vault?.folderName}
                    </span>
                    {vaultPermission === 'granted' && (
                      <button
                        type="button"
                        onClick={() =>
                          void onSyncSingleToVault(recording.id, { forceOverwrite: true })
                        }
                        className="underline underline-offset-4 text-[var(--ink-muted)] hover:text-[var(--ink)] cursor-pointer"
                      >
                        Overwrite with Tapeleaf copy
                      </button>
                    )}
                  </span>
                ) : vault && vaultPermission === 'granted' ? (
                  <button
                    type="button"
                    onClick={() => void onSyncSingleToVault(recording.id)}
                    className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)] hover:text-[var(--ink)] underline underline-offset-4 cursor-pointer"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    Write to {vault.folderName}
                  </button>
                ) : vault && vaultPermission === 'prompt' ? (
                  <button
                    type="button"
                    onClick={onReconnectVault}
                    className="inline-flex items-center gap-1.5 text-[var(--ink-secondary)] hover:text-[var(--ink)] underline underline-offset-4 cursor-pointer"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    Reconnect {vault.folderName} to write
                  </button>
                ) : vaultPermission !== 'unsupported' ? (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    className="inline-flex items-center gap-1.5 hover:text-[var(--ink)] cursor-pointer"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    Connect Obsidian vault folder
                  </button>
                ) : null}

                {recording.audioSizeBytes > OBSIDIAN_STANDARD_LIMIT_BYTES && (
                  <span className="rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[11.5px] text-[var(--ink-secondary)]">
                    {formatBytes(recording.audioSizeBytes)} · exceeds Obsidian Sync Standard 5 MB
                    file limit (Plus: 200 MB)
                  </span>
                )}
              </div>
              {selectedVaultExport?.error && (
                <p className="text-[12.5px] text-[var(--vermilion)]">{selectedVaultExport.error}</p>
              )}
            </div>
          )}

          {/* Queued / Failed Transcription Banner */}
          {recording.status === 'queued' && (
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--canvas)] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-[14px] font-medium text-[var(--ink)]">
                  {!hasApiKey
                    ? 'Audio saved — Gemini API key needed'
                    : !isOnline
                      ? 'Audio saved offline'
                      : geminiUnreachable
                        ? 'Gemini unreachable — retrying shortly'
                        : 'Queued for transcription'}
                </p>
                <p className="text-[13px] text-[var(--ink-muted)]">
                  {!hasApiKey
                    ? 'Add your Gemini API key in Settings to transcribe and organize this clip.'
                    : !isOnline
                      ? 'Keep Tapeleaf open when back online to transcribe this clip automatically.'
                      : geminiUnreachable
                        ? 'Network request to Gemini failed. Tapeleaf will retry automatically while open, or tap Retry now.'
                        : 'Starting transcription shortly while Tapeleaf is open…'}
                </p>
              </div>
              {!hasApiKey ? (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[var(--ink)] px-3.5 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
                >
                  <Settings className="h-3.5 w-3.5" />
                  Open Settings
                </button>
              ) : isOnline ? (
                <button
                  type="button"
                  onClick={onDrainQueueNow}
                  className="inline-flex min-h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[var(--ink)] px-3.5 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {geminiUnreachable ? 'Retry now' : 'Transcribe now'}
                </button>
              ) : null}
            </div>
          )}

          {recording.status === 'failed' && (
            <div className="rounded-2xl border border-[var(--border-strong)] bg-[var(--canvas)] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--ink)]">
                  <AlertCircle className="h-4 w-4 text-[var(--vermilion)]" />
                  Audio is saved, but transcription didn’t finish
                </p>
                <p className="text-[13px] text-[var(--ink-muted)]">
                  {recording.errorMessage ||
                    'Tap Retry processing to transcribe this audio clip.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void onReprocess(recording)}
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
              {availableTabs.map((tab) => {
                const selected = detailTab === tab;
                const label =
                  tab === 'english' ? 'English' : tab === 'original' ? 'Original' : 'Markdown';
                return (
                  <button
                    key={tab}
                    ref={(el) => {
                      tabRefs.current[tab] = el;
                    }}
                    id={`tapeleaf-tab-${tab}`}
                    type="button"
                    role="tab"
                    tabIndex={selected ? 0 : -1}
                    aria-selected={selected}
                    aria-controls={`tapeleaf-panel-${tab}`}
                    onClick={() => setDetailTab(tab)}
                    onKeyDown={(e) => handleTabKeyDown(e, tab)}
                    className={[
                      'rounded-lg px-3.5 py-1.5 text-[13.5px] font-medium transition-all cursor-pointer',
                      selected
                        ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]',
                    ].join(' ')}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <span className="font-mono text-[12px] text-[var(--ink-muted)] truncate">
              {selectedFilename}
            </span>
          </div>

          {/* Body Content */}
          <div
            id={`tapeleaf-panel-${detailTab}`}
            role="tabpanel"
            aria-labelledby={`tapeleaf-tab-${detailTab}`}
          >
            {recording.status === 'processing' ? (
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
                copied={copiedId === recording.id}
                onCopy={() => void handleCopyMarkdown()}
              />
            ) : detailTab === 'original' && !recording.isEnglish ? (
              <section lang={recording.language} className="space-y-4 pt-1">
                <p className="font-mono text-[12px] uppercase tracking-wider text-[var(--ink-muted)]">
                  Original · {recording.languageName}
                </p>
                <div className="space-y-4 text-[17px] leading-[1.82] text-[var(--ink)]">
                  {(recording.originalTranscript ?? '')
                    .split(/\n{2,}/)
                    .filter(Boolean)
                    .map((para, idx) => (
                      <p key={idx}>{para}</p>
                    ))}
                </div>
              </section>
            ) : (
              <section className="space-y-4 pt-1">
                {recording.englishTranscript ? (
                  <div className="space-y-4 text-[17px] leading-[1.78] text-[var(--ink)]">
                    {recording.englishTranscript
                      .split(/\n{2,}/)
                      .filter(Boolean)
                      .map((para, idx) => (
                        <p key={idx}>{para}</p>
                      ))}
                  </div>
                ) : (
                  <p className="text-[15px] text-[var(--ink-muted)]">No transcript yet.</p>
                )}
              </section>
            )}
          </div>
        </article>
      </div>
    </>
  );
}
