import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppearanceReporter } from '../common/src/main/assets/web/app.js';

// A stand-in for the MediaQueryList a head unit exposes; `flip` is what the car does when its
// appearance setting changes.
function mediaQuery(dark = false) {
  const listeners = new Set();
  const media = {
    matches: dark,
    addEventListener: (type, fn) => { if (type === 'change') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'change') listeners.delete(fn); },
    flip(value) { media.matches = value; for (const fn of [...listeners]) fn({ matches: value }); },
    get listeners() { return listeners.size; },
  };
  return media;
}

function fixture(dark = false) {
  const media = mediaQuery(dark), sent = [], seen = [];
  const reporter = createAppearanceReporter({
    send: value => { sent.push(value); return true; },
    query: () => media,
    onChange: value => seen.push(value),
  });
  return { media, sent, seen, reporter };
}

test('connecting reports the head unit preference once', () => {
  const f = fixture(false);
  f.reporter.open();
  assert.deepEqual(f.sent, [{ type: 'browser-appearance', dark: false }]);
  assert.deepEqual(f.seen, [false]);
});

test('a live appearance flip is reported without another poll', () => {
  const f = fixture(false);
  f.reporter.open();
  f.media.flip(true);
  assert.deepEqual(f.sent.at(-1), { type: 'browser-appearance', dark: true });
  f.media.flip(false);
  assert.deepEqual(f.sent.at(-1), { type: 'browser-appearance', dark: false });
  assert.equal(f.sent.length, 3);
});

test('reopening after a reconnect re-reports instead of trusting the last connection', () => {
  const f = fixture(true);
  f.reporter.open();
  f.reporter.close();
  f.reporter.open();
  assert.deepEqual(f.sent, [
    { type: 'browser-appearance', dark: true },
    { type: 'browser-appearance', dark: true },
  ]);
  assert.equal(f.media.listeners, 1, 'listeners must not stack across reconnects');
});

test('refresh re-reads for a page that was hidden while the car changed appearance', () => {
  const f = fixture(false);
  f.reporter.open();
  // No `change` event: some embedded Chromium builds only re-evaluate on reveal.
  f.media.matches = true;
  f.reporter.refresh();
  assert.deepEqual(f.sent.at(-1), { type: 'browser-appearance', dark: true });
});

test('a browser without the media query reports nothing and never forces an appearance', () => {
  const sent = [];
  const reporter = createAppearanceReporter({
    send: value => { sent.push(value); return true; },
    query: () => { throw new Error('unsupported'); },
  });
  reporter.open();
  reporter.refresh();
  assert.deepEqual(sent, []);
});

test('a closed reporter stops listening', () => {
  const f = fixture(false);
  f.reporter.open();
  f.reporter.close();
  f.media.flip(true);
  assert.equal(f.sent.length, 1);
});
