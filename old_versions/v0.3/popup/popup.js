const EQ_BAND_COUNT = 6;
const DEFAULT_STATE = Object.freeze({
  enabled: false,
  volume: 100,
  muted: false,
  eqEnabled: false,
  eqGains: Object.freeze(Array(EQ_BAND_COUNT).fill(0))
});

const elements = {
  processingToggle: document.querySelector("#processing-toggle"),
  audioControls: document.querySelector("#audio-controls"),
  volumeSlider: document.querySelector("#volume-slider"),
  volumeOutput: document.querySelector("#volume-output"),
  resetButton: document.querySelector("#reset-button"),
  muteButton: document.querySelector("#mute-button"),
  equalizerToggle: document.querySelector("#equalizer-toggle"),
  equalizerState: document.querySelector("#equalizer-state"),
  equalizerControls: document.querySelector("#equalizer-controls"),
  equalizerBands: [...document.querySelectorAll("[data-eq-band]")],
  flatButton: document.querySelector("#flat-button"),
  stateBadge: document.querySelector("#state-badge"),
  status: document.querySelector("#status"),
  statusText: document.querySelector("#status-text"),
  message: document.querySelector("#message")
};

let currentTabId = null;
let currentTabUrl = "";
let currentState = { ...DEFAULT_STATE };
let busy = true;
let volumeRequestNumber = 0;
let eqRequestNumber = 0;
let eqBusy = false;
let transition = "";
let currentError = "";

function showMessage(text = "") {
  currentError = text;
  elements.message.textContent = text;
  elements.message.hidden = !text;
}

function normalizedEqGains(value) {
  return Array.isArray(value) && value.length === EQ_BAND_COUNT
    ? value.map((gain) => Number.isFinite(gain) ? gain : 0)
    : Array(EQ_BAND_COUNT).fill(0);
}

function formatDb(value) {
  return `${value > 0 ? "+" : ""}${value} dB`;
}

function render(state = currentState) {
  currentState = {
    enabled: Boolean(state.enabled),
    volume: Number.isFinite(state.volume) ? state.volume : 100,
    muted: Boolean(state.muted),
    eqEnabled: Boolean(state.eqEnabled),
    eqGains: normalizedEqGains(state.eqGains)
  };

  elements.processingToggle.checked = currentState.enabled;
  elements.processingToggle.disabled = busy || currentTabId === null;
  elements.audioControls.disabled = busy || !currentState.enabled;
  elements.volumeSlider.value = String(currentState.volume);
  elements.volumeOutput.value = `${currentState.volume}%`;
  elements.volumeOutput.textContent = `${currentState.volume}%`;
  elements.muteButton.setAttribute("aria-pressed", String(currentState.muted));
  elements.muteButton.textContent = currentState.muted ? "Unmute" : "Mute";
  elements.equalizerToggle.checked = currentState.eqEnabled;
  elements.equalizerToggle.disabled = busy || eqBusy || !currentState.enabled;
  elements.equalizerState.textContent = currentState.eqEnabled ? "ON" : "OFF";
  elements.equalizerControls.disabled = busy || eqBusy || !currentState.enabled || !currentState.eqEnabled;
  elements.equalizerBands.forEach((slider, index) => {
    const gain = currentState.eqGains[index];
    slider.value = String(gain);
    const output = slider.parentElement.querySelector("output");
    output.value = formatDb(gain);
    output.textContent = formatDb(gain);
  });
  elements.stateBadge.textContent = currentState.enabled ? "ON" : "OFF";
  elements.stateBadge.className = `badge ${currentState.enabled ? "badge-on" : "badge-off"}`;
  const statusKind = currentError ? "error" : currentState.enabled ? "on" : "off";
  elements.status.className = `status status-${statusKind}`;
  elements.statusText.textContent = currentError
    || (transition === "starting" ? "Starting audio processing…" : "")
    || (transition === "stopping" ? "Stopping audio processing…" : "")
    || (currentState.enabled
      ? currentState.muted
        ? "Audio processing active · Muted"
        : "Audio processing active"
      : "Not active on this tab");
}

async function sendCommand(type, data = {}) {
  const response = await chrome.runtime.sendMessage({
    target: "service-worker",
    type,
    tabId: currentTabId,
    tabUrl: currentTabUrl,
    ...data
  });

  if (!response?.ok) {
    throw new Error(response?.error || "The extension could not complete that action.");
  }

  return response.state;
}

async function setProcessing(enabled) {
  busy = true;
  transition = enabled ? "starting" : "stopping";
  showMessage();
  render();

  try {
    currentState = await sendCommand(enabled ? "ENABLE" : "DISABLE");
  } catch (error) {
    if (enabled) {
      currentState = { ...DEFAULT_STATE };
    } else {
      try {
        currentState = await sendCommand("GET_STATE");
      } catch {
        currentState = { ...DEFAULT_STATE };
      }
    }
    showMessage(error.message);
  } finally {
    transition = "";
    busy = false;
    render();
  }
}

async function setVolume(volume) {
  const requestNumber = ++volumeRequestNumber;
  showMessage();

  try {
    const state = await sendCommand("SET_VOLUME", { volume });
    if (requestNumber === volumeRequestNumber) {
      render(state);
    }
  } catch (error) {
    if (requestNumber === volumeRequestNumber) {
      showMessage(error.message);
      await refreshState();
    }
  }
}

async function setEqualizerEnabled(eqEnabled) {
  eqBusy = true;
  showMessage();
  currentState = { ...currentState, eqEnabled };
  render();

  try {
    currentState = await sendCommand("SET_EQ_ENABLED", { eqEnabled });
  } catch (error) {
    showMessage(error.message);
    await refreshState();
  } finally {
    eqBusy = false;
    render();
  }
}

async function setEqBand(bandIndex, gain) {
  const requestNumber = ++eqRequestNumber;
  showMessage();

  try {
    const state = await sendCommand("SET_EQ_BAND", { bandIndex, gain });
    if (requestNumber === eqRequestNumber) {
      render(state);
    }
  } catch (error) {
    if (requestNumber === eqRequestNumber) {
      showMessage(error.message);
      await refreshState();
    }
  }
}

async function setFlatEqualizer() {
  eqRequestNumber += 1;
  eqBusy = true;
  showMessage();
  render();

  try {
    currentState = await sendCommand("FLAT_EQ");
  } catch (error) {
    showMessage(error.message);
    await refreshState();
  } finally {
    eqBusy = false;
    render();
  }
}

async function refreshState() {
  try {
    currentState = await sendCommand("GET_STATE");
  } catch (error) {
    currentState = { ...DEFAULT_STATE };
    showMessage(error.message);
  } finally {
    transition = "";
    busy = false;
    render();
  }
}

elements.processingToggle.addEventListener("change", () => {
  void setProcessing(elements.processingToggle.checked);
});

elements.volumeSlider.addEventListener("input", () => {
  const volume = Number(elements.volumeSlider.value);
  elements.volumeOutput.value = `${volume}%`;
  elements.volumeOutput.textContent = `${volume}%`;
  void setVolume(volume);
});

elements.resetButton.addEventListener("click", () => {
  void setVolume(100);
});

elements.muteButton.addEventListener("click", async () => {
  showMessage();
  elements.muteButton.disabled = true;

  try {
    const state = await sendCommand("SET_MUTED", { muted: !currentState.muted });
    render(state);
  } catch (error) {
    showMessage(error.message);
  } finally {
    elements.muteButton.disabled = false;
  }
});

elements.equalizerToggle.addEventListener("change", () => {
  void setEqualizerEnabled(elements.equalizerToggle.checked);
});

elements.equalizerBands.forEach((slider) => {
  slider.addEventListener("input", () => {
    const bandIndex = Number(slider.dataset.eqBand);
    const gain = Number(slider.value);
    const eqGains = [...currentState.eqGains];
    eqGains[bandIndex] = gain;
    currentState = { ...currentState, eqGains };
    const output = slider.parentElement.querySelector("output");
    output.value = formatDb(gain);
    output.textContent = formatDb(gain);
    void setEqBand(bandIndex, gain);
  });
});

elements.flatButton.addEventListener("click", () => {
  void setFlatEqualizer();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "popup" || message.type !== "TAB_STATE_CHANGED" || message.tabId !== currentTabId) {
    return false;
  }

  volumeRequestNumber += 1;
  eqRequestNumber += 1;
  currentState = message.state || { ...DEFAULT_STATE };
  busy = false;
  transition = "";
  showMessage(currentState.enabled ? "" : "Audio processing stopped unexpectedly.");
  render();
  return false;
});

async function initialize() {
  render();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) {
      throw new Error("No active tab is available.");
    }

    currentTabId = tab.id;
    currentTabUrl = typeof tab.url === "string" ? tab.url : "";
    await refreshState();
  } catch (error) {
    busy = false;
    showMessage(error.message || "Unable to access the current tab.");
    render();
  }
}

void initialize();
