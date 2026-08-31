const OFFSCREEN_DOCUMENT_PATH = "audio/offscreen.html";
const DEFAULT_STATE = Object.freeze({
  enabled: false,
  volume: 100,
  muted: false,
  eqEnabled: false,
  eqGains: Object.freeze(Array(7).fill(0)),
  selectedPreset: "Flat"
});
const PROTECTED_TAB_MESSAGE = "This tab cannot be controlled.";
const START_FAILURE_MESSAGE = "Unable to start audio processing.";

let creatingOffscreenDocument = null;
const tabOperationQueues = new Map();

function enqueueForTab(tabId, operation) {
  const previous = tabOperationQueues.get(tabId) || Promise.resolve();
  const result = previous.then(operation, operation);
  const queueTail = result.catch(() => undefined).finally(() => {
    if (tabOperationQueues.get(tabId) === queueTail) {
      tabOperationQueues.delete(tabId);
    }
  });
  tabOperationQueues.set(tabId, queueTail);
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
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = (async () => {
      if (!(await hasOffscreenDocument())) {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_DOCUMENT_PATH,
          reasons: ["USER_MEDIA"],
          justification: "Route user-enabled tab audio through a local per-tab volume control."
        });
      }

      // A newly created document can briefly exist before its message listener
      // is ready. A small bounded handshake avoids racing the first activation.
      let lastError = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "PING" });
          if (response?.ok) {
            return;
          }
        } catch (error) {
          lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw lastError || new Error("The audio engine did not become ready.");
    })().finally(() => {
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

function isProtectedTabUrl(url) {
  if (typeof url !== "string" || !url) {
    return false;
  }

  return /^(chrome|chrome-extension|edge|about|devtools):/i.test(url)
    || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)(\/|$)/i.test(url);
}

function looksLikeProtectedTabError(error) {
  const details = String(error?.message || error);
  return /(chrome:\/\/|edge:\/\/|web store|webstore|cannot be captured|not capturable|protected|restricted|permission denied)/i.test(details);
}

async function cleanupFailedStart(tabId) {
  if (!(await hasOffscreenDocument())) {
    return;
  }

  try {
    await sendToAudioEngine("STOP_SESSION", { tabId });
  } catch (error) {
    console.warn(`Tab Audio Control: partial cleanup failed for tab ${tabId}.`, error);
  }
}

async function enable(tabId, tabUrl) {
  if (isProtectedTabUrl(tabUrl)) {
    throw new Error(PROTECTED_TAB_MESSAGE);
  }

  try {
    await ensureOffscreenDocument();
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
    await cleanupFailedStart(tabId);
    if (error?.message === PROTECTED_TAB_MESSAGE || looksLikeProtectedTabError(error)) {
      throw new Error(PROTECTED_TAB_MESSAGE);
    }
    throw new Error(START_FAILURE_MESSAGE);
  }
}

async function disable(tabId) {
  if (!(await hasOffscreenDocument())) {
    return { ...DEFAULT_STATE };
  }

  const response = await sendToAudioEngine("STOP_SESSION", { tabId });
  return response.state;
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
      return enqueueForTab(tabId, () => getState(tabId));
    case "ENABLE":
      return enqueueForTab(tabId, () => enable(tabId, message.tabUrl));
    case "DISABLE":
      return enqueueForTab(tabId, () => disable(tabId));
    case "SET_VOLUME":
      return enqueueForTab(tabId, () => updateSession("SET_VOLUME", tabId, { volume: message.volume }));
    case "SET_MUTED":
      return enqueueForTab(tabId, () => updateSession("SET_MUTED", tabId, { muted: message.muted }));
    case "SET_EQ_ENABLED":
      return enqueueForTab(tabId, () => updateSession("SET_EQ_ENABLED", tabId, { eqEnabled: message.eqEnabled }));
    case "SET_EQ_BAND":
      return enqueueForTab(tabId, () => updateSession("SET_EQ_BAND", tabId, {
        bandIndex: message.bandIndex,
        gain: message.gain
      }));
    case "APPLY_EQ_PRESET":
      return enqueueForTab(tabId, () => updateSession("APPLY_EQ_PRESET", tabId, {
        preset: message.preset
      }));
    case "FLAT_EQ":
      return enqueueForTab(tabId, () => updateSession("APPLY_EQ_PRESET", tabId, {
        preset: "Flat"
      }));
    default:
      throw new Error("Unknown extension request.");
  }
}

function userFacingError(error, type) {
  if (error?.message === PROTECTED_TAB_MESSAGE || error?.message === START_FAILURE_MESSAGE) {
    return error.message;
  }
  if (type === "ENABLE") {
    return START_FAILURE_MESSAGE;
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
      sendResponse({ ok: false, error: userFacingError(error, message.type) });
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueueForTab(tabId, async () => {
    if (!(await hasOffscreenDocument())) {
      return;
    }

    await sendToAudioEngine("DELETE_TAB", { tabId });
  }).catch((error) => {
    console.warn(`Tab Audio Control: cleanup failed for closed tab ${tabId}.`, error);
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "service-worker" || message.type !== "SESSION_ENDED") {
    return false;
  }

  const tabId = message.tabId;
  if (!Number.isInteger(tabId)) {
    return false;
  }

  void enqueueForTab(tabId, async () => {
    const state = await getState(tabId);
    await chrome.runtime.sendMessage({
      target: "popup",
      type: "TAB_STATE_CHANGED",
      tabId,
      reason: "stream-ended",
      state
    }).catch(() => undefined);
  }).catch((error) => {
    console.warn(`Tab Audio Control: unable to report ended session for tab ${tabId}.`, error);
  });
  return false;
});
