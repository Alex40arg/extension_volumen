const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createHarness, source, clone } = require('./harness.cjs');

(async () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.version, '0.9.0');
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.deepEqual(manifest.permissions, ['offscreen', 'tabCapture', 'storage', 'activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
  for (const file of ['popup/popup.js', 'background/service-worker.js', 'background/presets.js', 'shared/presets.js', 'audio/offscreen.js']) {
    new vm.Script(source(file));
    assert.doesNotMatch(source(file), /fetch\s*\(|XMLHttpRequest|WebSocket|storage\.sync|innerHTML/);
  }
  for (const file of ['popup/popup.js', 'popup/popup.html', 'popup/popup.css', 'background/service-worker.js']) {
    assert.doesNotMatch(source(file), /flat-button|flatButton|setFlatEqualizer|FLAT_EQ/);
  }
  const h = createHarness();
  const command = async (type, data) => {
    const result = await h.command(type, data);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const expectedDefault = { enabled: false, backend: null, volume: 100, muted: false, eqEnabled: false, analyzerEnabled: false, eqDirty: false, eqGains: [0,0,0,0,0,0,0], selectedPreset: 'Flat' };
  assert.deepEqual(clone((await command('GET_STATE')).state), expectedDefault);
  await command('APPLY_EQ_PRESET', { preset: 'Soft V' });
  assert.equal(h.state.captures, 0, 'Loading while OFF never captures audio');
  const curve = [4,3,-1,-3,-1,2,4];
  const saved = await command('PRESETS_SAVE', { name: '  Alex V  ', gains: curve });
  const id = saved.presets[0].id;
  assert.equal(saved.presets[0].name, 'Alex V');
  assert.equal((await command('GET_STATE')).state.selectedPreset, id);
  assert.deepEqual(Object.keys(h.state.storage), ['customPresets']);
  assert.deepEqual(Object.keys(h.state.storage.customPresets[0]).sort(), ['gains','id','name']);
  assert.equal((await h.command('PRESETS_SAVE', { name: 'alex v', gains: curve })).ok, false);
  for (const name of ['', ' ', 'soft v', 'Custom', 'A'.repeat(31), 'bad\nname']) {
    assert.equal((await h.command('PRESETS_SAVE', { name, gains: curve })).ok, false, name);
  }
  assert.equal((await h.command('PRESETS_SAVE', { name: 'Invalid', gains: [13,0,0,0,0,0,0] })).ok, false);
  assert.equal((await h.command('PRESETS_RENAME', { id: 'Flat', name: 'Override' })).ok, false);
  assert.equal((await h.command('PRESETS_DELETE', { id: 'Soft V' })).ok, false);
  await command('ENABLE');
  await command('SET_EQ_ENABLED', { eqEnabled: true });
  await command('SET_VOLUME', { volume: 135 });
  await command('SET_MUTED', { muted: true });
  await command('APPLY_EQ_PRESET', { preset: 'Flat' });
  let state = (await command('APPLY_EQ_PRESET', { preset: id })).state;
  assert.deepEqual(clone(state.eqGains), curve);
  assert.equal(state.volume, 135); assert.equal(state.muted, true); assert.equal(state.eqEnabled, true);
  await command('PRESETS_RENAME', { id, name: 'Mi V' });
  assert.equal(h.state.storage.customPresets[0].name, 'Mi V');
  assert.deepEqual(h.state.storage.customPresets[0].gains, curve);
  assert.equal((await command('GET_STATE')).state.selectedPreset, id);
  await command('APPLY_EQ_PRESET', { tabId: 2, preset: 'Bass' });
  assert.equal((await command('GET_STATE', { tabId: 2 })).state.selectedPreset, 'Bass');
  await command('APPLY_EQ_PRESET', { tabId: 2, preset: id });
  await command('PRESETS_DELETE', { id });
  for (const tabId of [1,2]) {
    state = (await command('GET_STATE', { tabId })).state;
    assert.equal(state.selectedPreset, 'Custom');
    assert.deepEqual(clone(state.eqGains), curve);
  }
  assert.equal(h.state.storage.customPresets.length, 0);
  state = (await command('DISABLE')).state;
  assert.equal(state.volume, 100); assert.equal(state.muted, false); assert.equal(state.eqEnabled, true);
  state = (await command('ENABLE')).state;
  assert.equal(state.volume, 100); assert.equal(state.muted, false); assert.deepEqual(clone(state.eqGains), curve);
  await command('SET_EQ_ENABLED', { eqEnabled: false });
  state = (await command('APPLY_EQ_PRESET', { preset: 'Treble' })).state;
  assert.equal(state.eqEnabled, false);
  assert.deepEqual(clone(vm.runInContext('sessions.get(1).eqFilters.map(filter => filter.gain.value)', h.audio)), [0,0,0,0,0,0,0]);
  await command('SET_EQ_BAND', { bandIndex: 0, gain: 7 });
  assert.equal((await command('GET_STATE')).state.selectedPreset, 'Custom');
  const results = await Promise.all(Array.from({ length: 8 }, () => h.command('PRESETS_SAVE', { name: 'Rock <test>', gains: curve })));
  assert.equal(results.filter((result) => result.ok).length, 1, 'Concurrent duplicate writes are rejected');
  assert.equal(h.state.storage.customPresets.length, 1);
  assert.equal(h.state.storage.customPresets[0].name, 'Rock <test>');
  assert.equal((await command('GET_STATE')).state.selectedPreset, 'Custom', 'Saving an older curve must not overwrite current edits');
  const persisted = clone(h.state.storage);
  h.state.failWrite = true;
  for (const [type, data] of [
    ['PRESETS_SAVE', { name: 'Fail', gains: curve }],
    ['PRESETS_RENAME', { id: persisted.customPresets[0].id, name: 'Fail' }],
    ['PRESETS_DELETE', { id: persisted.customPresets[0].id }]
  ]) assert.equal((await h.command(type, data)).ok, false);
  assert.deepEqual(h.state.storage, persisted);
  h.state.failWrite = false;
  h.state.failRead = true;
  assert.equal((await h.command('PRESETS_LIST')).ok, false);
  h.state.failRead = false;
  await command('PRESETS_SAVE', { name: 'Recovery', gains: curve });
  assert.equal(h.state.storage.customPresets.length, 2, 'Queue recovers after storage errors');
  const restarted = createHarness(h.state.storage);
  assert.equal((await restarted.command('PRESETS_LIST')).presets.length, 2);
  assert.deepEqual(clone((await restarted.command('GET_STATE')).state), expectedDefault);
  await h.closeTab(1);
  assert.deepEqual(clone((await command('GET_STATE')).state), expectedDefault);
  const good = persisted.customPresets[0];
  const corrupt = createHarness({ customPresets: [null, {}, good, {...good}, {...good, id: 'user:00000000-0000-0000-0000-000000000001', name: 'Flat'}, {...good, gains: [0]}, {...good, gains: [NaN,0,0,0,0,0,0]}, {...good, gains: [0.5,0,0,0,0,0,0]}] });
  assert.equal((await corrupt.command('PRESETS_LIST')).presets.length, 1);
  assert.equal((await createHarness({customPresets: 'bad'}).command('PRESETS_LIST')).presets.length, 0);
  const original = source('old_versions/v0.5/audio/offscreen.js');
  const originalContext = vm.createContext({ chrome: { runtime: { onMessage: { addListener() {} } } } });
  vm.runInContext(original, originalContext);
  // v0.7 adds analyser lifecycle and dirty state; the audible DSP stays unchanged.
  for (const name of ['rampAudioParam','applyGain','applyEq','setVolume','setMuted','setEqEnabled']) {
    assert.equal(vm.runInContext(`${name}.toString()`, h.audio), vm.runInContext(`${name}.toString()`, originalContext), `${name} unchanged`);
  }
  assert.deepEqual(clone(vm.runInContext('EQ_PRESETS', h.audio)), clone(vm.runInContext('EQ_PRESETS', originalContext)));
  console.log('PASS: v0.6 storage CRUD, validation, concurrent writes, failures/recovery, per-tab lifecycle, factory protection, privacy, unchanged DSP and safe defaults.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
