import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapturedAudio } from '../types';

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'paused';

// Prefer explicit AAC/MP4 (.m4a) when supported & playable for broadest Obsidian Sync
// playback across Android, macOS, and iOS; fall back cleanly to WebM/Opus or Ogg/Opus.
const MIME_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

const BAR_COUNT = 26;
const EMPTY_LEVELS = Array.from({ length: BAR_COUNT }, () => 0.08);
const ERROR_FINALIZE_FALLBACK_MS = 1500;

export function probeSupportedMimeTypes(): string[] {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return [];
  }
  const probeAudio =
    typeof document !== 'undefined' ? document.createElement('audio') : null;

  const playable: string[] = [];
  const recorderOnly: string[] = [];

  for (const candidate of MIME_CANDIDATES) {
    if (!MediaRecorder.isTypeSupported(candidate)) continue;
    if (probeAudio) {
      // Require exact candidate playability so explicit codec variants aren't masked by bare container checks
      if (probeAudio.canPlayType(candidate) !== '') {
        playable.push(candidate);
      } else {
        recorderOnly.push(candidate);
      }
    } else {
      playable.push(candidate);
    }
  }

  return [...playable, ...recorderOnly];
}

export function extensionForMimeType(mimeType: string, fallbackName?: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'm4a';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  if (lower.includes('flac')) return 'flac';
  if (lower.includes('webm')) return 'webm';

  if (fallbackName) {
    const ext = fallbackName.split('.').pop()?.toLowerCase() ?? '';
    if (['m4a', 'mp4', 'webm', 'ogg', 'wav', 'mp3', 'flac', 'aac'].includes(ext)) {
      return ext === 'mp4' ? 'm4a' : ext;
    }
  }
  return 'webm';
}

export interface UseRecorderOptions {
  onInterruptedCapture?: (audio: CapturedAudio) => void;
}

export function useRecorder(options?: UseRecorderOptions) {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<number[]>(EMPTY_LEVELS);
  const [error, setError] = useState<string | null>(null);
  const [candidateMimeTypes] = useState<string[]>(() => probeSupportedMimeTypes());
  const [activeMimeType, setActiveMimeType] = useState<string>(
    () => candidateMimeTypes[0] ?? '',
  );

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const accumulatedMsRef = useRef<number>(0);
  const statusRef = useRef<RecorderStatus>('idle');
  const levelHistoryRef = useRef<number[]>([...EMPTY_LEVELS]);
  const lastSampleTsRef = useRef<number>(0);

  const finalizedRef = useRef<boolean>(false);
  const discardOnStopRef = useRef<boolean>(false);
  const hadRecorderErrorRef = useRef<boolean>(false);
  const stopResolverRef = useRef<((audio: CapturedAudio | null) => void) | null>(null);
  const onInterruptedRef = useRef(options?.onInterruptedCapture);
  onInterruptedRef.current = options?.onInterruptedCapture;

  const isSupported =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined';

  const updateStatus = useCallback((next: RecorderStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const releaseHardware = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.onended = null;
        track.stop();
      }
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    mediaRecorderRef.current = null;
  }, []);

  const finalizeCapture = useCallback(
    (resolvedMime: string, wasInterrupted: boolean) => {
      if (finalizedRef.current) return;
      finalizedRef.current = true;

      const finalElapsedMs =
        statusRef.current === 'recording'
          ? accumulatedMsRef.current + (performance.now() - startedAtRef.current)
          : accumulatedMsRef.current;

      const discard = discardOnStopRef.current;
      const chunks = chunksRef.current;
      const resolver = stopResolverRef.current;
      const hadError = hadRecorderErrorRef.current;

      chunksRef.current = [];
      stopResolverRef.current = null;
      discardOnStopRef.current = false;
      hadRecorderErrorRef.current = false;
      accumulatedMsRef.current = 0;
      setElapsedMs(0);
      levelHistoryRef.current = [...EMPTY_LEVELS];
      setLevels(EMPTY_LEVELS);
      releaseHardware();
      updateStatus('idle');

      if (discard) {
        resolver?.(null);
        return;
      }

      const blob = new Blob(chunks, { type: resolvedMime });
      const captured: CapturedAudio | null =
        blob.size > 0
          ? {
              blob,
              mimeType: resolvedMime,
              durationSeconds: Math.max(1, Math.round(finalElapsedMs / 1000)),
              extension: extensionForMimeType(resolvedMime),
            }
          : null;

      if (resolver) {
        resolver(captured);
      } else if (wasInterrupted || hadError) {
        if (captured) {
          setError('Recording ended unexpectedly — saving the audio captured so far.');
          onInterruptedRef.current?.(captured);
        } else {
          setError('Recording was interrupted by the browser before any audio was captured.');
        }
      }
    },
    [releaseHardware, updateStatus],
  );

  useEffect(() => {
    return () => {
      discardOnStopRef.current = true;
      const rec = mediaRecorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          // ignore
        }
      }
      releaseHardware();
    };
  }, [releaseHardware]);

  const startMeterLoop = useCallback(() => {
    const tick = (ts: number) => {
      if (statusRef.current === 'recording') {
        const currentElapsed =
          accumulatedMsRef.current + (performance.now() - startedAtRef.current);
        setElapsedMs(currentElapsed);

        if (ts - lastSampleTsRef.current >= 55) {
          lastSampleTsRef.current = ts;
          let level = 0.14;
          if (analyserRef.current) {
            const analyser = analyserRef.current;
            const data = new Uint8Array(analyser.fftSize);
            analyser.getByteTimeDomainData(data);

            let sumSquares = 0;
            for (let i = 0; i < data.length; i += 1) {
              const norm = (data[i] - 128) / 128;
              sumSquares += norm * norm;
            }
            const rms = Math.sqrt(sumSquares / data.length);
            level = Math.min(1, Math.max(0.08, Math.pow(rms * 3.8, 0.78)));
          }

          const nextHistory = [...levelHistoryRef.current.slice(1), level];
          levelHistoryRef.current = nextHistory;
          setLevels(nextHistory);
        }
      }
      if (statusRef.current === 'recording' || statusRef.current === 'paused') {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const startRecording = useCallback(async () => {
    if (statusRef.current !== 'idle') return;
    setError(null);

    if (!isSupported) {
      setError('This browser does not support audio recording via MediaRecorder.');
      return;
    }

    updateStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // Try each probed candidate MIME type (MP4/AAC -> WebM/Opus -> Ogg -> browser default)
      // so a runtime constructor or start() failure on one format cleanly falls back to the next.
      const attempts: (string | undefined)[] = [...candidateMimeTypes, undefined];
      let recorder: MediaRecorder | null = null;
      let resolvedMime = 'audio/webm';
      let lastStartErr: unknown = null;

      chunksRef.current = [];
      finalizedRef.current = false;
      discardOnStopRef.current = false;
      hadRecorderErrorRef.current = false;
      stopResolverRef.current = null;

      for (const candidate of attempts) {
        let trial: MediaRecorder | null = null;
        try {
          trial = candidate
            ? new MediaRecorder(stream, { mimeType: candidate })
            : new MediaRecorder(stream);

          const trialMime = trial.mimeType || candidate || 'audio/webm';

          trial.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
              chunksRef.current.push(event.data);
            }
          };

          trial.onstop = () => {
            if (errorTimerRef.current !== null) {
              window.clearTimeout(errorTimerRef.current);
              errorTimerRef.current = null;
            }
            const mime = trial?.mimeType || trialMime;
            const wasInterrupted =
              hadRecorderErrorRef.current ||
              (!stopResolverRef.current && !discardOnStopRef.current);
            finalizeCapture(mime, wasInterrupted);
          };

          trial.onerror = () => {
            // Per MediaStream Recording spec, dataavailable and stop can still fire
            // after error even when state is already inactive. Record the error and
            // wait for onstop (with a safety fallback timer if stop never arrives).
            hadRecorderErrorRef.current = true;
            const mime = trial?.mimeType || trialMime;
            if (trial && trial.state !== 'inactive') {
              try {
                trial.stop();
              } catch {
                // fall through to timer
              }
            }
            if (errorTimerRef.current === null && !finalizedRef.current) {
              errorTimerRef.current = window.setTimeout(() => {
                errorTimerRef.current = null;
                finalizeCapture(mime, true);
              }, ERROR_FINALIZE_FALLBACK_MS);
            }
          };

          trial.start();
          recorder = trial;
          resolvedMime = trial.mimeType || trialMime;
          break;
        } catch (err) {
          lastStartErr = err;
          if (trial) {
            trial.ondataavailable = null;
            trial.onstop = null;
            trial.onerror = null;
          }
        }
      }

      if (!recorder) {
        throw lastStartErr ?? new Error('Could not initialize MediaRecorder.');
      }

      setActiveMimeType(resolvedMime);

      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          if (recorder && recorder.state !== 'inactive') {
            try {
              recorder.stop();
            } catch {
              hadRecorderErrorRef.current = true;
              if (errorTimerRef.current === null && !finalizedRef.current) {
                errorTimerRef.current = window.setTimeout(() => {
                  errorTimerRef.current = null;
                  finalizeCapture(recorder?.mimeType || resolvedMime, true);
                }, ERROR_FINALIZE_FALLBACK_MS);
              }
            }
          }
        };
      }

      // Level meter is strictly optional: never let AudioContext failure abort capture
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        if (AudioCtx) {
          const audioCtx = new AudioCtx();
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.75;
          source.connect(analyser);
          audioCtxRef.current = audioCtx;
          analyserRef.current = analyser;
        }
      } catch {
        audioCtxRef.current = null;
        analyserRef.current = null;
      }

      mediaRecorderRef.current = recorder;
      accumulatedMsRef.current = 0;
      startedAtRef.current = performance.now();
      levelHistoryRef.current = [...EMPTY_LEVELS];
      setLevels(EMPTY_LEVELS);
      setElapsedMs(0);

      updateStatus('recording');
      startMeterLoop();
    } catch (err) {
      releaseHardware();
      updateStatus('idle');
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('Microphone permission was denied. Allow mic access in browser settings.');
      } else if (name === 'NotFoundError') {
        setError('No microphone detected on this device.');
      } else {
        setError('Could not start the microphone. Check device permissions and try again.');
      }
    }
  }, [candidateMimeTypes, finalizeCapture, isSupported, releaseHardware, startMeterLoop, updateStatus]);

  const pauseRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || statusRef.current !== 'recording') return;
    if (typeof recorder.pause === 'function') {
      recorder.pause();
    }
    accumulatedMsRef.current += performance.now() - startedAtRef.current;
    setElapsedMs(accumulatedMsRef.current);
    updateStatus('paused');
  }, [updateStatus]);

  const resumeRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || statusRef.current !== 'paused') return;
    if (typeof recorder.resume === 'function') {
      recorder.resume();
    }
    startedAtRef.current = performance.now();
    updateStatus('recording');
  }, [updateStatus]);

  const cancelRecording = useCallback(() => {
    discardOnStopRef.current = true;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
        return;
      } catch {
        // fall through
      }
    }
    finalizeCapture(activeMimeType || 'audio/webm', false);
  }, [activeMimeType, finalizeCapture]);

  const stopRecording = useCallback((): Promise<CapturedAudio | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        if (!finalizedRef.current && chunksRef.current.length > 0) {
          stopResolverRef.current = resolve;
          finalizeCapture(activeMimeType || 'audio/webm', false);
        } else {
          releaseHardware();
          updateStatus('idle');
          resolve(null);
        }
        return;
      }

      stopResolverRef.current = resolve;
      try {
        recorder.stop();
      } catch {
        finalizeCapture(recorder.mimeType || activeMimeType || 'audio/webm', false);
      }
    });
  }, [activeMimeType, finalizeCapture, releaseHardware, updateStatus]);

  return {
    status,
    elapsedMs,
    levels,
    supportedMimeType: activeMimeType,
    isSupported,
    error,
    clearError: () => setError(null),
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    cancelRecording,
  };
}
