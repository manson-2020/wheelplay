import { errorName, isRtcErrorRetryable } from './video-renderer.js';

// Video WebRTC remains receive-only. Browser audio uses the paired WebSocket.
// `experiment` runs the head-unit Bluetooth diagnostics in this page (see BROWSER_AUDIO.md):
// `noanswer` parses the offer but never answers, `inactive` answers with the media direction held
// back - together they tell apart offer parsing, transport setup and media flow as the trigger.
export function createRtcReceiver(createRenderer, {
  send, onReady = () => {}, onStop = () => {}, onStats = () => {},
  onResize = () => {}, onReset = () => {}, experiment = '',
  createPeer = () => new RTCPeerConnection({ iceServers: [] }),
  supportsCodec = codec => {
    if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return true;
    const caps = RTCRtpReceiver.getCapabilities('video');
    const codecs = (caps && caps.codecs) || [];
    // Some head units only populate the list after setRemoteDescription. An empty list is not
    // evidence of absence, so let the SDP answer report an unsupported media section instead.
    if (!codecs.length) return true;
    return codecs.some(c => c.mimeType.toLowerCase() === `video/${codec.toLowerCase()}`);
  },
  schedule = setTimeout, cancel = clearTimeout, now = () => Date.now(),
} = {}) {
  let renderer = null, track = null, previousStats = null, renderStalledSince = null, lastRendered = 0;
  let codec = 'H264', lastReason = null;
  let peer = null, id = null, generation = 0, timeout = null, gathering = null, statsTimer = null, ready = false;
  let lastDecoded = 0, sent = 0, lastSentAt = 0, sentAtLastProgress = 0;
  let stalledSince = null, statsFailedSince = null, disconnectTimer = null, recoveryGraceMs = 10000;
  function diagnostics() {
    let codecs = [];
    try {
      if (typeof RTCRtpReceiver !== 'undefined' && RTCRtpReceiver.getCapabilities) {
        const all = (RTCRtpReceiver.getCapabilities('video') || {}).codecs || [];
        // One entry per mime: Chrome lists every H.264 profile separately, which used to push
        // H265/AV1 out of the 12-entry window and made the diag line look incomplete.
        const seen = new Set();
        codecs = all.filter(entry => {
          const mime = String(entry.mimeType || '').toLowerCase();
          if (!mime || seen.has(mime)) return false;
          seen.add(mime); return true;
        }).slice(0, 12).map(entry => `${entry.mimeType}${entry.sdpFmtpLine ? ` ${entry.sdpFmtpLine}` : ''}`.slice(0, 96));
      }
    } catch (_) { codecs = []; }
    const snapshot = {
      ua: String((typeof navigator !== 'undefined' && navigator.userAgent) || '').slice(0, 128),
      hasPc: typeof RTCPeerConnection !== 'undefined',
      hasRvfc: typeof HTMLVideoElement !== 'undefined' && Boolean(HTMLVideoElement.prototype.requestVideoFrameCallback),
      hasStats: typeof RTCPeerConnection !== 'undefined' && Boolean(RTCPeerConnection.prototype && RTCPeerConnection.prototype.getStats),
      dpr: typeof devicePixelRatio === 'number' ? Math.round(devicePixelRatio * 100) / 100 : 0,
      viewport: `${typeof innerWidth === 'number' ? innerWidth : 0}x${typeof innerHeight === 'number' ? innerHeight : 0}`,
      screen: typeof screen !== 'undefined' ? `${screen.width}x${screen.height}` : '0x0',
    };
    // The whole snapshot stays under 1 KB; trim codecs first, never the capability flags.
    while (codecs.length > 0 && JSON.stringify({ ...snapshot, codecs }).length > 1024) codecs = codecs.slice(0, -1);
    return { ...snapshot, codecs };
  }
  function close() {
    generation++; cancel(timeout); cancel(gathering); cancel(statsTimer); cancel(disconnectTimer);
    timeout = null; gathering = null; statsTimer = null; disconnectTimer = null;
    stalledSince = null; statsFailedSince = null;
    renderStalledSince = null;
    const old = peer; peer = null; ready = false; id = null;
    onReset();
    if (renderer) renderer.stop(); renderer = null;
    if (track) { track.onended = null; track.stop(); track = null; }
    previousStats = null; lastRendered = 0;
    if (old) { old.ontrack = old.onconnectionstatechange = old.onicegatheringstatechange = null; old.close(); }
  }
  function fallback(reason = 'connection-failed', retryable = true) {
    const current = id;
    if (current === null) return;
    lastReason = reason;
    // A first-frame timeout is ambiguous on a head unit: name the peer states before close() so
    // the phone can tell an ICE that never completed from a stream that arrived but never decoded.
    const states = reason === 'first-frame-timeout' && peer
      ? { conn: peer.connectionState, ice: peer.iceConnectionState, gather: peer.iceGatheringState,
          ...(track ? { track: 1 } : {}) }
      : {};
    close(); onStop(reason);
    send({ type: 'rtc-fallback', id: current, reason, ...states, ...(retryable ? {} : { retryable: false }) });
  }
  async function receive(message) {
    if (message.type === 'rtc-stop') {
      if (message.id === id) { close(); onStop('server-stop'); }
      return;
    }
    if (message.type !== 'rtc-offer') return;
    close(); id = message.id; codec = message.codec === 'H265' ? 'H265' : 'H264';
    recoveryGraceMs = [4000, 10000, 30000].includes(message.recoveryGraceMs) ? message.recoveryGraceMs : 10000;
    const token = generation, current = () => generation === token && peer !== null;
    // One capability snapshot per offer: a head unit without remote debugging can still
    // report what it supports and whether the WebRTC APIs exist at all.
    send({ type: 'rtc-diag', id, ...diagnostics() });
    if (!supportsCodec(codec)) { fallback('codec-unsupported', false); return; }
    // `?rtcexp=noanswer` stops after parsing: no peer is created, so nothing on the car can run.
    if (experiment === 'noanswer') {
      timeout = schedule(() => { if (generation === token) fallback('exp:noanswer'); }, 15000);
      return;
    }
    timeout = schedule(() => { if (generation === token)
      fallback(experiment === 'inactive' ? 'exp:inactive-first-frame' : 'first-frame-timeout');
    }, Math.max(10000, recoveryGraceMs));
    try {
      const pc = createPeer(); peer = pc;
      const displayed = size => {
        if (!current() || ready || !size.width || !size.height) return;
        ready = true; cancel(timeout); timeout = null;
        // The last failed attempt stays visible while retrying, but a working stream must not
        // keep showing that old reason next to its own fps.
        lastReason = null;
        lastDecoded = 0; sent = 0; sentAtLastProgress = 0; lastSentAt = now();
        lastRendered = renderer?.snapshot().renderedFrames ?? 0;
        send({ type: 'rtc-ready', id }); onReady(size);
        if (current()) statsTimer = schedule(sample, 1000);
      };
      const sample = async () => {
        if (!current()) return;
        try {
          const report = await pc.getStats();
          if (!current()) return;
          statsFailedSince = null;
          report.forEach(stat => {
            if (!current()) return;
            if (stat.type !== 'inbound-rtp' || (stat.kind || stat.mediaType) !== 'video') return;
            const decoded = stat.framesDecoded || 0, at = now();
            const output = renderer.snapshot();
            const presented = output.presentedFrames;
            const rendered = output.renderedFrames;
            if (rendered === null || rendered !== lastRendered || sent <= sentAtLastProgress || at - lastSentAt >= 2000) {
              renderStalledSince = null;
            } else if (renderStalledSince === null) renderStalledSince = at;
            lastRendered = rendered;
            if (decoded !== lastDecoded || sent <= sentAtLastProgress || at - lastSentAt >= 2000) {
              stalledSince = null; sentAtLastProgress = sent;
            } else if (stalledSince === null) stalledSince = at;
            const previous = previousStats;
            const elapsed = previous ? Math.max(1, at - previous.at) : 0;
            const delta = key => previous && Number.isFinite(stat[key]) && Number.isFinite(previous.stat[key])
              ? Math.max(0, stat[key] - previous.stat[key]) : null;
            const rate = key => elapsed && delta(key) !== null ? delta(key) * 1000 / elapsed : null;
            const averageMs = (total, count) => delta(count) > 0 && delta(total) !== null ? delta(total) * 1000 / delta(count) : null;
            let rttMs = null;
            report.forEach(entry => {
              if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated && Number.isFinite(entry.currentRoundTripTime)) rttMs = entry.currentRoundTripTime * 1000;
            });
            const metrics = {
              receivedFps: rate('framesReceived'), decodedFps: rate('framesDecoded'),
              presentedFps: presented !== null && previous?.presented !== null && elapsed ? Math.max(0, presented - previous.presented) * 1000 / elapsed : null,
              renderedFps: rendered !== null && previous?.rendered !== null && elapsed ? Math.max(0, rendered - previous.rendered) * 1000 / elapsed : null,
              renderedFrames: rendered,
              decodeMs: averageMs('totalDecodeTime', 'framesDecoded'),
              jitterBufferMs: averageMs('jitterBufferDelay', 'jitterBufferEmittedCount'),
              processingMs: averageMs('totalProcessingDelay', 'framesDecoded'),
              dropped: delta('framesDropped'), lost: delta('packetsLost'), nack: delta('nackCount'),
              bitrateMbps: rate('bytesReceived') === null ? null : rate('bytesReceived') * 8 / 1e6,
              rttMs,
            };
            onStats(metrics.presentedFps ?? metrics.decodedFps, metrics);
            if (!current()) return;
            send({ type: 'rtc-feedback', id, packets: Math.max(0, stat.packetsReceived || 0),
              lost: Math.max(0, stat.packetsLost || 0), decoded, nack: Math.max(0, stat.nackCount || 0), rttMs });
            previousStats = { at, stat, presented, rendered };
            lastDecoded = decoded;
            // Static CarPlay screens legitimately stop producing frames.
            if (stalledSince !== null && at - stalledSince >= recoveryGraceMs) fallback('decode-stall');
            else if (renderStalledSince !== null && at - renderStalledSince >= recoveryGraceMs) fallback('render-stalled');
          });
        } catch (_) {
          if (current()) {
            if (statsFailedSince === null) statsFailedSince = now();
            if (now() - statsFailedSince >= recoveryGraceMs) fallback('stats-unavailable');
          }
        }
        if (current()) statsTimer = schedule(sample, 1000);
      };
      renderer = createRenderer({
        onReady: displayed,
        onResize: size => { if (current()) onResize(size); },
        onError: (reason, retryable) => { if (current()) fallback(reason, retryable); },
      });
      pc.onconnectionstatechange = () => {
        if (!current()) return;
        if (['failed', 'closed'].includes(pc.connectionState)) { fallback(`connection:${pc.connectionState}`); return; }
        if (pc.connectionState === 'disconnected') {
          if (disconnectTimer === null) {
            const timer = schedule(() => {
              if (current() && disconnectTimer === timer && pc.connectionState !== 'connected') fallback('disconnect-timeout');
            }, recoveryGraceMs);
            disconnectTimer = timer;
          }
        } else if (pc.connectionState === 'connected') {
          cancel(disconnectTimer); disconnectTimer = null;
        }
      };
      pc.ontrack = event => {
        if (!current()) return;
        if (track) { fallback('track-replaced'); return; }
        track = event.track;
        track.onended = () => { if (current()) fallback('track-ended'); };
        renderer.start(track, event.streams);
      };
      try { await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp }); }
      catch (error) { if (generation === token) fallback(`offer:${errorName(error)}`, isRtcErrorRetryable(error)); return; }
      if (!current()) return;
      let answer;
      try { answer = await pc.createAnswer(); }
      catch (error) { if (generation === token) fallback(`answer:${errorName(error)}`, isRtcErrorRetryable(error)); return; }
      if (!current()) return;
      if (/^m=video 0(?: |\r?$)/m.test(answer.sdp)) { fallback('codec-rejected', false); return; }
      // `?rtcexp=inactive` holds the media direction back: ICE and DTLS still establish but no RTP
      // flows, so a Bluetooth drop then names transport setup rather than media flow as the trigger.
      const rewritten = experiment === 'inactive'
        ? answer.sdp.replace(/a=(?:sendrecv|recvonly|sendonly)/g, 'a=inactive') : answer.sdp;
      // Use the browser as DTLS server: Mbed TLS 3.6 cannot reassemble a fragmented
      // ClientHello from newer Chrome versions. Passive is a standard answer role.
      const passive = { type: answer.type, sdp: rewritten.replace(/a=setup:active/g, 'a=setup:passive') };
      try { await pc.setLocalDescription(passive); }
      catch (_) {
        // Some head-unit builds reject a rewritten DTLS role; keep the generated answer.
        try { await pc.setLocalDescription(answer); }
        catch (error) { if (generation === token) fallback(`local-desc:${errorName(error)}`, isRtcErrorRetryable(error)); return; }
      }
      if (!current()) return;
      // One line of negotiation facts about the answer we are about to send. The full SDP stays
      // on the LAN, but `m=video 0`, the codec fmtp and the candidate mix are what explain a
      // rejection from a head unit with no reachable console.
      const answerSummary = sdp => {
        const lines = String(sdp || '').split(/\r?\n/).map(line => line.trim());
        const media = lines.find(line => line.startsWith('m=video ')) || '';
        const fields = media.replace(/^m=video\s+/, '').split(/\s+/).filter(Boolean);
        const payload = fields[2] || '';
        const rtpmap = lines.find(line => line.startsWith(`a=rtpmap:${payload} `)) || '';
        const fmtp = lines.find(line => line.startsWith(`a=fmtp:${payload} `)) || '';
        const codecLine = `${rtpmap.replace('a=rtpmap:', '').replace(`${payload} `, '')} ${fmtp.replace('a=fmtp:', '').replace(`${payload} `, '')}`.trim();
        const setup = lines.find(line => line.startsWith('a=setup:')) || '';
        let host = 0, srflx = 0, relay = 0, mdns = 0;
        for (const line of lines) {
          if (!line.startsWith('a=candidate:')) continue;
          const parts = line.slice('a=candidate:'.length).split(/\s+/).filter(Boolean);
          if ((parts[4] || '').toLowerCase().endsWith('.local')) mdns++;
          if (parts[7] === 'host') host++;
          else if (parts[7] === 'srflx') srflx++;
          else if (parts[7] === 'relay') relay++;
        }
        return {
          media: fields.length ? `video:${fields[0]}` : 'none',
          codecs: codecLine.slice(0, 200),
          setup: setup.replace('a=setup:', '') || 'none',
          candidates: `host:${host},srflx:${srflx},relay:${relay},mdns:${mdns}`,
        };
      };
      let answered = false;
      const answerReady = (force = false) => {
        if (answered || !current() || !pc.localDescription) return;
        if (!force && pc.iceGatheringState !== 'complete') return;
        answered = true; cancel(gathering); gathering = null;
        pc.onicegatheringstatechange = null;
        const sdp = pc.localDescription.sdp;
        send({ type: 'rtc-answer', id, sdp });
        send({ type: 'rtc-diag', id, answer: answerSummary(sdp) });
      };
      if (pc.iceGatheringState === 'complete') answerReady();
      else {
        pc.onicegatheringstatechange = () => answerReady();
        // Head units that never report completion would otherwise reach the first-frame
        // timeout with no answer sent at all; send what has been gathered.
        gathering = schedule(() => {
          if (generation !== token) return;
          // setLocalDescription succeeded, so this only fails on a browser that produced an
          // answer without an SDP; name it instead of waiting for the first-frame timeout.
          if (!pc.localDescription) { fallback('gathering-timeout'); return; }
          answerReady(true);
        }, 3000);
      }
    } catch (error) {
      if (generation !== token) return;
      if (error?.message === 'processor-unsupported') { fallback('processor-unsupported', false); return; }
      fallback(`transport:${errorName(error)}`, isRtcErrorRetryable(error));
    }
  }
  return { receive, close, fallback, get active() { return ready; }, get codec() { return codec; },
    get lastReason() { return lastReason; },
    get recovering() { return ready && (disconnectTimer !== null || stalledSince !== null || renderStalledSince !== null || statsFailedSince !== null); },
    progress(count) {
      if (count > sent) {
        if (now() - lastSentAt >= 2000) { stalledSince = null; renderStalledSince = null; }
        lastSentAt = now();
      }
      sent = count;
    },
  };
}

