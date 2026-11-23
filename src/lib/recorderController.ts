import type { CapturedAudio, RecordingDraft } from '../types';
import { extensionForMimeType } from './audio';
import {
  appendDraftChunk,
  deleteRecordingDraft,
  generateRecordingId,
  upsertRecordingDraft,
} from './db';

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopping';

export interface RecorderTrackLike {
  onended: ((this: never, ev: Event) => unknown) | null;
  stop: () => void;
}

export interface RecorderStreamLike {
  getTracks: () => RecorderTrackLike[];
  getAudioTracks: () => RecorderTrackLike[];
}

export interface MediaRecorderLike {
  readonly state: RecordingState;
  readonly mimeType: string;
  ondataavailable: ((this: never, ev: BlobEvent) => unknown) | null;
  onstop: ((this: never, ev: Event) => unknown) | null;
  onerror: ((this: never, ev: ErrorEvent) => unknown) | null;
  start: (timeslice?: number) => void;
  stop: () => void;
  pause?: () => void;
  resume?: () => void;
}

export interface RecorderDraftStore {
  upsertDraft: (draft: RecordingDraft) => Promise<void>;
  appendChunk: (draftId: string, seq: number, blob: Blob, durationSeconds: number) => Promise<void>;
  deleteDraft: (draftId: string) => Promise<void>;
}

export interface RecorderEnvironment {
  getUserMedia: () => Promise<RecorderStreamLike>;
  createRecorder: (stream: RecorderStreamLike, mimeType?: string) => MediaRecorderLike;
  candidateMimeTypes: string[];
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (id: ReturnType<typeof setTimeout>) => void;
  draftStore?: RecorderDraftStore;
  timesliceMs?: number;
  errorFallbackMs?: number;
}

export interface RecorderControllerCallbacks {
  onStatusChange: (status: RecorderStatus) => void;
  onMimeTypeChange: (mimeType: string) => void;
  onErrorChange: (error: string | null) => void;
  onInterruptedCapture?: (audio: CapturedAudio) => void;
  onStreamReady?: (sessionId: number, stream: RecorderStreamLike) => void;
  onSessionReleased?: (sessionId: number) => void;
}

interface CaptureSession {
  readonly id: number;
  readonly draftId: string;
  recorder: MediaRecorderLike | null;
  stream: RecorderStreamLike | null;
  chunks: Blob[];
  chunkSeq: number;
  mimeType: string;
  startedAt: number;
  accumulatedMs: number;
  status: RecorderStatus;
  finalized: boolean;
  discardOnStop: boolean;
  hadError: boolean;
  stopPromise: Promise<CapturedAudio | null> | null;
  stopResolver: ((audio: CapturedAudio | null) => void) | null;
  errorTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_TIMESLICE_MS = 5000;
const DEFAULT_ERROR_FALLBACK_MS = 1500;

const defaultDraftStore: RecorderDraftStore = {
  upsertDraft: upsertRecordingDraft,
  appendChunk: appendDraftChunk,
  deleteDraft: deleteRecordingDraft,
};

/**
 * Framework-free recording state machine. Every capture is scoped to an isolated
 * `CaptureSession` so double-Stop taps and late `MediaRecorder` callbacks from a
 * previous session can never touch or tear down a newer capture.
 */
export class RecorderController {
  private readonly env: RecorderEnvironment;
  private readonly callbacks: RecorderControllerCallbacks;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (id: ReturnType<typeof setTimeout>) => void;
  private readonly draftStore: RecorderDraftStore;
  private readonly timesliceMs: number;
  private readonly errorFallbackMs: number;

  private activeSession: CaptureSession | null = null;
  private nextSessionId = 1;
  private status: RecorderStatus = 'idle';
  private activeMimeType: string;

  constructor(env: RecorderEnvironment, callbacks: RecorderControllerCallbacks) {
    this.env = env;
    this.callbacks = callbacks;
    this.now = env.now ?? (() => performance.now());
    this.setTimer = env.setTimeoutFn ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = env.clearTimeoutFn ?? ((id) => globalThis.clearTimeout(id));
    this.draftStore = env.draftStore ?? defaultDraftStore;
    this.timesliceMs = env.timesliceMs ?? DEFAULT_TIMESLICE_MS;
    this.errorFallbackMs = env.errorFallbackMs ?? DEFAULT_ERROR_FALLBACK_MS;
    this.activeMimeType = env.candidateMimeTypes[0] ?? '';
  }

  getStatus(): RecorderStatus {
    return this.status;
  }

  getCurrentElapsedMs(): number {
    const s = this.activeSession;
    if (!s) return 0;
    if (s.status === 'recording') {
      return s.accumulatedMs + (this.now() - s.startedAt);
    }
    return s.accumulatedMs;
  }

  private setStatus(next: RecorderStatus) {
    this.status = next;
    this.callbacks.onStatusChange(next);
  }

  private releaseSession(session: CaptureSession) {
    if (session.errorTimer !== null) {
      this.clearTimer(session.errorTimer);
      session.errorTimer = null;
    }
    if (session.stream) {
      for (const track of session.stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
      session.stream = null;
    }
    session.recorder = null;
    this.callbacks.onSessionReleased?.(session.id);
  }

  private finalizeSession(
    session: CaptureSession,
    resolvedMime: string,
    wasInterrupted: boolean,
  ) {
    if (session.finalized) return;
    session.finalized = true;

    const finalElapsedMs =
      session.status === 'recording'
        ? session.accumulatedMs + (this.now() - session.startedAt)
        : session.accumulatedMs;

    const discard = session.discardOnStop;
    const chunks = session.chunks;
    const resolver = session.stopResolver;
    const hadError = session.hadError;

    session.chunks = [];
    session.stopResolver = null;
    session.stopPromise = null;
    session.status = 'idle';

    this.releaseSession(session);

    // Strictly guard UI/controller reset so a late callback from an older session
    // can never clear or release a newer active recording.
    if (this.activeSession === session) {
      this.activeSession = null;
      this.setStatus('idle');
    }

    if (discard) {
      void this.draftStore.deleteDraft(session.draftId).catch(() => {});
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
            draftId: session.draftId,
          }
        : null;

    if (!captured) {
      void this.draftStore.deleteDraft(session.draftId).catch(() => {});
    }

    if (resolver) {
      resolver(captured);
    } else if (wasInterrupted || hadError) {
      if (captured) {
        this.callbacks.onErrorChange(
          'Recording ended unexpectedly — saving the audio captured so far.',
        );
        this.callbacks.onInterruptedCapture?.(captured);
      } else {
        this.callbacks.onErrorChange(
          'Recording was interrupted by the browser before any audio was captured.',
        );
      }
    }
  }

  async startRecording(): Promise<void> {
    if (this.status !== 'idle' || this.activeSession !== null) return;
    this.callbacks.onErrorChange(null);

    const session: CaptureSession = {
      id: this.nextSessionId++,
      draftId: `draft_${generateRecordingId()}`,
      recorder: null,
      stream: null,
      chunks: [],
      chunkSeq: 0,
      mimeType: 'audio/webm',
      startedAt: 0,
      accumulatedMs: 0,
      status: 'requesting',
      finalized: false,
      discardOnStop: false,
      hadError: false,
      stopPromise: null,
      stopResolver: null,
      errorTimer: null,
    };

    this.activeSession = session;
    this.setStatus('requesting');

    try {
      const stream = await this.env.getUserMedia();
      if (this.activeSession !== session) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      session.stream = stream;

      const attempts: (string | undefined)[] = [...this.env.candidateMimeTypes, undefined];
      let recorder: MediaRecorderLike | null = null;
      let resolvedMime = 'audio/webm';
      let lastStartErr: unknown = null;

      for (const candidate of attempts) {
        let trial: MediaRecorderLike | null = null;
        try {
          trial = this.env.createRecorder(stream, candidate);
          const trialMime = trial.mimeType || candidate || 'audio/webm';

          trial.ondataavailable = (event) => {
            if (event.data && event.data.size > 0 && !session.finalized) {
              session.chunks.push(event.data);
              const seq = session.chunkSeq++;
              if (!session.discardOnStop) {
                const approxSeconds =
                  (session.status === 'recording'
                    ? session.accumulatedMs + (this.now() - session.startedAt)
                    : session.accumulatedMs) / 1000;
                void this.draftStore
                  .appendChunk(session.draftId, seq, event.data, approxSeconds)
                  .catch(() => {});
              }
            }
          };

          trial.onstop = () => {
            if (session.errorTimer !== null) {
              this.clearTimer(session.errorTimer);
              session.errorTimer = null;
            }
            const mime = trial?.mimeType || trialMime;
            const wasInterrupted =
              session.hadError || (!session.stopResolver && !session.discardOnStop);
            this.finalizeSession(session, mime, wasInterrupted);
          };

          trial.onerror = () => {
            session.hadError = true;
            const mime = trial?.mimeType || trialMime;
            if (trial && trial.state !== 'inactive') {
              try {
                trial.stop();
              } catch {
                // fall through to timer
              }
            }
            if (session.errorTimer === null && !session.finalized) {
              session.errorTimer = this.setTimer(() => {
                session.errorTimer = null;
                this.finalizeSession(session, mime, true);
              }, this.errorFallbackMs);
            }
          };

          trial.start(this.timesliceMs);
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

      session.recorder = recorder;
      session.mimeType = resolvedMime;
      this.activeMimeType = resolvedMime;
      this.callbacks.onMimeTypeChange(resolvedMime);

      const nowIso = new Date().toISOString();
      void this.draftStore
        .upsertDraft({
          id: session.draftId,
          created: nowIso,
          mimeType: resolvedMime,
          extension: extensionForMimeType(resolvedMime),
          durationSeconds: 0,
          updatedAt: nowIso,
        })
        .catch(() => {});

      for (const track of stream.getAudioTracks()) {
        track.onended = () => {
          if (session.finalized) return;
          if (recorder && recorder.state !== 'inactive') {
            try {
              recorder.stop();
            } catch {
              session.hadError = true;
              if (session.errorTimer === null && !session.finalized) {
                session.errorTimer = this.setTimer(() => {
                  session.errorTimer = null;
                  this.finalizeSession(session, recorder?.mimeType || resolvedMime, true);
                }, this.errorFallbackMs);
              }
            }
          }
        };
      }

      session.accumulatedMs = 0;
      session.startedAt = this.now();
      session.status = 'recording';
      this.callbacks.onStreamReady?.(session.id, stream);
      this.setStatus('recording');
    } catch (err) {
      this.releaseSession(session);
      if (this.activeSession === session) {
        this.activeSession = null;
        this.setStatus('idle');
      }
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        this.callbacks.onErrorChange(
          'Microphone permission was denied. Allow mic access in browser settings.',
        );
      } else if (name === 'NotFoundError') {
        this.callbacks.onErrorChange('No microphone detected on this device.');
      } else {
        this.callbacks.onErrorChange(
          'Could not start the microphone. Check device permissions and try again.',
        );
      }
    }
  }

  pauseRecording(): void {
    const session = this.activeSession;
    const recorder = session?.recorder;
    if (!session || !recorder || session.status !== 'recording') return;
    if (typeof recorder.pause === 'function') {
      recorder.pause();
    }
    session.accumulatedMs += this.now() - session.startedAt;
    session.status = 'paused';
    this.setStatus('paused');
  }

  resumeRecording(): void {
    const session = this.activeSession;
    const recorder = session?.recorder;
    if (!session || !recorder || session.status !== 'paused') return;
    if (typeof recorder.resume === 'function') {
      recorder.resume();
    }
    session.startedAt = this.now();
    session.status = 'recording';
    this.setStatus('recording');
  }

  cancelRecording(): void {
    const session = this.activeSession;
    if (!session || session.status === 'stopping') return;
    session.discardOnStop = true;
    session.status = 'stopping';
    this.setStatus('stopping');

    const recorder = session.recorder;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
        return;
      } catch {
        // fall through
      }
    }
    this.finalizeSession(session, session.mimeType || this.activeMimeType || 'audio/webm', false);
  }

  stopRecording(): Promise<CapturedAudio | null> {
    const session = this.activeSession;
    if (!session) {
      return Promise.resolve(null);
    }

    // Idempotent: a second Stop tap while waiting on dataavailable/onstop shares the same promise
    if (session.stopPromise) {
      return session.stopPromise;
    }

    session.stopPromise = new Promise<CapturedAudio | null>((resolve) => {
      session.stopResolver = resolve;

      if (session.status === 'recording') {
        session.accumulatedMs += this.now() - session.startedAt;
      }
      session.status = 'stopping';
      this.setStatus('stopping');

      const recorder = session.recorder;
      if (!recorder || recorder.state === 'inactive') {
        this.finalizeSession(
          session,
          session.mimeType || this.activeMimeType || 'audio/webm',
          false,
        );
        return;
      }

      try {
        recorder.stop();
        if (session.errorTimer === null && !session.finalized) {
          session.errorTimer = this.setTimer(() => {
            session.errorTimer = null;
            this.finalizeSession(session, recorder.mimeType || session.mimeType, false);
          }, this.errorFallbackMs * 2);
        }
      } catch {
        this.finalizeSession(
          session,
          recorder.mimeType || session.mimeType || this.activeMimeType || 'audio/webm',
          false,
        );
      }
    });

    return session.stopPromise;
  }

  dispose(): void {
    const session = this.activeSession;
    this.activeSession = null;
    if (session) {
      session.discardOnStop = true;
      const rec = session.recorder;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          // ignore
        }
      }
      this.releaseSession(session);
    }
  }
}
