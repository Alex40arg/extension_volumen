(() => {
  const CONTROLLER_KEY = "__tabAudioControlInPageV09";
  if (globalThis[CONTROLLER_KEY]) return;

  const CONFIG = globalThis.__TAB_AUDIO_CONTROL_CONFIG;
  if (!CONFIG) throw new Error("In-page audio configuration is unavailable.");

  const MEDIA_SELECTOR = "video, audio";
  const MEDIA_WAIT_MS = 1800;
  const PROBE_INTERVAL_MS = 100;
  const PROBE_ATTEMPTS = 15;
  const records = new Set();
  const recordsByElement = new WeakMap();
  const pendingMedia = new Map();
  let audioContext = null;
  let eqFilters = [];
  let analyserNode = null;
  let gainNode = null;
  let spectrum = null;
  let observer = null;
  let active = false;
  let volume = 100;
  let muted = false;
  let eqEnabled = false;
  let analyzerEnabled = false;
  let eqGains = Array(CONFIG.bands.length).fill(0);
  let mediaWaitResolve = null;

  function debug(message) {
    console.debug(`Tab Audio Control in-page: ${message}`);
  }

  function validGains(value) {
    return Array.isArray(value) && value.length === CONFIG.bands.length
      && value.every((gain) => Number.isInteger(gain) && gain >= -12 && gain <= 12);
  }

  function ramp(param, value) {
    const now = audioContext.currentTime;
    if (typeof param.cancelAndHoldAtTime === "function") {
      param.cancelAndHoldAtTime(now);
    } else {
      const currentValue = param.value;
      param.cancelScheduledValues(now);
      param.setValueAtTime(currentValue, now);
    }
    param.linearRampToValueAtTime(value, now + CONFIG.rampSeconds);
  }

  function applyGain() {
    ramp(gainNode.gain, muted ? 0 : volume / 100);
  }

  function applyEq() {
    eqFilters.forEach((filter, index) => ramp(filter.gain, eqEnabled ? eqGains[index] : 0));
  }

  function disconnect(node) {
    try {
      node?.disconnect();
    } catch {
      // Idempotent cleanup: a disconnected node needs no further work.
    }
  }

  function buildGraph() {
    eqFilters = CONFIG.bands.map((band) => {
      const filter = audioContext.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.setValueAtTime(band.frequency, audioContext.currentTime);
      if (band.type === "peaking") filter.Q.setValueAtTime(band.q, audioContext.currentTime);
      filter.gain.setValueAtTime(0, audioContext.currentTime);
      return filter;
    });
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = CONFIG.spectrum.fftSize;
    analyserNode.smoothingTimeConstant = CONFIG.spectrum.smoothing;
    analyserNode.minDecibels = CONFIG.spectrum.minDecibels;
    analyserNode.maxDecibels = CONFIG.spectrum.maxDecibels;
    gainNode = audioContext.createGain();
    gainNode.gain.setValueAtTime(1, audioContext.currentTime);

    for (let index = 0; index < eqFilters.length - 1; index += 1) {
      eqFilters[index].connect(eqFilters[index + 1]);
    }
    eqFilters.at(-1).connect(analyserNode);
    analyserNode.connect(gainNode);
    gainNode.connect(audioContext.destination);
    spectrum = createSpectrumBuffers();
  }

  function destroyGraph() {
    eqFilters.forEach(disconnect);
    disconnect(analyserNode);
    disconnect(gainNode);
    eqFilters = [];
    analyserNode = null;
    gainNode = null;
    spectrum = null;
  }

  function sourceLooksCorsUnsafe(media) {
    const value = media.currentSrc;
    if (!value) return false;
    try {
      const sourceUrl = new URL(value, document.baseURI);
      if (!["http:", "https:"].includes(sourceUrl.protocol)) return false;
      return sourceUrl.origin !== location.origin && !media.crossOrigin;
    } catch {
      return true;
    }
  }

  function mediaIsEligible(media) {
    return media instanceof HTMLMediaElement && Boolean(media.currentSrc)
      && !media.mediaKeys && !sourceLooksCorsUnsafe(media);
  }

  function clearPendingMedia(media) {
    const handler = pendingMedia.get(media);
    if (!handler) return;
    media.removeEventListener("loadedmetadata", handler);
    media.removeEventListener("canplay", handler);
    pendingMedia.delete(media);
  }

  function waitForMediaSource(media) {
    if (pendingMedia.has(media)) return;
    const handler = () => {
      if (!active || !media.currentSrc) return;
      clearPendingMedia(media);
      attachMedia(media);
    };
    pendingMedia.set(media, handler);
    media.addEventListener("loadedmetadata", handler);
    media.addEventListener("canplay", handler);
  }

  function connectRecord(record) {
    if (record.connected || !active || !eqFilters.length) return;
    disconnect(record.source);
    record.source.connect(eqFilters[0]);
    record.connected = true;
  }

  function attachMedia(media) {
    if (!(media instanceof HTMLMediaElement)) return false;
    if (!media.currentSrc) {
      waitForMediaSource(media);
      return false;
    }
    clearPendingMedia(media);
    if (!mediaIsEligible(media)) return false;
    let record = recordsByElement.get(media);
    if (!record) {
      try {
        record = { media, source: audioContext.createMediaElementSource(media), connected: false };
      } catch (error) {
        debug(`media element unavailable (${error?.name || "Web Audio error"})`);
        return false;
      }
      records.add(record);
      recordsByElement.set(media, record);
      debug("media element detected");
    }
    records.add(record);
    connectRecord(record);
    if (mediaWaitResolve) mediaWaitResolve();
    return true;
  }

  function visitMedia(root) {
    if (root instanceof HTMLMediaElement) attachMedia(root);
    if (root?.querySelectorAll) root.querySelectorAll(MEDIA_SELECTOR).forEach(attachMedia);
  }

  function pruneDetachedMedia() {
    for (const media of [...pendingMedia.keys()]) {
      if (!media.isConnected) clearPendingMedia(media);
    }
    for (const record of [...records]) {
      if (record.media.isConnected) continue;
      if (record.connected) disconnect(record.source);
      record.connected = false;
      records.delete(record);
    }
  }

  function startObserver() {
    observer?.disconnect();
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") visitMedia(mutation.target);
        mutation.addedNodes.forEach(visitMedia);
      }
      queueMicrotask(pruneDetachedMedia);
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"]
    });
  }

  function connectedRecords() {
    return [...records].filter((record) => record.connected && record.media.isConnected);
  }

  async function waitForMedia() {
    if (connectedRecords().length) return true;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        mediaWaitResolve = null;
        resolve();
      }, MEDIA_WAIT_MS);
      mediaWaitResolve = () => {
        clearTimeout(timer);
        mediaWaitResolve = null;
        resolve();
      };
    });
    return connectedRecords().length > 0;
  }

  async function probeSignal() {
    const playing = connectedRecords().filter(({ media }) => !media.paused && !media.ended
      && !media.muted && media.volume > 0 && media.readyState >= 2);
    if (!playing.length) return true;
    const initialTimes = playing.map(({ media }) => media.currentTime);
    const bins = new Uint8Array(analyserNode.frequencyBinCount);
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
      analyserNode.getByteFrequencyData(bins);
      if (bins.some((value) => value > 0)) return true;
    }
    const advanced = playing.some(({ media }, index) => media.currentTime - initialTimes[index] >= 0.4);
    return !advanced;
  }

  function createSpectrumBuffers() {
    const bins = new Uint8Array(analyserNode.frequencyBinCount);
    const bars = Array(CONFIG.spectrum.bars).fill(0);
    const ranges = [];
    const maxHz = Math.min(CONFIG.spectrum.maxHz, audioContext.sampleRate / 2);
    const binHz = audioContext.sampleRate / analyserNode.fftSize;
    for (let index = 0; index < CONFIG.spectrum.bars; index += 1) {
      const low = CONFIG.spectrum.minHz * (maxHz / CONFIG.spectrum.minHz) ** (index / CONFIG.spectrum.bars);
      const high = CONFIG.spectrum.minHz * (maxHz / CONFIG.spectrum.minHz) ** ((index + 1) / CONFIG.spectrum.bars);
      const start = Math.min(bins.length - 1, Math.max(1, Math.round(low / binHz)));
      const end = Math.min(bins.length, Math.max(start + 1, Math.round(high / binHz)));
      ranges.push([start, end]);
    }
    return { bins, bars, ranges };
  }

  function readSpectrum() {
    if (!active || !analyzerEnabled || !spectrum) return { active: false };
    analyserNode.getByteFrequencyData(spectrum.bins);
    spectrum.ranges.forEach(([start, end], index) => {
      let peak = 0;
      for (let bin = start; bin < end; bin += 1) peak = Math.max(peak, spectrum.bins[bin]);
      spectrum.bars[index] = peak;
    });
    return { active: true, bars: spectrum.bars };
  }

  async function bypass() {
    observer?.disconnect();
    observer = null;
    for (const media of [...pendingMedia.keys()]) clearPendingMedia(media);
    mediaWaitResolve?.();
    mediaWaitResolve = null;
    active = false;
    for (const record of records) {
      disconnect(record.source);
      record.connected = false;
    }
    destroyGraph();

    if (!records.size) {
      if (audioContext && audioContext.state !== "closed") await audioContext.close();
      audioContext = null;
    } else {
      // createMediaElementSource permanently reroutes an element. Keeping a
      // transparent source -> destination path is the only non-destructive OFF.
      for (const record of records) {
        if (!record.media.isConnected) continue;
        record.source.connect(audioContext.destination);
      }
      if (audioContext.state === "suspended") await audioContext.resume();
    }
    debug("cleanup completed; media is in transparent bypass");
    return { ok: true };
  }

  async function start(settings) {
    if (active) {
      volume = 100;
      muted = false;
      eqEnabled = Boolean(settings?.eqEnabled);
      analyzerEnabled = Boolean(settings?.analyzerEnabled);
      eqGains = validGains(settings?.eqGains) ? [...settings.eqGains] : Array(CONFIG.bands.length).fill(0);
      applyEq();
      applyGain();
      return { ok: true };
    }
    volume = 100;
    muted = false;
    eqEnabled = Boolean(settings?.eqEnabled);
    analyzerEnabled = Boolean(settings?.analyzerEnabled);
    eqGains = validGains(settings?.eqGains) ? [...settings.eqGains] : Array(CONFIG.bands.length).fill(0);

    if (!audioContext || audioContext.state === "closed") audioContext = new AudioContext();
    for (const record of records) disconnect(record.source);
    destroyGraph();
    // Resume before taking ownership of any media element. If autoplay policy
    // rejects this step, fallback can occur without rerouting page audio.
    if (audioContext.state === "suspended") await audioContext.resume();
    buildGraph();
    active = true;
    visitMedia(document);
    startObserver();
    applyEq();
    applyGain();

    if (!(await waitForMedia())) {
      await bypass();
      return { ok: false, reason: "no-media" };
    }
    if (!(await probeSignal())) {
      await bypass();
      return { ok: false, reason: "blocked-signal" };
    }
    debug("fullscreen-friendly backend selected");
    return { ok: true };
  }

  async function command(type, data = {}) {
    if (type === "START") return start(data);
    if (type === "BYPASS") return bypass();
    if (type === "PING") return { ok: true, active };
    if (type === "GET_SPECTRUM") return readSpectrum();
    if (!active) throw new Error("In-page audio processing is not active.");

    if (type === "SET_VOLUME") {
      const value = Number(data.volume);
      if (!Number.isFinite(value) || value < 0 || value > 200 || value % 5 !== 0) throw new Error("Invalid volume.");
      volume = value;
      applyGain();
    } else if (type === "SET_MUTED") {
      if (typeof data.muted !== "boolean") throw new Error("Invalid mute state.");
      muted = data.muted;
      applyGain();
    } else if (type === "SET_EQ_ENABLED") {
      eqEnabled = Boolean(data.eqEnabled);
      applyEq();
    } else if (type === "SET_EQ_BAND") {
      const index = Number(data.bandIndex);
      const gain = Number(data.gain);
      if (!Number.isInteger(index) || index < 0 || index >= eqGains.length
          || !Number.isInteger(gain) || gain < -12 || gain > 12) throw new Error("Invalid EQ band.");
      eqGains[index] = gain;
      ramp(eqFilters[index].gain, eqEnabled ? gain : 0);
    } else if (type === "APPLY_EQ_PRESET") {
      if (!validGains(data.gains)) throw new Error("Invalid EQ preset.");
      eqGains = [...data.gains];
      applyEq();
    } else if (type === "SET_ANALYZER_ENABLED") {
      analyzerEnabled = Boolean(data.analyzerEnabled);
    } else {
      throw new Error("Unknown in-page request.");
    }
    return { ok: true };
  }

  Object.defineProperty(globalThis, CONTROLLER_KEY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ command })
  });
})();
