import { useEffect, useState } from 'react';
import {
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  FolderCheck,
  FolderOpen,
  HardDrive,
  KeyRound,
  RefreshCw,
  Unlink,
  X,
} from 'lucide-react';
import {
  AVAILABLE_MODELS,
  verifyGeminiApiKey,
} from '../lib/geminiClient';
import { getStorageStats } from '../lib/db';
import type { VaultPermissionState } from '../lib/vaultSync';
import { formatBytes } from '../markdown';
import type { StoredVaultHandle } from '../types';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  apiKey: string;
  rememberKey: boolean;
  model: string;
  onSaveGemini: (next: { apiKey: string; rememberOnDevice: boolean; model: string }) => void;
  vault: StoredVaultHandle | null;
  vaultPermission: VaultPermissionState;
  pendingVaultCount: number;
  recordingCount: number;
  onConnectVault: () => Promise<void>;
  onReconnectVault: () => Promise<void>;
  onDisconnectVault: () => Promise<void>;
  onSyncVaultNow: () => Promise<void>;
}

export function SettingsModal({
  open,
  onClose,
  apiKey,
  rememberKey,
  model,
  onSaveGemini,
  vault,
  vaultPermission,
  pendingVaultCount,
  recordingCount,
  onConnectVault,
  onReconnectVault,
  onDisconnectVault,
  onSyncVaultNow,
}: SettingsModalProps) {
  const [keyDraft, setKeyDraft] = useState(apiKey);
  const [rememberDraft, setRememberDraft] = useState(rememberKey);
  const [modelDraft, setModelDraft] = useState(model);
  const [showKey, setShowKey] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [keyFeedback, setKeyFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultMessage, setVaultMessage] = useState<string | null>(null);
  const [storageStats, setStorageStats] = useState<{
    persisted: boolean;
    usageBytes: number;
    quotaBytes: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setKeyDraft(apiKey);
    setRememberDraft(rememberKey);
    setModelDraft(model);
    setKeyFeedback(null);
    setVaultMessage(null);
    void getStorageStats().then(setStorageStats);
  }, [open, apiKey, rememberKey, model]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = () => {
    onSaveGemini({
      apiKey: keyDraft.trim(),
      rememberOnDevice: rememberDraft,
      model: modelDraft,
    });
    setKeyFeedback({
      ok: true,
      text: keyDraft.trim()
        ? rememberDraft
          ? 'Saved on this device.'
          : 'Saved for this session.'
        : 'Key cleared.',
    });
  };

  const handleTestKey = async () => {
    setTestingKey(true);
    setKeyFeedback(null);
    const res = await verifyGeminiApiKey(keyDraft);
    setTestingKey(false);
    setKeyFeedback({ ok: res.ok, text: res.message });
    if (res.ok) {
      onSaveGemini({
        apiKey: keyDraft.trim(),
        rememberOnDevice: rememberDraft,
        model: modelDraft,
      });
    }
  };

  const runVaultAction = async (fn: () => Promise<void>, successNote?: string) => {
    setVaultBusy(true);
    setVaultMessage(null);
    try {
      await fn();
      if (successNote) setVaultMessage(successNote);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User dismissed folder picker
      } else {
        setVaultMessage(err instanceof Error ? err.message : 'Folder operation failed.');
      }
    } finally {
      setVaultBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/45 backdrop-blur-[2px] p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Tapeleaf settings"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-[480px] max-h-[90dvh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur-md px-5 py-4">
          <h2 className="text-[17px] font-semibold tracking-[-0.015em]">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-6">
          {/* Obsidian Vault Folder Section */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <FolderCheck className="h-4 w-4 text-[var(--ink-muted)]" />
              <h3 className="text-[14.5px] font-semibold text-[var(--ink)]">
                Obsidian Vault Folder
              </h3>
            </div>

            {vaultPermission === 'unsupported' ? (
              <p className="rounded-2xl border border-[var(--border)] bg-[var(--canvas)] p-3.5 text-[13.5px] leading-relaxed text-[var(--ink-secondary)]">
                Direct folder writing requires Chrome on Android (v132+) or Desktop Chrome/Edge.
                You can still use <strong>Copy MD</strong>, <strong>Download .md</strong>, and{' '}
                <strong>Share Audio</strong> on this browser.
              </p>
            ) : (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--canvas)] p-4 space-y-3">
                {vault ? (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[14px] font-medium text-[var(--ink)] truncate">
                        {vault.folderName}
                      </p>
                      <p className="mt-0.5 text-[12.5px] text-[var(--ink-muted)]">
                        {vaultPermission === 'granted'
                          ? pendingVaultCount > 0
                            ? `Connected · ${pendingVaultCount} note${pendingVaultCount === 1 ? '' : 's'} waiting to write`
                            : 'Connected · writing .md + audio/ automatically'
                          : 'Reconnect needed after app restart'}
                      </p>
                    </div>
                    <span
                      className={[
                        'shrink-0 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium',
                        vaultPermission === 'granted'
                          ? 'bg-[var(--surface-subtle)] text-[var(--ink)]'
                          : 'bg-[var(--vermilion-soft)] text-[var(--vermilion)]',
                      ].join(' ')}
                    >
                      {vaultPermission === 'granted' ? 'Connected' : 'Reconnect'}
                    </span>
                  </div>
                ) : (
                  <p className="text-[13.5px] leading-relaxed text-[var(--ink-secondary)]">
                    Connect a subfolder (like <code className="font-mono text-[12.5px]">Tapeleaf</code>)
                    inside your Obsidian vault stored in <strong>Device storage</strong>. Tapeleaf
                    writes both the <code className="font-mono text-[12.5px]">.md</code> note and{' '}
                    <code className="font-mono text-[12.5px]">audio/</code> clip directly there so{' '}
                    <strong>Obsidian Sync</strong> syncs both automatically.
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {vault && vaultPermission === 'prompt' && (
                    <button
                      type="button"
                      disabled={vaultBusy}
                      onClick={() => void runVaultAction(onReconnectVault, 'Vault reconnected.')}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[var(--ink)] px-3.5 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 disabled:opacity-50 cursor-pointer"
                    >
                      <FolderOpen className="h-4 w-4" />
                      Reconnect folder
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={vaultBusy}
                    onClick={() => void runVaultAction(onConnectVault, 'Vault folder connected.')}
                    className={[
                      'inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-medium transition-colors disabled:opacity-50 cursor-pointer',
                      !vault
                        ? 'bg-[var(--ink)] text-[var(--canvas)] hover:opacity-90'
                        : 'border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--surface-subtle)]',
                    ].join(' ')}
                  >
                    <FolderOpen className="h-4 w-4" />
                    {vault ? 'Change folder' : 'Connect vault folder'}
                  </button>

                  {vault && vaultPermission === 'granted' && (
                    <button
                      type="button"
                      disabled={vaultBusy}
                      onClick={() => void runVaultAction(onSyncVaultNow, 'Vault write check complete.')}
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[13px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] disabled:opacity-50 cursor-pointer"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${vaultBusy ? 'animate-spin' : ''}`} />
                      Write pending
                    </button>
                  )}

                  {vault && (
                    <button
                      type="button"
                      disabled={vaultBusy}
                      onClick={() =>
                        void runVaultAction(onDisconnectVault, 'Disconnected vault folder.')
                      }
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--vermilion)] disabled:opacity-50 cursor-pointer"
                    >
                      <Unlink className="h-3.5 w-3.5" />
                      Disconnect
                    </button>
                  )}
                </div>

                {vaultMessage && (
                  <p className="text-[12.5px] text-[var(--ink-secondary)]">{vaultMessage}</p>
                )}

                <p className="text-[12px] leading-relaxed text-[var(--ink-muted)]">
                  Android tip: pick a subfolder inside your vault in Device storage (Android blocks
                  top-level Downloads/Documents and Obsidian’s private App storage). Enable{' '}
                  <strong>Audio</strong> in Obsidian Sync settings so audio attachments sync across
                  devices (Sync Standard caps files at 5 MB; Plus at 200 MB).
                </p>
              </div>
            )}
          </section>

          {/* Gemini API Key Section */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-[var(--ink-muted)]" />
                <h3 className="text-[14.5px] font-semibold text-[var(--ink)]">Gemini API</h3>
              </div>
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[12.5px] text-[var(--ink-muted)] hover:text-[var(--ink)]"
              >
                Get API key
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-[var(--canvas)] p-4 space-y-3.5">
              <div className="space-y-1.5">
                <label htmlFor="tapeleaf-api-key" className="block text-[13px] font-medium text-[var(--ink-secondary)]">
                  Gemini API Key
                </label>
                <div className="relative flex items-center">
                  <input
                    id="tapeleaf-api-key"
                    type={showKey ? 'text' : 'password'}
                    value={keyDraft}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    placeholder="AIza..."
                    autoComplete="off"
                    spellCheck={false}
                    className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-3.5 pr-11 font-mono text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--border-strong)] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    aria-label={showKey ? 'Hide API key' : 'Show API key'}
                    className="absolute right-2 flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:text-[var(--ink)] cursor-pointer"
                  >
                    {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rememberDraft}
                  onChange={(e) => setRememberDraft(e.target.checked)}
                  className="mt-1 h-4 w-4 accent-[var(--ink)] rounded cursor-pointer"
                />
                <span className="text-[13px] leading-snug text-[var(--ink-secondary)]">
                  Remember key on this device
                  <span className="block text-[12px] text-[var(--ink-muted)]">
                    Off = session-only (clears when you close the app). Your key is sent only to
                    Google’s Gemini API.
                  </span>
                </span>
              </label>

              <div className="space-y-1.5">
                <label htmlFor="tapeleaf-model" className="block text-[13px] font-medium text-[var(--ink-secondary)]">
                  Model
                </label>
                <select
                  id="tapeleaf-model"
                  value={modelDraft}
                  onChange={(e) => setModelDraft(e.target.value)}
                  className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[13.5px] text-[var(--ink)] focus:border-[var(--border-strong)] focus:outline-none"
                >
                  {AVAILABLE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={handleSave}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-[var(--ink)] px-4 text-[13px] font-medium text-[var(--canvas)] hover:opacity-90 cursor-pointer"
                >
                  <Check className="h-4 w-4" />
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => void handleTestKey()}
                  disabled={testingKey || !keyDraft.trim()}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 text-[13px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] disabled:opacity-45 cursor-pointer"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${testingKey ? 'animate-spin' : ''}`} />
                  Test key
                </button>
              </div>

              {keyFeedback && (
                <p
                  className={[
                    'text-[12.5px]',
                    keyFeedback.ok ? 'text-[var(--ink-secondary)]' : 'text-[var(--vermilion)]',
                  ].join(' ')}
                >
                  {keyFeedback.text}
                </p>
              )}
            </div>
          </section>

          {/* Local Storage Info */}
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-[var(--ink-muted)]" />
              <h3 className="text-[14.5px] font-semibold text-[var(--ink)]">On-Device Storage</h3>
            </div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--canvas)] px-4 py-3 flex items-center justify-between gap-3 text-[13px] text-[var(--ink-secondary)]">
              <span>
                {recordingCount} local {recordingCount === 1 ? 'note' : 'notes'}
                {storageStats ? ` · ${formatBytes(storageStats.usageBytes)} used` : ''}
              </span>
              <span className="font-mono text-[11.5px] text-[var(--ink-muted)]">
                {storageStats?.persisted ? 'Persistent' : 'Standard'}
              </span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
