// Test-only Chrome/Web Audio doubles. No browser profile or real audio is used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

function createHarness(initial = {}, options = {}) {
  const state = {
    storage: clone(initial), writes: 0, captures: 0, failRead: false, failWrite: false, logs: [],
    inPageInjected: false, inPageActive: false, inPageBypasses: 0, inPageAnalyzer: false
  };
  const workerListeners = [], audioListeners = [], removedListeners = [], updatedListeners = [], storageListeners = [];
  let offscreenExists = false;
  const logger = { warn: (...args) => state.logs.push(args), error: (...args) => state.logs.push(args), debug: (...args) => state.logs.push(args), log() {} };
  function dispatch(listeners, message) {
    return new Promise((resolve, reject) => {
      let handled = false;
      for (const listener of listeners) {
        if (listener(message, {}, resolve)) handled = true;
      }
      if (!handled) reject(new Error('No message handler.'));
    });
  }
  function sendMessage(message) {
    if (message.target === 'offscreen') return dispatch(audioListeners, clone(message));
    if (message.target === 'service-worker') return dispatch(workerListeners, clone(message));
    return Promise.resolve();
  }
  class Param {
    value = 0;
    setValueAtTime(value) { this.value = value; }
    cancelAndHoldAtTime() {}
    linearRampToValueAtTime(value) { this.value = value; }
  }
  class Node {
    gain = new Param(); frequency = new Param(); Q = new Param();
    connections = []; disconnected = false;
    connect(node) { this.connections.push(node); }
    disconnect() { this.connections = []; this.disconnected = true; }
  }
  class Analyser extends Node {
    fftSize = 2048; reads = 0;
    data = new Uint8Array(1024);
    get frequencyBinCount() { return this.fftSize / 2; }
    getByteFrequencyData(buffer) { this.reads++; buffer.set(this.data); }
  }
  class AudioContext {
    currentTime = 0; state = 'running'; destination = {}; sampleRate = 48000;
    createMediaStreamSource() { return new Node(); }
    createBiquadFilter() { return new Node(); }
    createGain() { return new Node(); }
    createAnalyser() { return new Analyser(); }
    async close() { this.state = 'closed'; }
    async resume() {}
  }
  const audio = vm.createContext({ console: logger, AudioContext,
    navigator: { mediaDevices: { async getUserMedia() {
      const track = { readyState: 'live', addEventListener() {}, removeEventListener() {}, stop() { this.readyState = 'ended'; } };
      return { getTracks: () => [track] };
    } } },
    chrome: { runtime: { onMessage: { addListener: (listener) => audioListeners.push(listener) }, sendMessage } }
  });
  vm.runInContext(source('shared/audio-config.js') + '\n' + source('shared/presets.js') + '\n' + source('shared/spectrum.js') + '\n' + source('audio/offscreen.js'), audio);
  const chrome = {
    runtime: {
      getURL: (file) => `chrome-extension://test/${file}`,
      getContexts: async () => offscreenExists ? [{}] : [],
      onMessage: { addListener: (listener) => workerListeners.push(listener) }, sendMessage
    },
    offscreen: { async createDocument() { offscreenExists = true; } },
    scripting: { async executeScript(details) {
      if (!options.inPage) throw new Error('In-page injection unavailable in the capture regression harness.');
      if (details.files) {
        state.inPageInjected = true;
        return [{}];
      }
      const type = details.args?.[1];
      const data = details.args?.[2] || {};
      if (!state.inPageInjected) throw new Error('Controller unavailable.');
      if (type === 'START') { state.inPageActive = true; return [{ result: { ok: true } }]; }
      if (type === 'BYPASS') { state.inPageActive = false; state.inPageBypasses++; return [{ result: { ok: true } }]; }
      if (type === 'PING') return [{ result: { ok: true, active: state.inPageActive } }];
      if (!state.inPageActive) throw new Error('Controller inactive.');
      if (type === 'SET_ANALYZER_ENABLED') state.inPageAnalyzer = Boolean(data.analyzerEnabled);
      if (type === 'GET_SPECTRUM') return [{ result: state.inPageAnalyzer
        ? { active: true, bars: Array(48).fill(17) } : { active: false } }];
      return [{ result: { ok: true } }];
    } },
    tabCapture: { async getMediaStreamId() { state.captures++; return 'fake-stream'; } },
    tabs: {
      onRemoved: { addListener: (listener) => removedListeners.push(listener) },
      onUpdated: { addListener: (listener) => updatedListeners.push(listener) }
    },
    storage: {
      local: {
        async get(key) { if (state.failRead) throw new Error('Read failure'); return clone({ [key]: state.storage[key] ?? [] }); },
        async set(value) {
          if (state.failWrite) throw new Error('Quota failure');
          await new Promise((resolve) => setImmediate(resolve));
          state.writes++;
          Object.assign(state.storage, clone(value));
          storageListeners.forEach((listener) => listener({ customPresets: { newValue: state.storage.customPresets } }, 'local'));
        }
      },
      onChanged: { addListener: (listener) => storageListeners.push(listener) }
    }
  };
  const worker = vm.createContext({ chrome, console: logger, crypto: { randomUUID }, setTimeout });
  worker.importScripts = (...files) => files.forEach((file) => vm.runInContext(source(path.join('background', file)), worker));
  vm.runInContext(source('background/service-worker.js'), worker);
  return {
    state, audio, worker, chrome,
    command: (type, data = {}) => sendMessage({ target: 'service-worker', type, tabId: 1, ...data }),
    closeTab: async (tabId) => {
      removedListeners.forEach((listener) => listener(tabId));
      await vm.runInContext(`enqueueForTab(${tabId}, () => undefined)`, worker);
    },
    navigate: async (tabId) => {
      updatedListeners.forEach((listener) => listener(tabId, { status: 'loading' }));
      await vm.runInContext(`enqueueForTab(${tabId}, () => undefined)`, worker);
    }
  };
}
module.exports = { createHarness, source, clone, root };
