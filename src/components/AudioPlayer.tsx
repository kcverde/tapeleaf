import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Pause, Play } from 'lucide-react';
import {
  deterministicWaveformFallback,
  extractWaveformPeaks,
} from '../lib/audio';
import { getAudioRecord } from '../lib/db';
import { formatDuration } from '../markdown';
import type { Recording } from '../types';

const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
const WAVEFORM_BARS = 44;

// Cache decoded waveform peaks per recording ID for instant re-render when switching notes
const waveformCache = new Map<string, number[]>();

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
  const waveRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [seekableEnd, setSeekableEnd] = useState(0);
  const [rateIndex, setRateIndex] = useState(0);

  const fallbackBars = useMemo(
    () => deterministicWaveformFallback(recording.id, WAVEFORM_BARS),
    [recording.id],
  );
  const [peaks, setPeaks] = useState<number[]>(
    () => waveformCache.get(recording.id) ?? fallbackBars,
  );

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
    setPeaks(waveformCache.get(recording.id) ?? fallbackBars);
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

        if (!waveformCache.has(recording.id)) {
          void extractWaveformPeaks(rec.blob, recording.id, WAVEFORM_BARS).then((decoded) => {
            if (!active) return;
            waveformCache.set(recording.id, decoded);
            setPeaks(decoded);
          });
        }
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
  }, [recording.id, fallbackBars]);

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

  const seekFromClientX = (clientX: number) => {
    const track = waveRef.current;
    if (!track || !canSeek) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seekTo(ratio * maxSeekable);
  };

  const cycleRate = () => {
    setRateIndex((prev) => (prev + 1) % PLAYBACK_RATES.length);
  };

  const displayDuration = Math.max(mediaDuration, seekableEnd, recording.durationSeconds);
  const progressRatio =
    displayDuration > 0 ? Math.max(0, Math.min(1, currentTime / displayDuration)) : 0;
  const activeBarIdx =
    currentTime > 0 || isPlaying
      ? Math.min(peaks.length - 1, Math.floor(progressRatio * peaks.length))
      : -1;

  return (
    <div className="rounded-lg border border-[var(--deck-border)] bg-[var(--deck-bg)] text-[var(--deck-ink)] p-3.5 sm:p-4 space-y-3">
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

      {/* Interactive Segmented Waveform Scrubber */}
      <div
        ref={waveRef}
        role="slider"
        tabIndex={canSeek ? 0 : -1}
        aria-label="Audio progress"
        aria-valuemin={0}
        aria-valuemax={Math.round(displayDuration)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`${formatDuration(currentTime)} of ${formatDuration(displayDuration)}`}
        aria-disabled={!canSeek}
        onPointerDown={(e) => {
          if (!canSeek) return;
          draggingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (!draggingRef.current) return;
          seekFromClientX(e.clientX);
        }}
        onPointerUp={(e) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
        onKeyDown={(e) => {
          if (!canSeek) return;
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            seekTo(currentTime + 5);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            seekTo(currentTime - 5);
          } else if (e.key === 'Home') {
            e.preventDefault();
            seekTo(0);
          } else if (e.key === 'End') {
            e.preventDefault();
            seekTo(maxSeekable);
          } else if (e.key === ' ') {
            e.preventDefault();
            void togglePlay();
          }
        }}
        className={[
          'flex h-11 sm:h-12 w-full items-center gap-[3px] select-none touch-none rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--deck-ink)]/50',
          canSeek ? 'cursor-pointer' : 'opacity-55 cursor-default',
        ].join(' ')}
      >
        {peaks.map((amp, i) => {
          const isHead = i === activeBarIdx;
          const isPlayed = activeBarIdx >= 0 && i < activeBarIdx;
          const heightPct = Math.round(Math.max(16, Math.min(100, amp * 100)));
          return (
            <span
              key={i}
              aria-hidden="true"
              className="flex-1 rounded-[1.5px] transition-colors duration-75"
              style={{
                height: `${isHead ? Math.max(heightPct, 72) : heightPct}%`,
                backgroundColor: isHead
                  ? 'var(--vermilion)'
                  : isPlayed
                    ? 'var(--deck-ink)'
                    : 'var(--deck-wave-idle)',
              }}
            />
          );
        })}
      </div>

      {/* Tactile Transport Keys + Tabular Time Readout */}
      <div className="flex items-center justify-between gap-2 pt-0.5">
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void togglePlay()}
            disabled={!objectUrl}
            aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-[var(--deck-ink)] px-3.5 font-mono text-[11.5px] font-bold uppercase tracking-wider text-[var(--deck-bg)] hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-40 cursor-pointer"
          >
            {isPlaying ? (
              <>
                <Pause className="h-3.5 w-3.5 fill-current" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 fill-current" />
                <span>Play</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => seekTo(currentTime - 10)}
            disabled={!canSeek}
            aria-label="Rewind 10 seconds"
            title="Back 10s"
            className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--deck-border)] bg-[var(--deck-surface)] px-2.5 font-mono text-[11px] font-semibold tabular-nums text-[var(--deck-ink)] hover:bg-[var(--deck-surface-hover)] transition-colors disabled:opacity-40 cursor-pointer"
          >
            −10
          </button>
          <button
            type="button"
            onClick={() => seekTo(currentTime + 10)}
            disabled={!canSeek}
            aria-label="Forward 10 seconds"
            title="Forward 10s"
            className="inline-flex h-9 items-center justify-center rounded-md border border-[var(--deck-border)] bg-[var(--deck-surface)] px-2.5 font-mono text-[11px] font-semibold tabular-nums text-[var(--deck-ink)] hover:bg-[var(--deck-surface-hover)] transition-colors disabled:opacity-40 cursor-pointer"
          >
            +10
          </button>
        </div>

        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[11.5px] tabular-nums text-[var(--deck-muted)] truncate">
            <span className="text-[var(--deck-ink)]">{formatDuration(currentTime)}</span>
            <span className="mx-1 opacity-60">/</span>
            <span>{formatDuration(displayDuration)}</span>
          </span>

          <button
            type="button"
            onClick={cycleRate}
            aria-label={`Playback speed ${playbackRate}x`}
            title="Change playback speed"
            className="inline-flex h-9 min-w-[46px] shrink-0 items-center justify-center rounded-md border border-[var(--deck-border)] bg-[var(--deck-surface)] px-2 font-mono text-[11.5px] font-semibold tabular-nums text-[var(--deck-ink)] hover:bg-[var(--deck-surface-hover)] transition-colors cursor-pointer"
          >
            {playbackRate}×
          </button>
        </div>
      </div>

      {loadError && (
        <p className="inline-flex items-center gap-1.5 text-[12px] text-[var(--vermilion)]">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {loadError}
        </p>
      )}
    </div>
  );
}
