// Keep essential controls until WebSocket accepts them. A successful send is never retried.
export function createControlOutbox(socket, {
  schedule = setTimeout, cancel = clearTimeout, now = () => Date.now(), onFailure = () => socket.close(),
} = {}) {
  const touches = [], imageAcks = new Map();
  const signals = [];
  let ack = null, audioAck = null, audioReady = null, ping = null, feedback = null, viewport = null, locationFix = null, timer = null, blockedSince = null, closed = false;
  const close = () => {
    closed = true; cancel(timer); timer = null;
    ack = null; audioAck = null; audioReady = null; ping = null; feedback = null; viewport = null; locationFix = null; touches.length = 0; signals.length = 0;
    imageAcks.clear();
  };
  const fail = () => { close(); onFailure(); };
  const flush = () => {
    if (closed) return;
    if (socket.readyState !== 1) { close(); return; }
    try {
      while ((ack || imageAcks.size || audioAck || audioReady || touches.length || signals.length || viewport || locationFix || feedback || ping) && socket.bufferedAmount < 8192) {
        if (imageAcks.size) {
          const [key, json] = imageAcks.entries().next().value; socket.send(json); imageAcks.delete(key);
        } else if (ack) { socket.send(ack); ack = null; }
        else if (audioAck) { socket.send(audioAck); audioAck = null; }
        else if (audioReady) { socket.send(audioReady); audioReady = null; }
        else if (touches.length) { socket.send(touches[0].json); touches.shift(); }
        else if (signals.length) { socket.send(signals[0]); signals.shift(); }
        else if (viewport) { socket.send(viewport); viewport = null; }
        else if (locationFix) { socket.send(locationFix); locationFix = null; }
        else if (feedback) { socket.send(feedback); feedback = null; }
        else { socket.send(ping); ping = null; }
        blockedSince = null;
      }
    } catch (_) { fail(); return; }
    if (ack || imageAcks.size || audioAck || audioReady || touches.length || signals.length || viewport || locationFix || feedback || ping) {
      if (blockedSince === null) blockedSince = now();
      if (now() - blockedSince >= 1500) { fail(); return; }
      if (timer === null) timer = schedule(() => { timer = null; flush(); }, 10);
    } else {
      cancel(timer); timer = null; blockedSince = null;
    }
  };
  return {
    send(data, kind = 'edge') {
      if (closed || socket.readyState !== 1) return false;
      const json = JSON.stringify(data);
      if (data.type === 'ack' && Number.isSafeInteger(data.sequence)) {
        const key = `${data.sessionId}/${data.videoEpoch}/${data.sequence}`;
        if (!imageAcks.has(key) && imageAcks.size >= 8) { fail(); return false; }
        imageAcks.set(key, json);
      } else if (data.type === 'ack') ack = json;
      else if (data.type === 'audio-ack') audioAck = json;
      else if (data.type === 'audio-ready') audioReady = json;
      else if (data.type === 'ping') ping = json;
      else if (data.type === 'rtc-feedback') feedback = json;
      else if (data.type === 'viewport') viewport = json;
      else if (data.type === 'location') locationFix = json;
      else if (data.type === 'touch' || data.type === 'input') {
        const tail = touches[touches.length - 1];
        // Only consecutive moves may be replaced; never cross a down/up/release boundary.
        if (kind === 'move' && tail && tail.kind === 'move' && tail.type === data.type && tail.eventKind === data.kind) tail.json = json;
        else if (touches.length < 64) touches.push({ kind, json, type: data.type, eventKind: data.kind });
        else { fail(); return false; }
      } else if (['rtc-start', 'rtc-answer', 'rtc-ready', 'rtc-fallback', 'rtc-diag', 'vcs-start', 'vcs-ready', 'vcs-fallback', 'vcs-feedback', 'vcs-keyframe', 'phone-connect', 'image-format', 'location-start', 'location-stop', 'location-clear', 'media', 'media-command', 'browser-appearance'].includes(data.type)) {
        if (signals.length >= 8 || json.length > 32768) { fail(); return false; }
        if (data.type.startsWith('location-')) locationFix = null;
        signals.push(json);
      } else return false;
      flush();
      return !closed;
    },
    close,
  };
}

