const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createHarness, source, clone } = require('./harness.cjs');

(async () => {
  const h = createHarness();
  const command = async (type, data) => {
    const result = await h.command(type, data);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.state;
  };
  const read = (tabId = 1) => h.chrome.runtime.sendMessage({ target: 'offscreen', type: 'GET_SPECTRUM', tabId });
  assert.equal((await read()).active, false);
  assert.equal((await h.command('SET_ANALYZER_ENABLED', { analyzerEnabled: true })).ok, false);
  assert.equal(h.state.captures, 0, 'Analysis cannot create a capture');
  await command('ENABLE');
  const session = vm.runInContext('sessions.get(1)', h.audio);
  const analyser = session.analyserNode;
  assert.equal(session.eqFilters.at(-1).connections[0], analyser);
  assert.equal(analyser.connections[0], session.gainNode);
  assert.equal(session.gainNode.connections[0], session.audioContext.destination);
  assert.equal(analyser.fftSize, 2048);
  assert.equal(analyser.smoothingTimeConstant, 0.8);
  assert.equal((await read()).active, false);
  assert.equal(analyser.reads, 0, 'OFF does not read FFT');
  await command('SET_ANALYZER_ENABLED', { analyzerEnabled: true });
  assert.equal(analyser.reads, 0, 'No popup request means no FFT reads');
  assert.deepEqual(clone((await read()).bars), Array(48).fill(0), 'Silence produces no invented bars');
  const buffers = session.spectrum;
  // An injected 1 kHz FFT peak tests grouping, not real capture or Web Audio DSP.
  analyser.data[Math.round(1000 / (48000 / 2048))] = 200;
  const peaks = clone((await read()).bars);
  const peakIndices = peaks.flatMap((value, index) => value === 200 ? [index] : []);
  assert.equal(peakIndices.length, 1);
  assert.ok(Math.abs(peakIndices[0] - Math.log(1000 / 30) / Math.log(15000 / 30) * 48) < 2);
  assert.equal(session.spectrum, buffers, 'FFT and grouped buffers reused');
  await command('SET_VOLUME', { volume: 30 });
  await command('SET_MUTED', { muted: true });
  assert.deepEqual(clone((await read()).bars), peaks, 'Pre-master magnitudes survive volume and mute');
  assert.equal(session.gainNode.gain.value, 0);
  await command('ENABLE', { tabId: 2 });
  assert.equal((await read(2)).active, false);
  for (let i = 0; i < 10; i++) {
    await command('SET_ANALYZER_ENABLED', { analyzerEnabled: false });
    const count = analyser.reads;
    assert.equal((await read()).active, false);
    assert.equal(analyser.reads, count);
    await command('SET_ANALYZER_ENABLED', { analyzerEnabled: true });
    assert.equal(session.analyserNode, analyser);
    assert.equal(analyser.connections.length, 1);
  }
  await command('SET_EQ_ENABLED', { eqEnabled: true });
  await command('APPLY_EQ_PRESET', { preset: 'Soft V' });
  assert.equal((await command('GET_STATE')).eqDirty, false);
  let state = await command('SET_EQ_BAND', { bandIndex: 3, gain: -4 });
  assert.equal(state.eqDirty, true); assert.equal(state.selectedPreset, 'Custom');
  const saved = await h.command('PRESETS_SAVE', { name: 'Alex V', gains: clone(state.eqGains) });
  assert.equal(saved.ok, true);
  state = await command('GET_STATE');
  assert.equal(state.eqDirty, false); assert.equal(state.selectedPreset, saved.presets[0].id);
  await command('PRESETS_DELETE', { id: state.selectedPreset });
  state = await command('GET_STATE');
  assert.equal(state.eqDirty, false, 'Deleting is not a manual band edit');
  state = await command('SET_EQ_BAND', { bandIndex: 0, gain: 8 });
  assert.equal(state.eqDirty, true);
  await command('DISABLE');
  assert.equal(session.analyserNode, null); assert.equal(session.spectrum, null);
  assert.equal(analyser.disconnected, true); assert.equal(session.audioContext.state, 'closed');
  assert.equal((await read()).active, false);
  state = await command('ENABLE');
  assert.equal(state.analyzerEnabled, true); assert.equal(state.eqDirty, true);
  assert.equal(state.volume, 100); assert.equal(state.muted, false); assert.equal(state.eqEnabled, true);
  assert.equal(state.eqGains[0], 8);
  await h.closeTab(1); await h.closeTab(1);
  assert.equal((await command('GET_STATE')).analyzerEnabled, false);
  assert.equal((await command('GET_STATE', { tabId: 2 })).enabled, true);
  assert.deepEqual(Object.keys(h.state.storage), ['customPresets']);

  // Drive the actual popup renderer with a deterministic clock and delayed IPC.
  const callbacks = new Map(); let nextId = 0, requests = 0, resolveRequest;
  const status = { textContent: '' };
  const context = { setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, fillText() {}, stroke() {}, fillRect() {} };
  const canvas = { clientWidth: 620, clientHeight: 121, getContext: () => context };
  const popup = vm.createContext({ window: { devicePixelRatio: 1 },
    requestAnimationFrame: (callback) => { callbacks.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: (id) => callbacks.delete(id), canvas, status,
    request: () => { requests++; return new Promise((resolve) => { resolveRequest = resolve; }); }
  });
  vm.runInContext(source('shared/spectrum.js') + '\n' + source('popup/spectrum.js') + '\nconst view = new SpectrumView(canvas, status, request);', popup);
  const run = (code) => vm.runInContext(code, popup);
  const frame = (time) => { const queued = [...callbacks.values()]; callbacks.clear(); queued.forEach((callback) => callback(time)); };
  const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };
  run('view.update(false, "OFF")'); assert.equal(callbacks.size, 0);
  run('view.update(true)'); run('view.update(true)'); assert.equal(callbacks.size, 1);
  frame(0); assert.equal(requests, 1);
  frame(40); frame(80); assert.equal(requests, 1, 'At most one request in flight');
  resolveRequest({ ok: true, active: true, bars: Array(48).fill(100) }); await settle();
  frame(90); assert.equal(requests, 2);
  run('view.update(false, "OFF")'); assert.equal(callbacks.size, 0);
  resolveRequest({ ok: true, active: true, bars: Array(48).fill(200) }); await settle();
  assert.equal(run('view.bars[0]'), 0, 'Late reply after OFF cannot draw');
  run('view.update(true)'); frame(100);
  resolveRequest({ ok: true, active: true, bars: Array(48).fill(80) }); await settle();
  frame(110); frame(139); assert.equal(requests, 3, 'Requests are capped at 25 FPS');
  frame(140); assert.equal(requests, 4);
  resolveRequest({ ok: false }); await settle();
  assert.equal(callbacks.size, 0, 'IPC failure stops rather than polling endlessly');
  run('view.update(true)'); assert.equal(callbacks.size, 0);
  run('view.update(false, "OFF"); view.update(true)'); assert.equal(callbacks.size, 1);
  run('view.stop()'); assert.equal(callbacks.size, 0);

  // Execute the actual popup event handlers against the worker/offscreen harness.
  const uiHarness = createHarness();
  class Element {
    value = ''; textContent = ''; hidden = false; disabled = false; checked = false;
    dataset = {}; listeners = {}; children = []; attributes = {};
    addEventListener(type, callback) { this.listeners[type] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    focus() {}
  }
  const nodes = new Map();
  const element = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  Object.assign(element('#spectrum-canvas'), canvas);
  const bands = Array.from({length:7}, (_, index) => {
    const slider = new Element(); slider.dataset.eqBand = String(index);
    const output = new Element(); slider.parentElement = { querySelector: () => output }; return slider;
  });
  const document = { hidden: false, querySelector: element, querySelectorAll: () => bands,
    createElement: () => new Element(), addEventListener() {} };
  const ui = vm.createContext({ document, window: {devicePixelRatio:1,addEventListener(){}},
    chrome: {...uiHarness.chrome, tabs: {...uiHarness.chrome.tabs, query:async()=>[{id:1}]}},
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  vm.runInContext(['shared/presets.js','shared/spectrum.js','popup/spectrum.js','popup/popup.js'].map(source).join('\n'), ui);
  await settle();
  const uiRun = (code) => vm.runInContext(code, ui);
  await uiRun('applyEqualizerPreset("Soft V")');
  assert.equal(element('#save-preset').disabled, true);
  assert.equal(element('#rename-preset').disabled, true);
  assert.equal(element('#delete-preset').disabled, true);
  await uiRun('setProcessing(true);');
  await uiRun('setEqualizerEnabled(true)');
  bands[3].value = '-4'; bands[3].listeners.input(); await settle();
  assert.equal(element('#preset-select').value, 'Custom');
  assert.equal(element('#save-preset').disabled, false, 'Manual input enables Save in real popup handler');
  element('#save-preset').listeners.click(); element('#preset-name').value = 'UI V';
  await uiRun('commitPreset({preventDefault(){}})');
  assert.equal(element('#save-preset').disabled, true);
  assert.equal(element('#rename-preset').disabled, false);
  assert.equal(element('#delete-preset').disabled, false);
  bands[0].value = '8'; bands[0].listeners.input(); await settle();
  assert.equal(element('#save-preset').disabled, false);
  await uiRun('setProcessing(false);');
  await uiRun('refreshState()');
  assert.equal(element('#save-preset').disabled, false, 'Unsaved manual edit survives popup refresh and DSP OFF');
  await uiRun('applyEqualizerPreset("Bass")');
  assert.equal(element('#save-preset').disabled, true);

  for (const file of ['shared/spectrum.js', 'popup/spectrum.js', 'popup/popup.js', 'audio/offscreen.js']) {
    new vm.Script(source(file));
    assert.doesNotMatch(source(file), /fetch\s*\(|XMLHttpRequest|WebSocket|MediaRecorder|storage\.local\.set/);
  }
  console.log('PASS: v0.7 DSP wiring, real FFT reader/grouping, safe reactivation, dirty presets, per-tab cleanup, 25 FPS cap, one request in flight, cancellation and late replies.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
