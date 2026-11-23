import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  FolderOpen,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { getVaultExportFor } from '../lib/vaultSync';
import type { VaultPermissionState } from '../lib/vaultSync';
import { formatDuration, formatRelativeTime } from '../markdown';
import type { Recording, StoredVaultHandle } from '../types';

export function formatTapeIndex(n: number | undefined): string {
  if (!n || n < 1) return '---';
  return String(n).padStart(3, '0');
}

interface LibraryPaneProps {
  recordings: Recording[];
  filteredRecordings: Recording[];
  tapeNumberById: Map<string, number>;
  loadingLibrary: boolean;
  storageError: string | null;
  onRetryBoot: () => void;
  selectedId: string;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  allTags: string[];
  selectedTag: string | null;
  onSelectTag: (tag: string | null) => void;
  onSelectRecording: (id: string) => void;
  hasApiKey: boolean;
  isOnline: boolean;
  vault: StoredVaultHandle | null;
  vaultPermission: VaultPermissionState;
  onOpenSettings: () => void;
  onConnectVault: () => void;
}

export function LibraryPane({
  recordings,
  filteredRecordings,
  tapeNumberById,
  loadingLibrary,
  storageError,
  onRetryBoot,
  selectedId,
  searchQuery,
  onSearchChange,
  searchInputRef,
  allTags,
  selectedTag,
  onSelectTag,
  onSelectRecording,
  hasApiKey,
  isOnline,
  vault,
  vaultPermission,
  onOpenSettings,
  onConnectVault,
}: LibraryPaneProps) {
  // Periodic tick so relative timestamps ("Just now", "2m ago") stay fresh while idle
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <>
      {/* Machined Hairline Search & Tag Strip */}
      <div className="shrink-0 bg-[var(--surface)] border-b border-[var(--border)]">
        <div
          className={[
            'relative flex items-center',
            allTags.length > 0 ? 'border-b border-[var(--border)]' : '',
          ].join(' ')}
        >
          <Search className="pointer-events-none absolute left-4 h-3.5 w-3.5 text-[var(--ink-muted)]" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="SEARCH TAPES, #TAGS…"
            aria-label="Search voice notes"
            className="h-11 w-full bg-transparent pl-10 pr-12 font-mono text-[12px] tracking-wide text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:outline-none"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => onSearchChange('')}
              aria-label="Clear search"
              className="absolute right-2.5 flex h-7 w-7 items-center justify-center rounded text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <div className="pointer-events-none absolute right-3.5 flex items-center gap-2">
              <span className="font-mono text-[11px] tabular-nums text-[var(--ink-muted)]">
                {filteredRecordings.length}
              </span>
              <kbd className="hidden lg:inline-flex items-center rounded border border-[var(--border-strong)] bg-[var(--canvas)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ink-muted)]">
                /
              </kbd>
            </div>
          )}
        </div>

        {allTags.length > 0 && (
          <div
            className="flex items-center gap-1.5 overflow-x-auto no-scrollbar px-4 py-2"
            role="group"
            aria-label="Filter by tag"
          >
            <button
              type="button"
              aria-pressed={selectedTag === null}
              onClick={() => onSelectTag(null)}
              className={[
                'shrink-0 rounded border px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider transition-colors cursor-pointer',
                selectedTag === null
                  ? 'bg-[var(--ink)] border-[var(--ink)] text-[var(--surface)]'
                  : 'bg-[var(--canvas)] border-[var(--border)] text-[var(--ink-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--ink)]',
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
                  aria-pressed={active}
                  onClick={() => onSelectTag(active ? null : tag)}
                  className={[
                    'shrink-0 rounded border px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider transition-colors cursor-pointer',
                    active
                      ? 'bg-[var(--ink)] border-[var(--ink)] text-[var(--surface)]'
                      : 'bg-[var(--canvas)] border-[var(--border)] text-[var(--ink-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--ink)]',
                  ].join(' ')}
                >
                  #{tag}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Indexed Hairline Tape Log */}
      <div className="flex-1 overflow-y-auto bg-[var(--canvas)]">
        {storageError ? (
          <div
            role="alert"
            className="m-4 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-5 py-7 text-center space-y-3"
          >
            <AlertCircle className="h-5 w-5 text-[var(--vermilion)] mx-auto" />
            <p className="text-[14.5px] font-semibold text-[var(--ink)]">
              Could not open local storage
            </p>
            <p className="text-[13px] leading-relaxed text-[var(--ink-muted)]">{storageError}</p>
            <button
              type="button"
              onClick={onRetryBoot}
              className="inline-flex min-h-[38px] items-center rounded-md bg-[var(--ink)] px-3.5 font-mono text-[12px] font-semibold uppercase tracking-wider text-[var(--surface)] hover:opacity-90 cursor-pointer"
            >
              Retry
            </button>
          </div>
        ) : loadingLibrary ? (
          <div aria-busy="true" aria-label="Loading notes">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex gap-3 border-b border-[var(--border)] px-4 py-3.5"
              >
                <div className="shimmer-bar h-3 w-7 rounded-[2px] mt-1 shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="shimmer-bar h-3.5 w-3/5 rounded-[2px]" />
                  <div className="shimmer-bar h-2.5 w-11/12 rounded-[2px]" />
                  <div className="shimmer-bar h-2 w-1/3 rounded-[2px]" />
                </div>
              </div>
            ))}
          </div>
        ) : filteredRecordings.length === 0 ? (
          <div className="m-4 rounded-lg border border-dashed border-[var(--border-strong)] bg-[var(--surface)]/50 px-5 py-9 text-center space-y-3">
            {recordings.length === 0 ? (
              <>
                <p className="font-mono text-[11px] uppercase tracking-widest text-[var(--ink-muted)]">
                  TAPE LOG · 000
                </p>
                <p className="text-[15px] font-semibold text-[var(--ink)]">No tapes recorded yet</p>
                <p className="text-[13px] leading-relaxed text-[var(--ink-muted)]">
                  Tap <strong>REC</strong> below. Clips save locally on your device and write
                  directly into your Obsidian vault folder.
                </p>
                <div className="pt-1 flex flex-wrap items-center justify-center gap-2">
                  {!hasApiKey && (
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md bg-[var(--ink)] px-3.5 font-mono text-[11.5px] font-semibold uppercase tracking-wider text-[var(--surface)] hover:opacity-90 cursor-pointer"
                    >
                      <Settings className="h-3.5 w-3.5" />
                      Set up Gemini &amp; Vault
                    </button>
                  )}
                  {hasApiKey && !vault && vaultPermission !== 'unsupported' && (
                    <button
                      type="button"
                      onClick={onConnectVault}
                      className="inline-flex min-h-[38px] items-center gap-1.5 rounded-md border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 font-mono text-[11.5px] font-semibold uppercase tracking-wider text-[var(--ink)] hover:bg-[var(--surface-subtle)] cursor-pointer"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      Connect Obsidian folder
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="text-[14.5px] font-semibold text-[var(--ink)]">
                  No matching tapes
                </p>
                <p className="text-[13px] text-[var(--ink-muted)]">
                  Try clearing your search or choosing another tag.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    onSearchChange('');
                    onSelectTag(null);
                  }}
                  className="inline-flex items-center rounded-md border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-1.5 font-mono text-[11.5px] font-semibold uppercase tracking-wider text-[var(--ink)] hover:bg-[var(--surface-subtle)] cursor-pointer"
                >
                  Reset filters
                </button>
              </>
            )}
          </div>
        ) : (
          filteredRecordings.map((rec) => {
            const isSelected = selectedId === rec.id;
            const isProcessing = rec.status === 'processing';
            const isQueued = rec.status === 'queued';
            const isFailed = rec.status === 'failed';
            const recVaultExport = getVaultExportFor(rec, vault?.vaultId);
            const writtenToVault =
              Boolean(vault) &&
              recVaultExport?.state === 'written' &&
              recVaultExport.audioWritten &&
              recVaultExport.lastExportedRevision >= rec.revision;
            const keptVaultCopy = Boolean(vault) && recVaultExport?.state === 'kept-vault';
            const hasConflict = Boolean(vault) && recVaultExport?.state === 'conflict';
            const tapeIndex = formatTapeIndex(tapeNumberById.get(rec.id));
            const highlightEdge = isSelected || isProcessing;

            return (
              <button
                key={rec.id}
                type="button"
                aria-current={isSelected ? 'true' : undefined}
                onClick={() => onSelectRecording(rec.id)}
                className={[
                  'group relative w-full text-left flex items-start gap-3 border-b border-[var(--border)] px-4 py-3.5 transition-colors cursor-pointer',
                  isSelected
                    ? 'bg-[var(--surface)]'
                    : isProcessing
                      ? 'bg-[var(--surface)]/80'
                      : 'bg-[var(--canvas)] hover:bg-[var(--surface)]/65',
                ].join(' ')}
              >
                {highlightEdge && (
                  <span
                    aria-hidden="true"
                    className={[
                      'absolute left-0 top-0 bottom-0 w-[3px] bg-[var(--vermilion)]',
                      isProcessing ? '' : 'hidden lg:block',
                    ].join(' ')}
                  />
                )}

                <span
                  className={[
                    'w-7 shrink-0 pt-0.5 font-mono text-[11px] font-semibold tabular-nums',
                    highlightEdge ? 'text-[var(--vermilion)]' : 'text-[var(--ink-muted)]',
                  ].join(' ')}
                >
                  {tapeIndex}
                </span>

                <div className="min-w-0 flex-1">
                  {isProcessing ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-2 text-[14px] font-semibold text-[var(--ink)]">
                          <span className="h-2 w-2 rounded-full bg-[var(--vermilion)] record-pulse" />
                          Listening &amp; organizing…
                        </span>
                        <span className="font-mono text-[11.5px] tabular-nums text-[var(--ink-muted)]">
                          {formatDuration(rec.durationSeconds)}
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        <div className="shimmer-bar h-2.5 w-11/12 rounded-[2px]" />
                        <div className="shimmer-bar h-2.5 w-7/12 rounded-[2px]" />
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-baseline justify-between gap-2.5">
                        <span className="block text-[14.5px] font-semibold leading-[1.3] tracking-[-0.015em] text-[var(--ink)] truncate">
                          {rec.title}
                        </span>
                        <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-[var(--ink-muted)]">
                          {formatDuration(rec.durationSeconds)}
                        </span>
                      </div>

                      {isQueued ? (
                        <p className="mt-1 text-[13px] text-[var(--ink-muted)] truncate">
                          {!hasApiKey
                            ? 'Audio saved · add Gemini key in Settings to transcribe'
                            : !isOnline
                              ? 'Saved offline · transcribes when back online'
                              : 'Queued for transcription…'}
                        </p>
                      ) : isFailed ? (
                        <p className="mt-1 inline-flex items-center gap-1.5 text-[13px] text-[var(--vermilion)]">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                          Audio saved · tap to retry transcription
                        </p>
                      ) : (
                        rec.summary && (
                          <p className="mt-1 text-[13px] leading-[1.45] text-[var(--ink-secondary)] line-clamp-2">
                            {rec.summary}
                          </p>
                        )
                      )}

                      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10.5px] tracking-wide text-[var(--ink-muted)]">
                        <span className="uppercase">
                          {formatRelativeTime(rec.created, nowMs)}
                        </span>

                        {!rec.isEnglish && rec.status === 'ready' && (
                          <span className="rounded border border-[var(--border-strong)] bg-[var(--panel)] px-1.5 py-[1px] text-[10px] font-semibold text-[var(--ink-secondary)]">
                            {rec.language.toUpperCase()}→EN
                          </span>
                        )}

                        {writtenToVault && (
                          <span
                            title="Written to Obsidian vault folder"
                            className="inline-flex items-center gap-0.5 font-semibold text-[var(--led-green)]"
                          >
                            <Check className="h-3 w-3" />
                            VAULT
                          </span>
                        )}

                        {keptVaultCopy && (
                          <span
                            title="Keeping the edited Obsidian copy"
                            className="inline-flex items-center gap-0.5 text-[var(--ink-secondary)]"
                          >
                            <Check className="h-3 w-3" />
                            OBSIDIAN COPY
                          </span>
                        )}

                        {hasConflict && (
                          <span className="font-semibold text-[var(--vermilion)]">
                            EDITED IN OBSIDIAN
                          </span>
                        )}

                        {rec.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="text-[var(--ink-muted)]">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </>
  );
}
