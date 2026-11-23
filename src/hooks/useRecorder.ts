import { useCallback, useEffect, useRef, useState } from 'react';
import { extensionForMimeType, probeSupportedMimeTypes } from '../lib/audio';
import { RecorderController } from '../lib/recorderController';
import type { RecorderStatus, RecorderStreamLike } from '../lib/recorderController';
import type { CapturedAudio } from '../types';

export { extensionForMimeType, probeSupportedMimeTypes };
export type { RecorderStatus };

const BAR_COUNT = 26;
const EMPTY_LEVELS = Array.from({ length: BAR_COUNT }, () => 0.08);
const TIMER_UPDATE_INTERVAL_MS = 100;
const METER_SAMPLE_INTERVAL_MS = 55;

export interface UseRecorderOptions {
  onInterruptedCapture?: (audio: CapturedAudio) => void;
  onStatusChange?: (status: RecorderStatus) => void;
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

  const controllerRef = useRef<RecorderController | null>(null);
  const meterSessionIdRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const meterBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number | null>(null);
  const levelHistoryRef = useRef<number[]>([...EMPTY_LEVELS]);
  const lastSampleTsRef = useRef<number>(0);
  const lastTimerTsRef = useRef<number>(0);

  const onInterruptedRef = useRef(options?.onInterruptedCapture);
  onInterruptedRef.current = options?.onInterruptedCapture;
  const onStatusChangeRef = useRef(options?.onStatusChange);
  onStatusChangeRef.current = options?.onStatusChange;

  const isSupported =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined';

  const stopMeterLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const teardownAnalyser = useCallback(() => {
    stopMeterLoop();
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    meterBufferRef.current = null;
    meterSessionIdRef.current = null;
  }, [stopMeterLoop]);

  const startMeterLoop = useCallback(() => {
    stopMeterLoop();
    lastTimerTsRef.current = 0;
    lastSampleTsRef.current = 0;

    const tick = (ts: number) => {
      const ctrl = controllerRef.current;
      if (!ctrl || ctrl.getStatus() !== 'recording') {
        rafRef.current = null;
        return;
      }

      if (ts - lastTimerTsRef.current >= TIMER_UPDATE_INTERVAL_MS) {
        lastTimerTsRef.current = ts;
        setElapsedMs(ctrl.getCurrentElapsedMs());
      }

      if (ts - lastSampleTsRef.current >= METER_SAMPLE_INTERVAL_MS) {
        lastSampleTsRef.current = ts;
        let level = 0.14;
        const analyser = analyserRef.current;
        const buf = meterBufferRef.current;
        if (analyser && buf) {
          analyser.getByteTimeDomainData(buf);
          let sumSquares = 0;
          for (let i = 0; i < buf.length; i += 1) {
            const norm = (buf[i] - 128) / 128;
            sumSquares += norm * norm;
          }
          const rms = Math.sqrt(sumSquares / buf.length);
          level = Math.min(1, Math.max(0.08, Math.pow(rms * 3.8, 0.78)));
        }

        const nextHistory = [...levelHistoryRef.current.slice(1), level];
        levelHistoryRef.current = nextHistory;
        setLevels(nextHistory);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [stopMeterLoop]);

  useEffect(() => {
    const ctrl = new RecorderController(
      {
        candidateMimeTypes,
        getUserMedia: () =>
          navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          }),
        createRecorder: (stream, mimeType) =>
          mimeType
            ? new MediaRecorder(stream as MediaStream, { mimeType })
            : new MediaRecorder(stream as MediaStream),
      },
      {
        onStatusChange: (next) => {
          setStatus(next);
          onStatusChangeRef.current?.(next);
          if (next === 'recording') {
            startMeterLoop();
          } else {
            stopMeterLoop();
            if (next === 'paused' && controllerRef.current) {
              setElapsedMs(controllerRef.current.getCurrentElapsedMs());
            } else if (next === 'idle') {
              setElapsedMs(0);
              levelHistoryRef.current = [...EMPTY_LEVELS];
              setLevels(EMPTY_LEVELS);
            }
          }
        },
        onMimeTypeChange: (mime) => setActiveMimeType(mime),
        onErrorChange: (msg) => setError(msg),
        onInterruptedCapture: (audio) => onInterruptedRef.current?.(audio),
        onStreamReady: (sessionId: number, stream: RecorderStreamLike) => {
          teardownAnalyser();
          meterSessionIdRef.current = sessionId;
          levelHistoryRef.current = [...EMPTY_LEVELS];
          setLevels(EMPTY_LEVELS);
          setElapsedMs(0);
          try {
            const AudioCtx =
              window.AudioContext ||
              (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext;
            if (AudioCtx) {
              const audioCtx = new AudioCtx();
              const source = audioCtx.createMediaStreamSource(stream as MediaStream);
              const analyser = audioCtx.createAnalyser();
              analyser.fftSize = 256;
              analyser.smoothingTimeConstant = 0.75;
              source.connect(analyser);
              audioCtxRef.current = audioCtx;
              analyserRef.current = analyser;
              meterBufferRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
            }
          } catch {
            audioCtxRef.current = null;
            analyserRef.current = null;
            meterBufferRef.current = null;
          }
        },
        onSessionReleased: (sessionId: number) => {
          if (meterSessionIdRef.current === sessionId) {
            teardownAnalyser();
          }
        },
      },
    );

    controllerRef.current = ctrl;
    return () => {
      ctrl.dispose();
      teardownAnalyser();
      controllerRef.current = null;
    };
  }, [candidateMimeTypes, startMeterLoop, stopMeterLoop, teardownAnalyser]);

  const startRecording = useCallback(async () => {
    if (!isSupported) {
      setError('This browser does not support audio recording via MediaRecorder.');
      return;
    }
    await controllerRef.current?.startRecording();
  }, [isSupported]);

  const pauseRecording = useCallback(() => {
    controllerRef.current?.pauseRecording();
  }, []);

  const resumeRecording = useCallback(() => {
    controllerRef.current?.resumeRecording();
  }, []);

  const cancelRecording = useCallback(() => {
    controllerRef.current?.cancelRecording();
  }, []);

  const stopRecording = useCallback((): Promise<CapturedAudio | null> => {
    return controllerRef.current?.stopRecording() ?? Promise.resolve(null);
  }, []);

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
