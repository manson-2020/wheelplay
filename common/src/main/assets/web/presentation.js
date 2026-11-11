// Source availability, a committed picture and input readiness are independent.
// Silence is normal for a static screen; only an explicit gap starts this deadline.
export function createPresentationController({
  onChange = () => {}, schedule = setTimeout, cancel = clearTimeout,
  now = () => performance.now(), holdMs = 2000,
} = {}) {
  let connected = false, source = 'waiting', inputReady = true, frame = null;
  let sessionId = null, videoEpoch = null, revision = 0, invalid = false;
  let deadline = null, timer = null, timerGeneration = 0;
  const same = picture => picture && picture.revision === revision && !invalid;
  function clearDeadline() { cancel(timer); timer = null; deadline = null; timerGeneration++; }
  function snapshot() {
    const showing = connected && same(frame) && source === 'ready';
    const recovering = connected && !!frame && !showing && source !== 'stopped';
    const held = recovering && deadline !== null && now() < deadline;
    return { state: !connected ? 'disconnected' : showing ? 'showing' : held ? 'recovering' : 'waiting',
      visible: showing || held, interactive: showing && inputReady,
      frame, sessionId, videoEpoch, revision };
  }
  function publish() {
    const value = snapshot();
    if (value.state === 'showing' || !connected || source === 'stopped' || !frame) clearDeadline();
    else if (deadline === null) {
      deadline = now() + holdMs;
      const token = ++timerGeneration;
      const expire = () => {
        if (token !== timerGeneration) return;
        const remaining = deadline - now();
        if (remaining > 0) { timer = schedule(expire, remaining); return; }
        timer = null; onChange(snapshot());
      };
      timer = schedule(expire, holdMs);
    }
    onChange(snapshot());
  }
  function accept(meta = {}) {
    if (!connected) return false;
    if (meta.videoEpoch == null) return videoEpoch === null;
    if (!Number.isSafeInteger(meta.videoEpoch) || !Number.isSafeInteger(meta.sessionId) ||
        meta.videoEpoch < 0 || meta.sessionId < 0) return false;
    if (videoEpoch !== null && (meta.videoEpoch < videoEpoch ||
      meta.videoEpoch === videoEpoch && meta.sessionId !== sessionId)) return false;
    if (meta.videoEpoch !== videoEpoch || meta.sessionId !== sessionId) {
      sessionId = meta.sessionId; videoEpoch = meta.videoEpoch; revision++;
      source = 'waiting'; inputReady = false; invalid = false;
    }
    return true;
  }
  return {
    open() { clearDeadline(); connected = true; source = 'waiting'; inputReady = true;
      frame = null; sessionId = videoEpoch = null; revision++; invalid = false; publish(); },
    close() { connected = false; frame = null; revision++; publish(); },
    status(meta) {
      if (!accept(meta)) return false;
      // Compatibility with servers predating versioned media packets.
      if (videoEpoch === null && frame && frame.transport !== 'rtc' && (meta.width !== frame.width || meta.height !== frame.height)) {
        revision++; invalid = false;
      }
      source = meta.sourceState || (meta.streaming ? 'ready' : 'recovering');
      inputReady = meta.inputReady ?? source === 'ready';
      publish(); return true;
    },
    present(meta, width, height, transport, expectedRevision = null) {
      if (!accept(meta) || source === 'stopped' || expectedRevision !== null && expectedRevision !== revision) return false;
      frame = { width, height, transport, revision, mime: meta.mime }; invalid = false;
      if (videoEpoch === null) { source = 'ready'; inputReady = true; }
      publish(); return true;
    },
    accepts(meta) {
      const previous = revision, accepted = accept(meta);
      if (accepted && previous !== revision) publish();
      return accepted;
    },
    invalidate(transport) { if (frame?.transport === transport) { invalid = true; publish(); } },
    forget() { frame = null; publish(); },
    inputUnavailable() { inputReady = false; publish(); },
    refresh: publish,
    get current() { return snapshot(); },
  };
}

