importScripts("../shared/presets.js", "presets.js");

const OFFSCREEN_DOCUMENT_PATH = "audio/offscreen.html";
const DEFAULT_STATE = Object.freeze({
  enabled: false,
  backend: null,
  volume: 100,
  muted: false,
  eqEnabled: false,
  analyzerEnabled: false,
  eqDirty: false,
  eqGains: Object.freeze(Array(7).fill(0)),
  selectedPreset: "Flat"
});
const PROTECTED_TAB_MESSAGE = "This tab cannot be controlled.";
const START_FAILURE_MESSAGE = "Unable to start audio processing.";
const IN_PAGE_CONTROLLER_KEY = "__tabAudioControlInPageV09";

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

async function getStoredState(tabId) {
  if (!(await hasOffscreenDocument())) {
    return { ...DEFAULT_STATE };
  }

  const response = await sendToAudioEngine("GET_STATE", { tabId });
  return response.state;
}

async function runInPageCommand(tabId, type, data = {}) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (controllerKey, commandType, commandData) => {
      const controller = globalThis[controllerKey];
      if (!controller) throw new Error("The in-page controller is unavailable.");
      return controller.command(commandType, commandData);
    },
    args: [IN_PAGE_CONTROLLER_KEY, type, data]
  });
  const result = results?.[0]?.result;
  if (!result) throw new Error("The in-page controller did not respond.");
  return result;
}

async function injectInPageController(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["shared/audio-config.js", "inpage/controller.js"]
  });
}

async function getState(tabId) {
  const state = await getStoredState(tabId);
  if (state.backend !== "in-page") return state;
  try {
    const response = await runInPageCommand(tabId, "PING");
    if (response.ok && response.active) return state;
  } catch {
    // A full navigation destroys the isolated controller. The offscreen
    // registry must not keep a zombie in-page session afterward.
  }
  const response = await sendToAudioEngine("STOP_IN_PAGE", { tabId });
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
    await runInPageCommand(tabId, "BYPASS").catch(() => undefined);
    await sendToAudioEngine("STOP_IN_PAGE", { tabId });
    await sendToAudioEngine("STOP_SESSION", { tabId });
  } catch (error) {
    console.warn(`Tab Audio Control: partial cleanup failed for tab ${tabId}.`, error);
  }
}

async function startCaptureFallback(tabId) {
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const response = await sendToAudioEngine("START_SESSION", { tabId, streamId });
  console.debug(`Tab Audio Control: capture fallback selected for tab ${tabId}.`);
  return response.state;
}

async function tryStartInPage(tabId, initialState) {
  try {
    await injectInPageController(tabId);
    const result = await runInPageCommand(tabId, "START", {
      eqEnabled: initialState.eqEnabled,
      analyzerEnabled: initialState.analyzerEnabled,
      eqGains: initialState.eqGains
    });
    if (!result.ok) {
      console.debug(`Tab Audio Control: in-page fallback triggered for tab ${tabId} (${result.reason || "unavailable"}).`);
      return null;
    }
    const response = await sendToAudioEngine("REGISTER_IN_PAGE", { tabId });
    console.debug(`Tab Audio Control: fullscreen-friendly backend selected for tab ${tabId}.`);
    return response.state;
  } catch (error) {
    console.debug(`Tab Audio Control: in-page fallback triggered for tab ${tabId}.`, error);
    await runInPageCommand(tabId, "BYPASS").catch(() => undefined);
    await sendToAudioEngine("STOP_IN_PAGE", { tabId }).catch(() => undefined);
    return null;
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

    // activeTab exists only because the user opened the popup and explicitly
    // enabled processing. No persistent host access is requested.
    const inPageState = await tryStartInPage(tabId, existingState);
    return inPageState || startCaptureFallback(tabId);
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

  const state = await getStoredState(tabId);
  if (state.backend === "in-page") {
    await runInPageCommand(tabId, "BYPASS").catch((error) => {
      console.warn(`Tab Audio Control: in-page cleanup failed for tab ${tabId}.`, error);
    });
    const response = await sendToAudioEngine("STOP_IN_PAGE", { tabId });
    return response.state;
  }
  const response = await sendToAudioEngine("STOP_SESSION", { tabId });
  return response.state;
}

async function updateSession(type, tabId, data) {
  if (!(await hasOffscreenDocument())) {
    throw new Error("Audio processing is not active on this tab.");
  }

  const state = await getStoredState(tabId);
  if (state.backend === "in-page") {
    try {
      await runInPageCommand(tabId, type, data);
    } catch (error) {
      await sendToAudioEngine("STOP_IN_PAGE", { tabId }).catch(() => undefined);
      throw error;
    }
  }
  const response = await sendToAudioEngine(type, { tabId, ...data });
  return response.state;
}

async function getSpectrum(tabId) {
  if (!(await hasOffscreenDocument())) return { active: false };
  const state = await getStoredState(tabId);
  if (state.backend === "in-page") {
    try {
      return await runInPageCommand(tabId, "GET_SPECTRUM");
    } catch {
      await sendToAudioEngine("STOP_IN_PAGE", { tabId }).catch(() => undefined);
      return { active: false };
    }
  }
  if (state.backend === "tab-capture") return sendToAudioEngine("GET_SPECTRUM", { tabId });
  return { active: false };
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
    case "SET_ANALYZER_ENABLED":
      return enqueueForTab(tabId, () => updateSession("SET_ANALYZER_ENABLED", tabId, { analyzerEnabled: message.analyzerEnabled }));
    case "SET_EQ_BAND":
      return enqueueForTab(tabId, () => updateSession("SET_EQ_BAND", tabId, {
        bandIndex: message.bandIndex,
        gain: message.gain
      }));
    case "APPLY_EQ_PRESET":
      return enqueuePresetOperation(() => enqueueForTab(tabId, async () => {
        let gains;
        if (!Object.hasOwn(EQ_PRESETS, message.preset)) {
          const preset = (await readCustomPresets()).find((item) => item.id === message.preset);
          if (!preset) throw new Error("Unknown custom preset.");
          gains = preset.gains;
        }
        // Loading a curve while OFF creates only temporary settings, never a capture.
        await ensureOffscreenDocument();
        return updateSession("APPLY_EQ_PRESET", tabId, { preset: message.preset, gains });
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

  if (["PRESETS_LIST", "PRESETS_SAVE", "PRESETS_RENAME", "PRESETS_DELETE"].includes(message.type)) {
    enqueuePresetOperation(() => handlePresetRequest(message))
      .then((result) => sendResponse({ ok: !result.error, ...result }))
      .catch((error) => {
        console.error("Tab Audio Control: preset storage operation failed.", error);
        const verb = { PRESETS_LIST: "load", PRESETS_SAVE: "save", PRESETS_RENAME: "rename", PRESETS_DELETE: "delete" }[message.type];
        sendResponse({ ok: false, error: `Unable to ${verb} preset${message.type === "PRESETS_LIST" ? "s" : ""}. Please try again.` });
      });
    return true;
  }

  if (message.type === "GET_SPECTRUM") {
    const tabId = message.tabId;
    if (!Number.isInteger(tabId) || tabId < 0) {
      sendResponse({ ok: false, active: false });
      return false;
    }
    enqueueForTab(tabId, () => getSpectrum(tabId))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch(() => sendResponse({ ok: false, active: false }));
    return true;
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  void enqueueForTab(tabId, async () => {
    if (!(await hasOffscreenDocument())) return;
    const state = await getStoredState(tabId);
    if (state.backend !== "in-page") return;
    try {
      const response = await runInPageCommand(tabId, "PING");
      if (response.ok && response.active) return; // Same-document/SPA update.
    } catch {
      // A new document has no controller; clear the old registry below.
    }
    await sendToAudioEngine("STOP_IN_PAGE", { tabId });
    console.debug(`Tab Audio Control: in-page state cleared after navigation in tab ${tabId}.`);
  }).catch((error) => {
    console.warn(`Tab Audio Control: navigation cleanup failed for tab ${tabId}.`, error);
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
