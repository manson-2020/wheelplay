// A new browser ES module has to be registered in three places: the Android server's static
// asset whitelist, the local preview server's file map, and the VM harnesses that concatenate the
// module graph. Missing any one of them 404s the import at runtime - on a head unit the whole
// page dies with no console to explain why. This audit keeps all of them equal to the directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => readFileSync(path.join(root, relative), 'utf8');
const onDisk = readdirSync(path.join(root, 'common/src/main/assets/web'))
  .filter(name => name.endsWith('.js')).sort();
const names = text => [...text.matchAll(/'([a-z0-9-]+\.js)'/g)].map(match => match[1]);

function listed(file, declaration) {
  const match = read(`test/${file}`).match(new RegExp(`${declaration} = \\[([\\s\\S]*?)\\]`));
  assert.ok(match, `${file} must declare ${declaration}`);
  return names(match[1]);
}

test('every browser module is served by the Android server and the local preview', () => {
  const server = [...read('common/src/main/java/com/shilapi/xcertplay/web/LanWebServer.kt')
    .matchAll(/"\/([a-z0-9-]+\.js)"\s*->/g)].map(match => match[1]).sort();
  const preview = [...read('scripts/preview.mjs')
    .matchAll(/'\/([a-z0-9-]+\.js)':\s*'[a-z0-9-]+\.js'/g)].map(match => match[1]).sort();
  assert.deepEqual(server, onDisk, 'LanWebServer.kt static asset whitelist is incomplete');
  assert.deepEqual(preview, onDisk, 'scripts/preview.mjs static asset map is incomplete');
});

test('test harnesses and the import audit cover the whole module graph', () => {
  assert.deepEqual(listed('web-modules.test.js', 'const files').sort(), onDisk);
  const mainGraph = onDisk.filter(name => name !== 'audio-worklet.js').sort();
  for (const file of ['pairing.test.js', 'stream-client.test.js']) {
    const modules = listed(file, 'const source');
    assert.deepEqual([...modules].sort(), mainGraph, `${file} module list is incomplete`);
    assert.equal(modules.at(-1), 'app.js', `${file} must load app.js last`);
  }
});
