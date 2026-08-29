const OFFSCREEN_DOCUMENT_PATH = "audio/offscreen.html";
const DEFAULT_STATE = Object.freeze({ enabled: false, volume: 100, muted: false });

let creatingOffscreenDocument = null;
let operationQueue = Promise.resolve();

function enqueue(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => undefined);
  return result;
}

async function hasOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Route user-enabled tab audio through a local per-tab volume control."
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }

  await creatingOffscreenDocument;
}

async function sendToAudioEngine(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ target: "offscreen", type, ...data });
  if (!response?.ok) {
    throw new Error(response?.error || "Audio engine request failed.");
  }
  return response;
}

async function getState(tabId) {
  if (!(await hasOffscreenDocument())) {
    return { ...DEFAULT_STATE };
  }

  const response = await sendToAudioEngine("GET_STATE", { tabId });
  return response.state;
}

async function enable(tabId) {
  await ensureOffscreenDocument();

  try {
    const existingState = await getState(tabId);
    if (existingState.enabled) {
      return existingState;
    }

    // This call stays downstream of the explicit popup gesture. The stream ID is
    // consumed immediately because Chrome expires unused IDs after a few seconds.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const response = await sendToAudioEngine("START_SESSION", { tabId, streamId });
    return response.state;
  } catch (error) {
    await closeAudioEngineIfUnused();
    throw error;
  }
}

async function disable(tabId) {
  if (!(await hasOffscreenDocument())) {
    return { ...DEFAULT_STATE };
  }

  const response = await sendToAudioEngine("STOP_SESSION", { tabId });
  if (response.sessionCount === 0 && (await hasOffscreenDocument())) {
    await chrome.offscreen.closeDocument();
  }
  return { ...DEFAULT_STATE };
}

async function updateSession(type, tabId, data) {
  if (!(await hasOffscreenDocument())) {
    throw new Error("Audio processing is not active on this tab.");
  }

  const response = await sendToAudioEngine(type, { tabId, ...data });
  return response.state;
}

async function handlePopupMessage(message) {
  const tabId = message.tabId;
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error("No valid tab is selected.");
  }

  switch (message.type) {
    case "GET_STATE":
      return getState(tabId);
    case "ENABLE":
      return enqueue(() => enable(tabId));
    case "DISABLE":
      return enqueue(() => disable(tabId));
    case "SET_VOLUME":
      return enqueue(() => updateSession("SET_VOLUME", tabId, { volume: message.volume }));
    case "SET_MUTED":
      return enqueue(() => updateSession("SET_MUTED", tabId, { muted: message.muted }));
    default:
      throw new Error("Unknown extension request.");
  }
}

function userFacingError(type) {
  if (type === "ENABLE") {
    return "This tab cannot be controlled. Try a regular webpage with audio.";
  }
  return "Unable to update audio processing for this tab.";
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "service-worker" || message.type === "SESSION_ENDED") {
    return false;
  }

  handlePopupMessage(message)
    .then((state) => sendResponse({ ok: true, state }))
    .catch((error) => {
      console.error(`Tab Audio Control: ${message.type} failed.`, error);
      sendResponse({ ok: false, error: userFacingError(message.type) });
    });

  return true;
});

async function closeAudioEngineIfUnused() {
  if (!(await hasOffscreenDocument())) {
    return;
  }

  const response = await sendToAudioEngine("GET_SESSION_COUNT");
  if (response.sessionCount === 0 && (await hasOffscreenDocument())) {
    await chrome.offscreen.closeDocument();
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(async () => {
    if (!(await hasOffscreenDocument())) {
      return;
    }

    await sendToAudioEngine("STOP_SESSION", { tabId });
    await closeAudioEngineIfUnused();
  }).catch((error) => {
    console.error(`Tab Audio Control: cleanup failed for tab ${tabId}.`, error);
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "service-worker" || message.type !== "SESSION_ENDED") {
    return false;
  }

  void enqueue(closeAudioEngineIfUnused).catch((error) => {
    console.error("Tab Audio Control: unable to release the idle audio engine.", error);
  });
  return false;
});
