import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resourceStrings, renderBrowserTemplate } from '../scripts/resource-strings.mjs';
import { t } from '../common/src/main/assets/web/text.js';

const template = readFileSync(new URL('../common/src/main/assets/web/index.html', import.meta.url), 'utf8');

test('every ES module the web page imports is whitelisted by the web server', () => {
  // The server only serves hand-listed assets; a new module missing from that when-block makes
  // the whole import graph fail on the head unit and the page stays dead (silent, no console).
  const server = readFileSync(new URL('../common/src/main/java/com/shilapi/xcertplay/web/LanWebServer.kt', import.meta.url), 'utf8');
  const dir = new URL('../common/src/main/assets/web/', import.meta.url);
  const imported = new Set();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.js') || name === 'audio-worklet.js') continue;
    const source = readFileSync(new URL(name, dir), 'utf8');
    for (const match of source.matchAll(/from\s*'\.\/([a-z-]+\.js)'/g)) imported.add(match[1]);
  }
  for (const name of ['text.js', 'desktop-input.js', 'audio-worklet.js']) imported.add(name);
  assert.ok(imported.size > 10, `expected the real module graph, found ${[...imported].join(', ')}`);
  for (const name of imported) {
    assert.match(server, new RegExp(`"/${name.replace('.', '\\.')}" ->`), `LanWebServer must whitelist /${name}`);
  }
});
test('all browser messages exist in each Android resource catalog', () => {
  for (const module of ['shared', 'common']) {
    const base = resourceStrings('values', module);
    const argumentsIn = value => [...value.matchAll(/%(\d+)\$[0-9]*([a-zA-Z])/g)].map(match => match[1] + match[2]).sort();
    for (const qualifier of ['values-zh-rCN', 'values-zh-rTW']) {
      const catalog = resourceStrings(qualifier, module);
      assert.deepEqual(Object.keys(catalog).sort(), Object.keys(base).sort());
      for (const key of Object.keys(base)) assert.deepEqual(argumentsIn(catalog[key]), argumentsIn(base[key]), key);
    }
  }
  for (const [qualifier, title] of [['values', 'Connect your CarPlay display'], ['values-zh-rCN', '连接 CarPlay 车机屏幕'], ['values-zh-rTW', '連線 CarPlay 車機螢幕']]) {
    const messages = resourceStrings(qualifier), html = renderBrowserTemplate(template, messages);
    assert.ok(html.includes(title));
    assert.ok(!html.includes('{{'));
  }
});
test('localized messages preserve positional arguments without interpreting their contents', () => {
  globalThis.wheelplayMessages = { test: '%2$s / %1$s / %2$s' };
  try { assert.equal(t('test', '$& <script>', 'iPhone'), 'iPhone / $& <script> / iPhone'); }
  finally { delete globalThis.wheelplayMessages; }
});
test('browser template interpolation escapes markup', () => {
  assert.equal(renderBrowserTemplate('<p>{{text}}</p>', { text: '"<&' }), '<p>&quot;&lt;&amp;</p>');
});

test('Android exports every browser template and literal message key, not just the desktop fixture', () => {
  const android = readFileSync(new URL('../common/src/main/java/com/shilapi/xcertplay/web/BrowserStrings.kt', import.meta.url), 'utf8');
  const keys = new Set([...android.matchAll(/"([a-z0-9_]+)"\s+to\s+UiR\.string\.([a-z0-9_]+)/g)].map(match => {
    assert.equal(match[1], match[2]); return match[1];
  }));
  const required = [...template.matchAll(/\{\{([a-z0-9_]+)\}\}/g)].map(match => match[1]);
  for (const name of ['app.js', 'phone-gauge.js', 'browser-audio.js', 'browser-location.js']) {
    const js = readFileSync(new URL(`../common/src/main/assets/web/${name}`, import.meta.url), 'utf8');
    required.push(...[...js.matchAll(/\bt\(['"]([a-z0-9_]+)['"]/g)].map(match => match[1]));
  }
  for (const key of required) if (key !== 'locale') assert.ok(keys.has(key), `Android BrowserStrings is missing ${key}`);
});

test('connection status and its actions live in the drawer, with no top bar or hide option', () => {
  assert.doesNotMatch(template, /<header|id="topbar"|id="hide-toolbar"/);
  const aside = template.indexOf('<aside id="settings-drawer"');
  const end = template.indexOf('</aside>');
  assert.ok(aside > 0 && end > aside);
  for (const id of ['status', 'fullscreen', 'disconnect', 'diag-toggle', 'settings-close']) {
    const at = template.indexOf(`id="${id}"`);
    assert.ok(at > aside && at < end, `${id} must live inside the drawer`);
  }
  assert.ok(template.indexOf('id="settings-toggle"') < aside, 'the pairing page keeps a drawer entry');
});

test('auto full screen is a preference and the footer button is a separate one-shot toggle', () => {
  const option = template.match(/<label class="launch-option" for="fullscreen-on-start">[\s\S]*?<\/label>/);
  assert.ok(option, 'the auto full screen option exists');
  assert.match(option[0], /\{\{web_auto_full_screen\}\}/);
  assert.match(option[0], /\{\{web_auto_full_screen_help\}\}/);
  assert.doesNotMatch(template, /web_hide_top_bar_enter_full_screen_on_start|web_enter_full_screen_when_starting_and_hide_the_top/);
  assert.match(template, /id="fullscreen" type="button"[^>]*>\{\{web_full_screen\}\}/);
  const body = template.indexOf('class="drawer-body"'), foot = template.indexOf('class="drawer-foot"');
  assert.ok(template.indexOf('id="fullscreen-on-start"') > body, 'the preference is in the scrolling settings');
  assert.ok(template.indexOf('id="fullscreen"') > foot, 'the one-shot button is in the fixed footer');
});
