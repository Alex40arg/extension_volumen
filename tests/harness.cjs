// Test-only Chrome/Web Audio doubles. No browser profile or real audio is used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const clone = (value) => JSON.parse(JSON.stringify(value));

function createHarness(initial = {}) {
  const state = { storage: clone(initial), writes: 0, captures: 0, failRead: false, failWrite: false, rejectIconDictionaries: false, logs: [], iconCalls: [], titleCalls: [], activeTabId: 1 };
  const workerListeners = [], audioListeners = [], removedListeners = [], activatedListeners = [], storageListeners = [];
  let offscreenExists = false;
  const logger = { warn: (...args) => state.logs.push(args), error: (...args) => state.logs.push(args), log() {} };
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
  vm.runInContext(source('shared/presets.js') + '\n' + source('shared/spectrum.js') + '\n' + source('audio/offscreen.js'), audio);
  const chrome = {
    runtime: {
      getURL: (file) => `chrome-extension://test/${file}`,
      getContexts: async () => offscreenExists ? [{}] : [],
      onMessage: { addListener: (listener) => workerListeners.push(listener) }, sendMessage
    },
    offscreen: { async createDocument() { offscreenExists = true; } },
    tabCapture: { async getMediaStreamId() { state.captures++; return 'fake-stream'; } },
    action: {
      async setIcon(details) {
        if (state.rejectIconDictionaries && typeof details.path === 'object') throw new Error('Dictionary rejected');
        state.iconCalls.push(clone(details));
      },
      async setTitle(details) { state.titleCalls.push(clone(details)); }
    },
    tabs: {
      onRemoved: { addListener: (listener) => removedListeners.push(listener) },
      onActivated: { addListener: (listener) => activatedListeners.push(listener) },
      async query() { return [{ id: state.activeTabId }]; }
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
    activateTab: async (tabId) => {
      state.activeTabId = tabId;
      activatedListeners.forEach((listener) => listener({ tabId }));
      await vm.runInContext(`enqueueForTab(${tabId}, () => undefined)`, worker);
    },
    sessionEnded: async (tabId) => {
      workerListeners.forEach((listener) => listener({ target: 'service-worker', type: 'SESSION_ENDED', tabId }, {}, () => {}));
      await vm.runInContext(`enqueueForTab(${tabId}, () => undefined)`, worker);
    }
  };
}
module.exports = { createHarness, source, clone, root };
