import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDesiredNoteFilename,
  buildObsidianMarkdown,
  formatTranscriptForMarkdown,
  parseTranscriptBlocks,
  sanitizeMarkdownBody,
  sanitizeMarkdownInline,
} from '../src/markdown';
import {
  deleteRecordingFromVault,
  hasDeletableVaultArtifacts,
  matchesDesiredFilename,
  needsVaultWrite,
  writeRecordingToVault,
} from '../src/lib/vaultSync';
import {
  buildPrompt,
  classifyGeminiError,
  GeminiClientError,
  parseAndValidateAnalysis,
} from '../src/lib/geminiClient';
import { generateRecordingId, withQueueLock } from '../src/lib/db';
import { validateImportedAudioFile } from '../src/lib/audio';
import { RecorderController } from '../src/lib/recorderController';
import type {
  MediaRecorderLike,
  RecorderStatus,
  RecorderStreamLike,
  RecorderTrackLike,
} from '../src/lib/recorderController';
import { buildWebManifest, normalizeBase } from '../vite.config';
import type { Recording, StoredVaultHandle, VaultExportState } from '../src/types';

// --- Minimal in-memory FileSystemDirectoryHandle mock ---

class MockWritable {
  private readonly onWrite: (data: Blob | string) => Promise<void>;
  private pending: Blob | string = '';

  constructor(onWrite: (data: Blob | string) => Promise<void>) {
    this.onWrite = onWrite;
  }

  async write(data: Blob | string) {
    this.pending = data;
  }

  async close() {
    await this.onWrite(this.pending);
  }

  async abort() {
    this.pending = '';
  }
}

class MockFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  private readonly dir: MockDirectoryHandle;

  constructor(name: string, dir: MockDirectoryHandle) {
    this.name = name;
    this.dir = dir;
  }

  async getFile(): Promise<Blob> {
    const val = this.dir.files.get(this.name);
    if (val === undefined) {
      throw new DOMException('Not found', 'NotFoundError');
    }
    return val;
  }

  async createWritable() {
    return new MockWritable(async (data) => {
      const blob = typeof data === 'string' ? new Blob([data], { type: 'text/markdown' }) : data;
      this.dir.files.set(this.name, blob);
    });
  }
}

class MockDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly files = new Map<string, Blob>();
  readonly dirs = new Map<string, MockDirectoryHandle>();
  failRemoveFor = new Set<string>();

  constructor(name: string) {
    this.name = name;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.files.has(name) && !opts?.create) {
      throw new DOMException(`Missing ${name}`, 'NotFoundError');
    }
    return new MockFileHandle(name, this);
  }

  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let sub = this.dirs.get(name);
    if (!sub) {
      if (!opts?.create) {
        throw new DOMException(`Missing dir ${name}`, 'NotFoundError');
      }
      sub = new MockDirectoryHandle(name);
      this.dirs.set(name, sub);
    }
    return sub;
  }

  async removeEntry(name: string) {
    if (this.failRemoveFor.has(name)) {
      throw new Error(`Simulated remove failure for ${name}`);
    }
    if (!this.files.has(name)) {
      throw new DOMException(`Missing ${name}`, 'NotFoundError');
    }
    this.files.delete(name);
  }
}

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  const id = overrides.id ?? 'rec_20261122_143502_a1b2c3d4e5f60708';
  return {
    id,
    title: 'Dentist Visit',
    created: '2026-11-22T14:35:02.000Z',
    durationSeconds: 42,
    language: 'en',
    languageName: 'English',
    isEnglish: true,
    status: 'ready',
    summary: 'Confirm Thursday dental appointment and pick up prescription.',
    tags: ['errands', 'health'],
    audioPath: `audio/${id}.m4a`,
    audioFilename: `${id}.m4a`,
    audioMimeType: 'audio/mp4',
    audioSizeBytes: 1234,
    englishTranscript: 'Remember to confirm the dentist appointment for Thursday morning.',
    revision: 1,
    ...overrides,
  };
}

function makeVault(dir: MockDirectoryHandle, vaultId = 'vault_test1'): StoredVaultHandle {
  return {
    key: 'obsidian-vault',
    vaultId,
    folderName: dir.name,
    handle: dir as unknown as FileSystemDirectoryHandle,
    connectedAt: '2026-11-22T14:00:00.000Z',
  };
}

describe('Vault deletion safety', () => {
  it('never deletes an unrelated Obsidian note when recording only exported audio (empty filename)', async () => {
    const dir = new MockDirectoryHandle('ObsidianVault');
    const vault = makeVault(dir);

    const rec = makeRecording({ title: 'Voice note', status: 'queued' });
    const predictedName = buildDesiredNoteFilename(rec);
    // An unrelated note already occupies the predicted filename
    dir.files.set(predictedName, new Blob(['# Precious Unrelated Obsidian Note\n']));

    const audioBlob = new Blob(['fake-audio-bytes'], { type: 'audio/mp4' });
    const deferredOutcome = await writeRecordingToVault({
      vault,
      recording: rec,
      audioBlob,
      deferMarkdown: true,
      onReserveFilename: async () => {},
    });

    assert.equal(deferredOutcome.vaultState.filename, '');
    assert.equal(deferredOutcome.vaultState.audioWritten, true);

    const recWithExport: Recording = {
      ...rec,
      vaultExports: { [vault.vaultId]: deferredOutcome.vaultState },
    };

    assert.equal(hasDeletableVaultArtifacts(recWithExport, vault.vaultId), true);

    const delRes = await deleteRecordingFromVault(vault, recWithExport);
    assert.equal(delRes.ok, true);
    assert.equal(delRes.deletedNote, false);
    assert.equal(delRes.deletedAudio, true);
    // The unrelated note MUST still exist untouched!
    assert.equal(dir.files.has(predictedName), true);
    assert.equal(await dir.files.get(predictedName)!.text(), '# Precious Unrelated Obsidian Note\n');
  });

  it('refuses to delete a note modified in Obsidian unless forceDeleteModified is explicitly set', async () => {
    const dir = new MockDirectoryHandle('ObsidianVault');
    const vault = makeVault(dir);
    const rec = makeRecording();
    const audioBlob = new Blob(['audio-data'], { type: 'audio/mp4' });

    const writeOutcome = await writeRecordingToVault({
      vault,
      recording: rec,
      audioBlob,
      onReserveFilename: async () => {},
    });
    assert.equal(writeOutcome.vaultState.state, 'written');

    const filename = writeOutcome.vaultState.filename;
    // Simulate user editing the note inside Obsidian
    dir.files.set(filename, new Blob(['# Edited manually inside Obsidian\n']));

    const recExported: Recording = {
      ...rec,
      vaultExports: { [vault.vaultId]: writeOutcome.vaultState },
    };

    const blocked = await deleteRecordingFromVault(vault, recExported);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.modifiedInVault, true);
    }
    assert.equal(dir.files.has(filename), true);

    // Explicit force delete succeeds
    const forced = await deleteRecordingFromVault(vault, recExported, {
      forceDeleteModified: true,
    });
    assert.equal(forced.ok, true);
    assert.equal(dir.files.has(filename), false);
  });

  it('reports partial deletion when note deletion succeeds but audio deletion fails', async () => {
    const dir = new MockDirectoryHandle('ObsidianVault');
    const vault = makeVault(dir);
    const rec = makeRecording();
    const audioBlob = new Blob(['audio-data'], { type: 'audio/mp4' });

    const writeOutcome = await writeRecordingToVault({
      vault,
      recording: rec,
      audioBlob,
      onReserveFilename: async () => {},
    });

    const audioSubdir = dir.dirs.get('audio')!;
    audioSubdir.failRemoveFor.add(rec.audioFilename);

    const recExported: Recording = {
      ...rec,
      vaultExports: { [vault.vaultId]: writeOutcome.vaultState },
    };

    const res = await deleteRecordingFromVault(vault, recExported);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.deletedNote, true);
      assert.equal(res.deletedAudio, false);
      assert.match(res.error, /Markdown note was deleted/i);
    }
  });
});

describe('Vault concurrent writes, renames, and disconnect cancellation', () => {
  it('serializes two same-minute recordings under per-vault lock without overwriting each other', async () => {
    const dir = new MockDirectoryHandle('ObsidianVault');
    const vault = makeVault(dir);

    const recA = makeRecording({
      id: 'rec_20261122_143502_aaaaaaaaaaaaaaaa',
      title: 'Quick Thought',
      englishTranscript: 'First recording transcript.',
    });
    const recB = makeRecording({
      id: 'rec_20261122_143509_bbbbbbbbbbbbbbbb',
      title: 'Quick Thought',
      englishTranscript: 'Second recording transcript.',
    });

    const blob = new Blob(['audio'], { type: 'audio/mp4' });

    const [outA, outB] = await Promise.all([
      withQueueLock(`vault:${vault.vaultId}`, () =>
        writeRecordingToVault({
          vault,
          recording: recA,
          audioBlob: blob,
          onReserveFilename: async () => {},
        }),
      ),
      withQueueLock(`vault:${vault.vaultId}`, () =>
        writeRecordingToVault({
          vault,
          recording: recB,
          audioBlob: blob,
          onReserveFilename: async () => {},
        }),
      ),
    ]);

    assert.equal(outA.vaultState.state, 'written');
    assert.equal(outB.vaultState.state, 'written');
    assert.notEqual(outA.vaultState.filename, outB.vaultState.filename);
    assert.equal(dir.files.size, 2);
    assert.match(await dir.files.get(outA.vaultState.filename)!.text(), /First recording/);
    assert.match(await dir.files.get(outB.vaultState.filename)!.text(), /Second recording/);
  });

  it('aborts write immediately if vault connection generation became stale', async () => {
    const dir = new MockDirectoryHandle('ObsidianVault');
    const vault = makeVault(dir);
    const rec = makeRecording();
    let active = false;

    const out = await writeRecordingToVault({
      vault,
      recording: rec,
      audioBlob: new Blob(['audio'], { type: 'audio/mp4' }),
      isStillActive: () => active,
      onReserveFilename: async () => {},
    });

    assert.equal(out.aborted, true);
    assert.equal(dir.files.size, 0);
  });

  it('distinguishes numeric collision suffixes from distinct parenthesized titles', () => {
    assert.equal(
      matchesDesiredFilename('2026-11-22 14.35 - Foo (2).md', '2026-11-22 14.35 - Foo.md'),
      true,
    );
    assert.equal(
      matchesDesiredFilename('2026-11-22 14.35 - Foo (bar).md', '2026-11-22 14.35 - Foo.md'),
      false,
    );
  });

  it('persists pendingFilename before writing a rename and reconciles cleanly', async () => {
    const dir = new MockDirectoryHandle('ObsidianVault');
    const vault = makeVault(dir);
    const rec = makeRecording({ title: 'Initial Draft' });
    const blob = new Blob(['audio'], { type: 'audio/mp4' });

    const first = await writeRecordingToVault({
      vault,
      recording: rec,
      audioBlob: blob,
      onReserveFilename: async () => {},
    });

    const reservedStates: VaultExportState[] = [];
    const renamedRec: Recording = {
      ...rec,
      title: 'Final Title',
      revision: 2,
      vaultExports: { [vault.vaultId]: first.vaultState },
    };

    const second = await writeRecordingToVault({
      vault,
      recording: renamedRec,
      audioBlob: blob,
      onReserveFilename: async (st) => {
        reservedStates.push(st);
      },
    });

    assert.equal(second.vaultState.state, 'written');
    assert.ok(reservedStates.length >= 2);
    // First reservation records pendingFilename before the new file write
    assert.equal(reservedStates[0].filename, first.vaultState.filename);
    assert.equal(reservedStates[0].pendingFilename, second.vaultState.filename);
    // Old untouched file was removed
    assert.equal(dir.files.has(first.vaultState.filename), false);
    assert.equal(dir.files.has(second.vaultState.filename), true);
  });

  it('treats kept-vault state as not needing an automatic overwrite', () => {
    const rec = makeRecording({
      revision: 2,
      vaultExports: {
        vault_1: {
          vaultId: 'vault_1',
          filename: 'note.md',
          audioWritten: true,
          lastExportedRevision: 2,
          lastExportedHash: 'abc',
          state: 'kept-vault',
        },
      },
    });
    assert.equal(needsVaultWrite(rec, 'vault_1'), false);
  });
});

describe('Markdown neutralization and Obsidian safety', () => {
  it('neutralizes HTML, Templater, wikilinks, dataviewjs fences, and obsidian URIs while keeping audio embed', () => {
    const rec = makeRecording({
      title: 'Meeting\n## Injected Heading <script>alert(1)</script>',
      summary: 'See [[Secret Note]] and [click](obsidian://open?vault=x)',
      englishTranscript: [
        'Hello <img src=x onerror=alert(1)> world.',
        '<% tp.system.prompt("pwn") %>',
        '![[Private File]]',
        '```dataviewjs',
        'dv.paragraph("exec")',
        '```',
        'Link: [run](javascript:alert(1))',
      ].join('\n'),
    });

    const md = buildObsidianMarkdown(rec);
    // Own audio embed stays intact
    assert.ok(md.includes(`![[${rec.audioFilename}]]`));
    // Dangerous payloads neutralized
    assert.equal(md.includes('<script>'), false);
    assert.equal(md.includes('<img '), false);
    assert.equal(md.includes('<% tp.system'), false);
    assert.equal(md.includes('![[Private File]]'), false);
    assert.equal(md.includes('```dataviewjs'), false);
    assert.equal(md.includes('](obsidian://'), false);
    assert.equal(md.includes('](javascript:'), false);
    // Inline title stays single-line
    const headingLine = md.split('\n').find((l) => l.startsWith('# '));
    assert.ok(headingLine && !headingLine.includes('\n'));
  });

  it('sanitizes inline and body helpers cleanly', () => {
    assert.equal(sanitizeMarkdownInline('Line1\nLine2 [[x]]'), 'Line1 Line2 \\[\\[x\\]\\]');
    assert.equal(sanitizeMarkdownBody('intro\n  ~~~js\ncode\n~~~'), 'intro\n  \\~\\~\\~js\ncode\n\\~\\~\\~');
  });

  it('parses and formats multi-speaker transcripts across plain, single-newline, named, and bolded formats', () => {
    const standard = [
      'Speaker 1: Should we grab chorizo before heading up?',
      '',
      'Speaker 2: Yeah, let us stop at the little market on the way.',
      '',
      'Speaker 1: Great, I will bring cash.',
    ].join('\n');

    assert.deepEqual(parseTranscriptBlocks(standard), [
      { speaker: 'Speaker 1', text: 'Should we grab chorizo before heading up?' },
      { speaker: 'Speaker 2', text: 'Yeah, let us stop at the little market on the way.' },
      { speaker: 'Speaker 1', text: 'Great, I will bring cash.' },
    ]);

    assert.equal(
      formatTranscriptForMarkdown(standard),
      [
        '**Speaker 1:** Should we grab chorizo before heading up?',
        '',
        '**Speaker 2:** Yeah, let us stop at the little market on the way.',
        '',
        '**Speaker 1:** Great, I will bring cash.',
      ].join('\n'),
    );

    // Single-newline turns with named speakers & continuation line
    const singleNewline = [
      'Dr. Chen: Take this twice a day.',
      'And drink plenty of water.',
      'María: Got it, meeting at 9:30 tomorrow.',
    ].join('\n');

    assert.deepEqual(parseTranscriptBlocks(singleNewline), [
      { speaker: 'Dr. Chen', text: 'Take this twice a day.\nAnd drink plenty of water.' },
      { speaker: 'María', text: 'Got it, meeting at 9:30 tomorrow.' },
    ]);

    // Normalizes already-bolded speaker labels without double-bolding
    const preBolded = '**Alex:** Hello there.\n\n**Sam**: Hey, how are you?';
    assert.deepEqual(parseTranscriptBlocks(preBolded), [
      { speaker: 'Alex', text: 'Hello there.' },
      { speaker: 'Sam', text: 'Hey, how are you?' },
    ]);
    assert.equal(
      formatTranscriptForMarkdown(preBolded),
      '**Alex:** Hello there.\n\n**Sam:** Hey, how are you?',
    );
  });

  it('does not misclassify single-speaker prose with colons, notes, or timestamps as speakers', () => {
    const prose = [
      'Note: pick up groceries before 5:30.',
      '',
      'Reminder: call the dentist on Thursday.',
      '',
      'Action Item: check https://example.com for hours.',
    ].join('\n');

    const blocks = parseTranscriptBlocks(prose);
    assert.equal(blocks.every((b) => b.speaker === undefined), true);
    assert.equal(blocks.length, 3);
    assert.equal(formatTranscriptForMarkdown(prose), prose);
  });

  it('formats multi-speaker English and Original transcripts in Obsidian Markdown while preserving sanitization', () => {
    const rec = makeRecording({
      isEnglish: false,
      language: 'es',
      languageName: 'Spanish',
      englishTranscript:
        'Speaker 1: Check <script>alert(1)</script> and [[Secret]]\n\nSpeaker 2: Visit [site](obsidian://open?vault=x)',
      originalTranscript:
        'Speaker 1: Mira esto.\n\nSpeaker 2: Vale, gracias.',
    });

    const md = buildObsidianMarkdown(rec);
    assert.ok(md.includes('**Speaker 1:** Check &lt;script>alert(1)&lt;/script> and \\[\\[Secret\\]\\]'));
    assert.ok(md.includes('**Speaker 2:** Visit [site](blocked://open?vault=x)'));
    assert.ok(md.includes('**Speaker 1:** Mira esto.\n\n**Speaker 2:** Vale, gracias.'));
    assert.equal(md.includes('<script>'), false);
    assert.equal(md.includes('[[Secret]]'), false);
  });
});

describe('Gemini prompt speaker diarization guidance', () => {
  it('instructs Gemini to omit labels for one speaker and label turns for multiple speakers', () => {
    const prompt = buildPrompt(['work', 'meetings']);
    assert.match(prompt, /one speaker/i);
    assert.match(prompt, /NO speaker labels/i);
    assert.match(prompt, /Speaker 1:/);
    assert.match(prompt, /originalTranscript and englishTranslation/);
  });
});

describe('Gemini response validation and error classification', () => {
  it('rejects non-object JSON, malformed JSON, and empty objects', () => {
    assert.throws(() => parseAndValidateAnalysis('not json'), GeminiClientError);
    assert.throws(() => parseAndValidateAnalysis('"scalar"'), GeminiClientError);
    assert.throws(() => parseAndValidateAnalysis('[]'), GeminiClientError);
    assert.throws(() => parseAndValidateAnalysis('{}'), GeminiClientError);
  });

  it('sanitizes valid analysis objects and strips newlines from single-line fields', () => {
    const res = parseAndValidateAnalysis(
      JSON.stringify({
        detectedLanguage: 'Spanish\nExtra',
        languageCode: 'ES',
        isEnglish: false,
        title: 'Lisbon\nTrip Ideas',
        summary: 'Check flights\nnext week.',
        tags: ['#Travel', 'Personal Ideas', 123, 'travel'],
        originalTranscript: 'Hola mundo.',
        englishTranslation: 'Hello world.',
      }),
    );

    assert.equal(res.detectedLanguage, 'Spanish Extra');
    assert.equal(res.languageCode, 'es');
    assert.equal(res.title, 'Lisbon Trip Ideas');
    assert.equal(res.summary, 'Check flights next week.');
    assert.deepEqual(res.tags, ['travel', 'personal-ideas']);
  });

  it('distinguishes upload and transcription timeouts from service failures', () => {
    const upload = classifyGeminiError(new DOMException('expired', 'TimeoutError'), 'upload');
    assert.equal(upload.kind, 'transient');
    assert.match(upload.message, /audio upload timed out/i);
    const generation = classifyGeminiError(new Error('request timed out'), 'transcription');
    assert.match(generation.message, /transcription timed out/i);
    const deadline = classifyGeminiError(
      new Error(JSON.stringify({ error: { code: 504, status: 'DEADLINE_EXCEEDED' } })),
      'preparation',
    );
    assert.match(deadline.message, /audio preparation timed out/i);
    const busy = classifyGeminiError(
      new Error(JSON.stringify({ error: { code: 503, message: 'Service unavailable' } })),
      'transcription',
    );
    assert.equal(busy.kind, 'transient');
    assert.match(busy.message, /temporarily unavailable/i);
    assert.doesNotMatch(busy.message, /timed out/i);
    assert.equal(classifyGeminiError(upload, 'transcription'), upload);
  });

  it('retains the request stage and Gemini code/status in service failures', () => {
    const error = classifyGeminiError(new Error(JSON.stringify({ error: {
      code: 503, status: 'UNAVAILABLE', message: 'Service temporarily unavailable',
    } })), 'transcription');
    assert.equal(error.kind, 'transient');
    assert.match(error.message, /Details: transcription; HTTP 503; UNAVAILABLE/);
    assert.equal(classifyGeminiError(error, 'upload'), error);
  });

  it('reads HTTP status from SDK errors even without a JSON message', async () => {
    const { ApiError } = await import('@google/genai');
    const error = classifyGeminiError(new ApiError({
      status: 500, message: 'Internal server error',
    }), 'upload');
    assert.equal(error.kind, 'transient');
    assert.match(error.message, /Details: upload; HTTP 500/);
  });

  it('does not invent HTTP codes for local timeouts or include response payloads in diagnostics', () => {
    const timeout = classifyGeminiError(new DOMException('expired', 'TimeoutError'), 'preparation');
    assert.match(timeout.message, /Details: preparation; TimeoutError/);
    assert.doesNotMatch(timeout.message, /HTTP/);
    const error = classifyGeminiError(new Error(JSON.stringify({ error: {
      code: 503, status: 'UNAVAILABLE', message: 'private payload should not be copied',
    } })), 'upload');
    assert.doesNotMatch(error.message, /private payload/);
  });

  it('classifies auth, quota, timeout, and stale dynamic-import errors accurately', () => {
    assert.equal(
      classifyGeminiError(new Error(JSON.stringify({ error: { code: 401 } }))).kind,
      'auth',
    );
    assert.equal(
      classifyGeminiError(new Error(JSON.stringify({ error: { code: 429 } }))).kind,
      'quota',
    );
    assert.equal(classifyGeminiError(new DOMException('timed out', 'TimeoutError')).kind, 'transient');

    const chunkErr = classifyGeminiError(
      new TypeError(
        'Failed to fetch dynamically imported module: https://kcverde.github.io/tapeleaf/assets/web-B5-VRfol.js',
      ),
    );
    assert.equal(chunkErr.kind, 'other');
    assert.match(chunkErr.message, /updated in the background/i);
  });
});

describe('ID entropy, audio import validation, and PWA manifest consistency', () => {
  it('generates recording IDs with a full 64-bit (16 hex char) random suffix', () => {
    const id = generateRecordingId();
    assert.match(id, /^rec_\d{8}_\d{6}_[0-9a-f]{16}$/);
  });

  it('validates imported audio files and rejects non-audio or empty files', () => {
    const empty = new File([], 'empty.m4a', { type: 'audio/mp4' });
    assert.equal(validateImportedAudioFile(empty).ok, false);

    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    assert.equal(validateImportedAudioFile(text).ok, false);

    const inferred = new File(['bytes'], 'memo.m4a', { type: '' });
    const res = validateImportedAudioFile(inferred);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.mimeType, 'audio/mp4');
      assert.equal(res.extension, 'm4a');
    }
  });

  it('builds consistent root and subpath PWA manifests', () => {
    assert.equal(normalizeBase(undefined), '/');
    assert.equal(normalizeBase('tapeleaf'), '/tapeleaf/');
    assert.equal(normalizeBase('/tapeleaf/'), '/tapeleaf/');

    const rootManifest = buildWebManifest('/');
    assert.equal(rootManifest.start_url, '/');
    assert.equal(rootManifest.scope, '/');
    assert.equal(rootManifest.icons[0].src, '/icons/icon-192.png');

    const subManifest = buildWebManifest('/tapeleaf/');
    assert.equal(subManifest.start_url, '/tapeleaf/');
    assert.equal(subManifest.scope, '/tapeleaf/');
    assert.equal(subManifest.icons[0].src, '/tapeleaf/icons/icon-192.png');
  });
});

class FakeTrack implements RecorderTrackLike {
  onended: ((this: never, ev: Event) => unknown) | null = null;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream implements RecorderStreamLike {
  readonly track = new FakeTrack();
  getTracks() {
    return [this.track];
  }
  getAudioTracks() {
    return [this.track];
  }
}

class FakeMediaRecorder implements MediaRecorderLike {
  state: RecordingState = 'inactive';
  mimeType: string;
  startedTimeslice: number | undefined;
  ondataavailable: ((this: never, ev: BlobEvent) => unknown) | null = null;
  onstop: ((this: never, ev: Event) => unknown) | null = null;
  onerror: ((this: never, ev: ErrorEvent) => unknown) | null = null;

  constructor(mimeType = 'audio/mp4') {
    this.mimeType = mimeType;
  }

  start(timeslice?: number) {
    this.startedTimeslice = timeslice;
    this.state = 'recording';
  }

  stop() {
    // Per W3C MediaStream Recording spec, state flips to 'inactive' synchronously
    // BEFORE dataavailable and stop events fire asynchronously.
    this.state = 'inactive';
  }

  emitData(text: string) {
    const handler = this.ondataavailable as ((ev: { data: Blob }) => unknown) | null;
    handler?.({ data: new Blob([text], { type: this.mimeType }) });
  }

  emitStop() {
    const handler = this.onstop as ((ev: Event) => unknown) | null;
    handler?.(new Event('stop'));
  }
}

describe('RecorderController lifecycle, double-Stop, and late-event isolation', () => {
  it('makes Stop idempotent while waiting for async dataavailable/onstop and transitions through stopping', async () => {
    const statuses: RecorderStatus[] = [];
    const streams: FakeStream[] = [];
    const recorders: FakeMediaRecorder[] = [];
    const savedChunks: number[] = [];

    const ctrl = new RecorderController(
      {
        candidateMimeTypes: ['audio/mp4'],
        getUserMedia: async () => {
          const s = new FakeStream();
          streams.push(s);
          return s;
        },
        createRecorder: (_stream, mime) => {
          const r = new FakeMediaRecorder(mime || 'audio/mp4');
          recorders.push(r);
          return r;
        },
        draftStore: {
          upsertDraft: async () => {},
          appendChunk: async (_id, seq) => {
            savedChunks.push(seq);
          },
          deleteDraft: async () => {},
        },
      },
      {
        onStatusChange: (s) => statuses.push(s),
        onMimeTypeChange: () => {},
        onErrorChange: () => {},
      },
    );

    await ctrl.startRecording();
    assert.equal(ctrl.getStatus(), 'recording');
    assert.equal(recorders[0].startedTimeslice, 5000);

    // First Stop transitions synchronously to 'stopping' (NOT 'idle')
    const p1 = ctrl.stopRecording();
    assert.equal(ctrl.getStatus(), 'stopping');
    assert.equal(recorders[0].state, 'inactive');

    // Second Stop while pending returns the EXACT same promise and does NOT release or reset
    const p2 = ctrl.stopRecording();
    assert.equal(p1, p2);
    assert.equal(ctrl.getStatus(), 'stopping');
    assert.equal(streams[0].track.stopped, false);

    // Starting another capture while stopping is ignored
    await ctrl.startRecording();
    assert.equal(recorders.length, 1);

    // Deliver delayed final dataavailable + onstop
    recorders[0].emitData('first-clip-audio');
    recorders[0].emitStop();

    const captured = await p1;
    assert.ok(captured);
    assert.equal(await captured.blob.text(), 'first-clip-audio');
    assert.equal(ctrl.getStatus(), 'idle');
    assert.equal(streams[0].track.stopped, true);
    assert.deepEqual(savedChunks, [0]);
    assert.deepEqual(statuses, ['requesting', 'recording', 'stopping', 'idle']);
  });

  it('prevents a late onstop/onerror callback from an earlier recorder from stopping a new capture', async () => {
    const streams: FakeStream[] = [];
    const recorders: FakeMediaRecorder[] = [];

    const ctrl = new RecorderController(
      {
        candidateMimeTypes: ['audio/mp4'],
        errorFallbackMs: 20,
        getUserMedia: async () => {
          const s = new FakeStream();
          streams.push(s);
          return s;
        },
        createRecorder: (_stream, mime) => {
          const r = new FakeMediaRecorder(mime || 'audio/mp4');
          recorders.push(r);
          return r;
        },
        draftStore: {
          upsertDraft: async () => {},
          appendChunk: async () => {},
          deleteDraft: async () => {},
        },
      },
      {
        onStatusChange: () => {},
        onMimeTypeChange: () => {},
        onErrorChange: () => {},
      },
    );

    // Start recording #1, emit a chunk, then stop and let fallback timer finalize before late onstop
    await ctrl.startRecording();
    recorders[0].emitData('clip-1');
    const stop1 = ctrl.stopRecording();
    const res1 = await stop1; // Finalized by fallback timer
    assert.ok(res1);
    assert.equal(ctrl.getStatus(), 'idle');

    // Start recording #2 immediately
    await ctrl.startRecording();
    assert.equal(recorders.length, 2);
    assert.equal(ctrl.getStatus(), 'recording');
    assert.equal(streams[1].track.stopped, false);

    // Now fire LATE callbacks from recorder #1
    recorders[0].emitData('late-junk');
    recorders[0].emitStop();

    // Recording #2 MUST remain live, untouched, and keep its own clean audio
    assert.equal(ctrl.getStatus(), 'recording');
    assert.equal(streams[1].track.stopped, false);

    recorders[1].emitData('clip-2');
    const stop2 = ctrl.stopRecording();
    recorders[1].emitStop();
    const res2 = await stop2;
    assert.ok(res2);
    assert.equal(await res2.blob.text(), 'clip-2');
  });
});

