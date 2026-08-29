const DEFAULT_STATE = Object.freeze({ enabled: false, volume: 100, muted: false });

const elements = {
  processingToggle: document.querySelector("#processing-toggle"),
  audioControls: document.querySelector("#audio-controls"),
  volumeSlider: document.querySelector("#volume-slider"),
  volumeOutput: document.querySelector("#volume-output"),
  resetButton: document.querySelector("#reset-button"),
  muteButton: document.querySelector("#mute-button"),
  stateBadge: document.querySelector("#state-badge"),
  status: document.querySelector("#status"),
  statusText: document.querySelector("#status-text"),
  message: document.querySelector("#message")
};

let currentTabId = null;
let currentState = { ...DEFAULT_STATE };
let busy = true;
let volumeRequestNumber = 0;

function showMessage(text = "") {
  elements.message.textContent = text;
  elements.message.hidden = !text;
}

function render(state = currentState) {
  currentState = {
    enabled: Boolean(state.enabled),
    volume: Number.isFinite(state.volume) ? state.volume : 100,
    muted: Boolean(state.muted)
  };

  elements.processingToggle.checked = currentState.enabled;
  elements.processingToggle.disabled = busy || currentTabId === null;
  elements.audioControls.disabled = busy || !currentState.enabled;
  elements.volumeSlider.value = String(currentState.volume);
  elements.volumeOutput.value = `${currentState.volume}%`;
  elements.volumeOutput.textContent = `${currentState.volume}%`;
  elements.muteButton.setAttribute("aria-pressed", String(currentState.muted));
  elements.muteButton.textContent = currentState.muted ? "Unmute" : "Mute";
  elements.stateBadge.textContent = currentState.enabled ? "ON" : "OFF";
  elements.stateBadge.className = `badge ${currentState.enabled ? "badge-on" : "badge-off"}`;
  elements.status.className = `status ${currentState.enabled ? "status-on" : "status-off"}`;
  elements.statusText.textContent = currentState.enabled
    ? currentState.muted
      ? "Audio processing active · Muted"
      : "Audio processing active"
    : "Not active on this tab";
}

async function sendCommand(type, data = {}) {
  const response = await chrome.runtime.sendMessage({
    target: "service-worker",
    type,
    tabId: currentTabId,
    ...data
  });

  if (!response?.ok) {
    throw new Error(response?.error || "The extension could not complete that action.");
  }

  return response.state;
}

async function setProcessing(enabled) {
  busy = true;
  showMessage();
  render();

  try {
    currentState = await sendCommand(enabled ? "ENABLE" : "DISABLE");
  } catch (error) {
    showMessage(error.message);
  } finally {
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

async function refreshState() {
  try {
    currentState = await sendCommand("GET_STATE");
  } catch (error) {
    currentState = { ...DEFAULT_STATE };
    showMessage(error.message);
  } finally {
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

async function initialize() {
  render();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) {
      throw new Error("No active tab is available.");
    }

    currentTabId = tab.id;
    await refreshState();
  } catch (error) {
    busy = false;
    showMessage(error.message || "Unable to access the current tab.");
    render();
  }
}

void initialize();
