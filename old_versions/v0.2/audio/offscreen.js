const DEFAULT_STATE = Object.freeze({ enabled: false, volume: 100, muted: false });
const GAIN_RAMP_SECONDS = 0.02;
const sessions = new Map();

function publicState(session) {
  return session
    ? { enabled: true, volume: session.volume, muted: session.muted }
    : { ...DEFAULT_STATE };
}

function requireSession(tabId) {
  const session = sessions.get(tabId);
  if (!session) {
    throw new Error(`No active audio session for tab ${tabId}.`);
  }
  return session;
}

function applyGain(session) {
  const effectiveGain = session.muted ? 0 : session.volume / 100;
  const gain = session.gainNode.gain;
  const now = session.audioContext.currentTime;

  // Hold the gain at its exact in-flight value before starting a new ramp. This
  // avoids discontinuities when slider input events arrive faster than 20 ms.
  if (typeof gain.cancelAndHoldAtTime === "function") {
    gain.cancelAndHoldAtTime(now);
  } else {
    const currentGain = gain.value;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(currentGain, now);
  }

  gain.linearRampToValueAtTime(effectiveGain, now + GAIN_RAMP_SECONDS);
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
    gainNode = audioContext.createGain();

    // Hearing-safety invariant: every newly controlled tab starts at unity gain.
    gainNode.gain.setValueAtTime(1, audioContext.currentTime);
    sourceNode.connect(gainNode);
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
      gainNode,
      volume: 100,
      muted: false,
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
      gainNode = null;
      throw new Error("The captured stream ended during initialization.");
    }

    return publicState(session);
  } catch (error) {
    disconnectNode(sourceNode, "partial source node");
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
