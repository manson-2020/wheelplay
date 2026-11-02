import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodecReceiver, CODEC_STREAM_MAGIC } from '../common/src/main/assets/web/app.js';

globalThis.EncodedVideoChunk = class {
  constructor(init) { Object.assign(this, init); }
};

function fixture({
  supported = async () => true,
  profile = '42e01f',
} = {}) {
  const sent = [], drawn = [], timers = new Map();
  const decoders = [];
  let sequence = 0, clock = 0, ready = 0, stopped = 0, closed = false;
  class FakeDecoder {
    constructor({ output, error }) { decoders.push(this); this.output = output; this.error = error; }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) { (this.chunks ??= []).push(chunk); }
    reset() { this.resetCount = (this.resetCount || 0) + 1; }
    close() { this.closed = true; }
  }
  globalThis.VideoDecoder = FakeDecoder;
  const receiver = createCodecReceiver(frame => drawn.push(frame), {
    send: m => sent.push(m), supportsCodec: supported,
    onReady: () => ready++, onStop: () => stopped++,
    schedule(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    cancel(id) { timers.delete(id); },
    now: () => clock,
  });
  const packet = (sequenceId, pts, keyframe, payload = [1, 2, 3]) => {
    const buffer = new ArrayBuffer(24 + payload.length);
    const view = new DataView(buffer);
    view.setUint32(0, CODEC_STREAM_MAGIC, true);
    view.setBigInt64(4, BigInt(sequenceId), true);
    view.setBigInt64(12, BigInt(pts), true);
    view.setUint16(20, keyframe ? 1 : 0, true);
    view.setUint16(22, 0, true);
    new Uint8Array(buffer, 24).set(payload);
    return buffer;
  };
  return {
    receiver, sent, drawn, decoders, timers, packet, profile,
    get ready() { return ready; }, get stopped() { return stopped; },
    async start(id = 1) {
      await receiver.receive({ type: 'vcs-start', id, codec: 'H264', profile, recoveryGraceMs: 10000 });
      await Promise.resolve();
    },
    async tick(delay, at) {
      clock = at;
      const entry = [...timers.entries()].find(([, t]) => t.delay === delay);
      assert.ok(entry, `expected a timer at ${delay}`);
      timers.delete(entry[0]);
      await entry[1].fn();
    },
  };
}

test('a missing WebCodecs decoder falls back without touching the control socket', async () => {
  const f = fixture({ supported: async () => false });
  await f.start(2);
  assert.deepEqual(f.sent, [{ type: 'vcs-fallback', id: 2, reason: 'codec-unsupported', retryable: false }]);
});

test('keyframes then deltas decode, draw and report readiness', async () => {
  const f = fixture();
  await f.start(3);
  const decoder = f.decoders.at(-1);
  assert.equal(decoder.config.codec, 'avc1.42e01f');
  assert.equal(decoder.config.optimizeForLatency, true);
  f.receiver.feed(f.packet(0, 1000, true));
  f.receiver.feed(f.packet(1, 40000, false));
  assert.deepEqual(decoder.chunks.map(c => `${c.type}@${c.timestamp}`), ['key@1000', 'delta@40000']);
  decoder.output({ displayWidth: 1280, displayHeight: 720, close() {} });
  decoder.output({ displayWidth: 640, displayHeight: 360, close() {} });
  assert.equal(f.drawn.length, 2, 'every decoded frame reaches the draw callback');
  assert.equal(f.ready, 1);
  assert.deepEqual(f.sent.find(m => m.type === 'vcs-ready'), { type: 'vcs-ready', id: 3 });
  await f.tick(1000, 1000);
  // The decoded counter resets at readiness, so the first feedback counts post-ready frames only.
  assert.deepEqual(f.sent.find(m => m.type === 'vcs-feedback'), { type: 'vcs-feedback', id: 3, decoded: 1 });
});

test('deltas before the first keyframe are skipped and a gap waits for a keyframe', async () => {
  const f = fixture();
  await f.start(4);
  const decoder = f.decoders.at(-1);
  f.receiver.feed(f.packet(5, 0, false));
  assert.equal(decoder.chunks, undefined, 'a leading delta must not reach the decoder');
  f.receiver.feed(f.packet(0, 0, true));
  f.receiver.feed(f.packet(1, 33, false));
  f.receiver.feed(f.packet(3, 99, false, [9]));
  assert.equal(decoder.chunks.length, 2, 'a sequence gap skips the delta and waits');
  f.receiver.feed(f.packet(4, 132, true));
  assert.equal(decoder.resetCount, 1, 'the keyframe after a gap reconfigures the decoder');
  assert.equal(decoder.chunks.at(-1).type, 'key');
});

test('a decoder that stops advancing while the phone keeps sending eventually falls back', async () => {
  const f = fixture();
  await f.start(5);
  const decoder = f.decoders.at(-1);
  f.receiver.feed(f.packet(0, 0, true));
  decoder.output({ displayWidth: 1280, displayHeight: 720, close() {} });
  f.receiver.progress(10);
  await f.tick(1000, 1000);
  for (let at = 2000; at <= 11000; at += 1000) {
    f.receiver.progress(at);
    await f.tick(1000, at);
  }
  assert.deepEqual(f.sent.at(-1), { type: 'vcs-fallback', id: 5, reason: 'decode-stall' });
  assert.equal(decoder.closed, true);
});

test('a first frame that never arrives falls back after the grace period', async () => {
  const f = fixture();
  await f.start(6);
  await f.tick(10000, 10000);
  assert.deepEqual(f.sent.at(-1), { type: 'vcs-fallback', id: 6, reason: 'first-frame-timeout' });
});

test('a server stop closes the decoder and ignores stale feedback', async () => {
  const f = fixture();
  await f.start(7);
  const decoder = f.decoders.at(-1);
  await f.receiver.receive({ type: 'vcs-stop', id: 7 });
  assert.equal(decoder.closed, true);
  f.receiver.feed(f.packet(0, 0, true));
  assert.equal(decoder.chunks, undefined, 'closed decoders must not receive chunks');
});
