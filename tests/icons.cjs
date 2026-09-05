const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHarness, source } = require('./harness.cjs');

const SIZES = [16, 32, 48, 128];
const expectedPaths = (state) => Object.fromEntries(
  SIZES.map((size) => [size, `icons/${state}-${size}.png`])
);

function assertPng(path, size) {
  const png = fs.readFileSync(path);
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', `${path} is a PNG`);
  assert.equal(png.readUInt32BE(16), size, `${path} width`);
  assert.equal(png.readUInt32BE(20), size, `${path} height`);
  assert.equal(png[25], 6, `${path} uses RGBA color`);
}

(async () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.version, '0.8.0');
  assert.deepEqual(manifest.permissions, ['offscreen', 'tabCapture', 'storage']);
  assert.deepEqual(manifest.icons, expectedPaths('inactive'));
  assert.deepEqual(manifest.action.default_icon, expectedPaths('inactive'));

  for (const state of ['inactive', 'active']) {
    for (const size of SIZES) assertPng(`icons/${state}-${size}.png`, size);
  }

  const h = createHarness();
  const command = async (type, tabId) => {
    const response = await h.command(type, { tabId });
    assert.equal(response.ok, true, JSON.stringify(response));
  };
  const lastIcon = (tabId) => h.state.iconCalls.filter((call) => call.tabId === tabId).at(-1);
  const lastTitle = (tabId) => h.state.titleCalls.filter((call) => call.tabId === tabId).at(-1);

  // Tab A: OFF -> gray, ON -> red.
  await command('GET_STATE', 1);
  assert.deepEqual(lastIcon(1).path, expectedPaths('inactive'));
  await command('ENABLE', 1);
  assert.deepEqual(lastIcon(1).path, expectedPaths('active'));
  assert.equal(lastTitle(1).title, 'Tab Audio Control — ON');

  // Tab B remains OFF; switching tabs refreshes only each tab's own override.
  await command('GET_STATE', 2);
  assert.deepEqual(lastIcon(2).path, expectedPaths('inactive'));
  await h.activateTab(2);
  assert.deepEqual(lastIcon(2).path, expectedPaths('inactive'));
  await h.activateTab(1);
  assert.deepEqual(lastIcon(1).path, expectedPaths('active'));
  await command('DISABLE', 1);
  assert.deepEqual(lastIcon(1).path, expectedPaths('inactive'));

  h.state.rejectIconDictionaries = true;
  await command('GET_STATE', 1);
  assert.equal(lastIcon(1).path, 'icons/inactive-32.png');
  h.state.rejectIconDictionaries = false;

  await command('ENABLE', 1);
  await h.chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_SESSION', tabId: 1 });
  await h.sessionEnded(1);
  assert.deepEqual(lastIcon(1).path, expectedPaths('inactive'));
  assert.equal(lastTitle(1).title, 'Tab Audio Control — OFF');

  assert.equal(h.state.iconCalls.some((call) => call.tabId === undefined), false);
  assert.equal(h.state.titleCalls.some((call) => call.tabId === undefined), false);

  await h.closeTab(1);
  assert.equal((await h.command('GET_STATE', { tabId: 1 })).state.enabled, false);
  console.log('PASS: exact RGBA icon files, inactive manifest defaults, dynamic ON/OFF updates, tab switching, unexpected end and independent per-tab icons.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
