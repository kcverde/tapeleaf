import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapturedAudio } from '../types';

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'paused';

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const;

const BAR_COUNT = 26;
const EMPTY_LEVELS = Array.from({ length: BAR_COUNT }, () => 0.08);

export function probeSupportedMimeType(): string {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') {
    return '';
  }
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return '';
}

export function extensionForMimeType(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'm4a';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('wav')) return 'wav';
  return 'webm';
}

export function useRecorder() {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<number[]>(EMPTY_LEVELS);
  const [error, setError] = useState<string | null>(null);
  const [supportedMimeType] = useState<string>(() => probeSupportedMimeType());

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const accumulatedMsRef = useRef<number>(0);
  const statusRef = useRef<RecorderStatus>('idle');
  const levelHistoryRef = useRef<number[]>([...EMPTY_LEVELS]);
  const lastSampleTsRef = useRef<number>(0);

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
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
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

  useEffect(() => {
    return () => {
      releaseHardware();
    };
  }, [releaseHardware]);

  const startMeterLoop = useCallback(() => {
    const tick = (ts: number) => {
      if (statusRef.current === 'recording') {
        const currentElapsed = accumulatedMsRef.current + (performance.now() - startedAtRef.current);
        setElapsedMs(currentElapsed);

        if (analyserRef.current && ts - lastSampleTsRef.current >= 55) {
          lastSampleTsRef.current = ts;
          const analyser = analyserRef.current;
          const data = new Uint8Array(analyser.fftSize);
          analyser.getByteTimeDomainData(data);

          let sumSquares = 0;
          for (let i = 0; i < data.length; i += 1) {
            const norm = (data[i] - 128) / 128;
            sumSquares += norm * norm;
          }
          const rms = Math.sqrt(sumSquares / data.length);
          const boosted = Math.min(1, Math.max(0.08, Math.pow(rms * 3.8, 0.78)));

          const nextHistory = [...levelHistoryRef.current.slice(1), boosted];
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

      const options: MediaRecorderOptions = {};
      if (supportedMimeType) {
        options.mimeType = supportedMimeType;
      }

      const recorder = new MediaRecorder(stream, options);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

      mediaRecorderRef.current = recorder;
      accumulatedMsRef.current = 0;
      startedAtRef.current = performance.now();
      levelHistoryRef.current = [...EMPTY_LEVELS];
      setLevels(EMPTY_LEVELS);
      setElapsedMs(0);

      recorder.start(250);
      updateStatus('recording');
      startMeterLoop();
    } catch (err) {
      releaseHardware();
      updateStatus('idle');
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('Microphone permission was denied. Allow mic access in browser settings or try a sample capture.');
      } else if (name === 'NotFoundError') {
        setError('No microphone detected on this device.');
      } else {
        setError('Could not start the microphone. Check device permissions and try again.');
      }
    }
  }, [isSupported, releaseHardware, startMeterLoop, supportedMimeType, updateStatus]);

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
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // ignore
      }
    }
    chunksRef.current = [];
    accumulatedMsRef.current = 0;
    setElapsedMs(0);
    levelHistoryRef.current = [...EMPTY_LEVELS];
    setLevels(EMPTY_LEVELS);
    releaseHardware();
    updateStatus('idle');
  }, [releaseHardware, updateStatus]);

  const stopRecording = useCallback((): Promise<CapturedAudio | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        releaseHardware();
        updateStatus('idle');
        resolve(null);
        return;
      }

      const finalElapsedMs =
        statusRef.current === 'recording'
          ? accumulatedMsRef.current + (performance.now() - startedAtRef.current)
          : accumulatedMsRef.current;

      const resolvedMime = recorder.mimeType || supportedMimeType || 'audio/webm';

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: resolvedMime });
        chunksRef.current = [];
        accumulatedMsRef.current = 0;
        setElapsedMs(0);
        levelHistoryRef.current = [...EMPTY_LEVELS];
        setLevels(EMPTY_LEVELS);
        releaseHardware();
        updateStatus('idle');

        if (blob.size === 0) {
          resolve(null);
          return;
        }

        resolve({
          blob,
          mimeType: resolvedMime,
          durationSeconds: Math.max(1, Math.round(finalElapsedMs / 1000)),
          extension: extensionForMimeType(resolvedMime),
        });
      };

      try {
        if (recorder.state === 'recording') {
          recorder.requestData();
        }
        recorder.stop();
      } catch {
        releaseHardware();
        updateStatus('idle');
        resolve(null);
      }
    });
  }, [releaseHardware, supportedMimeType, updateStatus]);

  return {
    status,
    elapsedMs,
    levels,
    supportedMimeType,
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
