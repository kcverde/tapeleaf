import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FileAudio,
  FileText,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Search,
  Square,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import { INITIAL_FIXTURES, getFixtureAudioUrl } from './fixtures';
import { useRecorder } from './hooks/useRecorder';
import {
  buildNoteFilename,
  buildObsidianMarkdown,
  formatDuration,
  formatFullTimestamp,
  formatRelativeTime,
  formatTimerMs,
  normalizeTag,
} from './markdown';
import type { CapturedAudio, Recording } from './types';

type DetailTab = 'english' | 'original' | 'markdown';
type ThemeMode = 'light' | 'dark';

const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem('tapeleaf-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function makeRecordingId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `rec_${date}_${time}_${suffix}`;
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
  if (lower.includes('opus') && lower.includes('webm')) return 'OPUS · WEBM';
  if (lower.includes('mp4') || lower.includes('m4a')) return 'AAC · M4A';
  if (lower.includes('ogg')) return 'OPUS · OGG';
  if (lower.includes('webm')) return 'WEBM';
  return 'AUDIO';
}

function AudioPlayer({
  recording,
  isFixture,
}: {
  recording: Recording;
  isFixture: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [rateIndex, setRateIndex] = useState(0);

  const playbackRate = PLAYBACK_RATES[rateIndex];

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setMediaDuration(0);
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
      el.playbackRate = PLAYBACK_RATES[rateIndex];
    }
  }, [recording.id, recording.audioUrl]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  const togglePlay = async () => {
    const el = audioRef.current;
    if (!el || !recording.audioUrl) return;
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

  const seekTo = (nextSeconds: number) => {
    const el = audioRef.current;
    if (!el) return;
    const max = mediaDuration || recording.durationSeconds || 1;
    const clamped = Math.max(0, Math.min(max, nextSeconds));
    el.currentTime = clamped;
    setCurrentTime(clamped);
  };

  const cycleRate = () => {
    setRateIndex((prev) => (prev + 1) % PLAYBACK_RATES.length);
  };

  const effectiveDuration = mediaDuration > 0 && Number.isFinite(mediaDuration) ? mediaDuration : recording.durationSeconds;
  const progressPct = effectiveDuration > 0 ? Math.min(100, (currentTime / effectiveDuration) * 100) : 0;

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-subtle)]/75 px-3.5 py-3 sm:px-4 sm:py-3.5">
      <audio
        ref={audioRef}
        src={recording.audioUrl}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setMediaDuration(d);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
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
          disabled={!recording.audioUrl}
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
            aria-label="Rewind 10 seconds"
            title="Back 10s"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] transition-colors cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => seekTo(currentTime + 10)}
            aria-label="Forward 10 seconds"
            title="Forward 10s"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] transition-colors cursor-pointer"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-w-0 flex-1">
          <input
            type="range"
            min={0}
            max={effectiveDuration || 1}
            step={0.05}
            value={Math.min(currentTime, effectiveDuration || 1)}
            onChange={(e) => seekTo(Number(e.target.value))}
            aria-label="Audio progress"
            className="tapeleaf-scrubber w-full block"
            style={{
              background: `linear-gradient(to right, var(--ink) 0%, var(--ink) ${progressPct}%, var(--border-strong) ${progressPct}%, var(--border-strong) 100%)`,
              height: '4px',
              borderRadius: '9999px',
            }}
          />
          <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono tabular-nums text-[var(--ink-muted)]">
            <span>{formatDuration(currentTime)}</span>
            <div className="flex items-center gap-2">
              {isFixture && (
                <span className="font-sans text-[10.5px] text-[var(--ink-muted)]/80">
                  Demo tone
                </span>
              )}
              <span>{formatDuration(effectiveDuration)}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={cycleRate}
          aria-label={`Playback speed ${playbackRate}x`}
          title="Change playback speed"
          className="flex h-9 min-w-[46px] shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 font-mono text-[11.5px] font-medium tabular-nums text-[var(--ink-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--ink)] transition-colors cursor-pointer"
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
          <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
          <span className="truncate font-mono text-[11.5px] text-[var(--ink-secondary)]">
            {filename}
          </span>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] transition-colors shrink-0 cursor-pointer"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <pre className="p-4 sm:p-5 text-[12.5px] leading-[1.72] font-mono overflow-x-auto whitespace-pre-wrap break-words text-[var(--ink)]">
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
              <div key={index} className="text-[var(--ink-muted)] underline decoration-dotted underline-offset-4">
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
  const [recordings, setRecordings] = useState<Recording[]>(INITIAL_FIXTURES);
  const [selectedId, setSelectedId] = useState<string>(INITIAL_FIXTURES[0]?.id ?? '');
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

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const fixtureIdsRef = useRef<Set<string>>(new Set(INITIAL_FIXTURES.map((r) => r.id)));
  const processingTimersRef = useRef<Map<string, number>>(new Map());
  const objectUrlsRef = useRef<string[]>([]);

  const recorder = useRecorder();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const timers = processingTimersRef.current;
    return () => {
      for (const timerId of timers.values()) {
        window.clearTimeout(timerId);
      }
      for (const url of objectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  // Keyboard shortcut: `/` focuses search when not typing in an input
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

  const toggleTheme = () => {
    setTheme((prev) => {
      const next: ThemeMode = prev === 'light' ? 'dark' : 'light';
      window.localStorage.setItem('tapeleaf-theme', next);
      return next;
    });
  };

  // All tags sorted by frequency
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

  // Reset detail tab if switching to an English recording while on Original
  useEffect(() => {
    if (selectedRecording?.isEnglish && detailTab === 'original') {
      setDetailTab('english');
    }
  }, [selectedRecording?.id, selectedRecording?.isEnglish, detailTab]);

  // Close inline editors when selection changes
  useEffect(() => {
    setEditingTitle(false);
    setAddingTag(false);
    setTagDraft('');
    setConfirmDeleteId(null);
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

  const handleSelectRecording = (id: string) => {
    setSelectedId(id);
    setMobileView('detail');
  };

  const enqueueCapturedClip = useCallback((captured: CapturedAudio, simulated = false) => {
    const id = makeRecordingId();
    const created = new Date().toISOString();
    const objectUrl = URL.createObjectURL(captured.blob);
    objectUrlsRef.current.push(objectUrl);

    const stub: Recording = {
      id,
      title: 'New voice note',
      created,
      durationSeconds: captured.durationSeconds,
      language: 'en',
      languageName: 'English',
      isEnglish: true,
      status: 'processing',
      summary: '',
      tags: [],
      audioPath: `audio/${id}.${captured.extension}`,
      audioUrl: objectUrl,
      audioMimeType: captured.mimeType,
      englishTranscript: '',
    };

    setRecordings((prev) => [stub, ...prev]);
    setSelectedId(id);
    setSelectedTag(null);
    setSearchQuery('');
    setDetailTab('english');
    setMobileView('detail');

    const timer = window.setTimeout(() => {
      setRecordings((prev) =>
        prev.map((rec) =>
          rec.id === id
            ? {
                ...rec,
                status: 'ready',
                title: simulated
                  ? 'Sample capture — evening walk notes'
                  : 'Quick captured voice note',
                summary: simulated
                  ? 'Demo clip captured in prototype mode; Gemini transcription wires up in Phase 2.'
                  : 'Audio captured locally in your browser; live Gemini transcription and translation connect in Phase 2.',
                tags: simulated ? ['demo', 'ideas'] : ['inbox', 'voice-note'],
                englishTranscript: simulated
                  ? 'This is a simulated prototype capture showing Tapeleaf’s complete flow: instant local audio capture, the calm organizing shimmer, and an Obsidian-ready Markdown note with YAML frontmatter.\n\nOnce Phase 2 connects the Hono backend and Gemini audio pipeline, every clip will be saved to disk, language-detected, translated to English when needed, titled, and tagged automatically.'
                  : `Captured ${formatDuration(captured.durationSeconds)} of live microphone audio (${formatCodecLabel(captured.mimeType)}).\n\nPress Play above to verify your recording right now, edit the title or tags inline, or switch to the Markdown tab to inspect the Obsidian-ready note. In Phase 2, this clip will stream to the Hono backend and Gemini for real multilingual transcription and translation.`,
              }
            : rec,
        ),
      );
      processingTimersRef.current.delete(id);
    }, 2400);

    processingTimersRef.current.set(id, timer);
  }, []);

  const handleStopRecording = async () => {
    const captured = await recorder.stopRecording();
    if (captured) {
      enqueueCapturedClip(captured, false);
    }
  };

  const handleSimulateCapture = () => {
    recorder.clearError();
    const url = getFixtureAudioUrl(`sim_${Date.now()}`, [293.66, 349.23, 440.0, 523.25]);
    fetch(url)
      .then((res) => res.blob())
      .then((blob) => {
        enqueueCapturedClip(
          {
            blob,
            mimeType: 'audio/wav',
            durationSeconds: 8,
            extension: 'wav',
          },
          true,
        );
      })
      .catch(() => {});
  };

  const handleReprocess = (recording: Recording) => {
    if (recording.status === 'processing') return;
    const prevSnapshot = { ...recording };
    setRecordings((prev) =>
      prev.map((r) => (r.id === recording.id ? { ...r, status: 'processing' } : r)),
    );
    const existing = processingTimersRef.current.get(recording.id);
    if (existing) window.clearTimeout(existing);

    const timer = window.setTimeout(() => {
      setRecordings((prev) =>
        prev.map((r) =>
          r.id === recording.id
            ? {
                ...r,
                status: 'ready',
                title: r.title || prevSnapshot.title,
                summary: r.summary || prevSnapshot.summary,
              }
            : r,
        ),
      );
      processingTimersRef.current.delete(recording.id);
    }, 2000);
    processingTimersRef.current.set(recording.id, timer);
  };

  const handleDelete = (id: string) => {
    const existing = processingTimersRef.current.get(id);
    if (existing) {
      window.clearTimeout(existing);
      processingTimersRef.current.delete(id);
    }
    setRecordings((prev) => {
      const next = prev.filter((r) => r.id !== id);
      if (selectedId === id) {
        setSelectedId(next[0]?.id ?? '');
        setMobileView('list');
      }
      return next;
    });
    setConfirmDeleteId(null);
  };

  const startEditingTitle = () => {
    if (!selectedRecording || selectedRecording.status === 'processing') return;
    setTitleDraft(selectedRecording.title);
    setEditingTitle(true);
  };

  const commitTitleEdit = () => {
    if (!selectedRecording) return;
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== selectedRecording.title) {
      setRecordings((prev) =>
        prev.map((r) => (r.id === selectedRecording.id ? { ...r, title: trimmed } : r)),
      );
    }
    setEditingTitle(false);
  };

  const handleAddTag = () => {
    if (!selectedRecording) return;
    const clean = normalizeTag(tagDraft);
    if (clean && !selectedRecording.tags.includes(clean)) {
      setRecordings((prev) =>
        prev.map((r) =>
          r.id === selectedRecording.id ? { ...r, tags: [...r.tags, clean] } : r,
        ),
      );
    }
    setTagDraft('');
    setAddingTag(false);
  };

  const handleRemoveTag = (recordingId: string, tagToRemove: string) => {
    setRecordings((prev) =>
      prev.map((r) =>
        r.id === recordingId
          ? { ...r, tags: r.tags.filter((t) => t !== tagToRemove) }
          : r,
      ),
    );
    if (selectedTag === tagToRemove) {
      const stillExists = recordings.some(
        (r) => r.id !== recordingId && r.tags.includes(tagToRemove),
      );
      if (!stillExists) setSelectedTag(null);
    }
  };

  const selectedMarkdown = useMemo(
    () => (selectedRecording ? buildObsidianMarkdown(selectedRecording) : ''),
    [selectedRecording],
  );

  const selectedFilename = useMemo(
    () => (selectedRecording ? buildNoteFilename(selectedRecording) : 'note.md'),
    [selectedRecording],
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
      // Fallback textarea copy
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
    if (!selectedRecording?.audioUrl) return;
    try {
      const res = await fetch(selectedRecording.audioUrl);
      const blob = await res.blob();
      const ext = selectedRecording.audioMimeType?.includes('wav')
        ? 'wav'
        : selectedRecording.audioPath.split('.').pop() || 'webm';
      const baseName = selectedFilename.replace(/\.md$/, '');
      triggerDownload(blob, `${baseName}.${ext}`);
    } catch {
      // ignore
    }
  };

  const isActiveRecording = recorder.status === 'recording' || recorder.status === 'paused';

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
              <h1 className="text-[16px] font-semibold tracking-[-0.02em] text-[var(--ink)]">
                Tapeleaf
              </h1>
              <span className="text-[11.5px] font-mono tabular-nums text-[var(--ink-muted)]">
                {recordings.length}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors cursor-pointer"
          >
            {theme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
          </button>
        </header>

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
              className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-9 text-[13.5px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--border-strong)] focus:outline-none transition-colors"
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

          {/* Horizontal Scrollable Tag Pills */}
          <div
            className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5"
            role="tablist"
            aria-label="Filter by tag"
          >
            <button
              type="button"
              onClick={() => setSelectedTag(null)}
              className={[
                'shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors cursor-pointer',
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
                    'shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors cursor-pointer',
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
        </div>

        {/* Scannable Library Card Feed */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 pb-4 space-y-2">
          {filteredRecordings.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--border-strong)] px-5 py-10 text-center">
              <p className="text-[14px] font-medium text-[var(--ink)]">No matching voice notes</p>
              <p className="mt-1 text-[13px] text-[var(--ink-muted)]">
                Try clearing your search or choosing another tag.
              </p>
              {(searchQuery || selectedTag) && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedTag(null);
                  }}
                  className="mt-3 inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] cursor-pointer"
                >
                  Reset filters
                </button>
              )}
            </div>
          ) : (
            filteredRecordings.map((rec) => {
              const isSelected = selectedRecording?.id === rec.id;
              const isProcessing = rec.status === 'processing';
              return (
                <button
                  key={rec.id}
                  type="button"
                  onClick={() => handleSelectRecording(rec.id)}
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
                        <span className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--ink)]">
                          <span className="h-2 w-2 rounded-full bg-[var(--vermilion)] animate-pulse" />
                          Listening &amp; organizing…
                        </span>
                        <span className="font-mono text-[11px] tabular-nums text-[var(--ink-muted)]">
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
                        <h2 className="text-[14.5px] font-medium leading-[1.35] tracking-[-0.01em] text-[var(--ink)]">
                          {rec.title}
                        </h2>
                        <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-[var(--ink-muted)]">
                          {formatRelativeTime(rec.created)}
                        </span>
                      </div>

                      {rec.summary && (
                        <p className="mt-1 text-[13px] leading-[1.45] text-[var(--ink-secondary)] line-clamp-2">
                          {rec.summary}
                        </p>
                      )}

                      <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono text-[11px] tabular-nums text-[var(--ink-muted)]">
                          {formatDuration(rec.durationSeconds)}
                        </span>

                        {!rec.isEnglish && (
                          <span className="rounded-md bg-[var(--surface-subtle)] px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-[var(--ink-secondary)]">
                            {rec.language.toUpperCase()} → EN
                          </span>
                        )}

                        {rec.tags.slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            className="text-[11px] text-[var(--ink-muted)]"
                          >
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

        {/* Bottom Record Dock (Mobile Thumb-Zone + Desktop Left Rail) */}
        <div className="shrink-0 border-t border-[var(--border)] bg-[var(--canvas)]/95 backdrop-blur-md px-4 sm:px-5 pt-3 safe-bottom">
          {recorder.error && (
            <div className="mb-3 rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-[12px] text-[var(--ink-secondary)]">
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
              <button
                type="button"
                onClick={handleSimulateCapture}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-[var(--surface-subtle)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
              >
                Try sample capture
              </button>
            </div>
          )}

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
                  <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-[var(--ink-muted)]">
                    {recorder.status === 'recording' ? 'Recording' : 'Paused'}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="font-mono text-[15px] font-medium tabular-nums text-[var(--ink)]">
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

              {/* Live Mic Level Bars */}
              <div
                className="my-3 flex h-8 items-center justify-between gap-[3px] px-0.5"
                aria-hidden="true"
              >
                {recorder.levels.map((level, i) => {
                  const isRecent = i >= recorder.levels.length - 4 && recorder.status === 'recording';
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

              {/* Pause/Resume & Stop */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={
                    recorder.status === 'recording'
                      ? recorder.pauseRecording
                      : recorder.resumeRecording
                  }
                  className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] px-3 text-[13.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface-hover)] transition-colors cursor-pointer"
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
                  className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[var(--vermilion)] px-3 text-[13.5px] font-medium text-white hover:bg-[var(--vermilion-hover)] transition-colors cursor-pointer"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                  Stop &amp; Save
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-[var(--ink)]">
                  {recorder.status === 'requesting' ? 'Requesting mic…' : 'Ready to record'}
                </p>
                <p className="font-mono text-[10.5px] tracking-wide text-[var(--ink-muted)] truncate">
                  {formatCodecLabel(recorder.supportedMimeType)} · Obsidian .md
                </p>
              </div>

              <button
                type="button"
                onClick={() => void recorder.startRecording()}
                disabled={recorder.status === 'requesting'}
                aria-label="Start recording"
                className="group relative flex h-[52px] items-center gap-2.5 rounded-full bg-[var(--vermilion)] pl-4 pr-5 text-white shadow-[0_2px_10px_rgba(229,72,77,0.28)] hover:bg-[var(--vermilion-hover)] active:scale-[0.98] transition-all disabled:opacity-60 cursor-pointer shrink-0"
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full border border-white/45">
                  <span className="h-2.5 w-2.5 rounded-full bg-white" />
                </span>
                <span className="text-[14px] font-medium tracking-[-0.01em]">Record</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* RIGHT PANE: Calm Editorial Detail View */}
      <main
        className={[
          'flex-1 flex flex-col min-w-0 h-full bg-[var(--surface)] lg:bg-[var(--surface)]',
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
                  className="lg:hidden flex h-11 items-center gap-1 rounded-xl pl-1.5 pr-2.5 text-[13.5px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] cursor-pointer shrink-0"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Notes
                </button>

                <span className="hidden sm:inline text-[12.5px] text-[var(--ink-muted)] truncate">
                  {formatFullTimestamp(selectedRecording.created)}
                </span>

                {!selectedRecording.isEnglish && selectedRecording.status === 'ready' && (
                  <span className="hidden md:inline-flex items-center rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink-secondary)] shrink-0">
                    {selectedRecording.languageName} → English
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {confirmDeleteId === selectedRecording.id ? (
                  <div className="flex items-center gap-1.5 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-subtle)] px-2 py-1">
                    <span className="px-1.5 text-[12px] text-[var(--ink-secondary)]">
                      Delete note?
                    </span>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-[var(--ink-secondary)] hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(selectedRecording.id)}
                      className="rounded-lg bg-[var(--vermilion)] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[var(--vermilion-hover)] cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleCopyMarkdown()}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[12.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] transition-colors cursor-pointer"
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
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[12.5px] font-medium text-[var(--ink)] hover:bg-[var(--surface-subtle)] transition-colors cursor-pointer"
                    >
                      <Download className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                      <span className="hidden sm:inline">.md</span>
                    </button>

                    <div className="mx-0.5 hidden sm:block h-5 w-px bg-[var(--border)]" />

                    <button
                      type="button"
                      onClick={() => void handleDownloadAudio()}
                      disabled={!selectedRecording.audioUrl}
                      title="Download audio"
                      aria-label="Download audio"
                      className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--ink-muted)] hover:bg-[var(--surface-subtle)] hover:text-[var(--ink)] transition-colors disabled:opacity-40 cursor-pointer"
                    >
                      <FileAudio className="h-4 w-4" />
                    </button>

                    <button
                      type="button"
                      onClick={() => handleReprocess(selectedRecording)}
                      disabled={selectedRecording.status === 'processing'}
                      title="Reprocess note"
                      aria-label="Reprocess note"
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
                      onClick={() => setConfirmDeleteId(selectedRecording.id)}
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
                {/* Mobile Timestamp & Language Meta */}
                <div className="flex flex-wrap items-center gap-2 sm:hidden text-[12px] text-[var(--ink-muted)]">
                  <span>{formatFullTimestamp(selectedRecording.created)}</span>
                  {!selectedRecording.isEnglish && selectedRecording.status === 'ready' && (
                    <span className="rounded-md bg-[var(--surface-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink-secondary)]">
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
                      onBlur={commitTitleEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitTitleEdit();
                        if (e.key === 'Escape') setEditingTitle(false);
                      }}
                      aria-label="Edit note title"
                      className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--canvas)] px-3 py-1.5 -mx-3 text-[23px] sm:text-[26px] font-semibold leading-[1.22] tracking-[-0.025em] text-[var(--ink)] focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={startEditingTitle}
                      disabled={selectedRecording.status === 'processing'}
                      className="group inline-flex items-baseline gap-2.5 text-left rounded-lg -mx-1.5 px-1.5 py-0.5 hover:bg-[var(--surface-subtle)]/70 transition-colors disabled:hover:bg-transparent cursor-pointer"
                    >
                      <h2 className="text-[23px] sm:text-[26px] font-semibold leading-[1.22] tracking-[-0.025em] text-[var(--ink)]">
                        {selectedRecording.status === 'processing'
                          ? 'Listening & organizing…'
                          : selectedRecording.title}
                      </h2>
                      {selectedRecording.status === 'ready' && (
                        <Pencil className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </button>
                  )}

                  {/* Editorial 1-line Summary */}
                  {selectedRecording.status === 'ready' && selectedRecording.summary && (
                    <p className="mt-3 border-l-2 border-[var(--border-strong)] pl-3.5 text-[14.5px] leading-[1.6] text-[var(--ink-secondary)]">
                      {selectedRecording.summary}
                    </p>
                  )}

                  {/* Inline Editable Tags */}
                  {selectedRecording.status === 'ready' && (
                    <div className="mt-4 flex flex-wrap items-center gap-1.5">
                      {selectedRecording.tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-subtle)] pl-2.5 pr-1.5 py-1 text-[12px] font-medium text-[var(--ink-secondary)]"
                        >
                          <span>#{tag}</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveTag(selectedRecording.id, tag)}
                            aria-label={`Remove tag ${tag}`}
                            className="flex h-4 w-4 items-center justify-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--ink)] cursor-pointer"
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      ))}

                      {addingTag ? (
                        <input
                          ref={tagInputRef}
                          type="text"
                          value={tagDraft}
                          onChange={(e) => setTagDraft(e.target.value)}
                          onBlur={handleAddTag}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddTag();
                            }
                            if (e.key === 'Escape') {
                              setTagDraft('');
                              setAddingTag(false);
                            }
                          }}
                          placeholder="new-tag"
                          aria-label="New tag name"
                          className="h-7 w-28 rounded-full border border-[var(--border-strong)] bg-[var(--canvas)] px-2.5 text-[12px] text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setAddingTag(true)}
                          className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-[var(--border-strong)] px-2.5 text-[11.5px] font-medium text-[var(--ink-muted)] hover:border-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors cursor-pointer"
                        >
                          <Plus className="h-3 w-3" />
                          tag
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Clean Native Audio Playback Deck */}
                <AudioPlayer
                  recording={selectedRecording}
                  isFixture={fixtureIdsRef.current.has(selectedRecording.id)}
                />

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
                        'rounded-lg px-3.5 py-1.5 text-[12.5px] font-medium transition-all cursor-pointer',
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
                          'rounded-lg px-3.5 py-1.5 text-[12.5px] font-medium transition-all cursor-pointer',
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
                        'rounded-lg px-3.5 py-1.5 text-[12.5px] font-medium transition-all cursor-pointer',
                        detailTab === 'markdown'
                          ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[0_1px_2px_rgba(0,0,0,0.06)]'
                          : 'text-[var(--ink-muted)] hover:text-[var(--ink)]',
                      ].join(' ')}
                    >
                      Markdown
                    </button>
                  </div>

                  <span className="font-mono text-[11px] text-[var(--ink-muted)] truncate">
                    {selectedFilename}
                  </span>
                </div>

                {/* Body Content */}
                {selectedRecording.status === 'processing' ? (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--canvas)] p-5 space-y-3.5">
                    <div className="flex items-center gap-2.5 text-[13.5px] font-medium text-[var(--ink)]">
                      <span className="h-2 w-2 rounded-full bg-[var(--vermilion)] animate-pulse" />
                      Listening &amp; organizing…
                    </div>
                    <p className="text-[13px] leading-relaxed text-[var(--ink-muted)]">
                      Your audio is safely captured. Detecting language, transcribing, summarizing,
                      and writing the Obsidian Markdown note.
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
                  <section
                    lang={selectedRecording.language}
                    className="space-y-4 pt-1"
                  >
                    <p className="font-mono text-[11px] uppercase tracking-wider text-[var(--ink-muted)]">
                      Original · {selectedRecording.languageName}
                    </p>
                    <div className="space-y-4 text-[15.5px] leading-[1.8] text-[var(--ink)]">
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
                    <div className="space-y-4 text-[15.5px] leading-[1.78] text-[var(--ink)]">
                      {selectedRecording.englishTranscript
                        .split(/\n{2,}/)
                        .filter(Boolean)
                        .map((para, idx) => (
                          <p key={idx}>{para}</p>
                        ))}
                    </div>
                  </section>
                )}
              </article>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <TapeleafMark />
            <h2 className="mt-4 text-[16px] font-medium text-[var(--ink)]">
              Tap Record to capture a thought
            </h2>
            <p className="mt-1.5 max-w-xs text-[13.5px] leading-relaxed text-[var(--ink-muted)]">
              Every voice memo is saved as a clean Obsidian-ready Markdown note with YAML
              frontmatter.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
