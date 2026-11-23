import { useEffect, useState } from 'react';
import {
  AlertCircle,
  FolderCheck,
  FolderOpen,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { getVaultExportFor } from '../lib/vaultSync';
import type { VaultPermissionState } from '../lib/vaultSync';
import { formatDuration, formatRelativeTime } from '../markdown';
import type { Recording, StoredVaultHandle } from '../types';

interface LibraryPaneProps {
  recordings: Recording[];
  filteredRecordings: Recording[];
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
      {/* Search Bar + Tag Filter Pills */}
      <div className="px-4 sm:px-5 pb-3 shrink-0 space-y-2.5">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-[var(--ink-muted)]" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search titles, transcripts, #tags…"
            aria-label="Search voice notes"
            className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-9 text-[14.5px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--border-strong)] focus:outline-none transition-colors"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => onSearchChange('')}
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
            role="group"
            aria-label="Filter by tag"
          >
            <button
              type="button"
              aria-pressed={selectedTag === null}
              onClick={() => onSelectTag(null)}
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
                  aria-pressed={active}
                  onClick={() => onSelectTag(active ? null : tag)}
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
        {storageError ? (
          <div
            role="alert"
            className="rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] px-5 py-7 text-center space-y-3"
          >
            <AlertCircle className="h-5 w-5 text-[var(--vermilion)] mx-auto" />
            <p className="text-[14.5px] font-medium text-[var(--ink)]">
              Could not open local storage
            </p>
            <p className="text-[13px] leading-relaxed text-[var(--ink-muted)]">{storageError}</p>
            <button
              type="button"
              onClick={onRetryBoot}
              className="inline-flex min-h-[38px] items-center rounded-xl bg-[var(--ink)] px-3.5 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
            >
              Retry
            </button>
          </div>
        ) : loadingLibrary ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading notes">
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
                  {!hasApiKey && (
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-[var(--ink)] px-3.5 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
                    >
                      <Settings className="h-3.5 w-3.5" />
                      Set up Gemini &amp; Vault
                    </button>
                  )}
                  {hasApiKey && !vault && vaultPermission !== 'unsupported' && (
                    <button
                      type="button"
                      onClick={onConnectVault}
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
                    onSearchChange('');
                    onSelectTag(null);
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

            return (
              <button
                key={rec.id}
                type="button"
                aria-current={isSelected ? 'true' : undefined}
                onClick={() => onSelectRecording(rec.id)}
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
                      <span className="block text-[15.5px] font-medium leading-[1.35] tracking-[-0.01em] text-[var(--ink)]">
                        {rec.title}
                      </span>
                      <span className="shrink-0 pt-0.5 text-[12px] tabular-nums text-[var(--ink-muted)]">
                        {formatRelativeTime(rec.created, nowMs)}
                      </span>
                    </div>

                    {isQueued ? (
                      <p className="mt-1.5 text-[13.5px] text-[var(--ink-muted)]">
                        {!hasApiKey
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

                      {keptVaultCopy && (
                        <span
                          title="Keeping the edited Obsidian copy"
                          className="inline-flex items-center gap-1 text-[11.5px] text-[var(--ink-muted)]"
                        >
                          <FolderCheck className="h-3 w-3" />
                          Obsidian copy kept
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
    </>
  );
}
