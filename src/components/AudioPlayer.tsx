import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import { getAudioRecord } from '../lib/db';
import { formatDuration } from '../markdown';
import type { Recording } from '../types';

const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

function getSeekableEnd(el: HTMLAudioElement): number {
  if (el.seekable && el.seekable.length > 0) {
    const end = el.seekable.end(el.seekable.length - 1);
    if (Number.isFinite(end) && end > 0) return end;
  }
  return 0;
}

export function AudioPlayer({
  recording,
  onAudioLoaded,
}: {
  recording: Recording;
  onAudioLoaded?: (blob: Blob | null, mimeType?: string) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [seekableEnd, setSeekableEnd] = useState(0);
  const [rateIndex, setRateIndex] = useState(0);

  const onAudioLoadedRef = useRef(onAudioLoaded);
  onAudioLoadedRef.current = onAudioLoaded;

  const playbackRate = PLAYBACK_RATES[rateIndex];

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;

    setObjectUrl(null);
    setLoadError(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setMediaDuration(0);
    setSeekableEnd(0);
    onAudioLoadedRef.current?.(null);

    void getAudioRecord(recording.id)
      .then((rec) => {
        if (!active) return;
        if (!rec) {
          setLoadError('Local audio file is missing from device storage.');
          return;
        }
        createdUrl = URL.createObjectURL(rec.blob);
        setObjectUrl(createdUrl);
        onAudioLoadedRef.current?.(rec.blob, rec.mimeType);
      })
      .catch(() => {
        if (!active) return;
        setLoadError('Could not load audio from device storage.');
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
      setMediaDuration((prev) => (Math.abs(prev - el.duration) > 0.05 ? el.duration : prev));
    }
    const end = getSeekableEnd(el);
    if (end > 0) {
      setSeekableEnd((prev) => (Math.abs(prev - end) > 0.05 ? end : prev));
    }
  };

  const togglePlay = async () => {
    const el = audioRef.current;
    if (!el || !objectUrl) return;
    if (el.paused) {
      try {
        await el.play();
      } catch {
        setIsPlaying(false);
        setLoadError('Browser could not start audio playback for this clip.');
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
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-subtle)]/75 px-3.5 py-3 sm:px-4 sm:py-3.5 space-y-2">
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
        onError={() => {
          setIsPlaying(false);
          setLoadError('Audio playback failed — this codec may not be supported on this browser.');
        }}
      />

      <div className="flex items-center gap-2.5 sm:gap-3">
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

        <div className="flex items-center gap-0.5 shrink-0">
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

      {loadError && (
        <p className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--vermilion)]">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {loadError}
        </p>
      )}
    </div>
  );
}
