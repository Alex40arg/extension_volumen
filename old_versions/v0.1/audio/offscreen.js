const DEFAULT_STATE = Object.freeze({ enabled: false, volume: 100, muted: false });
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
  session.gainNode.gain.setValueAtTime(effectiveGain, session.audioContext.currentTime);
}

async function destroySession(tabId, notify = false) {
  const session = sessions.get(tabId);
  if (!session) {
    return;
  }

  sessions.delete(tabId);
  for (const track of session.stream.getTracks()) {
    track.onended = null;
  }

  try {
    session.sourceNode.disconnect();
    session.gainNode.disconnect();
  } catch (error) {
    console.warn(`Tab Audio Control: node disconnect failed for tab ${tabId}.`, error);
  }

  for (const track of session.stream.getTracks()) {
    track.stop();
  }

  if (session.audioContext.state !== "closed") {
    await session.audioContext.close();
  }

  if (notify) {
    void chrome.runtime.sendMessage({
      target: "service-worker",
      type: "SESSION_ENDED",
      tabId
    }).catch(() => undefined);
  }
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

    const session = {
      stream,
      audioContext,
      sourceNode,
      gainNode,
      volume: 100,
      muted: false
    };
    sessions.set(tabId, session);

    for (const track of stream.getTracks()) {
      track.onended = () => {
        void destroySession(tabId, true).catch((error) => {
          console.error(`Tab Audio Control: ended session cleanup failed for tab ${tabId}.`, error);
        });
      };
    }

    return publicState(session);
  } catch (error) {
    try {
      sourceNode?.disconnect();
      gainNode?.disconnect();
    } catch {
      // The nodes may never have been connected.
    }

    for (const track of stream?.getTracks() || []) {
      track.stop();
    }

    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close();
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
  if (!Number.isInteger(message.tabId) && message.type !== "GET_SESSION_COUNT") {
    throw new Error("A valid tab ID is required.");
  }

  switch (message.type) {
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
