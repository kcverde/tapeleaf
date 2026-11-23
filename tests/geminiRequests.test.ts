import assert from 'node:assert/strict';
import { it } from 'node:test';
import { analyzeAudioBlob, INLINE_LIMIT_BYTES } from '../src/lib/geminiClient';

it('gives transcription ten minutes in both the SDK and abort signal', async (t) => {
  const readerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  Object.defineProperty(globalThis, 'FileReader', {
    configurable: true,
    value: class {
      result = 'data:audio/m4a;base64,YXVkaW8=';
      onload?: () => void;
      readAsDataURL() { this.onload?.(); }
    },
  });
  t.after(() => {
    if (readerDescriptor) Object.defineProperty(globalThis, 'FileReader', readerDescriptor);
    else Reflect.deleteProperty(globalThis, 'FileReader');
  });
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests++;
    assert.equal(new Headers(init.headers).get('X-Server-Timeout'), '600');
    assert.ok(init.signal);
    return new Response(JSON.stringify({ candidates: [{
      finishReason: 'STOP',
      content: { parts: [{ text: JSON.stringify({
        title: 'Test Recording', originalTranscript: 'Complete transcript.',
        englishTranslation: 'Complete transcript.', isEnglish: true,
      }) }] },
    }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const result = await analyzeAudioBlob({
    apiKey: 'test-only', model: 'gemini-test', blob: new Blob(['audio']),
    mimeType: 'audio/m4a', existingTags: [],
  });
  assert.equal(result.originalTranscript, 'Complete transcript.');
  assert.equal(requests, 1);
  assert.deepEqual(timeouts, [600_000]);
});

it('gives large uploads ten minutes and identifies upload timeout failures', async (t) => {
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests++;
    assert.equal(new Headers(init.headers).get('X-Server-Timeout'), '600');
    throw new DOMException('request timed out', 'TimeoutError');
  });
  await assert.rejects(analyzeAudioBlob({
    apiKey: 'test-only', model: 'gemini-test',
    blob: new Blob([new Uint8Array(INLINE_LIMIT_BYTES + 1)], { type: 'audio/m4a' }),
    mimeType: 'audio/m4a', existingTags: [],
  }), /audio upload timed out/i);
  assert.ok(requests >= 1);
  assert.deepEqual(timeouts, [600_000]);
});
