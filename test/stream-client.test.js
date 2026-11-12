import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resourceStrings } from '../scripts/resource-strings.mjs';
const messages = resourceStrings('values-zh-rCN');

const source = ['text.js', 'desktop-input.js', 'browser-audio.js', 'browser-location.js', 'browser-media-session.js', 'phone-gauge.js', 'viewport.js', 'presentation.js', 'media-probes.js', 'jpeg-presenter.js', 'control-outbox.js', 'browser-appearance.js', 'video-renderer.js', 'rtc-receiver.js', 'codec-stream.js', 'app.js']
  .map(name => readFileSync(new URL(`../common/src/main/assets/web/${name}`, import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replaceAll('export function', 'function').replaceAll('export const', 'const')).join('\n');
function fixture({ storedCanvas = null, storedMode = null, processorAvailable = true, storedIgnoreZoom = null, storageDisabled = false, canvasAvailable = true, supportsWebp = false,
  geometry = null, visual = null, peerAvailable = true, search = '', mediaSession = null, locationBrowser = null,
  fullscreen = 'supported', fullscreenResults = null, autoFullscreen = false, codeDenied = false, videoDecoder = false,
  resume = () => ({ token: 'session-token', name: 'Chrome' }) } = {}) {
  const elements = new Map(), timers = new Map(), raf = new Map(), sockets = [], peers = [], draws = [];
  const preferences = new Map(storedCanvas === null ? [] : [['wheelplay.canvasVideo', storedCanvas]]);
  if (storedIgnoreZoom !== null) preferences.set('wheelplay.ignoreBrowserZoom', storedIgnoreZoom);
  if (autoFullscreen) preferences.set('wheelplay.fullscreenOnStart', 'true');
  const videoCallbacks = new Map(), createdVideos = [], processors = [];
  if (storedMode !== null) preferences.set('wheelplay.videoRenderer', storedMode);
  const documentEvents = {}, documentListeners = {}, fullscreenCalls = [];
  const fireDocument = (name, event = {}) => (documentListeners[name] || []).forEach(fn => fn(event));
  const visualEvents = {};
  const visualViewport = visual ? { ...visual, addEventListener(type, fn) { visualEvents[type] = fn; } } : undefined;
  const mainRect = geometry ? { left: 0, top: geometry.top, width: geometry.width, height: geometry.height - geometry.top }
    : { left: 0, top: 0, width: 1280, height: 720 };
  let nextTimer = 0, nextFrame = 0, clockNow = 1000;
  const element = id => {
    const classes = new Set();
    if (!elements.has(id)) elements.set(id, { hidden: id === 'video-canvas' || id === 'disconnect', complete: true, value: '123456', handlers: {}, naturalWidth: 1280, naturalHeight: 720,
      checked: false, videoWidth: 1280, videoHeight: 720, readyState: 2, currentTime: 0,
      style: { removeProperty(name) { delete this[name]; } },
      parentElement: { getBoundingClientRect: () => mainRect },
      getContext: () => canvasAvailable ? { drawImage: (...args) => draws.push(args) } : null,
      play: async () => {},
      requestVideoFrameCallback(fn) { const frame = ++nextFrame; videoCallbacks.set(frame, fn); return frame; },
      cancelVideoFrameCallback(frame) { videoCallbacks.delete(frame); },
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
      remove() { this.hidden = true; this.removed = true; },
      insertBefore(child) { child.removed = false; },
      removeAttribute() {}, setAttribute() {}, setPointerCapture() {}, focus() {},
      closest(selector) { return selector === `#${id}` ? this : null; },
      getBoundingClientRect() {
        if (id !== 'display' || !classes.has('ignore-browser-zoom')) return mainRect;
        const scale = Number(this.style.transform.match(/scale\((.*)\)/)[1]);
        return { left: parseFloat(this.style.left), top: parseFloat(this.style.top),
          width: parseFloat(this.style.width) * scale, height: parseFloat(this.style.height) * scale };
      },
      addEventListener(name, fn) { const previous = this.handlers[name]; this.handlers[name] = previous ? event => { previous(event); fn(event); } : fn; } });
    return elements.get(id);
  };
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose(); }
  }
  class Peer {
    constructor() { this.iceGatheringState = 'complete'; this.localDescription = { sdp: 'answer' }; peers.push(this); }
    async setRemoteDescription() {}
    async createAnswer() { return { type: 'answer', sdp: 'a=setup:active\r\n' }; }
    async setLocalDescription() {}
    close() { this.closed = true; }
  }
  // A head unit with WebCodecs: decoding a chunk synchronously delivers its first frame, which
  // is enough to exercise the codec stream's onReady -> presentation commit path.
  const videoDecoders = [];
  class FakeVideoDecoder {
    constructor({ output }) { this.output = output; videoDecoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    reset() { this.state = 'configured'; }
    decode(chunk) { (this.chunks ??= []).push(chunk); this.output({ displayWidth: 1280, displayHeight: 720, close() {} }); }
    close() { this.closed = true; }
    static isConfigSupported() { return Promise.resolve({ supported: true }); }
  }
  class FakeEncodedVideoChunk { constructor(init) { Object.assign(this, init); } }
  const document = { createElement(tag) { assert.equal(tag, 'video'); const video = element('video'); createdVideos.push(video); return video; }, getElementById: element, fullscreenElement: null, documentElement: {},
    addEventListener(name, fn) { (documentListeners[name] ??= []).push(fn); documentEvents[name] = fn; },
    exitFullscreen() {
      fullscreenCalls.push('exit'); this.fullscreenElement = null;
      fireDocument('fullscreenchange'); return Promise.resolve();
    },
  };
  const enterFullscreen = () => { document.fullscreenElement = document.documentElement; fireDocument('fullscreenchange'); };
  // `fullscreenResults` consumes one outcome per request, then falls back to the `fullscreen`
  // default - handy for "page load rejected, first tap succeeds" browser behaviour.
  const pendingResults = fullscreenResults === null ? [] : [...fullscreenResults];
  if (fullscreen !== 'unsupported') document.documentElement.requestFullscreen = () => {
    fullscreenCalls.push('request');
    const outcome = pendingResults.length ? pendingResults.shift() : fullscreen;
    if (typeof outcome === 'function') return outcome(enterFullscreen);
    if (outcome === 'denied') return Promise.reject(new Error('fullscreen denied'));
    enterFullscreen(); return Promise.resolve();
  };
  const context = { document, navigator: { ...locationBrowser, mediaSession }, window: { isSecureContext: Boolean(locationBrowser), addEventListener() {}, visualViewport,
    localStorage: {
      getItem(key) { if (storageDisabled) throw new Error('denied'); return preferences.get(key) ?? null; },
      setItem(key, value) { if (storageDisabled) throw new Error('denied'); preferences.set(key, value); },
      removeItem(key) { preferences.delete(key); },
    },
  },
    MediaMetadata: class { constructor(value) { Object.assign(this, value); } },
    location: { host: 'server:8080', search, protocol: locationBrowser ? 'https:' : 'http:' }, URL: { createObjectURL: () => 'blob:frame', revokeObjectURL() {} }, Date, WebSocket: Socket,
    MediaStreamTrackProcessor: processorAvailable ? class {
      constructor(init) {
        this.init = init; this.pending = [];
        this.reader = {
          read: () => new Promise(resolve => this.pending.push(resolve)),
          cancel: () => { this.canceled = true; this.pending.splice(0).forEach(resolve => resolve({ done: true })); },
          releaseLock: () => { this.released = true; },
        };
        this.readable = { getReader: () => this.reader }; processors.push(this);
      }
    } : undefined,
    ArrayBuffer, DataView, Blob,
    VideoDecoder: videoDecoder ? FakeVideoDecoder : undefined,
    EncodedVideoChunk: videoDecoder ? FakeEncodedVideoChunk : undefined,
    RTCPeerConnection: peerAvailable ? Peer : undefined, performance: { now: () => clockNow },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay, at: clockNow + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 0; }, clearInterval() {},
    requestAnimationFrame(fn) { const frame = ++nextFrame; raf.set(frame, fn); return frame; },
    cancelAnimationFrame(frame) { raf.delete(frame); },
    fetch: async url => {
      if (url === '/pair/code') return codeDenied ? { ok: false, status: 401 } : { ok: true, json: async () => ({ token: 'session-token' }) };
      if (url === '/pair/remember') return { ok: true, json: async () => ({ id: 'd'.repeat(32), secret: 's'.repeat(32), name: 'Chrome' }) };
      if (url === '/pair/resume') return { ok: true, json: async () => resume() };
      return new Promise(() => {});
    },
  };
  if (supportsWebp) context.Image = class {
    naturalWidth = 2; naturalHeight = 2;
    set src(value) { setImmediate(() => this.onload?.()); }
    removeAttribute() {}
  };
  context.wheelplayMessages = messages;
  vm.runInNewContext(source, context);
  return { element, sockets, timers, peers, draws, preferences, raf, videoCallbacks, document, fullscreenCalls, createdVideos, processors, visualViewport, visualEvents,
    reportViewport() {
      const [id, timer] = [...timers].find(([, t]) => t.delay === 180);
      timers.delete(id); timer.fn();
    },
    advance(ms) {
      clockNow += ms;
      for (;;) {
        const entry = [...timers].find(([, timer]) => timer.at <= clockNow);
        if (!entry) break;
        timers.delete(entry[0]); entry[1].fn();
      }
    },
    stats: () => context.window.wheelplayStats,
    select(mode) { element(`renderer-${mode}`).checked = true; element(`renderer-${mode}`).handlers.change(); },
    async decoded(width = 1280, height = 720) {
      const frame = { displayWidth: width, displayHeight: height, closes: 0, close() { this.closes++; } };
      processors.at(-1).pending.shift()({ value: frame, done: false });
      await new Promise(resolve => setImmediate(resolve)); return frame;
    },
    async connect() {
      element('connect-form').handlers.submit({ preventDefault() {} });
      await new Promise(resolve => setImmediate(resolve));
      const ws = sockets.at(-1); ws.readyState = 1; ws.onopen(); return ws;
    },
    frame(ws) { ws.onmessage({ data: {} }); [element('screen'), element('screen-next'), element('screen-third')].find(image => image.onload).onload(); },
    async offer(ws, id = 1, meta = {}) {
      ws.onmessage({ data: JSON.stringify({ type: 'rtc-offer', id, sdp: 'offer', ...meta }) });
      await new Promise(resolve => setImmediate(resolve));
      peers.at(-1).ontrack({ track: { stop() {} }, streams: [{}] });
      await new Promise(resolve => setImmediate(resolve));
    },
    pointer(type, x = 100, surface = 'screen') { element(surface).handlers[type]({ pointerId: 1, pointerType: 'touch', clientX: x, clientY: 100, preventDefault() {} }); },
    // A document-level tap, with a gesture but no target element: this is what the browser
    // requires before it will honour an automatic fullscreen request.
    tapAnywhere(target = null) { fireDocument('pointerdown', { pointerType: 'touch', preventDefault() {}, target }); },
    flushMoves() { const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(fn => fn()); },
    retry() {
      const [id, timer] = [...timers].find(([, t]) => t.delay === 10);
      timers.delete(id); timer.fn();
    },
    status(ws, extra = {}) {
      ws.onmessage({ data: JSON.stringify({ type: 'status', sessionId: 7, videoEpoch: 1,
        width: 1280, height: 720, sourceState: 'ready', inputReady: true,
        rtcAvailable: false, vcsAvailable: false, ...extra }) });
    },
    async vcsStart(ws, extra = {}) {
      ws.onmessage({ data: JSON.stringify({ type: 'vcs-start', id: 2, sessionId: 7, videoEpoch: 1,
        codec: 'H264', profile: '640033', recoveryGraceMs: 10000, ...extra }) });
      await new Promise(resolve => setImmediate(resolve));
    },
    // A v2 still-image packet with a newer epoch advances the presentation revision without
    // stopping the codec stream - exactly what a source reconfiguration does on a first visit.
    v2Frame(ws, epoch = 2) {
      const buffer = new ArrayBuffer(37), view = new DataView(buffer);
      view.setUint32(0, 0x32565057, true);
      view.setFloat64(4, 7, true); view.setFloat64(12, epoch, true); view.setFloat64(20, 1, true);
      view.setUint32(28, 1280, true); view.setUint32(32, 720, true);
      ws.onmessage({ data: buffer });
    },
    codecFrame(ws) {
      const buffer = new ArrayBuffer(27), view = new DataView(buffer);
      view.setUint32(0, 0x31564357, true);
      view.setBigInt64(4, 0n, true); view.setBigInt64(12, 1000n, true);
      view.setUint16(20, 1, true); view.setUint16(22, 0, true);
      ws.onmessage({ data: buffer });
    },
    videoDecoders,
    recoveryCount: () => context.__frameCommitRecovery || 0,
    // Fire the watchdog without advancing the clock: the harness's 2 s auto-pair retry would
    // otherwise bump authGeneration and make the real reconnect callback a no-op.
    fireWatchdog() {
      const entry = [...timers].find(([, t]) => t.delay === 2500);
      assert.ok(entry, 'expected the frame-commit watchdog');
      timers.delete(entry[0]); entry[1].fn();
    },
    async reconnect() {
      const entry = [...timers].filter(([, t]) => t.delay === 1000).at(-1);
      assert.ok(entry, 'expected the reconnect timer');
      timers.delete(entry[0]); await entry[1].fn();
    },
  };
}

test('the overlay forwards a complete drag independently of the native video element', async () => {
  const f = fixture(), ws = await f.connect(); f.frame(ws);
  f.pointer('pointerdown', 100, 'touch-surface');
  f.pointer('pointermove', 200, 'touch-surface'); f.flushMoves();
  f.pointer('pointerup', 200, 'touch-surface');
  assert.deepEqual(ws.sent.filter(m => m.type === 'touch').map(m => m.contacts[0].down), [true, true, false]);
});

test('the drawer Disconnect button appears only while connected and closes the drawer', async () => {
  const f = fixture();
  assert.equal(f.element('disconnect').hidden, true, 'the button starts hidden in the HTML');
  await f.connect();
  assert.equal(f.element('disconnect').hidden, false);
  f.element('settings-toggle').handlers.click();
  assert.equal(f.element('settings-drawer').classList.contains('open'), true);
  f.element('disconnect').handlers.click();
  assert.equal(f.element('disconnect').hidden, true);
  assert.equal(f.element('settings-drawer').classList.contains('open'), false, 'disconnecting dismisses the drawer');
  assert.equal(f.element('pairing').hidden, false);
});

const flush = () => new Promise(resolve => setImmediate(resolve));

test('a plain visit leaves fullscreen alone and labels the button for entering', async () => {
  const f = fixture(); await f.connect();
  assert.deepEqual(f.fullscreenCalls, []);
  assert.equal(f.document.fullscreenElement, null);
  assert.equal(f.element('fullscreen').textContent, messages.web_full_screen);
});

test('auto full screen asks once as the page loads, before pairing starts', async () => {
  const f = fixture({ autoFullscreen: true });
  assert.deepEqual(f.fullscreenCalls, ['request']);
  assert.equal(f.document.fullscreenElement, f.document.documentElement);
  assert.equal(f.element('fullscreen').textContent, messages.web_exit_full_screen);
  await f.connect();
  assert.equal(f.element('display').hidden, false, 'a fullscreen page still connects');
});

test('a gesture-gated browser enters fullscreen on the first tap only', async () => {
  const f = fixture({ autoFullscreen: true, fullscreenResults: ['denied', 'supported'] });
  await flush();
  assert.deepEqual(f.fullscreenCalls, ['request']);
  assert.equal(f.document.fullscreenElement, null);
  f.tapAnywhere();
  assert.deepEqual(f.fullscreenCalls, ['request', 'request']);
  assert.equal(f.document.fullscreenElement, f.document.documentElement);
  assert.equal(f.element('fullscreen').textContent, messages.web_exit_full_screen);
  f.tapAnywhere();
  assert.deepEqual(f.fullscreenCalls, ['request', 'request'], 'the first tap is the only retry');
});

test('clearing the auto option cancels the pending first-tap retry', async () => {
  const f = fixture({ autoFullscreen: true, fullscreenResults: ['denied', 'supported'] });
  await flush();
  f.element('fullscreen-on-start').checked = false;
  f.element('fullscreen-on-start').handlers.change({});
  assert.equal(f.preferences.get('wheelplay.fullscreenOnStart'), 'false');
  f.tapAnywhere();
  assert.deepEqual(f.fullscreenCalls, ['request'], 'no retry after the option is cleared');
  assert.equal(f.document.fullscreenElement, null);
});

test('enabling the option requests fullscreen in the toggle gesture; disabling it never exits', async () => {
  const f = fixture();
  f.element('fullscreen-on-start').checked = true;
  f.element('fullscreen-on-start').handlers.change({});
  assert.deepEqual(f.fullscreenCalls, ['request']);
  assert.equal(f.document.fullscreenElement, f.document.documentElement);
  assert.equal(f.preferences.get('wheelplay.fullscreenOnStart'), 'true');
  f.element('fullscreen-on-start').checked = false;
  f.element('fullscreen-on-start').handlers.change({});
  assert.equal(f.fullscreenCalls.includes('exit'), false, 'clearing auto full screen leaves a chosen fullscreen alone');
  assert.equal(f.document.fullscreenElement, f.document.documentElement);
});

test('the one-shot button toggles fullscreen and cancels a pending automatic request', async () => {
  const f = fixture({ autoFullscreen: true, fullscreenResults: ['denied', 'supported'] });
  await flush();
  await f.element('fullscreen').handlers.click();
  assert.deepEqual(f.fullscreenCalls, ['request', 'request']);
  assert.equal(f.document.fullscreenElement, f.document.documentElement);
  assert.equal(f.element('fullscreen').textContent, messages.web_exit_full_screen);
  await f.element('fullscreen').handlers.click();
  assert.deepEqual(f.fullscreenCalls, ['request', 'request', 'exit']);
  assert.equal(f.document.fullscreenElement, null);
  assert.equal(f.element('fullscreen').textContent, messages.web_full_screen);
  f.tapAnywhere();
  assert.equal(f.fullscreenCalls.filter(call => call === 'request').length, 2,
    'the manual exit is not undone by the automatic retry');
});

test('the first tap on a fullscreen control belongs to that control, not the automatic request', async () => {
  const f = fixture({ autoFullscreen: true, fullscreenResults: ['denied'] });
  await flush();
  assert.deepEqual(f.fullscreenCalls, ['request'], 'the page-load request was refused');
  f.tapAnywhere(f.element('fullscreen'));
  assert.deepEqual(f.fullscreenCalls, ['request'], 'no automatic retry races the button');
  await f.element('fullscreen').handlers.click();
  assert.deepEqual(f.fullscreenCalls, ['request', 'request']);
  assert.equal(f.document.fullscreenElement, f.document.documentElement);

  const toggle = fixture({ autoFullscreen: true, fullscreenResults: ['denied'] });
  await flush();
  toggle.tapAnywhere(toggle.element('fullscreen-on-start'));
  assert.deepEqual(toggle.fullscreenCalls, ['request'], 'tapping the option does not auto-enter fullscreen');
  assert.equal(toggle.document.fullscreenElement, null);
});

test('auto full screen is page-level: disconnect and pairing failure leave it intact', async () => {
  const connected = fixture({ autoFullscreen: true });
  await connected.connect();
  connected.element('disconnect').handlers.click();
  assert.equal(connected.fullscreenCalls.includes('exit'), false);
  assert.equal(connected.document.fullscreenElement, connected.document.documentElement);
  assert.equal(connected.element('pairing').hidden, false);

  const failed = fixture({ autoFullscreen: true, codeDenied: true });
  failed.element('connect-form').handlers.submit({ preventDefault() {} });
  await flush();
  assert.equal(failed.sockets.length, 0);
  assert.deepEqual(failed.fullscreenCalls, ['request']);
  assert.equal(failed.document.fullscreenElement, failed.document.documentElement);
  assert.equal(failed.element('pairing').hidden, false);
  assert.equal(failed.element('connect').disabled, false);
});

test('an unsupported or refusing browser still connects without a pending retry', async () => {
  for (const options of [{ fullscreen: 'unsupported' }, { fullscreen: 'denied' }]) {
    const f = fixture({ autoFullscreen: true, ...options });
    await flush();
    await f.connect();
    assert.equal(f.element('display').hidden, false);
    f.tapAnywhere();
    assert.equal(f.document.fullscreenElement, null);
    f.element('disconnect').handlers.click();
    assert.equal(f.fullscreenCalls.includes('exit'), false);
  }
});

test('actual image onload retries ACK and preserves down/up during browser congestion', async () => {
  const f = fixture(), ws = await f.connect();
  ws.bufferedAmount = 8192;
  f.frame(ws); f.pointer('pointerdown'); f.pointer('pointermove', 200); f.flushMoves(); f.pointer('pointerup', 200);
  assert.deepEqual(ws.sent.map(m => m.type), ['ping']);
  ws.bufferedAmount = 0; f.retry();
  assert.deepEqual(ws.sent.map(m => m.type), ['ping', 'ack', 'touch', 'touch', 'touch']);
  assert.deepEqual(ws.sent.slice(2).map(m => m.contacts[0].down), [true, true, false]);
});

test('disconnect drops pending ACK and old animation callbacks cannot send into a new gesture', async () => {
  const f = fixture(), old = await f.connect(); f.frame(old); f.pointer('pointerdown');
  f.pointer('pointermove', 200);
  old.bufferedAmount = 8192; old.onmessage({ data: {} });
  const lateImageLoad = [f.element('screen'), f.element('screen-next')].find(image => image.onload).onload;
  lateImageLoad();
  old.close();
  const current = await f.connect(); f.frame(current); f.pointer('pointerdown', 300);
  const before = current.sent.length;
  lateImageLoad(); f.flushMoves();
  assert.equal(current.sent.length, before);
  assert.equal([...f.timers.values()].some(t => t.delay === 10), false);
  assert.equal(old.sent.filter(m => m.type === 'ack').length, 1);
});

test('pending movement is cancelled at up before another down', async () => {
  const f = fixture(), ws = await f.connect(); f.frame(ws);
  f.pointer('pointerdown'); f.pointer('pointermove', 200); f.pointer('pointerup'); f.pointer('pointerdown', 300);
  const before = ws.sent.length; f.flushMoves();
  assert.equal(ws.sent.length, before);
  assert.deepEqual(ws.sent.filter(m => m.type === 'touch').map(m => m.contacts[0].down), [true, false, true]);
});

test('renderer defaults, legacy migration, new preference precedence and storage errors', async () => {
  const defaults = fixture(); assert.equal(defaults.element('renderer-native').checked, true);
  const f = fixture({ storedCanvas: 'true' }); assert.equal(f.element('renderer-video-canvas').checked, true);
  f.select('track-canvas');
  assert.equal(f.preferences.get('wheelplay.videoRenderer'), 'track-canvas');
  assert.equal(f.preferences.get('wheelplay.canvasVideo'), 'true');
  assert.equal(f.element('renderer-video-canvas').checked, false);
  const preferred = fixture({ storedCanvas: 'true', storedMode: 'native' });
  assert.equal(preferred.element('renderer-native').checked, true);
  assert.equal(fixture({ storedCanvas: 'true', storedMode: 'invalid' }).element('renderer-video-canvas').checked, true);
  const denied = fixture({ storageDisabled: true }); denied.select('track-canvas');
  assert.equal((await denied.connect()).readyState, 1);
  assert.equal(denied.stats().presentation.selectedMode, 'track-canvas');
});

test('default WebRTC presents native video without allocating a Canvas', async () => {
  const f = fixture(), ws = await f.connect(); await f.offer(ws);
  assert.equal(f.element('video').hidden, false);
  assert.equal(f.element('video').classList.contains('offscreen-video'), false);
  assert.equal(f.element('video-canvas').hidden, true); assert.equal(f.draws.length, 0);
  assert.equal(ws.sent.at(-1).type, 'rtc-ready');
});

test('a recoverable WebRTC disconnect preserves video and touch and reports recovery', async () => {
  const f = fixture(), ws = await f.connect(); await f.offer(ws);
  const peer = f.peers.at(-1);
  peer.connectionState = 'disconnected'; peer.onconnectionstatechange();
  ws.onmessage({ data: JSON.stringify({ type: 'status', width: 1280, height: 720, streaming: true }) });
  assert.equal(f.element('video').hidden, false);
  assert.equal(f.element('waiting').hidden, true);
  assert.match(f.element('status').textContent, /WebRTC.*等待恢复/);
  f.pointer('pointerdown', 100, 'touch-surface'); f.pointer('pointerup', 100, 'touch-surface');
  assert.equal(ws.sent.filter(m => m.type === 'touch').length, 2);
  assert.equal(ws.sent.some(m => m.type === 'rtc-fallback'), false);
  peer.connectionState = 'connected'; peer.onconnectionstatechange();
  ws.onmessage({ data: JSON.stringify({ type: 'status', width: 1280, height: 720, streaming: true }) });
  assert.doesNotMatch(f.element('status').textContent, /等待恢复/);
});

test('Canvas WebRTC handles touch, late JPEG loads, and reconnection without leaving old callbacks', async () => {
  const f = fixture({ storedCanvas: 'true' }), ws = await f.connect();
  ws.onmessage({ data: {} }); const lateImage = f.element('screen').onload;
  await f.offer(ws);
  assert.equal(f.element('video-canvas').hidden, false);
  assert.equal(f.element('video').hidden, false);
  assert.equal(f.element('video').classList.contains('offscreen-video'), true);
  lateImage(); assert.equal(f.element('screen').hidden, true);
  f.pointer('pointerdown', 100, 'touch-surface'); f.pointer('pointerup', 100, 'touch-surface');
  assert.deepEqual(ws.sent.filter(m => m.type === 'touch').map(m => m.contacts[0].down), [true, false]);
  ws.onmessage({ data: JSON.stringify({ type: 'status', width: 1280, height: 720, streaming: true, rtcAvailable: true }) });
  assert.match(f.element('status').textContent, /WebRTC \/ 兼容 Canvas/);
  const lateFrames = [...f.videoCallbacks.values()], lateRefresh = [...f.raf.values()];
  ws.close(); assert.equal(f.element('video-canvas').hidden, true);
  assert.equal(f.videoCallbacks.size, 0); assert.equal(f.raf.size, 0);
  const replacement = await f.connect(); await f.offer(replacement, 2); const count = f.draws.length;
  lateFrames.forEach(fn => fn(100, { presentedFrames: 100, mediaTime: .1 })); lateRefresh.forEach(fn => fn());
  assert.equal(f.draws.length, count); assert.equal(f.element('video-canvas').hidden, false);
});

test('Canvas failure falls back to JPEG while control and the selected preference remain available', async () => {
  const f = fixture({ storedCanvas: 'true', canvasAvailable: false }), ws = await f.connect(); await f.offer(ws);
  assert.equal(ws.readyState, 1);
  assert.equal(f.peers[0].closed, true);
  assert.equal(f.element('video-canvas').hidden, true);
  assert.equal(f.element('video').hidden, true);
  assert.equal(f.element('video').classList.contains('offscreen-video'), false);
  assert.equal(f.timers.size > 0 && [...f.timers.values()].some(t => t.delay === 1000), false);
  assert.equal(ws.sent.at(-1).type, 'rtc-fallback');
  assert.equal(ws.sent.at(-1).retryable, false);
  f.frame(ws); assert.equal(['screen', 'screen-next', 'screen-third'].some(id => !f.element(id).hidden), true);
  f.pointer('pointerdown', 100, 'touch-surface'); f.pointer('pointerup', 100, 'touch-surface');
  assert.equal(ws.sent.filter(m => m.type === 'touch').length, 2);
  assert.equal(f.element('renderer-video-canvas').checked, true);
});


test('phone connection requires pairing and reports the server result', async () => {
  const f = fixture();
  f.element('phone-connect').handlers.click();
  assert.equal(f.sockets.length, 0);
  assert.match(f.element('phone-connect-message').textContent, /重新配对/);
  const ws = await f.connect();
  f.element('phone-connect').handlers.click();
  assert.equal(ws.sent.filter(m => m.type === 'phone-connect').length, 1);
  assert.equal(f.element('phone-connect').disabled, true);
  ws.onmessage({ data: JSON.stringify({ type: 'phone-connect-result', message: '请在 Android 上完成授权' }) });
  assert.equal(f.element('phone-connect').disabled, false);
  assert.equal(f.element('phone-connect-message').textContent, '请在 Android 上完成授权');
});

test('phone connection survives congestion and is sent once after recovery', async () => {
  const f = fixture(), ws = await f.connect();
  ws.bufferedAmount = 8193;
  f.element('phone-connect').handlers.click();
  assert.equal(ws.sent.some(m => m.type === 'phone-connect'), false);
  assert.equal(f.element('phone-connect').disabled, true);
  ws.bufferedAmount = 0;
  f.retry();
  assert.equal(ws.sent.filter(m => m.type === 'phone-connect').length, 1);
});


test('interrupted display resumes with fresh authentication after a server restart', async () => {
  const f = fixture({ resume: () => ({ token: 'fresh-session', name: 'Chrome' }) });
  const old = await f.connect(); old.close();
  const retry = [...f.timers.values()].find(t => t.delay === 1000);
  assert.ok(retry); await retry.fn();
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets[1].url, 'ws://server:8080/stream?token=fresh-session&media=2&images=3&nowPlaying=1');
});

test('manual pairing mode requires fresh pairing after revocation during an active display', async () => {
  const f = fixture({ search: '?manual=1', resume: () => { const error = new Error('revoked'); error.status = 401; throw error; } });
  const old = await f.connect(); old.close();
  await [...f.timers.values()].find(t => t.delay === 1000).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sockets.length, 1);
  assert.equal(f.element('code-entry').hidden, false);
  assert.equal(f.preferences.has('wheelplay.browserDevice'), false);
});

test('ignore browser zoom defaults off and restores the saved choice', () => {
  const f = fixture();
  assert.equal(f.element('ignore-browser-zoom').checked, false);
  const option = f.element('ignore-browser-zoom');
  option.checked = true;
  option.handlers.change({ target: option });
  assert.equal(f.element('ignore-browser-zoom').checked, true);
  assert.equal(f.preferences.get('wheelplay.ignoreBrowserZoom'), 'true');
  const restored = fixture({ storedIgnoreZoom: 'true' });
  assert.equal(restored.element('ignore-browser-zoom').checked, true);
  const denied = fixture({ storageDisabled: true });
  const primary = denied.element('ignore-browser-zoom');
  primary.checked = true;
  assert.doesNotThrow(() => primary.handlers.change({ target: primary }));
});

test('a short split-screen viewport sends a valid canvas through the real zoom/style/report path', async () => {
  const f = fixture({ storedIgnoreZoom: 'true', geometry: { width: 960, height: 400, top: 64 },
    visual: { width: 960, height: 400, scale: 1, offsetLeft: 0, offsetTop: 0 } });
  const ws = await f.connect();
  f.reportViewport();
  assert.deepEqual(ws.sent.find(m => m.type === 'viewport'), { type: 'viewport', width: 960, height: 336 });
  Object.assign(f.visualViewport, { width: 640, height: 400 / 1.5, scale: 1.5 });
  f.visualEvents.resize(); f.reportViewport();
  const surface = f.element('display');
  assert.equal(surface.classList.contains('ignore-browser-zoom'), true);
  assert.equal(surface.style.transform, `scale(${1 / 1.5})`);
  const report = ws.sent.filter(m => m.type === 'viewport').at(-1);
  assert.deepEqual(report, { type: 'viewport', width: 1010, height: 320 });
  assert.ok(Math.abs(report.width / report.height - 960 / 304) < 0.01);
  const count = ws.sent.length;
  f.visualEvents.resize(); f.reportViewport();
  assert.equal(ws.sent.length, count, 'unchanged geometry must not renegotiate');
  const option = f.element('ignore-browser-zoom'); option.checked = false; option.handlers.change();
  f.reportViewport();
  assert.equal(surface.classList.contains('ignore-browser-zoom'), false);
  assert.equal(surface.style.transform, undefined);
  assert.deepEqual(ws.sent.filter(m => m.type === 'viewport').at(-1), { type: 'viewport', width: 960, height: 336 });
});

test('unsupported viewport shapes never reach Android as invalid control messages', async () => {
  const f = fixture({ storedIgnoreZoom: 'true', geometry: { width: 960, height: 400, top: 64 },
    visual: { width: 960, height: 400, scale: 1, offsetLeft: 0, offsetTop: 0 } });
  const ws = await f.connect(); f.reportViewport();
  const count = ws.sent.filter(m => m.type === 'viewport').length;
  Object.assign(f.visualViewport, { height: 100 });
  f.visualEvents.resize(); f.reportViewport();
  assert.equal(ws.sent.filter(m => m.type === 'viewport').length, count);
  assert.equal(ws.readyState, 1);
});

function videoPacket(videoEpoch, { sessionId = 7, width = 1280, height = 720, protocol = 2, sequence = videoEpoch, format = 1 } = {}) {
  const offset = protocol === 3 ? 40 : 36;
  const packet = new ArrayBuffer(offset + 3), header = new DataView(packet);
  header.setUint32(0, protocol === 3 ? 0x33565057 : 0x32565057, true); header.setFloat64(4, sessionId, true);
  header.setFloat64(12, videoEpoch, true); header.setFloat64(20, sequence, true);
  header.setUint32(28, width, true); header.setUint32(32, height, true);
  if (protocol === 3) header.setUint32(36, format, true);
  new Uint8Array(packet, offset).set([0xff, 0xd8, 0xff]); return packet;
}
function mediaStatus(ws, extra = {}) {
  ws.onmessage({ data: JSON.stringify({ type: 'status', mediaProtocol: 2, sessionId: 7, videoEpoch: 1,
    width: 1280, height: 720, streaming: true, sourceState: 'ready', inputReady: true, ...extra }) });
}
function finishJpeg(f, width = 1280, height = 720) {
  const image = [f.element('screen'), f.element('screen-next'), f.element('screen-third')].find(image => image.onload);
  image.naturalWidth = width; image.naturalHeight = height; image.onload(); return image;
}

test('v3 keeps two decodes alive, ACKs their identities, and never flashes or commits a late older decode', async () => {
  const f = fixture(), ws = await f.connect(); mediaStatus(ws, { mediaProtocol: 3 });
  const packet = sequence => videoPacket(1, { protocol: 3, sequence });
  ws.onmessage({ data: packet(1) }); const front = finishJpeg(f);
  ws.onmessage({ data: packet(2) }); const second = f.element('screen-next'), late = second.onload;
  ws.onmessage({ data: packet(3) }); const third = f.element('screen-third');
  assert.equal(front.hidden, false); assert.ok(second.onload); assert.ok(third.onload);
  third.onload(); late(); assert.equal(third.hidden, false);
  assert.equal(f.element('waiting').hidden, true);
  assert.deepEqual(ws.sent.filter(m => m.type === 'ack').map(m => m.sequence).sort(), [1, 2, 3]);
  assert.ok(ws.sent.filter(m => m.type === 'ack').every(m => m.sessionId === 7 && m.videoEpoch === 1));
  ws.onmessage({ data: videoPacket(0, { protocol: 3, sequence: 4 }) });
  assert.equal(ws.sent.at(-1).sequence, 4); assert.equal(third.hidden, false);
});

test('WebP is advertised only after a real probe; decode failure requests JPEG while preserving the presented image', async () => {
  const f = fixture({ supportsWebp: true }), ws = await f.connect();
  await new Promise(resolve => setImmediate(resolve)); mediaStatus(ws, { mediaProtocol: 3 });
  assert.deepEqual(ws.sent.find(m => m.type === 'image-format'), { type: 'image-format', format: 'webp' });
  ws.onmessage({ data: videoPacket(1, { protocol: 3, sequence: 1 }) }); const front = finishJpeg(f);
  ws.onmessage({ data: videoPacket(1, { protocol: 3, sequence: 2, format: 2 }) });
  f.element('screen-next').onerror();
  assert.equal(front.hidden, false); assert.equal(f.element('waiting').hidden, true);
  assert.deepEqual(ws.sent.at(-1), { type: 'image-format', format: 'jpeg' });
  ws.onmessage({ data: videoPacket(1, { protocol: 3, sequence: 3 }) }); finishJpeg(f);
  assert.equal(f.element('waiting').hidden, true);
});

test('RTC takeover retires both v3 decodes and late callbacks cannot send duplicate ACKs', async () => {
  for (const storedCanvas of [null, 'true']) {
    const f = fixture({ storedCanvas }), ws = await f.connect(); mediaStatus(ws, { mediaProtocol: 3 });
    ws.onmessage({ data: videoPacket(1, { protocol: 3, sequence: 1 }) }); finishJpeg(f);
    ws.onmessage({ data: videoPacket(1, { protocol: 3, sequence: 2 }) });
    ws.onmessage({ data: videoPacket(1, { protocol: 3, sequence: 3 }) });
    const late = [f.element('screen-next').onload, f.element('screen-third').onload];
    await f.offer(ws, 1, { sessionId: 7, videoEpoch: 1 });
    assert.deepEqual(ws.sent.filter(m => m.type === 'ack').map(m => m.sequence).sort(), [1, 2, 3]);
    late.forEach(fn => fn());
    assert.equal(ws.sent.filter(m => m.type === 'ack').length, 3);
    assert.equal(['screen', 'screen-next', 'screen-third'].every(id => f.element(id).hidden), true);
    assert.equal(f.element(storedCanvas ? 'video-canvas' : 'video').hidden, false);
  }
});

test('automatic RTC retry preserves JPEG and touch until the new video frame is ready', async () => {
  for (const storedCanvas of [null, 'true']) {
    const f = fixture({ storedCanvas }), ws = await f.connect(); mediaStatus(ws);
    await f.offer(ws, 1, { sessionId: 7, videoEpoch: 1 });
    const first = f.peers.at(-1); first.connectionState = 'failed'; first.onconnectionstatechange();
    ws.onmessage({ data: videoPacket(1) }); const picture = finishJpeg(f);
    mediaStatus(ws, { rtcAvailable: false, rtcRetryAfterMs: 5000 });
    assert.equal(f.element('waiting').hidden, true);
    f.advance(5000);
    const startCount = () => ws.sent.filter(message => message.type === 'rtc-start').length;
    const before = startCount();
    mediaStatus(ws, { rtcAvailable: true, rtcRetryAfterMs: 0 });
    mediaStatus(ws, { rtcAvailable: true, rtcRetryAfterMs: 0 });
    assert.equal(startCount(), before + 1, 'one request for an advertised retry window');
    ws.onmessage({ data: JSON.stringify({ type: 'rtc-offer', id: 2, sdp: 'offer', sessionId: 7, videoEpoch: 1 }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(picture.hidden, false, 'negotiation must keep JPEG visible');
    assert.equal(f.element('waiting').hidden, true);
    f.pointer('pointerdown', 100, 'touch-surface'); f.pointer('pointerup', 100, 'touch-surface');
    assert.equal(ws.sent.filter(message => message.type === 'touch').at(-1).contacts[0].down, false);
    ws.onmessage({ data: videoPacket(1) }); finishJpeg(f);
    const second = f.peers.at(-1);
    second.ontrack({ track: { stop() {} }, streams: [{}] }); await new Promise(resolve => setImmediate(resolve));
    assert.equal([f.element('screen'), f.element('screen-next')].every(image => image.hidden), true);
    assert.equal(f.element(storedCanvas ? 'video-canvas' : 'video').hidden, false);
    assert.equal(f.element('waiting').hidden, true);
    const starts = startCount();
    mediaStatus(ws, { rtcAvailable: false }); mediaStatus(ws, { rtcAvailable: true });
    assert.equal(startCount(), starts, 'an active receiver never requests a duplicate probe');
  }
});

test('a transient Canvas draw error permits a later retry to restore video', async () => {
  const f = fixture({ storedCanvas: 'true' }), ws = await f.connect(); mediaStatus(ws);
  const canvas = f.element('video-canvas'), getContext = canvas.getContext;
  canvas.getContext = () => ({ drawImage() { throw new Error('temporary surface loss'); } });
  await f.offer(ws, 1, { sessionId: 7, videoEpoch: 1 });
  assert.equal(ws.sent.at(-1).type, 'rtc-fallback');
  assert.notEqual(ws.sent.at(-1).retryable, false);
  ws.onmessage({ data: videoPacket(1) }); const picture = finishJpeg(f);
  mediaStatus(ws, { rtcAvailable: false, rtcRetryAfterMs: 5000 }); f.advance(5000);
  canvas.getContext = getContext;
  mediaStatus(ws, { rtcAvailable: true });
  await f.offer(ws, 2, { sessionId: 7, videoEpoch: 1 });
  assert.equal(picture.hidden, true); assert.equal(canvas.hidden, false);
});

test('failed retry and stale peer callbacks do not disturb the current JPEG or a reconnected session', async () => {
  const f = fixture(), ws = await f.connect(); mediaStatus(ws);
  ws.onmessage({ data: videoPacket(1) }); const picture = finishJpeg(f);
  mediaStatus(ws, { rtcAvailable: true });
  ws.onmessage({ data: JSON.stringify({ type: 'rtc-offer', id: 1, sdp: 'offer', sessionId: 7, videoEpoch: 1 }) });
  await new Promise(resolve => setImmediate(resolve));
  const peer = f.peers.at(-1), lateTrack = peer.ontrack;
  peer.connectionState = 'failed'; peer.onconnectionstatechange();
  assert.equal(picture.hidden, false); assert.equal(f.element('waiting').hidden, true);
  mediaStatus(ws, { rtcAvailable: false, rtcRetryAfterMs: 10000 });
  ws.close();
  const current = await f.connect(); mediaStatus(current, { videoEpoch: 2 });
  current.onmessage({ data: videoPacket(2) }); finishJpeg(f);
  const before = current.sent.filter(message => message.type.startsWith('rtc-')).length;
  lateTrack({ streams: [{}] }); f.advance(30000);
  assert.equal(current.sent.filter(message => message.type.startsWith('rtc-')).length, before,
    'old RTC callbacks and deadlines cannot send on a new socket');
  assert.equal(f.element('waiting').hidden, true);
});

test('a same-version RTC offer keeps the pending JPEG available if negotiation fails', async () => {
  const f = fixture(), ws = await f.connect(); mediaStatus(ws);
  ws.onmessage({ data: videoPacket(1) });
  ws.onmessage({ data: JSON.stringify({ type: 'rtc-offer', id: 1, sdp: 'offer', sessionId: 7, videoEpoch: 1 }) });
  await new Promise(resolve => setImmediate(resolve));
  finishJpeg(f);
  const peer = f.peers.at(-1); peer.connectionState = 'failed'; peer.onconnectionstatechange();
  assert.equal(f.element('screen').hidden, false);
  assert.equal(f.element('waiting').hidden, true);
  assert.equal(f.element('touch-surface').classList.contains('stale'), false);
});

test('versioned pointer cancellation sends a cancel command while ordinary up still releases the contact', async () => {
  for (const event of ['pointercancel', 'lostpointercapture']) {
    const f = fixture(), ws = await f.connect(); mediaStatus(ws);
    ws.onmessage({ data: videoPacket(1) }); finishJpeg(f);
    f.pointer('pointerdown', 100, 'touch-surface');
    f.pointer('pointermove', 200, 'touch-surface');
    f.pointer(event, 200, 'touch-surface');
    const afterCancel = ws.sent.length;
    f.flushMoves(); f.pointer('pointerup', 200, 'touch-surface');
    assert.equal(ws.sent.length, afterCancel);
    assert.deepEqual(ws.sent.filter(m => m.type === 'input').at(-1), {
      type: 'input', kind: 'release', sessionId: 7, videoEpoch: 1,
    });
    assert.deepEqual(ws.sent.filter(m => m.type === 'touch').map(m => m.contacts[0].down), [true]);
    f.pointer('pointerdown', 100, 'touch-surface'); f.pointer('pointerup', 100, 'touch-surface');
    f.pointer('lostpointercapture', 100, 'touch-surface');
    assert.equal(ws.sent.filter(m => m.type === 'input').length, 1);
    assert.equal(ws.sent.filter(m => m.type === 'touch').at(-1).contacts[0].down, false);
  }
});

test('a source gap releases touch, keeps the picture, and expires with no more status messages', async () => {
  const f = fixture(); const ws = await f.connect(); mediaStatus(ws);
  ws.onmessage({ data: videoPacket(1) }); finishJpeg(f);
  f.pointer('pointerdown', 100, 'touch-surface');
  mediaStatus(ws, { sourceState: 'recovering', streaming: false, inputReady: false });
  assert.deepEqual(ws.sent.filter(m => m.type === 'input').at(-1), { type: 'input', kind: 'release', sessionId: 7, videoEpoch: 1 });
  assert.equal(f.element('waiting').hidden, true);
  assert.equal(f.element('media-message').hidden, false);
  assert.match(f.element('media-message').textContent, /触控已暂停/);
  const before = ws.sent.filter(m => m.type === 'touch').length;
  f.pointer('pointerdown', 100, 'touch-surface');
  assert.equal(ws.sent.filter(m => m.type === 'touch').length, before);
  f.advance(1999); assert.equal(f.element('waiting').hidden, true);
  f.advance(1); assert.equal(f.element('waiting').hidden, false);
  assert.equal(ws.readyState, 1);
  mediaStatus(ws); assert.equal(f.element('waiting').hidden, true);
});

test('the touch-paused overlay stays visible because the drawer status is closed while driving', async () => {
  const f = fixture(), ws = await f.connect(); mediaStatus(ws);
  ws.onmessage({ data: videoPacket(1) }); finishJpeg(f);
  mediaStatus(ws, { sourceState: 'recovering', streaming: false, inputReady: false });
  assert.equal(f.element('media-message').hidden, false);
  assert.match(f.element('media-message').textContent, /触控已暂停/);
});

test('status during JPEG decoding leaves the old image and its input geometry intact', async () => {
  const f = fixture(), ws = await f.connect(); mediaStatus(ws);
  ws.onmessage({ data: videoPacket(1) }); const first = finishJpeg(f);
  ws.onmessage({ data: videoPacket(1) });
  const back = f.element('screen-next'); back.naturalWidth = 0;
  mediaStatus(ws);
  assert.equal(first.hidden, false); assert.equal(back.hidden, true);
  assert.equal(f.element('waiting').hidden, true);
  f.pointer('pointerdown', 100, 'touch-surface');
  assert.deepEqual(ws.sent.filter(m => m.type === 'touch').at(-1), {
    type: 'touch', sessionId: 7, videoEpoch: 1, contacts: [{ id: 0, x: 100 / 1280, y: 100 / 720, down: true }],
  });
});

test('same-size rebuild cancels an old decode and ACKs it without accepting stale callbacks', async () => {
  const f = fixture(), ws = await f.connect(); mediaStatus(ws);
  ws.onmessage({ data: videoPacket(1) }); finishJpeg(f);
  ws.onmessage({ data: videoPacket(1) });
  const late = f.element('screen-next').onload;
  const ackCount = ws.sent.filter(m => m.type === 'ack').length;
  mediaStatus(ws, { videoEpoch: 2 });
  assert.equal(ws.sent.filter(m => m.type === 'ack').length, ackCount + 1);
  late();
  assert.equal(f.element('touch-surface').classList.contains('stale'), true);
  ws.onmessage({ data: videoPacket(1) });
  assert.equal(f.element('screen-next').onload, null);
  ws.onmessage({ data: videoPacket(2) }); finishJpeg(f);
  assert.equal(f.element('touch-surface').classList.contains('stale'), false);
});

test('a rotated JPEG arriving before status disables old touch and commits the new geometry', async () => {
  const f = fixture(), ws = await f.connect(); mediaStatus(ws);
  ws.onmessage({ data: videoPacket(1) }); finishJpeg(f);
  f.pointer('pointerdown', 100, 'touch-surface');
  ws.onmessage({ data: videoPacket(2, { width: 720, height: 1280 }) });
  assert.deepEqual(ws.sent.filter(m => m.type === 'input').at(-1), { type: 'input', kind: 'release', sessionId: 7, videoEpoch: 2 });
  finishJpeg(f, 720, 1280);
  assert.equal(f.element('touch-surface').classList.contains('stale'), true, 'input needs a ready status');
  mediaStatus(ws, { videoEpoch: 2, width: 720, height: 1280 });
  f.pointer('pointerdown', 640, 'touch-surface');
  const touch = ws.sent.filter(m => m.type === 'touch').at(-1);
  assert.equal(touch.videoEpoch, 2); assert.equal(touch.contacts[0].x, .5);
});

test('an RTC rebuild keeps a frozen picture and rejects the previous offer and frame callbacks', async () => {
  for (const storedCanvas of [null, 'true']) {
    const f = fixture({ storedCanvas }), ws = await f.connect(); mediaStatus(ws);
    ws.onmessage({ data: JSON.stringify({ type: 'rtc-offer', id: 1, sdp: 'offer', sessionId: 7, videoEpoch: 1 }) });
    await new Promise(resolve => setImmediate(resolve));
    f.peers.at(-1).ontrack({ track: { stop() {} }, streams: [{}] }); await new Promise(resolve => setImmediate(resolve));
    const oldCallbacks = [...f.videoCallbacks.values()];
    mediaStatus(ws, { videoEpoch: 2 });
    assert.equal(f.element('held-frame').hidden, false);
    assert.equal(f.element('waiting').hidden, true);
    assert.equal(f.element('touch-surface').classList.contains('stale'), true);
    oldCallbacks.forEach(fn => fn(100, { presentedFrames: 100, mediaTime: .1 }));
    const count = f.peers.length;
    ws.onmessage({ data: JSON.stringify({ type: 'rtc-offer', id: 2, sdp: 'offer', sessionId: 7, videoEpoch: 1 }) });
    assert.equal(f.peers.length, count);
    f.advance(2000); assert.equal(f.element('waiting').hidden, false);
    ws.onmessage({ data: videoPacket(2) }); finishJpeg(f);
    assert.equal(f.element('held-frame').hidden, true);
    assert.equal(f.element('waiting').hidden, true);
  }
});

test('stopped media immediately covers an old image and a reconnected session needs a fresh frame', async () => {
  const f = fixture(), old = await f.connect(); mediaStatus(old);
  old.onmessage({ data: videoPacket(1) }); finishJpeg(f);
  mediaStatus(old, { videoEpoch: 2, sourceState: 'stopped', streaming: false, inputReady: false });
  assert.equal(f.element('waiting').hidden, false);
  old.close(); const current = await f.connect(); mediaStatus(current, { videoEpoch: 3 });
  f.advance(2000); assert.equal(f.element('waiting').hidden, false);
  current.onmessage({ data: videoPacket(3) }); finishJpeg(f);
  assert.equal(f.element('waiting').hidden, true);
});


test('Direct Canvas waits for drawing and never creates Video through recovery, fallback and reconnection', async () => {
  const f = fixture({ storedMode: 'track-canvas' }), ws = await f.connect();
  f.frame(ws);
  ws.onmessage({ data: {} }); const lateJpeg = f.element('screen-next').onload;
  await f.offer(ws);
  assert.equal(ws.sent.some(m => m.type === 'rtc-ready'), false);
  assert.equal(f.element('screen').hidden, false);
  const frame = await f.decoded(); assert.equal(frame.closes, 1);
  assert.equal(ws.sent.filter(m => m.type === 'rtc-ready').length, 1);
  lateJpeg(); assert.equal(f.element('screen').hidden, true);
  assert.equal(f.element('video-canvas').hidden, false);
  assert.equal(f.processors[0].init.maxBufferSize, 1);
  const peer = f.peers.at(-1);
  peer.connectionState = 'disconnected'; peer.onconnectionstatechange();
  assert.equal(f.element('video-canvas').hidden, false);
  peer.connectionState = 'connected'; peer.onconnectionstatechange();
  f.pointer('pointerdown', 100, 'touch-surface');
  f.processors.at(-1).pending.shift()({ done: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ws.readyState, 1);
  assert.equal(f.stats().presentation.fallbackReason, 'track-ended');
  assert.equal(f.element('video-canvas').width, 0);
  assert.equal(ws.sent.filter(m => m.type === 'touch').at(-1).contacts.length, 0);
  f.frame(ws); assert.equal(['screen', 'screen-next', 'screen-third'].some(id => !f.element(id).hidden), true);
  ws.close();
  const next = await f.connect(); await f.offer(next, 2); await f.decoded();
  assert.equal(f.createdVideos.length, 0);
  assert.equal(f.stats().presentation.activeMode, 'track-canvas');
  assert.equal(f.processors[0].released, true);
});

test('unsupported Direct Canvas skips rtc-start and handles an unexpected offer without Video', async () => {
  const f = fixture({ storedMode: 'track-canvas', processorAvailable: false }), ws = await f.connect();
  assert.equal(f.element('renderer-hint').hidden, false);
  for (let i = 0; i < 3; i++) ws.onmessage({ data: JSON.stringify({ type: 'status', streaming: true, rtcAvailable: true }) });
  assert.equal(ws.sent.some(m => m.type === 'rtc-start'), false);
  f.frame(ws);
  assert.match(f.element('status').textContent, /直接 Canvas 不可用/);
  ws.onmessage({ data: JSON.stringify({ type: 'rtc-offer', id: 9, sdp: 'offer' }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ws.sent.filter(m => m.type === 'rtc-fallback').length, 1);
  assert.equal(f.createdVideos.length, 0);
  assert.equal(f.preferences.get('wheelplay.videoRenderer'), 'track-canvas');
});

test('Direct Canvas resize controls touch mapping even after server status reports landscape', async () => {
  const f = fixture({ storedMode: 'track-canvas' }), ws = await f.connect(); await f.offer(ws);
  await f.decoded(720, 1280);
  ws.onmessage({ data: JSON.stringify({ type: 'status', width: 1280, height: 720, streaming: true }) });
  f.pointer('pointerdown', 100, 'touch-surface');
  assert.equal(ws.sent.some(m => m.type === 'touch'), false, 'Pillarbox is not touchable');
  f.pointer('pointerdown', 640, 'touch-surface');
  assert.equal(ws.sent.filter(m => m.type === 'touch').at(-1).contacts[0].x, .5);
  assert.equal(f.element('video-canvas').width, 720);
  assert.equal(f.element('video-canvas').height, 1280);
  f.pointer('pointerup', 640, 'touch-surface');
  await f.decoded(1280, 720); f.pointer('pointerdown', 100, 'touch-surface');
  assert.ok(ws.sent.filter(m => m.type === 'touch').at(-1).contacts[0].x < .1);
});

test('Direct Canvas drawing errors use JPEG and do not change browser audio or the connection', async () => {
  const f = fixture({ storedMode: 'track-canvas', canvasAvailable: false }), ws = await f.connect(); await f.offer(ws);
  assert.equal(ws.readyState, 1); assert.equal(f.createdVideos.length, 0);
  assert.equal(f.stats().presentation.fallbackReason, 'renderer-error');
  assert.equal(f.stats().presentation.activeMode, 'waiting');
  assert.equal(f.element('renderer-track-canvas').checked, true);
  f.pointer('pointerdown'); assert.equal(ws.sent.some(m => m.type === 'touch'), false);
  f.frame(ws); f.pointer('pointerdown'); f.pointer('pointerup');
  assert.equal(ws.sent.filter(m => m.type === 'touch').length, 2);
});

test('Direct Canvas failures freeze the last frame until the fallback image is decoded', async () => {
  for (const failure of ['draw', 'end']) {
    const f = fixture({ storedMode: 'track-canvas' }), ws = await f.connect();
    const canvas = f.element('video-canvas'), held = f.element('held-frame');
    let failDraw = false, copied = false;
    canvas.getContext = () => ({ drawImage() { if (failDraw) throw new Error('draw failed'); } });
    held.getContext = () => ({ drawImage(source) {
      assert.equal(source, canvas); assert.equal(source.hidden, false);
      assert.equal(source.width, 1280); assert.equal(source.height, 720);
      copied = true;
    } });
    await f.offer(ws); await f.decoded();
    f.pointer('pointerdown', 100, 'touch-surface');
    if (failure === 'draw') { failDraw = true; await f.decoded(); }
    else {
      f.processors.at(-1).pending.shift()({ done: true });
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(copied, true); assert.equal(held.hidden, false);
    assert.equal(canvas.width, 0); assert.equal(f.element('waiting').hidden, true);
    assert.deepEqual(ws.sent.filter(m => m.type === 'touch').at(-1).contacts, []);
    assert.equal(f.processors[0].canceled, true); assert.equal(f.processors[0].released, true);
    assert.equal(ws.sent.filter(m => m.type === 'rtc-fallback').length, 1);
    ws.onmessage({ data: {} });
    assert.equal(held.hidden, false, 'Keep the snapshot while the fallback image is loading');
    [f.element('screen'), f.element('screen-next'), f.element('screen-third')].find(image => image.onload).onload();
    assert.equal(held.hidden, true); assert.equal(held.width, 0);
    assert.equal(f.createdVideos.length, 0);
  }
});

test('an automatic retry keeps the launch mode until the user starts a new display session', async () => {
  const f = fixture({ storedMode: 'track-canvas' }), ws = await f.connect();
  f.select('native'); ws.close();
  const retry = [...f.timers.values()].find(t => t.delay === 1000);
  await retry.fn();
  const replacement = f.sockets.at(-1); replacement.readyState = 1; replacement.onopen();
  assert.equal(f.stats().presentation.selectedMode, 'track-canvas');
  await f.offer(replacement); await f.decoded();
  assert.equal(f.createdVideos.length, 0);
  f.element('disconnect').handlers.click();
  const next = await f.connect(); await f.offer(next);
  assert.equal(f.stats().presentation.selectedMode, 'native');
  assert.equal(f.createdVideos.length, 1);
});

test('late JPEG errors cannot close a live Canvas stream or a replacement connection', async () => {
  const f = fixture({ storedMode: 'track-canvas' }), ws = await f.connect();
  ws.onmessage({ data: {} }); const oldError = f.element('screen').onerror;
  await f.offer(ws); await f.decoded();
  oldError(); assert.equal(ws.readyState, 1);
  ws.close(); const replacement = await f.connect();
  oldError(); assert.equal(replacement.readyState, 1);
  assert.equal(f.createdVideos.length, 0);
});

test('a replaced JPEG load cannot ACK or display an obsolete image in the same session', async () => {
  const f = fixture(), ws = await f.connect();
  ws.onmessage({ data: {} }); const oldLoad = f.element('screen').onload;
  ws.onmessage({ data: {} });
  f.element('screen-next').onload();
  const before = ws.sent.length; oldLoad(); assert.equal(ws.sent.length, before);
  assert.equal(f.element('screen-next').hidden, false);
  assert.equal(f.element('screen').hidden, true);
});

test('Direct Canvas preserves versioned media isolation and input readiness across an RTC rebuild', async () => {
  const f = fixture({ storedMode: 'track-canvas' }), ws = await f.connect(); mediaStatus(ws);
  await f.offer(ws, 1, { sessionId: 7, videoEpoch: 1 }); await f.decoded();
  f.pointer('pointerdown', 100, 'touch-surface');
  mediaStatus(ws, { videoEpoch: 2, sourceState: 'recovering', inputReady: false });
  assert.deepEqual(ws.sent.filter(m => m.type === 'input').at(-1), { type: 'input', kind: 'release', sessionId: 7, videoEpoch: 2 });
  assert.equal(f.element('held-frame').hidden, false);
  assert.equal(f.element('touch-surface').classList.contains('stale'), true);
  const count = f.peers.length;
  ws.onmessage({ data: JSON.stringify({ type: 'rtc-offer', id: 2, sdp: 'offer', sessionId: 7, videoEpoch: 1 }) });
  assert.equal(f.peers.length, count);
  mediaStatus(ws, { videoEpoch: 2 });
  await f.offer(ws, 3, { sessionId: 7, videoEpoch: 2 }); await f.decoded(720, 1280);
  assert.equal(f.element('held-frame').hidden, true);
  assert.equal(f.element('touch-surface').classList.contains('stale'), false);
  f.pointer('pointerdown', 640, 'touch-surface');
  assert.equal(ws.sent.filter(m => m.type === 'touch').at(-1).videoEpoch, 2);
  assert.equal(f.createdVideos.length, 0);
});

test('Direct Canvas retries over v3 WebP without Video and only switches after the first new draw', async () => {
  const f = fixture({ storedMode: 'track-canvas' }), ws = await f.connect(); mediaStatus(ws);
  await f.offer(ws, 1, { sessionId: 7, videoEpoch: 1 }); await f.decoded();
  f.peers.at(-1).connectionState = 'failed'; f.peers.at(-1).onconnectionstatechange();
  ws.onmessage({ data: videoPacket(1, { protocol: 3, sequence: 17, format: 2 }) }); const image = finishJpeg(f);
  assert.match(f.element('status').textContent, /WebP/);
  assert.deepEqual(ws.sent.filter(m => m.type === 'ack').at(-1), { type: 'ack', sessionId: 7, videoEpoch: 1, sequence: 17 });
  mediaStatus(ws, { rtcAvailable: false }); mediaStatus(ws, { rtcAvailable: true });
  await f.offer(ws, 2, { sessionId: 7, videoEpoch: 1 });
  assert.equal(image.hidden, false);
  f.pointer('pointerdown', 100, 'touch-surface'); f.pointer('pointerup', 100, 'touch-surface');
  await f.decoded();
  assert.equal(image.hidden, true);
  assert.equal(f.stats().presentation.activeMode, 'track-canvas');
  assert.equal(f.stats().presentation.fallbackReason, null);
  assert.equal(f.createdVideos.length, 0);
});

test('a browser without RTCPeerConnection never requests an offer', async () => {
  const f = fixture({ peerAvailable: false }), ws = await f.connect();
  mediaStatus(ws, { rtcAvailable: true });
  assert.equal(ws.sent.some(m => m.type === 'rtc-start'), false);
});

test('?diag=1 names the WebRTC stage on the status line and ?unhide=1 keeps a layout box', async () => {
  const f = fixture({ search: '?diag=1&unhide=1' }), ws = await f.connect();
  ws.onmessage({ data: JSON.stringify({ type: 'status', width: 1280, height: 720, streaming: true, rtcDiag: 'hasPc=1 hasRvfc=1' }) });
  assert.match(f.element('status').textContent, /WebRTC: idle/);
  assert.equal(f.element('diag-panel').hidden, false);
  assert.match(f.element('diag-panel').textContent, /hasPc=1 hasRvfc=1/);
  // Assert synchronously after ontrack: the layout box only exists until the first frame.
  ws.onmessage({ data: JSON.stringify({ type: 'rtc-offer', id: 1, sdp: 'offer' }) });
  await new Promise(resolve => setImmediate(resolve));
  f.peers.at(-1).ontrack({ track: { stop() {} }, streams: [{}] });
  const video = f.createdVideos.at(-1);
  assert.equal(video.hidden, false);
  assert.equal(video.classList.contains('pending-video'), true);
  assert.equal(video.classList.contains('offscreen-video'), false);
  const hidden = fixture(), hiddenWs = await hidden.connect();
  hiddenWs.onmessage({ data: JSON.stringify({ type: 'status', width: 1280, height: 720, streaming: true, rtcDiag: 'hasPc=1' }) });
  assert.doesNotMatch(hidden.element('status').textContent, /WebRTC:/);
  assert.equal(hidden.element('diag-panel').hidden, true);
});

test('browser GPS option forwards through the authenticated stream and stops on socket loss', async () => {
  let deliver, clears = 0, queries = 0;
  const f = fixture({ locationBrowser: {
    permissions: { async query() { queries++; return { state: 'granted' }; } },
    geolocation: { watchPosition(success) { deliver = success; return 0; }, clearWatch() { clears++; } },
  } });
  const option = f.element('browser-location');
  assert.equal(option.checked, false); assert.equal(queries, 0);
  option.checked = true; option.handlers.change(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(option.checked, true); assert.equal(deliver, undefined);
  const ws = await f.connect(); await new Promise(resolve => setImmediate(resolve));
  deliver({ timestamp: Date.now(), coords: { latitude: 25, longitude: 121, accuracy: 5 } });
  const packet = ws.sent.find(m => m.type === 'location');
  assert.equal(packet.latitude, 25); assert.equal(packet.longitude, 121);
  assert.ok(ws.sent.findIndex(m => m.type === 'location-start') < ws.sent.indexOf(packet));
  ws.close(); assert.equal(clears, 1);
  const count = ws.sent.length;
  deliver({ timestamp: Date.now(), coords: { latitude: 26, longitude: 121, accuracy: 5 } });
  assert.equal(ws.sent.length, count);
});

test('the paired socket publishes phone state to Media Session and clears it before reconnecting', async () => {
  const handlers = new Map(), positions = [];
  const session = { setActionHandler: (action, fn) => handlers.set(action, fn), setPositionState: value => positions.push(value) };
  const f = fixture({ mediaSession: session }), ws = await f.connect();
  assert.match(ws.url, /nowPlaying=1/);
  const state = { type: 'now-playing', sessionId: 'phone', revision: 1, connectionGeneration: 3, trackRevision: 4,
    connected: true, available: true, title: 'Song', artist: 'Artist', status: 'playing', durationMs: 60000, positionMs: 1000, speed: 1 };
  ws.onmessage({ data: JSON.stringify(state) });
  assert.equal(session.metadata.title, 'Song'); assert.equal(session.playbackState, 'playing');
  assert.equal(positions.at(-1).position, 1);
  const pause = handlers.get('pause'); pause();
  assert.equal(ws.sent.at(-1).type, 'media-command'); assert.equal(ws.sent.at(-1).connectionGeneration, 3);
  ws.onmessage({ data: JSON.stringify({ type: 'media-command-result', requestId: 1, result: 'sent' }) });
  assert.equal(session.playbackState, 'playing');
  ws.close();
  assert.equal(session.metadata, null); assert.equal(session.playbackState, 'none');
  const count = ws.sent.length; pause(); assert.equal(ws.sent.length, count);
  ws.onmessage({ data: JSON.stringify({ ...state, revision: 2 }) });
  assert.equal(session.metadata, null);
});

test('a busy reply holds the landing page instead of cycling the auto-launch loop', async () => {
  const f = fixture(), ws = await f.connect();
  // Another head unit owns the stream: the reason is shown once, and no timer re-enters
  // connecting - that loop was the flicker a second browser showed while the first stayed.
  ws.onmessage({ data: JSON.stringify({ type: 'busy', message: '已有车机连接' }) });
  assert.equal(f.element('status').textContent, '已有车机连接');
  assert.equal(f.element('message').textContent, '已有车机连接');
  f.advance(30000);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.element('status').textContent, '已有车机连接');
  // Once the other head unit leaves, the retry button is the way back in.
  assert.equal(f.element('connect-form').hidden, false);
  await f.connect();
  assert.equal(f.sockets.length, 2);
});

test('a codec first frame survives a version change between vcs-start and decoding', async () => {
  const f = fixture({ videoDecoder: true }), ws = await f.connect();
  f.status(ws);
  await f.vcsStart(ws);
  assert.equal(f.videoDecoders.length, 1);
  // A source reconfiguration advances the version without stopping the codec stream. Committing
  // with the stale start-time revision used to discard this frame: the screen kept the last
  // JPEG, the JPEG encoder had already stopped, and touch stayed disabled until a page refresh.
  f.v2Frame(ws, 2);
  f.codecFrame(ws);
  // The next 400 ms heartbeat carries the new version's input readiness; touch is only enabled
  // once the service says the HID channel is live, never inferred from the picture itself.
  f.status(ws, { videoEpoch: 2, inputReady: true });
  assert.equal(f.stats().presentation.activeMode, 'codec');
  assert.equal(f.element('waiting').hidden, true);
  assert.equal(f.element('touch-surface').classList.contains('stale'), false);
  assert.equal(f.element('video-canvas').hidden, false);
  f.advance(3000);
  assert.equal(f.sockets.length, 1, 'a committed frame must not trigger the recovery reconnect');
});

test('a first frame the controller refuses rebuilds the socket instead of freezing', async () => {
  const f = fixture({ videoDecoder: true }), ws = await f.connect();
  f.status(ws);
  await f.vcsStart(ws);
  f.status(ws, { sourceState: 'stopped' });
  f.codecFrame(ws);
  assert.equal(f.element('waiting').hidden, false, 'the refused frame leaves the waiting overlay up');
  assert.equal(f.element('video-canvas').classList.contains('stale'), true);
  f.fireWatchdog();
  assert.equal(ws.readyState, 3, 'the stale session is closed');
  assert.equal(f.recoveryCount(), 1);
  await f.reconnect();
  assert.equal(f.sockets.length, 2, 'the existing reconnect path opens a fresh session');
});

test('frame-commit recovery is bounded so a broken head unit cannot reconnect forever', async () => {
  const f = fixture({ videoDecoder: true });
  const fail = async ws => {
    f.status(ws);
    await f.vcsStart(ws);
    f.status(ws, { sourceState: 'stopped' });
    f.codecFrame(ws);
    f.fireWatchdog();
  };
  const first = await f.connect();
  await fail(first);
  assert.equal(first.readyState, 3);
  await f.reconnect();
  assert.equal(f.sockets.length, 2);
  const second = f.sockets.at(-1); second.readyState = 1; second.onopen();
  await fail(second);
  assert.equal(second.readyState, 3);
  await f.reconnect();
  assert.equal(f.sockets.length, 3);
  const third = f.sockets.at(-1); third.readyState = 1; third.onopen();
  await fail(third);
  assert.equal(third.readyState, 1, 'a third refusal leaves the session alone');
  assert.equal(f.sockets.length, 3);
  assert.equal(f.recoveryCount(), 2);
});
