import test from 'node:test';
import assert from 'node:assert/strict';
import { readUrlFlags } from '../common/src/main/assets/web/url-flags.js';

const defaults = {
  diagnostic: false,
  keepVideoVisible: false,
  autoLaunch: true,
  rtcExperiment: '',
  mediaSessionMode: '',
  audioIdleMillis: 5000,
};

test('a plain address keeps the normal user path', () => {
  assert.deepEqual(readUrlFlags(''), defaults);
  assert.deepEqual(readUrlFlags(), defaults);
  assert.deepEqual(readUrlFlags(null), defaults);
  assert.deepEqual(readUrlFlags('?code=123456'), defaults);
});

test('flags are read independently and can be combined', () => {
  assert.deepEqual(readUrlFlags('?diag=1&unhide=1&rtcexp=inactive&ms=2&audioIdle=0&manual=1'), {
    diagnostic: true, keepVideoVisible: true, autoLaunch: false,
    rtcExperiment: 'inactive', mediaSessionMode: '2', audioIdleMillis: 0,
  });
  assert.deepEqual(readUrlFlags('?rtcexp=noanswer&ms=1&audioIdle=250'), {
    ...defaults, rtcExperiment: 'noanswer', mediaSessionMode: '1', audioIdleMillis: 250,
  });
  assert.equal(readUrlFlags('?code=123456&diag=1').diagnostic, true, 'flags work after other parameters');
  assert.equal(readUrlFlags('?manual=1&diag=1').autoLaunch, false);
});

test('each whitelist rejects unknown values instead of leaking them into the state machine', () => {
  for (const search of ['?diag=0', '?diag=11', '?unhide=yes', '?unhide=2', '?ms=3', '?ms=0',
    '?rtcexp=foo', '?rtcexp=noanswerish', '?rtcexp=inactive2', '?audioIdle=abc', '?audioIdle=-5',
    '?manual=2', '?manual=yes']) {
    assert.deepEqual(readUrlFlags(search), defaults, `${search} must fall back to defaults`);
  }
});

test('a value must be followed by a separator or the end of the query', () => {
  assert.equal(readUrlFlags('?diag=1x').diagnostic, false);
  assert.equal(readUrlFlags('?audioIdle=250ms').audioIdleMillis, 5000);
  assert.equal(readUrlFlags('?ms=12').mediaSessionMode, '');
  // location.search always carries the leading '?'; anything else is not a query.
  assert.deepEqual(readUrlFlags('diag=1'), defaults);
});

test('audio idle is a non-negative millisecond number with a 5 s default', () => {
  assert.equal(readUrlFlags('?audioIdle=0').audioIdleMillis, 0);
  assert.equal(readUrlFlags('?audioIdle=000').audioIdleMillis, 0);
  assert.equal(readUrlFlags('?audioIdle=999999').audioIdleMillis, 999999);
});

test('diag=0 never opens the panel, so the drawer button cannot promise an exit', () => {
  // app.js derives both the panel and the button label from `diagnostic`; a second, looser
  // parser used to make ?diag=0 show "Exit debug mode" with no panel behind it.
  const flags = readUrlFlags('?diag=0');
  assert.equal(flags.diagnostic, false);
  assert.equal(readUrlFlags('?diag=1').diagnostic, true);
});
