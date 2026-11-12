import { HEVC_CODEC_STRINGS } from './media-probes.js';

// The WebSocket codec stream: compressed H.264 access units over the paired WebSocket, decoded by
// WebCodecs and drawn onto the canvas. It exists for head units whose browser drops the phone's
// Bluetooth audio link while a WebRTC media transport is active (BROWSER_AUDIO.md): the conflict
// follows the peer connection itself, not any audio the page plays, so this path keeps Bluetooth
// and the wheel keys while still decoding the iPhone's own H.264 instead of JPEG images.
export const CODEC_STREAM_MAGIC = 0x31564357; // WCV1, matches CodecPacket.MAGIC
const HEADER_BYTES = 24; // magic + sequence + pts + flags + parameter length
export function createCodecReceiver(drawFrame, {
  send, onReady = () => {}, onStop = () => {}, onStats = () => {}, onReset = () => {},
  supportsCodec = config => typeof VideoDecoder === 'undefined' ? Promise.resolve(false)
    : VideoDecoder.isConfigSupported(config).then(result => result?.supported === true)
      .catch(() => false),
  schedule = setTimeout, cancel = clearTimeout, now = () => Date.now(),
} = {}) {
  let decoder = null, id = null, generation = 0, ready = false, codec = 'H264', keySeen = false;
  let config = null, lastSequence = null, lastSize = null;
  let timeout = null, statsTimer = null, recoveryGraceMs = 10000;
  let decoded = 0, sent = 0, lastDecoded = 0, sentAtLastProgress = 0, lastSentAt = 0, stalledSince = null, fpsPrevious = null;
  let lastReason = null;
  function current() { return decoder !== null && generation === decoder.__token; }
  function close() {
    generation++; cancel(timeout); cancel(statsTimer);
    timeout = statsTimer = null;
    // Leave the teardown reason behind: after a server-side stop this is the only record of how
    // far the attempt got (head units have no reachable console).
    globalThis.__vcsCloses = (globalThis.__vcsCloses || 0) + 1;
    probe('closed', lastReason || 'server-stop');
    stalledSince = null; const old = decoder; decoder = null; ready = false; id = null;
    onReset();
    if (old) { try { old.close(); } catch (_) {} }
  }
  function fallback(reason = 'connection-failed', retryable = true) {
    const currentId = id;
    if (currentId === null) return;
    lastReason = reason;
    close(); onStop(reason);
    send({ type: 'vcs-fallback', id: currentId, reason, ...(retryable ? {} : { retryable: false }) });
  }
  function receive(message) {
    if (message.type === 'vcs-stop') {
      if (message.id === id) { close(); onStop('server-stop'); }
      return;
    }
    if (message.type !== 'vcs-start') return;
    globalThis.__vcsStartId = message.id;
    globalThis.__vcsCloses = 0;
    probe('start', `id=${message.id} codec=${message.codec}`);
    close(); id = message.id; codec = message.codec === 'H265' ? 'H265' : 'H264';
    recoveryGraceMs = [4000, 10000, 30000].includes(message.recoveryGraceMs) ? message.recoveryGraceMs : 10000;
    const token = generation;
    if (typeof VideoDecoder === 'undefined') { fallback('codec-unsupported', false); return; }
    // H.264 and HEVC both arrive as Annex B byte streams, so no decoder description is configured;
    // the parameter sets (SPS/PPS, or VPS/SPS/PPS) ride inside the keyframe access units instead.
    // The service names the exact HEVC level it negotiated; the probed strings cover a page whose
    // service is older, or a level this decoder refuses but a nearby one it accepts.
    const candidates = message.codec === 'H265'
      ? [...new Set([message.webcodecs, ...HEVC_CODEC_STRINGS].filter(Boolean))]
      : [`avc1.${message.profile}`];
    config = null;
    keySeen = false; lastSequence = null; fpsPrevious = null; lastSize = null;
    timeout = schedule(() => { if (generation === token) fallback('first-frame-timeout'); }, Math.max(10000, recoveryGraceMs));
    const displayed = size => {
      if (!current() || ready || !size.width || !size.height) return;
      ready = true; cancel(timeout); timeout = null;
      lastReason = null;
      decoded = 0; sent = 0; sentAtLastProgress = 0; lastSentAt = now();
      send({ type: 'vcs-ready', id }); onReady(size);
      if (current()) statsTimer = schedule(sample, 1000);
    };
    const sample = () => {
      if (!current()) return;
      const at = now();
      if (decoded !== lastDecoded || sent <= sentAtLastProgress || at - lastSentAt >= 2000) {
        stalledSince = null; sentAtLastProgress = sent;
      } else if (stalledSince === null) stalledSince = at;
      const fps = fpsPrevious ? Math.max(0, decoded - fpsPrevious.count) * 1000 / Math.max(1, at - fpsPrevious.at) : null;
      fpsPrevious = { at, count: decoded };
      // `size` lets the page re-assert a first-frame commit that was dropped: the one-shot
      // onReady is the only other place that carries the decoded dimensions.
      onStats(fps, { decodedFps: fps, decoded, size: lastSize });
      send({ type: 'vcs-feedback', id, decoded });
      lastDecoded = decoded;
      // Static CarPlay screens legitimately stop producing frames; server progress freezes with
      // them, so the deadline only runs while the phone keeps sending (see progress).
      if (stalledSince !== null && at - stalledSince >= recoveryGraceMs) { fallback('decode-stall'); return; }
      if (current()) statsTimer = schedule(sample, 1000);
    };
    // First accepted configuration wins; a decoder that takes hvc1 may refuse hev1 and vice versa.
    const accept = list => list.reduce((found, codecString) => found.then(hit => hit
      ? hit
      : supportsCodec({ codec: codecString, optimizeForLatency: true }).then(ok => {
        probe('try', `${codecString}=${ok}`);
        return ok ? codecString : null;
      })),
    Promise.resolve(null));
    accept(candidates).then(codecString => {
      if (generation !== token) return;
      probe('support', `${codecString ?? candidates[0]}=${codecString !== null}`);
      if (codecString === null) { fallback('codec-unsupported', false); return; }
      config = { codec: codecString, optimizeForLatency: true };
      try {
        decoder = new VideoDecoder({
          output: frame => {
            decoded++;
            if (decoded === 1) probe('first-output', `${frame.displayWidth}x${frame.displayHeight}`);
            const size = { width: frame.displayWidth, height: frame.displayHeight };
            lastSize = size;
            try { drawFrame(frame); } finally { frame.close(); }
            displayed(size);
          },
          error: err => { probe('decoder-error', `${err && err.name}:${err && err.message}`); if (current()) fallback('decode-error'); },
        });
        decoder.__token = token;
        decoder.configure(config);
        probe('configured', codecString);
      } catch (_) { fallback('codec-unsupported', false); }
    });
  }
  // Head units have no reachable console, so the ?diag=1 panel shows the receiver's last stages:
  // one probe per step, the newest eight kept so a teardown never erases how far the attempt got.
  const probe = (stage, detail = '') => {
    const entry = `${stage}${detail ? ':' + detail : ''}`;
    globalThis.__vcsStage = entry;
    const trail = globalThis.__vcsTrail || (globalThis.__vcsTrail = []);
    trail.push(entry);
    if (trail.length > 8) trail.shift();
  };
  function feed(buffer) {
    if (!decoder || decoder.state !== 'configured') {
      // The skip flood must not drown the trail: count it, leave the rare stages visible.
      globalThis.__vcsFeedSkips = (globalThis.__vcsFeedSkips || 0) + 1;
      globalThis.__vcsStage = `feed-skip:${decoder ? decoder.state : 'null'}`;
      return;
    }
    const view = new DataView(buffer);
    const keyframe = view.getUint16(20, true) === 1;
    const sequence = Number(view.getBigInt64(4, true));
    // A sender-side drop breaks the prediction chain; only a keyframe can restart decoding.
    if (lastSequence !== null && sequence !== lastSequence + 1 && !(keyframe && keySeen)) return;
    if (!keyframe && !keySeen) { probe('await-key', `seq=${sequence}`); return; }
    lastSequence = sequence;
    if (keyframe && !keySeen) { keySeen = true; try { decoder.reset(); decoder.configure(config); } catch (_) { return; } }
    if (lastSequence === 0) probe('first-au', `key=${keyframe} bytes=${buffer.byteLength} skip=${view.getUint16(22, true)}`);
    try {
      decoder.decode(new EncodedVideoChunk({
        type: keyframe ? 'key' : 'delta',
        timestamp: Number(view.getBigInt64(12, true)),
        data: new Uint8Array(buffer, HEADER_BYTES),
      }));
    } catch (error) { probe('decode-throw', `${error && error.name}:${error && error.message}`); }
  }
  return { receive, feed, close, get active() { return ready; }, get codec() { return codec; },
    get lastReason() { return lastReason; },
    get recovering() { return ready && stalledSince !== null; },
    progress(count) {
      if (count > sent) {
        if (now() - lastSentAt >= 2000) stalledSince = null;
        lastSentAt = now();
      }
      sent = count;
    },
  };
}

