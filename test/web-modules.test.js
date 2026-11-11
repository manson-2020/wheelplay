// Static import audit for the browser ES modules. The VM-sandbox harnesses (pairing, stream
// client) concatenate every module into one scope, so a module that references a sibling's export
// without importing it runs fine in the tests and explodes in a real browser with a ReferenceError
// mid-session - codec-stream.js hid exactly that way after the 2026-11 split, killing the HEVC
// codec stream with an uncaught error between close() and the decoder setup. This test walks every
// module, finds identifiers that name another module's top-level export, and fails when the usage
// has no matching import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(dir, '../common/src/main/assets/web');
const files = ['app.js', 'audio-worklet.js', 'browser-appearance.js', 'browser-audio.js',
  'browser-location.js', 'browser-media-session.js', 'codec-stream.js', 'control-outbox.js',
  'desktop-input.js', 'jpeg-presenter.js', 'media-probes.js', 'phone-gauge.js', 'presentation.js',
  'rtc-receiver.js', 'text.js', 'video-renderer.js', 'viewport.js'];

const source = name => readFileSync(path.join(webDir, name), 'utf8');

const exportedNames = {};
for (const name of files) {
  exportedNames[name] = new Set([...source(name).matchAll(
    /^export (?:const|function|class|let|var) ([A-Za-z_$][\w$]*)/gm)].map(match => match[1]));
}

test('every cross-module identifier is imported by the module that uses it', () => {
  const missing = [];
  for (const name of files) {
    const src = source(name);
    const imported = new Set();
    for (const match of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
      for (const part of match[1].split(',')) {
        const id = part.trim().split(' as ')[0];
        if (id) imported.add(id);
      }
    }
    for (const [other, names] of Object.entries(exportedNames)) {
      if (other === name) continue;
      for (const exported of names) {
        if (imported.has(exported)) continue;
        const lines = src.split('\n');
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          const used = new RegExp(`(?<![\\w$])${exported}(?![\\w$])`).test(line);
          if (!used || line.trim().startsWith('//') || /\bimport\b/.test(line) || /\bfrom\s+'/.test(line)) continue;
          missing.push(`${name}:${index + 1} uses '${exported}' (exported by ${other}) without importing it`);
          break;
        }
      }
    }
  }
  assert.deepEqual(missing, []);
});
