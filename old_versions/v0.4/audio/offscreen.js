const EQ_BANDS = Object.freeze([
  // Shelves at the spectrum edges give a more natural broad bass/treble shape;
  // the five musical mid bands use moderate-Q peaking filters.
  Object.freeze({ frequency: 30, type: "lowshelf" }),
  Object.freeze({ frequency: 90, type: "peaking", q: 1 }),
  Object.freeze({ frequency: 300, type: "peaking", q: 1 }),
  Object.freeze({ frequency: 1000, type: "peaking", q: 1 }),
  Object.freeze({ frequency: 3000, type: "peaking", q: 1 }),
  Object.freeze({ frequency: 8000, type: "peaking", q: 1 }),
  Object.freeze({ frequency: 15000, type: "highshelf" })
]);
const DEFAULT_EQ_GAINS = Object.freeze(EQ_BANDS.map(() => 0));
const DEFAULT_STATE = Object.freeze({
  enabled: false,
  volume: 100,
  muted: false,
  eqEnabled: false,
  eqGains: DEFAULT_EQ_GAINS
});
const PARAM_RAMP_SECONDS = 0.02;
const sessions = new Map();

function publicState(session) {
  return session
    ? {
        enabled: true,
        volume: session.volume,
        muted: session.muted,
        eqEnabled: session.eqEnabled,
        eqGains: [...session.eqGains]
      }
    : { ...DEFAULT_STATE, eqGains: [...DEFAULT_EQ_GAINS] };
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
  session.eqFilters.forEach((filter, index) => {
    const effectiveGain = session.eqEnabled ? session.eqGains[index] : 0;
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
    return publicState(sessions.get(tabId));
  }

  let stream = null;
  let audioContext = null;
  let sourceNode = null;
  let eqFilters = [];
  let gainNode = null;

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

    // Hearing-safety invariant: every newly controlled tab starts at unity gain.
    gainNode.gain.setValueAtTime(1, audioContext.currentTime);
    sourceNode.connect(eqFilters[0]);
    for (let index = 0; index < eqFilters.length - 1; index += 1) {
      eqFilters[index].connect(eqFilters[index + 1]);
    }
    eqFilters.at(-1).connect(gainNode);
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
      stream,
      audioContext,
      sourceNode,
      eqFilters,
      gainNode,
      volume: 100,
      muted: false,
      eqEnabled: false,
      eqGains: [...DEFAULT_EQ_GAINS],
      handleTrackEnded
    };
    sessions.set(tabId, session);

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
      throw new Error("The captured stream ended during initialization.");
    }

    return publicState(session);
  } catch (error) {
    disconnectNode(sourceNode, "partial source node");
    eqFilters.forEach((filter, index) => disconnectNode(filter, `partial EQ band ${index + 1}`));
    disconnectNode(gainNode, "partial gain node");

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
  return publicState(session);
}

function setMuted(tabId, value) {
  if (typeof value !== "boolean") {
    throw new Error("Muted state must be a boolean.");
  }

  const session = requireSession(tabId);
  session.muted = value;
  applyGain(session);
  return publicState(session);
}

function setEqEnabled(tabId, value) {
  if (typeof value !== "boolean") {
    throw new Error("Equalizer state must be a boolean.");
  }

  const session = requireSession(tabId);
  session.eqEnabled = value;
  applyEq(session);
  return publicState(session);
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
  session.eqGains[bandIndex] = gain;
  const effectiveGain = session.eqEnabled ? gain : 0;
  rampAudioParam(session.eqFilters[bandIndex].gain, effectiveGain, session.audioContext);
  return publicState(session);
}

function setFlatEq(tabId) {
  const session = requireSession(tabId);
  session.eqGains.fill(0);
  applyEq(session);
  return publicState(session);
}

async function handleMessage(message) {
  if (!Number.isInteger(message.tabId) && !["GET_SESSION_COUNT", "PING"].includes(message.type)) {
    throw new Error("A valid tab ID is required.");
  }

  switch (message.type) {
    case "PING":
      return {};
    case "GET_STATE":
      return { state: publicState(sessions.get(message.tabId)) };
    case "START_SESSION":
      return { state: await startSession(message.tabId, message.streamId) };
    case "STOP_SESSION":
      await destroySession(message.tabId);
      return { state: { ...DEFAULT_STATE }, sessionCount: sessions.size };
    case "SET_VOLUME":
      return { state: setVolume(message.tabId, message.volume) };
    case "SET_MUTED":
      return { state: setMuted(message.tabId, message.muted) };
    case "SET_EQ_ENABLED":
      return { state: setEqEnabled(message.tabId, message.eqEnabled) };
    case "SET_EQ_BAND":
      return { state: setEqBand(message.tabId, message.bandIndex, message.gain) };
    case "FLAT_EQ":
      return { state: setFlatEq(message.tabId) };
    case "GET_SESSION_COUNT":
      return { sessionCount: sessions.size };
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
