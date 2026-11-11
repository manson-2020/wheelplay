import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resourceStrings } from '../scripts/resource-strings.mjs';
const messages = resourceStrings('values-zh-rCN');

const source = ['text.js', 'desktop-input.js', 'browser-audio.js', 'browser-location.js', 'browser-media-session.js', 'phone-gauge.js', 'viewport.js', 'presentation.js', 'media-probes.js', 'jpeg-presenter.js', 'control-outbox.js', 'browser-appearance.js', 'video-renderer.js', 'rtc-receiver.js', 'codec-stream.js', 'app.js']
  .map(name => readFileSync(new URL(`../common/src/main/assets/web/${name}`, import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replaceAll('export function', 'function').replaceAll('export const', 'const')).join('\n');
const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
const savedDevice = { id: 'd'.repeat(32), secret: 's'.repeat(32), name: 'Chrome · Android' };
const ok = data => ({ ok: true, json: async () => data });
function fixture({ status = () => ok({ state: 'pending' }), stored = null,
  resume = () => ok({ token: 'resumed-token', name: savedDevice.name }),
  auto = () => ok({ token: 'auto-token' }),
  storageDisabled = false, search = '', tls = { available: true, port: 8443 },
  href = 'http://server:8080/?code=123456#old', storedOptions = {} } = {}) {
  const elements = new Map(), timers = new Map(), sockets = [], requests = [], windowEvents = {};
  const preferences = new Map([
    ...(stored ? [['wheelplay.browserDevice', JSON.stringify(stored)]] : []),
    ...Object.entries(storedOptions),
  ]);
  let nextTimer = 0;
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { hidden: false, value: '123456', handlers: {}, checked: false,
        set src(value) { this.source = value; if (this.onload) this.onload(); },
        classList: {
          toggle(name, force) { const on = force === undefined ? !classes.has(name) : force; if (on) classes.add(name); else classes.delete(name); },
          add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains(name) { return classes.has(name); },
        },
        removeAttribute(name) { if (name === "href") delete this.href; }, setAttribute() {},
        addEventListener(name, fn) { const previous = this.handlers[name]; this.handlers[name] = previous ? event => { previous(event); fn(event); } : fn; } });
    }
    return elements.get(id);
  };
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; sockets.push(this); }
    close() {}
  }
  const context = { document: { getElementById: element, addEventListener() {} },
    window: { location: { search, pathname: '/', hash: '' }, history: { replaceState() {} },
      addEventListener(name, fn) { windowEvents[name] = fn; },
      localStorage: {
        getItem(key) { if (storageDisabled) throw new Error('denied'); return preferences.get(key) ?? null; },
        setItem(key, value) { if (storageDisabled) throw new Error('denied'); preferences.set(key, value); },
        removeItem(key) { preferences.delete(key); },
      },
    }, location: { host: 'server:8080', href, search }, URL, Date, WebSocket: Socket,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, clearInterval() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/tls.json') return ok(tls);
      if (url.endsWith('/status')) return status();
      if (url.endsWith('/resume')) return resume();
      if (url.endsWith('/remember')) return ok(savedDevice);
      if (url.endsWith('/auto')) return auto();
      if (url.endsWith('/code')) return ok({ token: 'code-token' });
      return ok({ id: 'request', secret: 'poll-secret', expiresIn: 120 });
    },
  };
  context.wheelplayMessages = messages;
  vm.runInNewContext(source, context);
  return { element, sockets, requests, preferences, windowEvents,
    submit: () => element('connect-form').handlers.submit({ preventDefault() {} }),
    poll: () => [...timers.values()].find(t => t.delay === 1000).fn(),
    drawerOpen: () => element('settings-drawer').classList.contains('open'),
    tapDisc: () => {
      const badge = element('phone-status');
      badge.handlers.pointerdown({ button: 0, pointerId: 1, clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} });
      badge.handlers.pointerup({ pointerId: 1 });
    },
  };
}

test('opening the page trusts the browser automatically and connects without pairing UI', async () => {
  const f = fixture();
  await settle();
  assert.deepEqual(f.requests.map(r => r.url), ['/pair/auto', '/pair/remember', '/pair/resume']);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'ws://server:8080/stream?token=resumed-token&media=2&images=3&nowPlaying=1');
  assert.equal(f.element('qr-pairing').hidden, true);
  assert.equal(f.element('code-entry').hidden, true);
  assert.equal(f.element('connect-form').hidden, true);
  assert.equal(f.requests.some(r => r.url.endsWith('/request')), false);
  assert.deepEqual(JSON.parse(f.preferences.get('wheelplay.browserDevice')), savedDevice);
});

test('a remembered browser resumes and connects on every open', async () => {
  const f = fixture({ stored: savedDevice });
  await settle();
  assert.equal(f.requests[0].url, '/pair/resume');
  assert.equal(f.requests[0].options.headers['X-Device-Secret'], savedDevice.secret);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.element('code-entry').hidden, true);
  assert.equal(f.element('qr-pairing').hidden, true);
});

test('?auto=1 remains an alias for the default automatic connection', async () => {
  const f = fixture({ search: '?auto=1' });
  await settle();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.requests[0].url, '/pair/auto');
});

test('?manual=1 keeps QR and code pairing and waits for the launch button', async () => {
  const f = fixture({ search: '?manual=1' });
  await flush();
  assert.equal(f.element('pair-qr').hidden, false);
  assert.equal(f.element('code-entry').hidden, false);
  assert.equal(f.element('connect-form').hidden, false);
  assert.equal(f.sockets.length, 0);
  f.submit(); await settle();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'ws://server:8080/stream?token=code-token&media=2&images=3&nowPlaying=1');
});

test('?manual=1 QR approval remembers the browser and waits for the explicit launch button', async () => {
  const f = fixture({ search: '?manual=1', status: () => ok({ state: 'approved', token: 'browser-token' }) });
  await flush(); assert.equal(f.element('pair-qr').hidden, false);
  await f.poll();
  assert.equal(f.sockets.length, 0);
  assert.equal(f.element('connect-label').textContent, '启动显示');
  assert.deepEqual(JSON.parse(f.preferences.get('wheelplay.browserDevice')), savedDevice);
  f.element('hide-toolbar').checked = true; f.element('renderer-video-canvas').checked = true;
  f.submit(); await settle();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'ws://server:8080/stream?token=resumed-token&media=2&images=3&nowPlaying=1');
  assert.equal(f.element('renderer-video-canvas').checked, true);
  assert.equal(f.requests.some(r => r.url.endsWith('/cancel')), false);
});

test('late QR approval cannot replace a manual code connection', async () => {
  let resolve;
  const f = fixture({ search: '?manual=1', status: () => new Promise(done => { resolve = done; }) });
  await flush(); const polling = f.poll(); f.submit();
  resolve(ok({ state: 'approved', token: 'late-token' }));
  await polling; await settle();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'ws://server:8080/stream?token=code-token&media=2&images=3&nowPlaying=1');
  assert.equal(f.requests.some(r => r.url.endsWith('/cancel')), true);
  assert.equal(f.requests.find(r => r.url.endsWith('/remember')).options.headers['X-Pair-Token'], 'code-token');
});

test('expired QR is removed while manual pairing remains available', async () => {
  const f = fixture({ search: '?manual=1', status: () => ({ ok: false, status: 404 }) });
  await flush(); await f.poll();
  assert.equal(f.element('pair-qr').hidden, true);
  assert.match(f.element('qr-status').textContent, /已过期/);
  assert.equal(f.element('refresh-qr').disabled, false);
  f.submit(); await settle(); assert.equal(f.sockets.length, 1);
});

test('a removed device is cleared and re-trusted automatically on the next open', async () => {
  let calls = 0;
  const f = fixture({ stored: savedDevice, resume: () => ++calls === 1
    ? { ok: false, status: 401 } : ok({ token: 'resumed-token', name: savedDevice.name }) });
  await settle();
  assert.equal(f.requests[0].url, '/pair/resume');
  assert.ok(f.requests.some(r => r.url.endsWith('/auto')));
  assert.equal(f.element('qr-pairing').hidden, true);
  assert.equal(f.sockets.length, 1);
});

test('temporary service failure keeps remembered credentials and the launch retry', async () => {
  let available = false;
  const f = fixture({ stored: savedDevice, resume: () => {
    if (!available) throw new Error('offline');
    return ok({ token: 'recovered-token', name: savedDevice.name });
  } });
  await flush();
  assert.equal(f.preferences.has('wheelplay.browserDevice'), true);
  assert.equal(f.requests.some(r => r.url.endsWith('/auto')), false);
  available = true; f.submit(); await settle();
  assert.equal(f.sockets.at(-1).url, 'ws://server:8080/stream?token=recovered-token&media=2&images=3&nowPlaying=1');
});

test('?code= still pairs by code and then connects automatically', async () => {
  const f = fixture({ search: '?code=123456' }); await settle();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.requests.some(r => r.url.endsWith('/auto')), false);
  assert.equal(f.sockets[0].url, 'ws://server:8080/stream?token=resumed-token&media=2&images=3&nowPlaying=1');
});

test('pagehide keeps device memory and back navigation reconnects automatically', async () => {
  const f = fixture({ stored: savedDevice }); await settle();
  const before = f.sockets.length;
  f.windowEvents.pagehide();
  assert.equal(f.preferences.has('wheelplay.browserDevice'), true);
  assert.equal(f.requests.some(r => r.url.endsWith('/revoke')), false);
  f.windowEvents.pageshow({ persisted: true }); await settle();
  assert.ok(f.sockets.length > before);
});

test('storage-disabled browsers connect automatically without being enrolled', async () => {
  const f = fixture({ storageDisabled: true }); await settle();
  assert.equal(f.requests.some(r => r.url.endsWith('/remember')), false);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].url, 'ws://server:8080/stream?token=auto-token&media=2&images=3&nowPlaying=1');
});

test('revocation between restore and launch requires fresh manual pairing in manual mode', async () => {
  let revoked = false;
  const f = fixture({ search: '?manual=1', stored: savedDevice, resume: () => revoked
    ? { ok: false, status: 401 } : ok({ token: 'old-token', name: savedDevice.name }) });
  await flush(); revoked = true; f.submit(); await settle();
  assert.equal(f.sockets.length, 0);
  f.submit(); await settle();
  assert.equal(f.sockets[0].url, 'ws://server:8080/stream?token=code-token&media=2&images=3&nowPlaying=1');
});

test('tapping the status disc opens the settings drawer from the right', async () => {
  const f = fixture({ stored: savedDevice }); await settle();
  assert.equal(f.drawerOpen(), false);
  f.tapDisc();
  assert.equal(f.drawerOpen(), true);
  assert.equal(f.element('settings-scrim').classList.contains('open'), true);
  f.element('settings-close').handlers.click();
  assert.equal(f.drawerOpen(), false);
});

test('disconnect stops automatic reconnection until the user taps reconnect', async () => {
  const f = fixture({ stored: savedDevice }); await settle();
  const before = f.sockets.length;
  f.element('disconnect').handlers.click();
  await flush();
  assert.equal(f.element('connect-form').hidden, false);
  assert.equal(f.element('connect-label').textContent, '重新连接');
  f.submit(); await settle();
  assert.ok(f.sockets.length > before);
});

test('HTTPS setup uses the configured port and strips pairing data, including IPv6 hosts', async () => {
  for (const [href, expected] of [
    ['http://server:8080/?code=123456#old', 'https://server:9443/'],
    ['http://[fd00::1]:8080/?code=123456', 'https://[fd00::1]:9443/'],
  ]) {
    const f = fixture({ href, tls: { available: true, port: 9443, fingerprint: 'verified' } });
    f.element('secure-setup').open = true;
    await f.element('secure-setup').handlers.toggle();
    assert.equal(f.element('https-entry').href, expected);
    assert.equal(f.element('tls-fingerprint').textContent, 'verified');
  }
});

test('unavailable HTTPS or invalid port withdraws a previously displayed link', async () => {
  for (const tls of [{ available: false, port: 9443 }, { available: true, port: 0 }, { available: true, port: '9443' }]) {
    const f = fixture({ tls });
    f.element('https-entry').href = 'https://server:8443/';
    f.element('secure-setup').open = true;
    await f.element('secure-setup').handlers.toggle();
    assert.equal(f.element('https-entry').href, undefined);
  }
});

test('disabled HTTPS removes the link and explains the app setting', async () => {
  const f = fixture({ tls: { available: false, enabled: false, port: 8443 } });
  f.element('https-entry').href = 'https://server:8443/';
  f.element('secure-setup').open = true;
  await f.element('secure-setup').handlers.toggle();
  assert.equal(f.element('https-entry').href, undefined);
  assert.match(f.element('tls-fingerprint').textContent, /HTTPS 已关闭.*Web 监听/);
});

test('top-bar and fullscreen options are restored from storage and persist on change', () => {
  const f = fixture({ storedOptions: { 'wheelplay.hideToolbar': 'false', 'wheelplay.fullscreenOnStart': 'true' } });
  assert.equal(f.element('hide-toolbar').checked, false);
  assert.equal(f.element('fullscreen-on-start').checked, true);
  f.element('hide-toolbar').checked = true;
  f.element('hide-toolbar').handlers.change({});
  assert.equal(f.preferences.get('wheelplay.hideToolbar'), 'true');
  f.element('fullscreen-on-start').checked = false;
  f.element('fullscreen-on-start').handlers.change({});
  assert.equal(f.preferences.get('wheelplay.fullscreenOnStart'), 'false');
});

test('the drawer debug entry flips its label with the diag parameter', () => {
  const plain = fixture();
  const diag = fixture({ search: '?diag=1' });
  assert.equal(plain.element('diag-toggle').textContent, messages['web_enter_debug_mode']);
  assert.equal(diag.element('diag-toggle').textContent, messages['web_exit_debug_mode']);
});
