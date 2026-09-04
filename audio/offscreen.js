const EQ_BANDS = globalThis.__TAB_AUDIO_CONTROL_CONFIG.bands;
const DEFAULT_EQ_GAINS = Object.freeze(EQ_BANDS.map(() => 0));
const PARAM_RAMP_SECONDS = globalThis.__TAB_AUDIO_CONTROL_CONFIG.rampSeconds;
const sessions = new Map();
const inPageSessions = new Map();
const tabSettings = new Map();

function defaultSettings() {
  return {
    eqEnabled: false,
    analyzerEnabled: false,
    eqDirty: false,
    eqGains: [...DEFAULT_EQ_GAINS],
    selectedPreset: "Flat"
  };
}

function getSettings(tabId, create = false) {
  let settings = tabSettings.get(tabId);
  if (!settings && create) {
    settings = defaultSettings();
    tabSettings.set(tabId, settings);
  }
  return settings || defaultSettings();
}

function publicState(tabId) {
  const session = sessions.get(tabId);
  const inPageSession = inPageSessions.get(tabId);
  const runtime = session || inPageSession;
  const settings = getSettings(tabId);
  return {
    enabled: Boolean(runtime),
    backend: session ? "tab-capture" : inPageSession ? "in-page" : null,
    // Session-only controls deliberately reset whenever processing stops.
    volume: runtime?.volume ?? 100,
    muted: runtime?.muted ?? false,
    eqEnabled: settings.eqEnabled,
    analyzerEnabled: settings.analyzerEnabled,
    eqDirty: settings.eqDirty,
    eqGains: [...settings.eqGains],
    selectedPreset: settings.selectedPreset
  };
}

function requireSession(tabId) {
  const session = sessions.get(tabId);
  if (!session) {
    throw new Error(`No active audio session for tab ${tabId}.`);
  }
  return session;
}

function rampAudioParam(param, value, audioContext) {
  const now = audioContext.currentTime;

  // Hold the parameter at its exact in-flight value before starting a new ramp.
  // This avoids discontinuities when slider input events arrive faster than 20 ms.
  if (typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(now);
  } else {
    const currentValue = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(currentValue, now);
  }

  param.linearRampToValueAtTime(value, now + PARAM_RAMP_SECONDS);
}

function applyGain(session) {
  const effectiveGain = session.muted ? 0 : session.volume / 100;
  rampAudioParam(session.gainNode.gain, effectiveGain, session.audioContext);
}

function applyEq(session) {
  const settings = getSettings(session.tabId);
  session.eqFilters.forEach((filter, index) => {
    const effectiveGain = settings.eqEnabled ? settings.eqGains[index] : 0;
    rampAudioParam(filter.gain, effectiveGain, session.audioContext);
  });
}

function disconnectNode(node, label) {
  if (!node) {
    return;
  }

  try {
    node.disconnect();
  } catch (error) {
    console.warn(`Tab Audio Control: ${label} disconnect failed.`, error);
  }
}

async function destroySession(tabId, notify = false) {
  const session = sessions.get(tabId);
  if (!session) {
    return false;
  }

  // Delete first so simultaneous STOP/track-ended cleanup becomes a no-op.
  sessions.delete(tabId);
  for (const track of session.stream.getTracks()) {
    track.removeEventListener("ended", session.handleTrackEnded);
  }

  disconnectNode(session.sourceNode, `source node for tab ${tabId}`);
  session.eqFilters.forEach((filter, index) => {
    disconnectNode(filter, `EQ band ${index + 1} for tab ${tabId}`);
  });
  disconnectNode(session.gainNode, `gain node for tab ${tabId}`);
  disconnectNode(session.analyserNode, `analyser node for tab ${tabId}`);
  session.analyserNode = null;
  session.spectrum = null;

  for (const track of session.stream.getTracks()) {
    try {
      track.stop();
    } catch (error) {
      console.warn(`Tab Audio Control: track stop failed for tab ${tabId}.`, error);
    }
  }

  if (session.audioContext.state !== "closed") {
    try {
      await session.audioContext.close();
    } catch (error) {
      console.warn(`Tab Audio Control: AudioContext close failed for tab ${tabId}.`, error);
    }
  }

  if (notify) {
    void chrome.runtime.sendMessage({
      target: "service-worker",
      type: "SESSION_ENDED",
      tabId
    }).catch(() => undefined);
  }
  return true;
}

async function startSession(tabId, streamId) {
  if (sessions.has(tabId)) {
    return publicState(tabId);
  }
  if (inPageSessions.has(tabId)) throw new Error("An in-page session is already active for this tab.");

  getSettings(tabId, true);

  let stream = null;
  let audioContext = null;
  let sourceNode = null;
  let eqFilters = [];
  let gainNode = null;
  let analyserNode = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    audioContext = new AudioContext();
    sourceNode = audioContext.createMediaStreamSource(stream);
    eqFilters = EQ_BANDS.map((band) => {
      const filter = audioContext.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.setValueAtTime(band.frequency, audioContext.currentTime);
      if (band.type === "peaking") {
        filter.Q.setValueAtTime(band.q, audioContext.currentTime);
      }
      filter.gain.setValueAtTime(0, audioContext.currentTime);
      return filter;
    });
    gainNode = audioContext.createGain();
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = SPECTRUM.fftSize;
    analyserNode.smoothingTimeConstant = SPECTRUM.smoothing;
    analyserNode.minDecibels = SPECTRUM.minDecibels;
    analyserNode.maxDecibels = SPECTRUM.maxDecibels;

    // Hearing-safety invariant: every newly controlled tab starts at unity gain.
    gainNode.gain.setValueAtTime(1, audioContext.currentTime);
    sourceNode.connect(eqFilters[0]);
    for (let index = 0; index < eqFilters.length - 1; index += 1) {
      eqFilters[index].connect(eqFilters[index + 1]);
    }
    // Transparent analysis after EQ, before master gain/mute. Toggling the
    // display never reconnects nodes or changes the audible signal path.
    eqFilters.at(-1).connect(analyserNode);
    analyserNode.connect(gainNode);
    gainNode.connect(audioContext.destination);

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const handleTrackEnded = () => {
      void destroySession(tabId, true).catch((error) => {
        console.error(`Tab Audio Control: ended session cleanup failed for tab ${tabId}.`, error);
      });
    };
    const session = {
      tabId,
      stream,
      audioContext,
      sourceNode,
      eqFilters,
      gainNode,
      analyserNode,
      spectrum: createSpectrumBuffers(analyserNode, audioContext.sampleRate),
      volume: 100,
      muted: false,
      handleTrackEnded
    };
    sessions.set(tabId, session);
    applyEq(session);

    for (const track of stream.getTracks()) {
      track.addEventListener("ended", handleTrackEnded);
    }

    if (stream.getTracks().some((track) => track.readyState === "ended")) {
      await destroySession(tabId, true);
      stream = null;
      audioContext = null;
      sourceNode = null;
      eqFilters = [];
      gainNode = null;
      analyserNode = null;
      throw new Error("The captured stream ended during initialization.");
    }

    return publicState(tabId);
  } catch (error) {
    disconnectNode(sourceNode, "partial source node");
    eqFilters.forEach((filter, index) => disconnectNode(filter, `partial EQ band ${index + 1}`));
    disconnectNode(gainNode, "partial gain node");
    disconnectNode(analyserNode, "partial analyser node");

    for (const track of stream?.getTracks() || []) {
      try {
        track.stop();
      } catch (cleanupError) {
        console.warn("Tab Audio Control: partial track cleanup failed.", cleanupError);
      }
    }

    if (audioContext && audioContext.state !== "closed") {
      try {
        await audioContext.close();
      } catch (cleanupError) {
        console.warn("Tab Audio Control: partial AudioContext cleanup failed.", cleanupError);
      }
    }
    throw error;
  }
}

function setVolume(tabId, value) {
  const volume = Number(value);
  if (!Number.isFinite(volume) || volume < 0 || volume > 200 || volume % 5 !== 0) {
    throw new Error("Volume must be between 0 and 200 in steps of 5.");
  }

  const session = requireSession(tabId);
  session.volume = volume;
  applyGain(session);
  return publicState(tabId);
}

function setMuted(tabId, value) {
  if (typeof value !== "boolean") {
    throw new Error("Muted state must be a boolean.");
  }

  const session = requireSession(tabId);
  session.muted = value;
  applyGain(session);
  return publicState(tabId);
}

function setEqEnabled(tabId, value) {
  if (typeof value !== "boolean") {
    throw new Error("Equalizer state must be a boolean.");
  }

  const session = requireSession(tabId);
  const settings = getSettings(tabId, true);
  settings.eqEnabled = value;
  applyEq(session);
  return publicState(tabId);
}

function setEqBand(tabId, bandIndexValue, gainValue) {
  const bandIndex = Number(bandIndexValue);
  const gain = Number(gainValue);
  if (!Number.isInteger(bandIndex) || bandIndex < 0 || bandIndex >= EQ_BANDS.length) {
    throw new Error("A valid equalizer band is required.");
  }
  if (!Number.isInteger(gain) || gain < -12 || gain > 12) {
    throw new Error("Equalizer gain must be between -12 and +12 dB in steps of 1 dB.");
  }

  const session = requireSession(tabId);
  const settings = getSettings(tabId, true);
  settings.eqGains[bandIndex] = gain;
  settings.selectedPreset = "Custom";
  settings.eqDirty = true;
  const effectiveGain = settings.eqEnabled ? gain : 0;
  rampAudioParam(session.eqFilters[bandIndex].gain, effectiveGain, session.audioContext);
  return publicState(tabId);
}

function applyEqPreset(tabId, preset, customGains) {
  const gains = Object.hasOwn(EQ_PRESETS, preset) ? EQ_PRESETS[preset] : customGains;
  if ((!Object.hasOwn(EQ_PRESETS, preset) && !CUSTOM_PRESET_ID.test(preset)) || !validPresetGains(gains)) {
    throw new Error("A valid equalizer preset is required.");
  }

  const settings = getSettings(tabId, true);
  settings.eqGains = [...gains];
  settings.selectedPreset = preset;
  settings.eqDirty = false;
  const session = sessions.get(tabId);
  if (session) applyEq(session);
  return publicState(tabId);
}

function registerInPageSession(tabId) {
  if (sessions.has(tabId)) throw new Error("A capture session is already active for this tab.");
  if (!inPageSessions.has(tabId)) {
    getSettings(tabId, true);
    inPageSessions.set(tabId, { tabId, volume: 100, muted: false });
  }
  return publicState(tabId);
}

function stopInPageSession(tabId) {
  inPageSessions.delete(tabId);
  return publicState(tabId);
}

function requireInPageSession(tabId) {
  const session = inPageSessions.get(tabId);
  if (!session) throw new Error(`No active in-page session for tab ${tabId}.`);
  return session;
}

function setInPageVolume(tabId, value) {
  const volume = Number(value);
  if (!Number.isFinite(volume) || volume < 0 || volume > 200 || volume % 5 !== 0) {
    throw new Error("Volume must be between 0 and 200 in steps of 5.");
  }
  requireInPageSession(tabId).volume = volume;
  return publicState(tabId);
}

function setInPageMuted(tabId, value) {
  if (typeof value !== "boolean") throw new Error("Muted state must be a boolean.");
  requireInPageSession(tabId).muted = value;
  return publicState(tabId);
}

function setInPageEqEnabled(tabId, value) {
  if (typeof value !== "boolean") throw new Error("Equalizer state must be a boolean.");
  requireInPageSession(tabId);
  getSettings(tabId, true).eqEnabled = value;
  return publicState(tabId);
}

function setInPageEqBand(tabId, bandIndexValue, gainValue) {
  const bandIndex = Number(bandIndexValue);
  const gain = Number(gainValue);
  if (!Number.isInteger(bandIndex) || bandIndex < 0 || bandIndex >= EQ_BANDS.length
      || !Number.isInteger(gain) || gain < -12 || gain > 12) throw new Error("Invalid equalizer band.");
  requireInPageSession(tabId);
  const settings = getSettings(tabId, true);
  settings.eqGains[bandIndex] = gain;
  settings.selectedPreset = "Custom";
  settings.eqDirty = true;
  return publicState(tabId);
}

function createSpectrumBuffers(analyser, sampleRate) {
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const bars = Array(SPECTRUM.bars).fill(0);
  const ranges = [];
  const maxHz = Math.min(SPECTRUM.maxHz, sampleRate / 2);
  const binHz = sampleRate / analyser.fftSize;
  for (let index = 0; index < SPECTRUM.bars; index += 1) {
    const low = SPECTRUM.minHz * (maxHz / SPECTRUM.minHz) ** (index / SPECTRUM.bars);
    const high = SPECTRUM.minHz * (maxHz / SPECTRUM.minHz) ** ((index + 1) / SPECTRUM.bars);
    const start = Math.min(bins.length - 1, Math.max(1, Math.round(low / binHz)));
    const end = Math.min(bins.length, Math.max(start + 1, Math.round(high / binHz)));
    ranges.push([start, end]);
  }
  // Low bars can share a bin: FFT resolution is finite, not invented detail.
  return { bins, bars, ranges };
}

function readSpectrum(tabId) {
  const session = sessions.get(tabId);
  if (!session || !getSettings(tabId).analyzerEnabled) return { active: false };
  const { bins, bars, ranges } = session.spectrum;
  session.analyserNode.getByteFrequencyData(bins);
  for (let index = 0; index < bars.length; index += 1) {
    let peak = 0;
    const [start, end] = ranges[index];
    for (let bin = start; bin < end; bin += 1) peak = Math.max(peak, bins[bin]);
    bars[index] = peak;
  }
  // No timer in the engine. Buffers are reused; Chrome serializes 48 numbers
  // only in response to a visible popup request, never stores audio or FFT.
  return { active: true, bars };
}

async function handleMessage(message) {
  if (!Number.isInteger(message.tabId) && !["GET_SESSION_COUNT", "PING", "FORGET_PRESET"].includes(message.type)) {
    throw new Error("A valid tab ID is required.");
  }

  switch (message.type) {
    case "PING":
      return {};
    case "GET_STATE":
      return { state: publicState(message.tabId) };
    case "GET_SPECTRUM":
      return readSpectrum(message.tabId);
    case "SET_ANALYZER_ENABLED":
      if (inPageSessions.has(message.tabId)) requireInPageSession(message.tabId);
      else requireSession(message.tabId);
      if (typeof message.analyzerEnabled !== "boolean") throw new Error("Analyzer state must be a boolean.");
      getSettings(message.tabId, true).analyzerEnabled = message.analyzerEnabled;
      return { state: publicState(message.tabId) };
    case "START_SESSION":
      return { state: await startSession(message.tabId, message.streamId) };
    case "REGISTER_IN_PAGE":
      return { state: registerInPageSession(message.tabId) };
    case "STOP_IN_PAGE":
      return { state: stopInPageSession(message.tabId) };
    case "STOP_SESSION":
      await destroySession(message.tabId);
      return { state: publicState(message.tabId), sessionCount: sessions.size };
    case "DELETE_TAB":
      await destroySession(message.tabId);
      inPageSessions.delete(message.tabId);
      tabSettings.delete(message.tabId);
      return { state: publicState(message.tabId), sessionCount: sessions.size + inPageSessions.size };
    case "SET_VOLUME":
      return { state: inPageSessions.has(message.tabId)
        ? setInPageVolume(message.tabId, message.volume) : setVolume(message.tabId, message.volume) };
    case "SET_MUTED":
      return { state: inPageSessions.has(message.tabId)
        ? setInPageMuted(message.tabId, message.muted) : setMuted(message.tabId, message.muted) };
    case "SET_EQ_ENABLED":
      return { state: inPageSessions.has(message.tabId)
        ? setInPageEqEnabled(message.tabId, message.eqEnabled) : setEqEnabled(message.tabId, message.eqEnabled) };
    case "SET_EQ_BAND":
      return { state: inPageSessions.has(message.tabId)
        ? setInPageEqBand(message.tabId, message.bandIndex, message.gain)
        : setEqBand(message.tabId, message.bandIndex, message.gain) };
    case "APPLY_EQ_PRESET":
      return { state: applyEqPreset(message.tabId, message.preset, message.gains) };
    case "MARK_SAVED_PRESET": {
      const settings = getSettings(message.tabId, true);
      // Saving never re-applies audio or overwrites edits made while storage was busy.
      if (CUSTOM_PRESET_ID.test(message.preset) && validPresetGains(message.gains)
          && settings.eqGains.every((gain, index) => gain === message.gains[index])) {
        settings.selectedPreset = message.preset;
        settings.eqDirty = false;
      }
      return { state: publicState(message.tabId) };
    }
    case "FORGET_PRESET":
      for (const settings of tabSettings.values()) {
        if (settings.selectedPreset === message.preset) settings.selectedPreset = "Custom";
      }
      return {};
    case "GET_SESSION_COUNT":
      return {
        sessionCount: sessions.size + inPageSessions.size,
        captureSessionCount: sessions.size,
        inPageSessionCount: inPageSessions.size
      };
    default:
      throw new Error("Unknown audio engine request.");
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  handleMessage(message)
    .then((response) => sendResponse({ ok: true, ...response }))
    .catch((error) => {
      console.error(`Tab Audio Control: ${message.type} failed.`, error);
      sendResponse({ ok: false, error: "Audio engine request failed." });
    });

  return true;
});
