const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createHarness, source, clone } = require('./harness.cjs');

(async () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.version, '0.9.0');
  assert.deepEqual(manifest.permissions, ['offscreen', 'tabCapture', 'storage', 'activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
  assert.doesNotMatch(JSON.stringify(manifest), /<all_urls>/);

  for (const file of [
    'shared/audio-config.js', 'inpage/controller.js', 'audio/offscreen.js',
    'background/service-worker.js', 'popup/popup.js'
  ]) {
    new vm.Script(source(file));
    assert.doesNotMatch(source(file), /fetch\s*\(|XMLHttpRequest|WebSocket|storage\.sync|innerHTML/);
  }

  const controller = source('inpage/controller.js');
  assert.match(controller, /createMediaElementSource\(media\)/);
  assert.match(controller, /new MutationObserver/);
  assert.match(controller, /MEDIA_SELECTOR = "video, audio"/);
  assert.match(controller, /record\.source\.connect\(audioContext\.destination\)/);
  assert.match(controller, /eqFilters\.at\(-1\)\.connect\(analyserNode\)/);
  assert.match(controller, /analyserNode\.connect\(gainNode\)/);
  assert.doesNotMatch(controller, /requestFullscreen|style\.|textContent|innerText|document\.cookie|localStorage/);

  class Param {
    value = 0;
    setValueAtTime(value) { this.value = value; }
    cancelAndHoldAtTime() {}
    linearRampToValueAtTime(value) { this.value = value; }
  }
  class AudioNode {
    gain = new Param(); frequency = new Param(); Q = new Param(); connections = [];
    connect(node) { this.connections.push(node); return node; }
    disconnect() { this.connections = []; }
  }
  class Analyser extends AudioNode {
    fftSize = 2048;
    get frequencyBinCount() { return this.fftSize / 2; }
    getByteFrequencyData(buffer) { buffer.fill(23); }
  }
  class Media {}
  const media = Object.assign(new Media(), {
    currentSrc: 'https://example.test/video.mp4', crossOrigin: '', mediaKeys: null,
    paused: false, ended: false, muted: false, volume: 1, readyState: 4,
    currentTime: 4, isConnected: true
  });
  const contexts = [];
  class AudioContext {
    constructor() { this.currentTime = 0; this.state = 'running'; this.sampleRate = 48000; this.destination = {}; contexts.push(this); }
    createMediaElementSource(element) { this.sourceElement = element; this.source = new AudioNode(); return this.source; }
    createBiquadFilter() { return new AudioNode(); }
    createGain() { return new AudioNode(); }
    createAnalyser() { return new Analyser(); }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  class MutationObserver { observe() {} disconnect() {} }
  const document = {
    baseURI: 'https://example.test/watch', documentElement: {},
    querySelectorAll: () => [media]
  };
  const inPageContext = vm.createContext({
    console: { debug() {} }, AudioContext, HTMLMediaElement: Media, MutationObserver,
    document, location: { origin: 'https://example.test' }, URL,
    queueMicrotask, setTimeout: (callback) => { callback(); return 1; }, clearTimeout() {}
  });
  vm.runInContext(source('shared/audio-config.js') + '\n' + controller, inPageContext);
  const inPageController = inPageContext.__tabAudioControlInPageV09;
  assert.equal((await inPageController.command('START', { eqEnabled: true, eqGains: [4,3,-1,-3,-1,2,4] })).ok, true);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].sourceElement, media);
  assert.equal(contexts[0].source.connections.length, 1, 'Media source has one audible route');
  const liveSpectrum = await inPageController.command('SET_ANALYZER_ENABLED', { analyzerEnabled: true })
    .then(() => inPageController.command('GET_SPECTRUM'));
  assert.equal(liveSpectrum.active, true);
  assert.equal(liveSpectrum.bars.length, 48);
  await inPageController.command('BYPASS');
  assert.equal(contexts[0].source.connections.length, 1, 'OFF retains one transparent route');
  assert.equal(contexts[0].source.connections[0], contexts[0].destination);

  const h = createHarness({}, { inPage: true });
  const command = async (type, data = {}) => {
    const response = await h.command(type, data);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response;
  };

  let state = clone((await command('ENABLE')).state);
  assert.equal(state.enabled, true);
  assert.equal(state.backend, 'in-page');
  assert.equal(state.volume, 100);
  assert.equal(state.muted, false);
  assert.equal(h.state.captures, 0, 'Successful in-page activation must not call tabCapture');

  state = clone((await command('SET_VOLUME', { volume: 150 })).state);
  assert.equal(state.volume, 150);
  state = clone((await command('SET_EQ_ENABLED', { eqEnabled: true })).state);
  assert.equal(state.eqEnabled, true);
  state = clone((await command('SET_EQ_BAND', { bandIndex: 3, gain: -3 })).state);
  assert.equal(state.eqGains[3], -3);
  assert.equal(state.selectedPreset, 'Custom');
  state = clone((await command('SET_ANALYZER_ENABLED', { analyzerEnabled: true })).state);
  assert.equal(state.analyzerEnabled, true);

  const spectrum = await h.chrome.runtime.sendMessage({ target: 'service-worker', type: 'GET_SPECTRUM', tabId: 1 });
  assert.equal(spectrum.ok, true);
  assert.equal(spectrum.active, true);
  assert.equal(spectrum.bars.length, 48);

  state = clone((await command('DISABLE')).state);
  assert.equal(state.enabled, false);
  assert.equal(state.backend, null);
  assert.equal(state.volume, 100);
  assert.equal(state.muted, false);
  assert.equal(h.state.inPageBypasses, 1);
  assert.equal(h.state.captures, 0);

  const navigation = createHarness({}, { inPage: true });
  await navigation.command('ENABLE');
  await navigation.navigate(1);
  assert.equal(clone((await navigation.command('GET_STATE')).state).backend, 'in-page', 'SPA/same-document controller stays active');
  navigation.state.inPageActive = false;
  await navigation.navigate(1);
  assert.equal(clone((await navigation.command('GET_STATE')).state).backend, null, 'Full navigation clears stale in-page state');

  const fallback = createHarness();
  const fallbackState = clone((await fallback.command('ENABLE')).state);
  assert.equal(fallbackState.backend, 'tab-capture');
  assert.equal(fallback.state.captures, 1);

  console.log('PASS: v0.9 in-page selection, safe defaults, per-tab state, analyzer routing, transparent OFF, minimal permissions and tabCapture fallback.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
