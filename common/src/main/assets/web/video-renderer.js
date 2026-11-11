// Keep the decoder in the DOM, outside the viewport. display:none/hidden can
// suppress video frame callbacks on embedded browsers. drawImage copies decoded
// frames directly; it does not read pixels back through getImageData.
export function createVideoCanvasRenderer(video, canvas, {
  onFrame = () => {}, onDraw = () => {}, onError = () => {},
  requestFrame = callback => requestAnimationFrame(callback), cancelFrame = id => cancelAnimationFrame(id),
  now = () => performance.now(),
  // A 1 px layout box inside the viewport until the first frame. Some head-unit builds
  // never decode a video element that is display:none or positioned offscreen.
  keepVisible = false,
} = {}) {
  let context = null, running = false, generation = 0, videoCallback = null, animationCallback = null;
  let lastVideoCallbackAt = 0, lastFrameKey = null;
  function prepare() {
    video.classList?.toggle('pending-video', keepVisible);
    video.classList?.toggle('offscreen-video', !keepVisible);
    video.hidden = false;
  }
  function stop() {
    running = false; generation++;
    if (videoCallback !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoCallback);
    if (animationCallback !== null) cancelFrame(animationCallback);
    videoCallback = animationCallback = null; context = null; lastFrameKey = null;
    video.hidden = true;
    video.classList?.toggle('offscreen-video', false); video.classList?.toggle('pending-video', false);
    canvas.hidden = true; canvas.width = canvas.height = 0;
  }
  function fail(error) { stop(); onError(error); }
  function draw(metadata = null, stalled = false) {
    if (!running || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    try {
      const width = video.videoWidth, height = video.videoHeight;
      const resized = canvas.width !== width || canvas.height !== height;
      // Prefer the frame counter over currentTime, which can advance between
      // decoded frames. Some WebRTC implementations leave this counter at zero.
      const frames = video.getVideoPlaybackQuality?.().totalVideoFrames;
      const time = metadata?.mediaTime ?? video.currentTime;
      const key = !stalled && frames > 0 ? `frame:${frames}` : Number.isFinite(time) ? `time:${time}` : null;
      if (!resized && key !== null && key === lastFrameKey) return;
      if (resized) { canvas.width = width; canvas.height = height; }
      context.drawImage(video, 0, 0, width, height);
      onDraw();
      lastFrameKey = key;
      const first = canvas.hidden;
      canvas.hidden = false;
      // The layout box was only needed until a frame existed; the canvas now owns the picture.
      if (first) { video.classList?.toggle('pending-video', false); video.classList?.toggle('offscreen-video', true); }
      if (first || resized) onFrame(width, height);
    } catch (error) { fail(error); }
  }
  function start() {
    stop(); prepare();
    try {
      context = canvas.getContext('2d', { alpha: false });
      if (!context) throw Object.assign(new Error('Canvas 2D unavailable'), { name: 'NotSupportedError' });
      running = true; lastVideoCallbackAt = now();
      const token = generation, current = () => running && token === generation;
      const observe = (_, metadata) => {
        if (!current()) return;
        videoCallback = null; lastVideoCallbackAt = now(); draw(metadata);
        if (current()) videoCallback = video.requestVideoFrameCallback(observe);
      };
      const refresh = () => {
        if (!current()) return;
        animationCallback = null;
        // Also recover if offscreen playback decodes but stops being composited.
        if (!video.requestVideoFrameCallback) draw();
        else if (now() - lastVideoCallbackAt >= 250) draw(null, true);
        if (current()) animationCallback = requestFrame(refresh);
      };
      draw();
      if (!current()) return;
      if (video.requestVideoFrameCallback) videoCallback = video.requestVideoFrameCallback(observe);
      animationCallback = requestFrame(refresh);
    } catch (error) { fail(error); }
  }
  return { prepare, start, stop };
}

// Every failure used to look identical from the phone; the reason now travels with the
// fallback so one head-unit retry names the stage that failed.
export const errorName = error => String((error && error.name) || 'error').slice(0, 32);
export function isRtcErrorRetryable(error) {
  return !['NotAllowedError', 'NotSupportedError'].includes(error?.name);
}

export function videoRendererPreference(value, legacy) {
  return ['native', 'video-canvas', 'track-canvas'].includes(value) ? value : legacy === 'true' ? 'video-canvas' : 'native';
}

// A reader owns each VideoFrame until it is drawn or discarded, including after stop.
export function createTrackCanvasRenderer(canvas, {
  onReady = () => {}, onResize = () => {}, onError = () => {},
  createProcessor = init => new MediaStreamTrackProcessor(init),
} = {}) {
  let generation = 0, reader = null, running = false, width = 0, height = 0, renderedFrames = 0;
  function stop() {
    generation++; running = false;
    const old = reader; reader = null;
    if (old) { try { Promise.resolve(old.cancel()).catch(() => {}); } catch (_) {} }
    canvas.hidden = true; canvas.width = canvas.height = 0;
  }
  async function consume(activeReader, context, token) {
    const current = () => running && generation === token;
    try {
      while (current()) {
        const { value: frame, done } = await activeReader.read();
        try {
          if (!current()) break;
          if (done) throw new Error('track-ended');
          if (!frame || !(frame.displayWidth > 0) || !(frame.displayHeight > 0)) continue;
          const resized = width !== frame.displayWidth || height !== frame.displayHeight;
          if (resized) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
          context.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight);
          width = frame.displayWidth; height = frame.displayHeight; renderedFrames++;
          canvas.hidden = false;
          if (renderedFrames === 1) onReady({ width, height });
          else if (resized) onResize({ width, height });
        } finally { frame?.close(); }
      }
    } catch (error) {
      if (current()) {
        // Let the receiver freeze the last picture before stop clears the canvas.
        try { onError(error.message === 'track-ended' ? 'track-ended' : 'renderer-error', isRtcErrorRetryable(error)); }
        finally { if (generation === token) stop(); }
      }
    } finally {
      try { activeReader.releaseLock(); } catch (_) {}
      if (reader === activeReader) reader = null;
    }
  }
  return {
    start(track) {
      stop(); width = height = renderedFrames = 0;
      try {
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw Object.assign(new Error('Canvas 2D unavailable'), { name: 'NotSupportedError' });
        reader = createProcessor({ track, maxBufferSize: 1 }).readable.getReader();
        running = true;
        void consume(reader, context, generation);
      } catch (error) { stop(); onError('renderer-error', isRtcErrorRetryable(error)); }
    },
    stop,
    snapshot: () => ({ width, height, renderedFrames, presentedFrames: null }),
  };
}

// Video elements exist only for the two legacy renderers, and belong to one offer.
export function createVideoRenderer(mode, canvas, {
  createVideo, onReady = () => {}, onResize = () => {}, onError = () => {}, keepVisible = false,
} = {}) {
  let video = null, copy = null, frameCallback = null, generation = 0, ready = false, started = false;
  let width = 0, height = 0, presentedFrames = null, renderedFrames = mode === 'video-canvas' ? 0 : null;
  function report(w, h) {
    if (!video || !w || !h) return;
    const resized = width !== w || height !== h;
    width = w; height = h;
    if (!ready) {
      ready = true;
      if (!copy) { video.hidden = false; video.classList?.toggle('pending-video', false); }
      onReady({ width, height });
    } else if (resized) onResize({ width, height });
  }
  function stop() {
    generation++;
    if (copy) copy.stop(); copy = null;
    if (video) {
      if (frameCallback !== null) video.cancelVideoFrameCallback?.(frameCallback);
      video.onloadeddata = video.onerror = video.onresize = null;
      video.srcObject = null; video.classList?.toggle('pending-video', false); video.remove(); video = null;
    }
    frameCallback = null;
  }
  return {
    start(track, streams = []) {
      stop(); ready = started = false; width = height = 0; presentedFrames = null;
      renderedFrames = mode === 'video-canvas' ? 0 : null;
      try {
        video = createVideo();
        // Until the first frame, keep the 1 px layout box when the head unit needs one.
        if (keepVisible) { video.classList?.toggle('pending-video', true); video.hidden = false; }
        const token = generation, current = () => video !== null && token === generation;
        if (mode === 'video-canvas') {
          copy = createVideoCanvasRenderer(video, canvas, {
            onDraw: () => { renderedFrames++; }, onFrame: report, keepVisible,
            onError: error => { if (current()) onError('renderer-error', isRtcErrorRetryable(error)); },
          });
          copy.prepare();
        }
        const displayed = () => {
          if (!current() || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
          if (copy) { if (!started) { started = true; copy.start(); } }
          else report(video.videoWidth, video.videoHeight);
        };
        video.onloadeddata = displayed;
        video.onresize = () => { if (current() && !copy) displayed(); };
        video.onerror = () => { if (current()) onError('decode-error'); };
        if (video.requestVideoFrameCallback) {
          let firstPresented = null;
          presentedFrames = 0;
          const observe = (_, metadata) => {
            if (!current()) return;
            if (firstPresented === null) firstPresented = metadata.presentedFrames;
            presentedFrames = metadata.presentedFrames - firstPresented;
            if (!copy) displayed();
            if (current()) frameCallback = video.requestVideoFrameCallback(observe);
          };
          frameCallback = video.requestVideoFrameCallback(observe);
        }
        video.srcObject = streams[0] || new MediaStream([track]);
        Promise.resolve(video.play()).then(displayed).catch(error => { if (current()) onError(`play:${errorName(error)}`, isRtcErrorRetryable(error)); });
      } catch (error) { onError('renderer-error', isRtcErrorRetryable(error)); }
    },
    stop,
    snapshot: () => ({ width, height, presentedFrames, renderedFrames }),
  };
}

