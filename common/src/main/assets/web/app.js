import { t } from './text.js';
import { createDesktopInput } from './desktop-input.js';
import { mapPoint, pairingCodeFromUrl, unzoomedDisplayRect, browserViewportSize } from './viewport.js';
import { createPresentationController } from './presentation.js';
import { decodeVideoPacket, probeWebp, probeHevc } from './media-probes.js';
import { createJpegPresenter } from './jpeg-presenter.js';
import { createControlOutbox } from './control-outbox.js';
import { createAppearanceReporter, createMediaSessionProbe } from './browser-appearance.js';
import { createVideoRenderer, createTrackCanvasRenderer, videoRendererPreference } from './video-renderer.js';
import { createRtcReceiver } from './rtc-receiver.js';
import { createCodecReceiver, CODEC_STREAM_MAGIC } from './codec-stream.js';
import { applyPhoneGauge, phoneGaugeValues, phoneStatusMarkup } from './phone-gauge.js';
import { createBrowserAudio } from './browser-audio.js';
import { createBrowserLocation } from './browser-location.js';
import { createBrowserMediaSession } from './browser-media-session.js';
import { readUrlFlags } from './url-flags.js';

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  // URL flags are parsed once, before any connection state exists (url-flags.js, docs/URL_FLAGS.md).
  const { diagnostic: diagnosticStatus, keepVideoVisible, autoLaunch, rtcExperiment,
    mediaSessionMode, audioIdleMillis } = readUrlFlags(location?.search || '');
  // Every persistent option funnels through here: a head unit without storage keeps session-only
  // defaults instead of failing, and a `storageAvailable` probe decides whether pairing can be
  // remembered across visits.
  const storageAvailable = (() => {
    try { window.localStorage.getItem('wheelplay.storage'); return true; } catch (_) { return false; }
  })();
  const storage = {
    get(key) { try { return window.localStorage.getItem(key); } catch (_) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (_) {} },
    remove(key) { try { window.localStorage.removeItem(key); } catch (_) {} },
  };
  const screen = $('screen');
  const screens = [screen, $('screen-next'), $('screen-third')];
  const heldFrame = $('held-frame');
  let video = null;
  const canvas = $('video-canvas');
  const display = $('display');
  const touchSurface = $('touch-surface');
  // Read-only diagnostic snapshots; counters never include pairing credentials or video payloads.
  const rendererStats = { selectedMode: 'native', activeMode: 'waiting', renderedFps: null, renderedFrames: null, fallbackReason: null };
  const performanceStats = { source: null, transport: null, receiver: null, image: null, presentation: rendererStats };
  const webpSupport = probeWebp();
  // `undefined` until the HEVC probe settles, `null` when this browser cannot decode it at all.
  let hevcCodec;
  // Awaited before the codec stream is requested: the service will not start an HEVC stream this
  // page never said it could decode, and the iPhone may already be sending one.
  const hevcProbe = probeHevc().then(codec => {
    hevcCodec = codec;
    // The panel only repaints on a media snapshot; a head unit sitting on JPEG may not send one.
    if (diagnosticStatus) renderPresentation(presentation.current);
    return codec;
  });
  Object.defineProperty(window, 'wheelplayStats', { configurable: true, get: () => JSON.parse(JSON.stringify(performanceStats)) });
  let rtc = null, rtcRequested = false, rtcFps = null;
  let codec = null, codecRequested = false, codecFps = null;
  // A video receiver can decode its first frame while the presentation controller refuses to
  // commit it (a version advanced between the start message and the first frame, or a brief
  // `stopped` status). Nothing else retries that commit, so the page would sit on a frozen JPEG
  // with touch disabled until somebody refreshes. Watch for that and rebuild the session the
  // same way a refresh would, bounded so a genuinely broken head unit cannot loop forever.
  const FRAME_COMMIT_GRACE_MS = 2500;
  let frameCommitTimer = null, frameCommitRetries = 0;
  // Latest server-side WebRTC hint and capability snapshot, kept for the ?diag=1 status line.
  let serverRtcHint = '', serverVcsHint = '', serverRtcDiag = '';
  let serverMedia = null;
  let socket = null, stopped = true, paired = false, retry = null, attempts = 0;
  let width = 1280, height = 720, live = false, lastStatus = 0, rtcMedia = {}, codecMedia = {};
  let heartbeat = null, movePending = false, moveGeneration = 0, outbox = null;
  let authGeneration = 0, deviceCredential = null;
  let userDisconnected = false, autoRetryTimer = null;
  // "Auto full screen" is a page-level preference, independent of the connection: every page load
  // asks once, and a browser that needs a gesture gets one retry on the first tap anywhere.
  let autoFullscreenPending = false;
  const locationOption = $('browser-location');
  locationOption.checked = false; // Never inherit form restoration or grant consent through storage.
  const browserLocation = createBrowserLocation({ send: data => send(data), onState(enabled, message, key) {
    locationOption.checked = enabled;
    $('location-status').textContent = message;
    $('location-message').textContent = message;
    $('location-message').hidden = !message || ['web_location_ready', 'web_location_active'].includes(key);
  } });
  locationOption.addEventListener('change', () => { void browserLocation.setEnabled(locationOption.checked); });
  const devicePreference = 'wheelplay.browserDevice';
  let pairingToken = null, qrGeneration = 0, qrTimer = null, qrRequest = null;
  let viewportReportTimer = null, lastViewportSignature = '';
  // `null` until the browser reports: the diag line then says "unknown" instead of claiming light.
  let browserDarkMode = null;
  const ignoreZoomOption = $('ignore-browser-zoom');
  const ignoreZoomPreference = 'wheelplay.ignoreBrowserZoom';
  ignoreZoomOption.checked = storage.get(ignoreZoomPreference) === 'true';
  function syncDisplayZoom() {
    if (!display.style) return;
    const area = ignoreZoomOption.checked && !display.hidden
      ? unzoomedDisplayRect(display.parentElement.getBoundingClientRect(), window.visualViewport) : null;
    display.classList.toggle('ignore-browser-zoom', Boolean(area));
    if (area) {
      Object.assign(display.style, {
        left: `${area.left}px`, top: `${area.top}px`,
        width: `${area.width * area.scale}px`, height: `${area.height * area.scale}px`,
        transform: `scale(${1 / area.scale})`,
      });
    } else {
      for (const name of ['left', 'top', 'width', 'height', 'transform']) display.style.removeProperty(name);
    }
  }
  ignoreZoomOption.addEventListener('change', () => {
    storage.set(ignoreZoomPreference, String(ignoreZoomOption.checked));
    release(); syncDisplayZoom(); scheduleViewportReport();
  });
  // The id and storage key keep their historical "on start" names so an existing preference
  // survives the rename to "Auto full screen". This is a page-level preference, not a connection
  // one: turning it off never tears down a fullscreen the user chose with the button below.
  const fullscreenOption = $('fullscreen-on-start');
  const fullscreenPreference = 'wheelplay.fullscreenOnStart';
  fullscreenOption.checked = storage.get(fullscreenPreference) === 'true';
  // Ask once per page load. A browser without a user gesture rejects the request; `pending` then
  // lets the first tap anywhere retry it exactly once. `retryOnGesture` is false for that retry,
  // so a second failure never re-arms against a manual exit.
  function requestAutoFullscreen(retryOnGesture = true) {
    if (document.fullscreenElement || !document.documentElement?.requestFullscreen) {
      autoFullscreenPending = false;
      return;
    }
    let request;
    try { request = Promise.resolve(document.documentElement.requestFullscreen()); }
    catch (_) { request = Promise.reject(); }
    request.then(() => { autoFullscreenPending = false; },
      () => { autoFullscreenPending = retryOnGesture && fullscreenOption.checked; });
  }
  fullscreenOption.addEventListener('change', () => {
    storage.set(fullscreenPreference, String(fullscreenOption.checked));
    // The toggle itself is a user gesture, so the request is allowed right here.
    if (fullscreenOption.checked) requestAutoFullscreen();
    else autoFullscreenPending = false;
  });
  if (fullscreenOption.checked) requestAutoFullscreen();
  const presentation = createPresentationController({ onChange: renderPresentation });
  const jpeg = createJpegPresenter(screens, {
    onFrame: (meta, frameWidth, frameHeight) => {
      if (meta.width && (meta.width !== frameWidth || meta.height !== frameHeight)) return false;
      if (!presentation.present(meta, frameWidth, frameHeight, 'jpeg', meta.revision)) return false;
      width = frameWidth; height = frameHeight;
      clearHeldFrame(); return true;
    },
    onError: meta => {
      if (meta.mime === 'image/webp') send({ type: 'image-format', format: 'jpeg' });
      if (!jpeg.current) presentation.invalidate('jpeg');
    },
  });
  const rendererPreference = 'wheelplay.videoRenderer';
  let selectedMode = 'native';
  try {
    selectedMode = videoRendererPreference(storage.get(rendererPreference), storage.get('wheelplay.canvasVideo'));
    storage.set(rendererPreference, selectedMode);
  } catch (_) {}
  let launchMode = selectedMode;
  const RENDERER_MODES = ['native', 'video-canvas', 'track-canvas'];
  const processorSupported = () => typeof MediaStreamTrackProcessor === 'function';
  function updateRendererOptions() {
    for (const mode of RENDERER_MODES) {
      $(`renderer-${mode}`).checked = selectedMode === mode;
      $(`renderer-${mode}-card`).classList.toggle('selected', selectedMode === mode);
    }
    $('renderer-hint').hidden = selectedMode !== 'track-canvas' || processorSupported();
  }
  for (const mode of RENDERER_MODES) {
    $(`renderer-${mode}`).addEventListener('change', () => {
      if (!$(`renderer-${mode}`).checked) return;
      selectedMode = mode; updateRendererOptions();
      storage.set(rendererPreference, mode);
    });
  }
  updateRendererOptions();
  function createLegacyVideo() {
    video = document.createElement('video');
    video.id = 'video'; video.autoplay = true; video.muted = true; video.playsInline = true; video.hidden = true;
    video.setAttribute('disablepictureinpicture', '');
    video.setAttribute('aria-label', t('web_live_carplay_video'));
    display.insertBefore(video, canvas); bindSurface(video);
    return video;
  }
  // Both video transports repaint through the same path; only their snapshot slot differs.
  // The start-time snapshot used to be passed to present() as an expected revision. A source
  // reconfiguration between `vcs-start`/`rtc-offer` and the first decoded frame advances the
  // controller revision (a status or a v2 JPEG packet can do it), so that snapshot is then older
  // than the live version and the first frame is discarded: the screen keeps the last JPEG and
  // `#touch-surface.stale` blocks all input until the driver refreshes. The receivers already
  // gate onReady on their own generation, so commit the live decoder's frame against the live
  // version, and repair by rebuilding the socket if the controller still refuses it.
  function showStreamSize(kind, size) {
    if (!presentation.presentLive(kind, size.width, size.height)) {
      watchFrameCommit(kind); return;
    }
    frameCommitRetries = 0; cancelFrameCommitWatch();
    width = size.width; height = size.height; jpeg.cancelPending(); jpeg.hide(); clearHeldFrame();
  }
  function showRtcSize(size) { showStreamSize('rtc', size); }
  function showCodecSize(size) { showStreamSize('codec', size); }
  function cancelFrameCommitWatch() {
    if (frameCommitTimer !== null) { clearTimeout(frameCommitTimer); frameCommitTimer = null; }
  }
  function watchFrameCommit(kind) {
    cancelFrameCommitWatch();
    frameCommitTimer = setTimeout(() => {
      frameCommitTimer = null;
      const ws = socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (presentation.current.frame?.transport === kind) { frameCommitRetries = 0; return; }
      if (frameCommitRetries >= 2) return;
      frameCommitRetries++;
      // Head units have no console: keep a breadcrumb for the ?diag=1 panel.
      globalThis.__frameCommitRecovery = (globalThis.__frameCommitRecovery || 0) + 1;
      // A fresh socket resets the presentation version scope, which is exactly what a manual
      // refresh does. The existing onclose path and its bounded backoff own the reconnection.
      ws.close();
    }, FRAME_COMMIT_GRACE_MS);
  }
  // A start message claims a presentation slot only when the controller accepts it; switching
  // revisions drops the still-image presenter's pending work so the new transport wins cleanly.
  // A rejected start also abandons the transport itself, exactly like the handler's early return.
  function acceptMediaStart(data, assign) {
    const previousRevision = presentation.current.revision;
    if (!presentation.accepts(data)) return false;
    if (previousRevision !== presentation.current.revision) jpeg.cancelPending();
    assign({ ...data, revision: presentation.current.revision });
    return true;
  }
  const pairApi = async (path, request = null) => {
    const headers = request?.token ? { 'X-Pair-Token': request.token } :
      request?.code ? { 'X-Pair-Code': request.code } :
      request?.device ? { 'X-Device-Id': request.device.id, 'X-Device-Secret': request.device.secret } :
      request ? { 'X-Pair-Id': request.id, 'X-Pair-Secret': request.secret } : {};
    const controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const timeout = setTimeout(() => controller && controller.abort(), 8000);
    try {
      const response = await fetch(`/pair/${path}`, { method: 'POST', headers, cache: 'no-store',
        keepalive: path === 'cancel' || path === 'revoke', ...(controller ? { signal: controller.signal } : {}) });
      if (!response.ok) {
        const error = new Error(response.status === 404 ? 'expired' : 'unavailable');
        error.status = response.status; throw error;
      }
      return await response.json();
    } finally { clearTimeout(timeout); }
  };
  try {
    const stored = storage.get(devicePreference);
    if (stored) {
      const device = JSON.parse(stored);
      if (typeof device.id === 'string' && typeof device.secret === 'string' && device.id.length === 32 && device.secret.length === 32) deviceCredential = device;
    }
  } catch (_) {}
  function showPairingReady(name = t("web_browser_paired"), autoStart = true) {
    $('remembered-device').hidden = autoLaunch;
    $('device-name').textContent = name;
    $('qr-pairing').hidden = true; $('pair-instructions').hidden = true;
    $('code-entry').hidden = true; $('code').required = false; $('code').disabled = true;
    $('connect-form').hidden = autoLaunch && !userDisconnected;
    $('connect-label').textContent = t("web_start_display");
    $('connect').disabled = false;
    $('status').textContent = t("web_paired_ready_to_start"); $('message').textContent = '';
    // A remembered or freshly trusted browser connects without a launch click.
    if (autoStart && autoLaunch && pairingToken && !userDisconnected) launch();
  }
  function showPairingEntry() {
    // QR/code pairing remains available under `?manual=1`; the default path never shows it.
    const manual = !autoLaunch;
    $('remembered-device').hidden = true;
    $('qr-pairing').hidden = !manual; $('pair-instructions').hidden = !manual;
    $('code-entry').hidden = !manual; $('code').required = manual; $('code').disabled = !manual;
    $('connect-form').hidden = !manual && !userDisconnected;
    $('connect-label').textContent = t(userDisconnected ? "web_reconnect" :
      manual ? "web_pair_start_display" : "web_start_display");
    $('connect').disabled = false;
  }
  async function preparePairing(token, generation, autoStart = true) {
    pairingToken = token;
    let name = t("web_browser_paired");
    let message = t("web_paired_choose_the_options_above_then_tap_start_display");
    if (storageAvailable) {
      try {
        const device = await pairApi('remember', { token });
        if (generation !== authGeneration) return;
        deviceCredential = device;
        storage.set(devicePreference, JSON.stringify(device));
        name = device.name;
      } catch (_) {
        message = t("web_paired_for_this_session_but_the_device_could_not");
      }
    } else message = t("web_paired_for_this_session_this_browser_cannot_remember_the");
    if (generation !== authGeneration) return;
    showPairingReady(name, autoStart); $('device-status').textContent = message;
  }
  async function initializePairing(linkedCode = null) {
    const generation = ++authGeneration;
    clearTimeout(autoRetryTimer);
    stopQr(); pairingToken = null;
    showPairingEntry(); $('connect').disabled = true;
    if (userDisconnected) {
      $('status').textContent = t("web_disconnected");
      return;
    }
    if (deviceCredential) {
      $('status').textContent = t("web_restoring_pairing");
      try {
        const result = await pairApi('resume', { device: deviceCredential });
        if (generation !== authGeneration) return;
        pairingToken = result.token;
        showPairingReady(result.name);
        $('device-status').textContent = t("web_pairing_restored_automatically_choose_the_options_above_then_tap");
        return;
      } catch (error) {
        if (generation !== authGeneration) return;
        if (error.status === 401) {
          deviceCredential = null;
          storage.remove(devicePreference);
          $('message').textContent = t("web_remembered_device_expired_or_removed_pair_again");
        } else {
          showPairingReady(deviceCredential.name || t("web_remembered_browser"));
          $('status').textContent = t("web_waiting_to_restore_pairing");
          $('device-status').textContent = t("web_could_not_restore_pairing_yet_check_the_service_and");
          return;
        }
      }
    }
    if (linkedCode) {
      $('code').value = linkedCode;
      try {
        const result = await pairApi('code', { code: linkedCode });
        if (generation !== authGeneration) return;
        await preparePairing(result.token, generation); return;
      } catch (_) {
        if (generation !== authGeneration) return;
        $('message').textContent = t("web_the_pairing_code_in_this_link_has_expired_scan");
      }
    }
    if (autoLaunch) {
      // First visit: the service issues a token without a QR scan or a pairing code. The origin
      // check on the server and the token requirement on /stream still apply.
      $('status').textContent = t("web_connecting");
      try {
        const result = await pairApi('auto');
        if (generation !== authGeneration) return;
        await preparePairing(result.token, generation);
        return;
      } catch (_) {
        if (generation !== authGeneration) return;
        $('status').textContent = t("web_waiting_to_pair");
        $('message').textContent = t("web_could_not_pair");
        // The service may still be starting; retry without leaving a dead launch page behind.
        autoRetryTimer = setTimeout(() => {
          if (generation === authGeneration) initializePairing();
        }, 2000);
        return;
      }
    }
    if (generation !== authGeneration) return;
    showPairingEntry(); $('status').textContent = t("web_waiting_to_pair"); startQr();
  }
  function stopQr(cancel = true) {
    qrGeneration++; clearTimeout(qrTimer);
    if (cancel && qrRequest) pairApi('cancel', qrRequest).catch(() => {});
    qrRequest = null;
    $('pair-qr').onload = null; $('pair-qr').onerror = null;
    $('pair-qr').hidden = true; $('pair-qr').removeAttribute('src');
  }
  async function startQr() {
    stopQr(); const generation = qrGeneration;
    $('qr-status').textContent = t("web_generating_qr_code");
    $('refresh-qr').disabled = true;
    try {
      const request = await pairApi('request');
      if (generation !== qrGeneration) { pairApi('cancel', request).catch(() => {}); return; }
      qrRequest = request;
      $('pair-qr').onload = () => {
        if (generation === qrGeneration) $('pair-qr').hidden = false;
      };
      $('pair-qr').onerror = () => {
        if (generation !== qrGeneration) return;
        $('pair-qr').hidden = true;
        $('qr-status').textContent = t("web_could_not_load_qr_code_refresh_and_try_again");
      };
      $('pair-qr').src = `/pair/qr?id=${encodeURIComponent(request.id)}&secret=${encodeURIComponent(request.secret)}`;
      $('qr-status').textContent = t("web_scan_with_the_server_app_and_allow_the_connection");
      const expiresAt = Date.now() + request.expiresIn * 1000;
      const poll = async () => {
        try {
          if (generation !== qrGeneration) return;
          if (Date.now() >= expiresAt) throw new Error('expired');
          const result = await pairApi('status', request);
          if (generation !== qrGeneration) return;
          if (result.state === 'approved') {
            stopQr(false); $('connect').disabled = true;
            await preparePairing(result.token, ++authGeneration); return;
          }
          qrTimer = setTimeout(poll, 1000);
        } catch (error) {
          if (generation !== qrGeneration) return;
          stopQr();
          $('qr-status').textContent = error.message === 'expired' ? t("web_qr_code_expired_refresh_and_scan_again") : t("web_could_not_check_pairing_status_refresh_the_qr_code");
        }
      };
      qrTimer = setTimeout(poll, 1000);
    } catch (_) {
      if (generation === qrGeneration) $('qr-status').textContent = t("web_qr_code_unavailable_refresh_and_try_again_or_enter");
    } finally {
      if (generation === qrGeneration) $('refresh-qr').disabled = false;
    }
  }
  $('refresh-qr').addEventListener('click', startQr);
  const pointers = new Map();
  let maxTouchContacts = 2;
  let pointerInput = false, keyboardInput = false, backButton = false;
  const send = (data, kind) => {
    if ((data.type === 'touch' || data.type === 'input') && presentation.current.videoEpoch !== null) {
      const { sessionId, videoEpoch } = presentation.current;
      data = { ...data, sessionId, videoEpoch };
    }
    return outbox ? outbox.send(data, kind) : false;
  };
  const desktop = createDesktopInput({ send, pointerEnabled: () => pointerInput,
    keyboardEnabled: () => keyboardInput, interactive: () => live,
    point: (event, surface, clamp) => mapPoint(event.clientX, event.clientY, surface.getBoundingClientRect(), width, height, clamp) });
  $('desktop-back').addEventListener('click', () => {
    if (!backButton || !live) return;
    release();
    send({ type: 'input', kind: 'key', key: 'BrowserBack', down: true }, 'boundary');
    send({ type: 'input', kind: 'key', key: 'BrowserBack', down: false }, 'boundary');
  });
  let desktopRevision = presentation.current.revision;
  const browserMedia = createBrowserMediaSession({ send });
  const browserAppearance = createAppearanceReporter({ send, onChange: dark => { browserDarkMode = dark; } });
  const browserAudio = createBrowserAudio({
    send,
    useElementSink: mediaSessionMode === '2',
    idleCloseMillis: audioIdleMillis,
    sendBinary: packet => {
      if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 8192) return false;
      try { socket.send(packet); return true; } catch (_) { return false; }
    },
    onState: ({ error }) => {
      $('audio-message').textContent = error;
      $('audio-message').hidden = !error || !paired;
    },
  });
  document.addEventListener('pointerdown', () => browserAudio.unlock(), { capture: true });
  // Metadata is published even without `?ms`: the head unit media card is a label, not a behaviour
  // change. Only the key handlers are gated, because forwarding a key changes what a button does.
  const mediaProbe = createMediaSessionProbe({
    send, onAction: () => presentation.refresh(), handlers: Boolean(mediaSessionMode),
  });
  // Some embedded browsers surface hardware media keys as key events instead of media session
  // actions, so echo the last key code too; without it "no action" is ambiguous.
  let lastKeyCode = '';
  if (mediaSessionMode) document.addEventListener('keydown', event => {
    lastKeyCode = event.code || event.key || 'unknown';
    presentation.refresh();
  }, { capture: true });
  $('secure-setup').addEventListener('toggle', async () => {
    if (!$('secure-setup').open) return;
    $('https-entry').removeAttribute('href');
    try {
      const response = await fetch('/tls.json', { cache: 'no-store' });
      const info = await response.json();
      if (info.available && Number.isInteger(info.port) && info.port >= 1 && info.port <= 65535) {
        const endpoint = new URL(location.href);
        endpoint.protocol = 'https:'; endpoint.port = String(info.port); endpoint.pathname = '/';
        endpoint.search = ''; endpoint.hash = '';
        $('https-entry').href = endpoint.href;
      }
      $('tls-fingerprint').textContent = info.enabled === false ? t("web_https_is_disabled_enable_it_in_the_app_s")
        : info.fingerprint || t("web_preparing_https_close_and_reopen_this_section_shortly");
      $('tls-error').textContent = info.error || '';
    } catch (_) { $('tls-error').textContent = t("web_certificate_information_is_temporarily_unavailable"); }
  });
  function scheduleViewportReport() {
    clearTimeout(viewportReportTimer);
    viewportReportTimer = setTimeout(() => {
      syncDisplayZoom();
      if (!socket || socket.readyState !== WebSocket.OPEN || display.hidden) return;
      const rect = display.getBoundingClientRect();
      const zoom = ignoreZoomOption.checked ? window.visualViewport?.scale || 1 : 1;
      const scale = (window.devicePixelRatio || 1) * zoom;
      const size = browserViewportSize(rect.width * scale, rect.height * scale);
      if (!size) return;
      const { width, height } = size;
      const signature = `${width}x${height}`;
      if (signature === lastViewportSignature) return;
      lastViewportSignature = signature;
      send({ type: 'viewport', width, height });
    }, 180);
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(scheduleViewportReport).observe(display);
  window.addEventListener('resize', scheduleViewportReport);
  for (const event of ['resize', 'scroll']) window.visualViewport?.addEventListener(event, () => {
    if (!ignoreZoomOption.checked) return;
    syncDisplayZoom(); scheduleViewportReport();
  });
  function cancelMove() { moveGeneration++; movePending = false; }
  function contacts() { return [...pointers.values()].map(p => ({ id: p.id, x: p.x, y: p.y, down: true })); }
  function release() {
    cancelMove(); pointers.clear(); desktop.release(false);
    send(presentation.current.videoEpoch === null
      ? { type: 'touch', contacts: [] }
      : { type: 'input', kind: 'release' });
  }
  function renderPresentation(value) {
    if (value.revision !== desktopRevision) {
      desktop.release(false); desktopRevision = value.revision;
    }
    live = value.interactive;
    for (const surface of [...screens, video, canvas, heldFrame].filter(Boolean)) surface.classList.toggle('stale', !value.visible);
    touchSurface.classList.toggle('stale', !live);
    $('waiting').hidden = value.visible;
    $('desktop-back').disabled = !live;
    if (!live && (pointers.size || desktop.active)) release();
    const rtcVisible = rtc && value.visible && value.frame?.transport === 'rtc';
    const codecVisible = codec && value.visible && value.frame?.transport === 'codec';
    rendererStats.activeMode = codecVisible ? 'codec' : rtcVisible ? launchMode : value.visible ? 'jpeg' : 'waiting';
    const rendererLabel = launchMode === 'native' ? 'Video' : t(launchMode === 'video-canvas' ? 'web_video_renderer_compat' : 'web_video_renderer_direct');
    const fallbackLabel = rendererStats.fallbackReason ? t(rendererStats.fallbackReason === 'processor-unsupported' ? 'web_video_renderer_unavailable' : 'web_video_renderer_failed') : '';
    const transport = codecVisible
      ? `${codec.codec === 'H265' ? 'HEVC' : 'H.264'} / WS${codecFps === null ? '' : ` · ${codecFps} fps`}`
      : rtcVisible ? `${rtc.codec === 'H265' ? 'HEVC' : 'H.264'} / WebRTC / ${rendererLabel}${rtcFps === null ? '' : ` · ${rtcFps} fps`}`
      : `${value.frame?.mime === 'image/webp' ? 'WebP' : 'JPEG'}${fallbackLabel}`;
    // ?diag=1 keeps the status line short: the fixed-height top bar cannot hold a negotiation
    // snapshot without overflowing over the picture. The detail goes into its own box instead.
    const rtcReason = rtc?.lastReason || serverRtcHint;
    const diagnostic = diagnosticStatus ? ` · WebRTC: ${rtcReason || (rtc?.active ? 'ok' : 'idle')}` : '';
    const image = performanceStats.image;
    // Only the path that is painting the picture owns this line. A live video transport leaves the
    // still-image encoder idle, so reporting its 0 fps beside a smooth picture reads as a stall -
    // and on a head unit this box is the only instrument the driver can look at.
    const sourceFps = performanceStats.source?.fps?.input;
    const sourceSuffix = typeof sourceFps === 'number' ? ` · src ${Math.round(sourceFps)} fps` : '';
    const videoDetail = codecVisible
      ? `ws dec ${codecFps ?? 0} fps${sourceSuffix}`
      : rtcVisible ? `rtc dec ${rtcFps ?? 0} fps${sourceSuffix}` : '';
    // Still-image throughput is encode-bound when enc stays below tx; ACK latency covers send, decode and return.
    const imageDetail = !videoDetail && image?.format
      ? `img enc ${image.encodedFps ?? 0} fps · tx ${image.sentFps ?? 0} fps · ack ${Math.round(image.lastAckMs || 0)} ms` : '';
    // WebCodecs is SecureContext-gated: a plain-http head unit page has no VideoDecoder at all,
    // so the codec stream can never start there and the picture stays on JPEG. Report the raw
    // capability and the server's refusal reason side by side instead of guessing. `hevc` answers a
    // separate question - whether this browser could decode the phone's HEVC at all - so `?` until
    // the probe settles, then 1 with the sample entry it accepted, or 0.
    const hevcState = hevcCodec === undefined ? '?' : hevcCodec ? `1:${hevcCodec.slice(0, 4)}` : 0;
    const capabilityDetail = `cap secure=${window.isSecureContext ? 1 : 0} vd=${typeof VideoDecoder === 'function' ? 1 : 0}` +
      ` hevc=${hevcState}` +
      (serverVcsHint ? ` vcs=${serverVcsHint}` : '') +
      ` last=${codec?.lastReason || '-'}` +
      ` startId=${globalThis.__vcsStartId ?? '-'} skips=${globalThis.__vcsFeedSkips || 0}` +
      ` closes=${globalThis.__vcsCloses ?? '-'} rejects=${globalThis.__vcsRejects || 0}` +
      ` rec=${globalThis.__frameCommitRecovery || 0}` +
      ` cs=${(globalThis.__vcsTrail || [globalThis.__vcsStage || '-']).join(' > ')}`;
    const detail = [serverRtcDiag, videoDetail || imageDetail, capabilityDetail, mediaSessionMode
      // The probe line is the evidence for whether the head unit delivers wheel keys at all.
      ? `ms=${mediaSessionMode} api=${mediaProbe?.available ? 1 : 0}` +
        ` key=${lastKeyCode || 'none'}` +
        (mediaProbe?.last ? ` last=${mediaProbe.last.action} ${Math.max(0, Math.round((Date.now() - mediaProbe.last.at) / 1000))}s ago` : ' last=none') +
        (serverMedia?.echo ? ` ${serverMedia.echo}` : '')
      : ''].filter(Boolean).join('\n');
    const hint = serverRtcHint === 'hevc-unsupported' ? ` · ${t('web_disable_hevc_to_use_webrtc_on_this_head_unit')}` : '';
    $('status').textContent = (value.state === 'recovering' ? t('web_video_recovering', transport) :
      value.visible ? value.interactive ? t('web_transport_touch_connected', transport, rtc?.recovering ? t('web_waiting_for_recovery') : '') :
        t('web_video_input_unavailable', transport) : t('web_connected_waiting_for_iphone_video')) + diagnostic + hint;
    // `?diag=1` is the only way to tell a head unit that reports its own light/dark preference
    // from one that always answers light: flip the car's appearance and watch this word.
    const schemeLine = `scheme=${browserDarkMode === null ? 'unknown' : browserDarkMode ? 'dark' : 'light'}`;
    const panel = $('diag-panel');
    panel.hidden = !diagnosticStatus;
    if (diagnosticStatus) panel.textContent = [detail, schemeLine].filter(Boolean).join('\n');
    // The status line now lives inside the drawer, which stays closed while driving. The picture
    // overlay is therefore the only visible surface for a "picture is up but touch is not" warning.
    const showWarning = value.visible && !value.interactive;
    $('media-message').hidden = !showWarning;
    $('media-message').textContent = showWarning ? $('status').textContent : '';
  }
  function clearHeldFrame() {
    heldFrame.hidden = true; heldFrame.width = heldFrame.height = 0;
  }
  function holdRtcFrame() {
    const transport = presentation.current.frame?.transport;
    if ((transport !== 'rtc' && transport !== 'codec') || !heldFrame.hidden) return;
    try {
      const source = canvas.hidden ? video : canvas;
      const frame = presentation.current.frame;
      heldFrame.width = frame.width; heldFrame.height = frame.height;
      heldFrame.getContext('2d', { alpha: false }).drawImage(source, 0, 0, frame.width, frame.height);
      heldFrame.hidden = false;
    } catch (_) { clearHeldFrame(); presentation.forget(); }
  }
  function cleanupImage() {
    jpeg.clear(); clearHeldFrame();
  }
  function cleanupRtc() {
    if (rtc) rtc.close(); rtc = null; rtcRequested = false; rtcFps = null;
    if (codec) codec.close(); codec = null; codecRequested = false; codecFps = null;
    video = null;
    performanceStats.source = performanceStats.transport = performanceStats.receiver = performanceStats.image = null;
    rendererStats.activeMode = 'waiting';
  }
  // A page load has no user gesture. Browsers that gate fullscreen therefore keep the wish
  // pending until the very first tap; one attempt per visit, so a manual toggle is never undone.
  document.addEventListener('pointerdown', event => {
    if (!autoFullscreenPending) return;
    autoFullscreenPending = false;
    // A tap on either fullscreen control is an explicit choice: let that control's own handler
    // own the state, otherwise an automatic request and a toggle would race and cancel out.
    if (event.target?.closest?.('#fullscreen') || event.target?.closest?.('#fullscreen-on-start')) return;
    if (document.fullscreenElement || !fullscreenOption.checked) return;
    requestAutoFullscreen(false);
  }, { capture: true });
  // Every teardown path - an explicit disconnect, a socket drop, a page hide - releases the same
  // resources in the same order; keeping it in one function is what keeps the paths in step.
  function teardownSession() {
    cancelFrameCommitWatch();
    presentation.close(); cleanupRtc(); cleanupImage();
    browserMedia.close(); browserAudio.close();
    browserAppearance.close(); browserLocation.close();
    renderPhoneStatus(null);
    $('audio-message').hidden = true;
  }
  function disconnect(refreshQr = true) {
    stopQr();
    authGeneration++;
    stopped = true; paired = false; release();
    if (outbox) { outbox.close(); outbox = null; }
    clearTimeout(retry); clearInterval(heartbeat);
    if (socket) { const old = socket; socket = null; old.close(); }
    teardownSession();
    $('pairing').hidden = false; $('display').hidden = true;
    syncDisplayZoom();
    $('disconnect').hidden = true; $('connect').disabled = false;
    $('status').textContent = t("web_disconnected");
    if (refreshQr) initializePairing();
  }
  // The badge only changes when the phone's own state changes; rewriting the SVG on every 400 ms
  // ping would keep the head unit compositing a picture that never moved.
  const statusBadge = $('phone-status');
  const badgePositionPreference = 'wheelplay.badgePosition';
  let phoneGaugeSvg = null;

  // The disc is also the settings handle, so it stays on screen before the first phone reading.
  // Without readings it shows a gear instead of the battery/volume gauge.
  const settingsBadgeMarkup = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#eef2ef" d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.61l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7 7 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.87a.5.5 0 0 0 .12.61l2.03 1.58c-.04.3-.06.62-.06.94s.02.64.06.94l-2.03 1.58a.5.5 0 0 0-.12.61l1.92 3.32c.12.22.39.3.6.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.59-.24 1.12-.56 1.62-.94l2.39.96c.22.08.48 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.61l-2.03-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/></svg>';
  const settingsDrawer = $('settings-drawer');
  const settingsScrim = $('settings-scrim');
  let settingsOpen = false, lastSettingsToggleAt = 0;
  function setSettingsOpen(open) {
    settingsOpen = open;
    settingsDrawer.classList.toggle('open', open);
    settingsScrim.classList.toggle('open', open);
    settingsDrawer.setAttribute('aria-hidden', String(!open));
  }
  function toggleSettings() { setSettingsOpen(!settingsOpen); }
  $('settings-toggle').addEventListener('click', () => setSettingsOpen(true));
  $('settings-close').addEventListener('click', () => setSettingsOpen(false));
  settingsScrim.addEventListener('click', () => setSettingsOpen(false));
  // Debug-mode entry at the bottom of the drawer: toggles ?diag=1 on the current address and
  // keeps every other query parameter intact; credentials live in localStorage and survive it.
  const diagToggle = $('diag-toggle');
  diagToggle.textContent = t(diagnosticStatus ? 'web_exit_debug_mode' : 'web_enter_debug_mode');
  diagToggle.addEventListener('click', () => {
    const url = new URL(location.href);
    if (diagnosticStatus) url.searchParams.delete('diag'); else url.searchParams.set('diag', '1');
    window.location.href = url.href;
  });
  document.addEventListener?.('keydown', event => {
    if (event.key === 'Escape' && settingsOpen) setSettingsOpen(false);
  });

  // `#display` can be inverse-scaled against browser zoom, so a screen-pixel drag delta has to be
  // divided back into the element's own CSS pixels before it is stored or applied.
  function badgeScale() {
    const width = display.getBoundingClientRect().width;
    return display.offsetWidth && width ? width / display.offsetWidth : 1;
  }

  function moveBadge(left, top) {
    const limitX = Math.max(4, display.clientWidth - statusBadge.offsetWidth - 4);
    const limitY = Math.max(4, display.clientHeight - statusBadge.offsetHeight - 4);
    statusBadge.style.left = `${Math.min(Math.max(4, left), limitX)}px`;
    statusBadge.style.top = `${Math.min(Math.max(4, top), limitY)}px`;
    statusBadge.style.right = 'auto';
  }

  function storedBadgePosition() {
    try {
      const saved = JSON.parse(storage.get(badgePositionPreference) || 'null');
      return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
    } catch (_) { return null; }
  }

  // Re-applied after the first frame and on every resize: a saved offset is only meaningful while
  // the display box keeps its size, and the gauge must never end up half outside it. Without a saved
  // offset the disc stays on the CSS home slot in style.css (the left dock, under the status icons),
  // which is percentage-based and therefore follows a resized picture on its own.
  function restoreBadgePosition() {
    const saved = storedBadgePosition();
    if (saved) moveBadge(saved.x, saved.y);
  }

  // Dragging is the only gesture; a double tap drops the saved offset and lets that CSS home slot
  // take over again - no second copy of the default coordinates to keep in sync.
  let badgeDrag = null;
  statusBadge.addEventListener('pointerdown', event => {
    if (event.button) return;
    badgeDrag = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      left: statusBadge.offsetLeft, top: statusBadge.offsetTop, moved: false,
    };
    statusBadge.setPointerCapture?.(event.pointerId);
    statusBadge.classList.add('dragging');
    event.preventDefault();
    // The gauge floats above the picture; a drag must never reach CarPlay as a touch.
    event.stopPropagation();
  });
  statusBadge.addEventListener('pointermove', event => {
    if (!badgeDrag || event.pointerId !== badgeDrag.id) return;
    const scale = badgeScale();
    const dx = (event.clientX - badgeDrag.x) / scale, dy = (event.clientY - badgeDrag.y) / scale;
    // A tap that jitters a few pixels must not slide the gauge.
    if (!badgeDrag.moved && Math.hypot(dx, dy) < 8) return;
    badgeDrag.moved = true;
    moveBadge(badgeDrag.left + dx, badgeDrag.top + dy);
  });
  function endBadgeDrag(event) {
    if (!badgeDrag || event.pointerId !== badgeDrag.id) return;
    statusBadge.releasePointerCapture?.(event.pointerId);
    statusBadge.classList.remove('dragging');
    if (badgeDrag.moved) {
      storage.set(badgePositionPreference, JSON.stringify({ x: statusBadge.offsetLeft, y: statusBadge.offsetTop }));
    } else {
      // A tap opens the settings drawer; a double tap only resets the disc position.
      const now = Date.now();
      if (now - lastSettingsToggleAt >= 300) {
        lastSettingsToggleAt = now;
        toggleSettings();
      }
    }
    badgeDrag = null;
  }
  statusBadge.addEventListener('pointerup', endBadgeDrag);
  statusBadge.addEventListener('pointercancel', endBadgeDrag);
  statusBadge.addEventListener('dblclick', () => {
    storage.remove(badgePositionPreference);
    statusBadge.style.left = statusBadge.style.top = statusBadge.style.right = '';
  });
  window.addEventListener('resize', restoreBadgePosition);
  restoreBadgePosition();

  function renderPhoneStatus(phone) {
    const values = phoneGaugeValues(phone);
    if (values === null) {
      if (phoneGaugeSvg !== null || statusBadge.innerHTML !== settingsBadgeMarkup) {
        statusBadge.innerHTML = settingsBadgeMarkup;
        phoneGaugeSvg = null;
      }
      statusBadge.hidden = false;
      return;
    }
    const first = phoneGaugeSvg === null;
    // The skeleton stays in the document, so a new reading is a style change CSS can interpolate -
    // sweeping rings, cross-fading colours, lighting one signal slot at a time. Only the first frame,
    // or a gauge whose nodes went missing, goes through the string builder.
    if (first || !applyPhoneGauge(statusBadge.firstElementChild, values)) {
      statusBadge.innerHTML = phoneStatusMarkup(values);
      phoneGaugeSvg = statusBadge.firstElementChild;
    }
    statusBadge.hidden = false;
    // The first measurable layout box is where a stored position becomes meaningful.
    if (first) restoreBadgePosition();
  }
  function connect() {
    clearTimeout(retry);
    $('connect').disabled = true;
    $('status').textContent = paired ? t("web_reconnecting") : t("web_connecting");
    const auth = pairingToken ? `token=${encodeURIComponent(pairingToken)}` : `code=${encodeURIComponent($('code').value)}`;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream?${auth}&media=2&images=3&nowPlaying=1`);
    ws.binaryType = 'arraybuffer';
    const mode = launchMode;
    socket = ws;
    const connectTimer = setTimeout(() => ws.close(), 8000);
    ws.onopen = () => {
      clearTimeout(connectTimer);
      if (socket !== ws) return;
      if (outbox) outbox.close();
      outbox = createControlOutbox(ws, { onFailure: () => {
        if (socket !== ws) return;
        cancelMove(); pointers.clear(); presentation.close(); ws.close();
      } });
      paired = true; attempts = 0; lastStatus = Date.now();
      browserMedia.open(); browserAudio.attach(); browserAppearance.open();
      browserLocation.attach();
      cleanupRtc();
      presentation.open();
      webpSupport.then(supported => {
        if (supported && socket === ws && ws.readyState === WebSocket.OPEN) send({ type: 'image-format', format: 'webp' });
      });
      Object.assign(rendererStats, { selectedMode: mode, activeMode: 'waiting', renderedFps: null, renderedFrames: null,
        fallbackReason: mode === 'track-canvas' && !processorSupported() ? 'processor-unsupported' : null });
      rtc = createRtcReceiver(callbacks => {
        if (mode === 'track-canvas') {
          if (!processorSupported()) throw new Error('processor-unsupported');
          return createTrackCanvasRenderer(canvas, callbacks);
        }
        return createVideoRenderer(mode, canvas, { ...callbacks, createVideo: createLegacyVideo, keepVisible: keepVideoVisible });
      }, { send, experiment: rtcExperiment,
        onReset: () => { holdRtcFrame(); presentation.invalidate('rtc'); },
        onResize: size => { if (socket === ws) showRtcSize(size); },
        onReady: size => {
          if (socket !== ws) return;
          rendererStats.activeMode = mode; rendererStats.fallbackReason = null;
          rendererStats.renderedFrames = mode === 'native' ? null : 1;
          showRtcSize(size);
        },
        onStop: reason => {
          if (socket !== ws) return;
          video = null; rtcFps = null; rendererStats.fallbackReason = reason; rendererStats.renderedFps = null;
          presentation.invalidate('rtc');
        },
        onStats: (fps, metrics) => {
          const outputFps = mode === 'track-canvas' ? metrics.renderedFps : fps;
          rtcFps = outputFps === null ? null : Math.round(outputFps); performanceStats.receiver = metrics;
          rendererStats.renderedFps = metrics.renderedFps; rendererStats.renderedFrames = metrics.renderedFrames;
          presentation.refresh();
        },
      });
      codec = createCodecReceiver(frame => {
        const size = { width: frame.displayWidth, height: frame.displayHeight };
        try {
          const resized = canvas.width !== size.width || canvas.height !== size.height;
          if (resized) { canvas.width = size.width; canvas.height = size.height; }
          canvas.getContext('2d', { alpha: false }).drawImage(frame, 0, 0, size.width, size.height);
          canvas.hidden = false;
        } finally { frame.close(); }
        return size;
      }, { send,
        onReset: () => { holdRtcFrame(); presentation.invalidate('codec'); },
        onReady: size => {
          if (socket !== ws) return;
          rendererStats.activeMode = 'codec'; rendererStats.fallbackReason = null;
          rendererStats.renderedFrames = 1;
          showCodecSize(size);
        },
        onStop: reason => {
          if (socket !== ws) return;
          codecFps = null; rendererStats.fallbackReason = reason;
          presentation.invalidate('codec');
        },
        onStats: (fps, metrics) => {
          codecFps = fps === null ? null : Math.round(fps); performanceStats.receiver = metrics;
          rendererStats.renderedFps = fps; rendererStats.renderedFrames = metrics.decoded;
          presentation.refresh();
        },
      });
      $('message').textContent = '';
      $('phone-connect').disabled = false;
      $('phone-connect-message').textContent = t("web_keep_wheelplay_in_the_foreground_on_android_tap_connect");
      $('pairing').hidden = true; $('display').hidden = false; $('disconnect').hidden = false;
      lastViewportSignature = '';
      scheduleViewportReport();
      $('status').textContent = t("web_connected_waiting_for_video");
      send({ type: 'ping' });
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        presentation.refresh();
        if (Date.now() - lastStatus > 6000) { ws.close(); return; }
        send({ type: 'ping' });
        if (pointers.size) send({ type: 'touch', contacts: contacts() }, 'move');
        desktop.heartbeat();
      }, 400);
    };
    ws.onmessage = event => {
      if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (typeof event.data === 'string') {
        const data = JSON.parse(event.data);
        if (browserMedia.receive(data)) return;
        if (browserAudio.control(data)) return;
        if (data.type === 'rtc-offer' || data.type === 'rtc-stop') {
          if (data.type === 'rtc-stop') rtcRequested = false;
          else if (!acceptMediaStart(data, media => { rtcMedia = media; })) return;
          rtc.receive(data); return;
        }
      if (data.type === 'vcs-start' || data.type === 'vcs-stop') {
        if (data.type === 'vcs-stop') {
          codecRequested = false;
        } else if (!acceptMediaStart(data, media => { codecMedia = media; })) {
          // Head units have no console: leave a breadcrumb the ?diag=1 panel can show. A rejected
          // start is the one failure that produces no other trace - no decoder, no fallback reply.
          const cur = presentation.current;
          globalThis.__vcsRejects = (globalThis.__vcsRejects || 0) + 1;
          globalThis.__vcsStage = `handler-reject epoch=${data.videoEpoch}/${data.sessionId} cur=${cur.videoEpoch}/${cur.sessionId}`;
          return;
        }
        codec.receive(data); return;
      }
        if (data.type === 'phone-connect-result') {
          $('phone-connect').disabled = false;
          $('phone-connect-message').textContent = data.message;
          return;
        }
        if (data.type === 'busy') {
          // Another head unit already owns the stream. Re-entering the auto-launch cycle here
          // would bounce between connecting and busy forever - the flicker a second browser
          // shows while the first one stays connected, with no backoff because disconnect()
          // resets the retry counters. Hold the landing page with the reason instead; the
          // retry button is the way back in once the other head unit leaves.
          const message = data.message;
          userDisconnected = true;
          disconnect();
          $('status').textContent = message;
          $('message').textContent = message;
          return;
        }
        if (data.type === 'status') {
          serverRtcHint = data.rtcHint || '';
          serverVcsHint = data.vcsHint || '';
          serverRtcDiag = data.rtcDiag || '';
          if (data.media) { serverMedia = data.media; mediaProbe?.apply(data.media); }
          // The phone's own battery and radio stay current even while no video is flowing, so the
          // badge is refreshed before any early return below.
          renderPhoneStatus(data.phone);
          performanceStats.source = data.performance?.source ?? null;
          performanceStats.transport = data.performance?.transport ?? null;
          performanceStats.image = data.performance?.image ?? null;
          lastStatus = Date.now();
          const nextTouchLimit = Number.isInteger(data.maxTouchContacts) ? Math.max(0, Math.min(10, data.maxTouchContacts)) : 2;
          if (nextTouchLimit !== maxTouchContacts) { release(); maxTouchContacts = nextTouchLimit; }
          const previousRevision = presentation.current.revision;
          if (!presentation.status(data)) return;
          if (previousRevision !== presentation.current.revision) desktop.release(false);
          if (pointerInput !== (data.pointerInput === true) || keyboardInput !== (data.keyboardInput === true)) desktop.release();
          pointerInput = data.pointerInput === true; keyboardInput = data.keyboardInput === true;
          backButton = data.backButton === true;
          $('desktop-back').hidden = !backButton;
          if (previousRevision !== presentation.current.revision) {
            jpeg.cancelPending();
            if (rtcMedia.revision !== presentation.current.revision) { rtc.close(); rtcRequested = false; }
            if (codecMedia.revision !== presentation.current.revision) { codec.close(); codecRequested = false; }
          }
          $('stage').textContent = data.stage || t("web_waiting_for_iphone_video");
          rtc.progress(data.rtcFrames || 0);
          codec.progress(data.vcsFrames || 0);
          if (data.vcsAvailable && !codecRequested && !codec.active && typeof VideoDecoder !== 'undefined') {
            codecRequested = true;
            // Report what this browser can decode with the request: it is the only side that knows,
            // and the service has to decide before it sends the first access unit. The probe has
            // usually settled already; waiting costs nothing when it has not.
            hevcProbe.then(() => { if (codecRequested) send({ type: 'vcs-start', hevc: hevcCodec || '' }); });
          }
          if (!data.vcsAvailable) codecRequested = false;
          if (data.rtcAvailable && !rtcRequested && !rtc.active && typeof RTCPeerConnection !== 'undefined' &&
              (mode !== 'track-canvas' || processorSupported())) {
            rtcRequested = true; send({ type: 'rtc-start' });
          }
          // The server resets availability when the iPhone starts a new video configuration.
          if (!data.rtcAvailable) rtcRequested = false;
          presentation.refresh();
        }
        if (data.type === 'input-unavailable') presentation.inputUnavailable();
        return;
      }
      if (browserAudio.receive(event.data)) return;
      // The codec stream's access units share the image socket but carry their own magic.
      if (event.data instanceof ArrayBuffer && event.data.byteLength >= 24 &&
          new DataView(event.data).getUint32(0, true) === CODEC_STREAM_MAGIC) {
        codec.feed(event.data); return;
      }
      let packet;
      try { packet = decodeVideoPacket(event.data); } catch (_) { ws.close(); return; }
      const meta = packet || {};
      const acknowledge = () => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        send(packet?.protocol === 3 ? { type: 'ack', sessionId: packet.sessionId,
          videoEpoch: packet.videoEpoch, sequence: packet.sequence } : { type: 'ack' });
      };
      const previousRevision = presentation.current.revision;
      if (!presentation.accepts(meta)) { acknowledge(); return; }
      if (previousRevision !== presentation.current.revision) { rtc.close(); rtcRequested = false; }
      if (rtc?.active) { acknowledge(); return; }
      meta.revision = presentation.current.revision;
      const payload = packet ? packet.jpeg : event.data;
      jpeg.load(payload instanceof ArrayBuffer ? new Blob([payload], { type: packet?.mime || 'image/jpeg' }) : payload, meta,
        () => socket === ws && ws.readyState === WebSocket.OPEN && !rtc?.active && presentation.current.revision === meta.revision,
        acknowledge);
    };
    ws.onclose = () => {
      clearTimeout(connectTimer);
      if (socket !== ws) return;
      if (outbox) { outbox.close(); outbox = null; }
      cancelMove();
      socket = null; pointers.clear(); desktop.release(false); pointerInput = false; keyboardInput = false; backButton = false; $('desktop-back').hidden = true;
      clearInterval(heartbeat);
      teardownSession();
      if (stopped) return;
      if (!paired || ++attempts > 8) {
        disconnect(); $('status').textContent = t("web_could_not_connect");
        $('message').textContent = t("web_check_that_the_server_is_running_and_the_pairing");
        return;
      }
      $('status').textContent = t("web_connection_interrupted_retrying");
      $('stage').textContent = t("web_check_that_the_server_and_head_unit_are_still");
      const generation = authGeneration;
      retry = setTimeout(async () => {
        if (deviceCredential) {
          try {
            const result = await pairApi('resume', { device: deviceCredential });
            if (stopped || generation !== authGeneration) return;
            pairingToken = result.token;
          } catch (error) {
            if (stopped || generation !== authGeneration) return;
            if (error.status === 401) { disconnect(); return; }
          }
        }
        if (!stopped && generation === authGeneration) connect();
      }, Math.min(8000, 500 * 2 ** attempts));
    };
    ws.onerror = () => {}; // onclose owns retry and visible error state.
  }
  /** Start display; the default pairing path calls this without a click. */
  function launch() {
    launchMode = selectedMode;
    const generation = ++authGeneration;
    stopQr(); $('connect').disabled = true; $('message').textContent = '';
    const start = () => { if (generation === authGeneration) { stopped = false; attempts = 0; connect(); } };
    if (pairingToken && !deviceCredential) { start(); return; }
    (async () => {
      try {
        if (deviceCredential) {
          const result = await pairApi('resume', { device: deviceCredential });
          if (generation !== authGeneration) return;
          pairingToken = result.token;
        } else {
          const result = await pairApi('code', { code: $('code').value });
          if (generation !== authGeneration) return;
          await preparePairing(result.token, generation, false);
        }
        start();
      } catch (error) {
        if (generation !== authGeneration) return;
        $('connect').disabled = false;
        if (error.status === 401 && deviceCredential) {
          pairingToken = null; deviceCredential = null;
          storage.remove(devicePreference);
          if (autoLaunch) {
            autoRetryTimer = setTimeout(() => {
              if (generation === authGeneration) initializePairing();
            }, 1000);
            return;
          }
          showPairingEntry(); startQr();
        }
        $('status').textContent = t("web_could_not_pair");
        $('message').textContent = t("web_check_the_service_and_network_or_scan_again_enter");
        if (autoLaunch && !userDisconnected) {
          autoRetryTimer = setTimeout(() => {
            if (generation === authGeneration) initializePairing();
          }, 2000);
        }
      }
    })();
  }
  $('connect-form').addEventListener('submit', event => {
    event.preventDefault();
    if (userDisconnected) { userDisconnected = false; initializePairing(); return; }
    launch();
  });
  $('phone-connect').addEventListener('click', () => {
    if (!paired || !send({ type: 'phone-connect' })) {
      $('phone-connect-message').textContent = t("web_browser_connection_interrupted_pair_again_and_retry");
      return;
    }
    $('phone-connect').disabled = true;
    $('phone-connect-message').textContent = t("web_requesting_iphone_connection");
  });
  $('disconnect').addEventListener('click', () => {
    userDisconnected = true;
    setSettingsOpen(false);
    disconnect();
  });
  // A one-shot toggle for this visit only: it neither changes nor is changed by the auto option.
  function syncFullscreenButton() {
    $('fullscreen').textContent = document.fullscreenElement ? t("web_exit_full_screen") : t("web_full_screen");
  }
  $('fullscreen').addEventListener('click', async () => {
    // A manual toggle owns this visit's fullscreen state - cancel any pending automatic request,
    // otherwise a later tap could drag the user back into fullscreen after they chose to leave.
    autoFullscreenPending = false;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else $('status').textContent = t("web_this_browser_does_not_support_full_screen");
    } catch (_) { $('status').textContent = t("web_use_the_browser_menu_to_toggle_full_screen"); }
  });
  document.addEventListener('fullscreenchange', () => {
    syncFullscreenButton();
    scheduleViewportReport();
  });
  syncFullscreenButton();
  // A separate layer prevents Android Chrome's native video gestures cancelling drags.
  function bindSurface(surface) {
    desktop.bind(surface);
    surface.addEventListener('contextmenu', event => event.preventDefault());
    surface.addEventListener('pointerdown', event => {
      if (pointerInput && event.pointerType === 'mouse') return;
      if (!live || pointers.size >= maxTouchContacts || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const point = mapPoint(event.clientX, event.clientY, surface.getBoundingClientRect(), width, height);
      if (!point) return;
      event.preventDefault();
      const used = new Set([...pointers.values()].map(p => p.id));
      let id = 0; while (used.has(id)) id++;
      pointers.set(event.pointerId, { id, ...point });
      surface.setPointerCapture(event.pointerId);
      cancelMove();
      send({ type: 'touch', contacts: contacts() });
    });
    surface.addEventListener('pointermove', event => {
      const p = pointers.get(event.pointerId); if (!p) return;
      const point = mapPoint(event.clientX, event.clientY, surface.getBoundingClientRect(), width, height, true);
      if (!point) return;
      Object.assign(p, point);
      if (!movePending) {
        movePending = true;
        const generation = moveGeneration;
        requestAnimationFrame(() => {
          if (generation !== moveGeneration) return;
          movePending = false;
          if (pointers.size) send({ type: 'touch', contacts: contacts() }, 'move');
        });
      }
    });
    function up(event) {
      const p = pointers.get(event.pointerId); if (!p) return;
      cancelMove();
      pointers.delete(event.pointerId);
      send({ type: 'touch', contacts: [...contacts(), { ...p, down: false }] });
    }
    surface.addEventListener('pointerup', up);
    const cancel = event => { if (pointers.has(event.pointerId)) release(); };
    surface.addEventListener('pointercancel', cancel);
    surface.addEventListener('lostpointercapture', cancel);
  }
  for (const surface of [...screens, canvas, touchSurface]) bindSurface(surface);
  window.addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) release();
    presentation.refresh();
    // A head unit normally leaves the page to change its own appearance, so coming back is the
    // most likely moment for a preference the `change` event never delivered.
    if (!document.hidden) browserAppearance.refresh();
  });
  window.addEventListener('pagehide', () => disconnect(false));
  window.addEventListener('pageshow', event => { if (event.persisted) initializePairing(); });
  const linkedCode = pairingCodeFromUrl(window.location?.search || '');
  if (linkedCode) {
    $('code').value = linkedCode;
    // Keep the short-lived code out of copied URLs and browser history entries.
    window.history?.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
  }
  renderPhoneStatus(null);
  initializePairing(linkedCode);
}
