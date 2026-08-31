const EQ_BAND_COUNT = 7;
const DEFAULT_STATE = Object.freeze({
  enabled: false,
  volume: 100,
  muted: false,
  eqEnabled: false,
  analyzerEnabled: false,
  eqDirty: false,
  eqGains: Object.freeze(Array(EQ_BAND_COUNT).fill(0)),
  selectedPreset: "Flat"
});

const elements = {
  processingToggle: document.querySelector("#processing-toggle"),
  analyzerToggle: document.querySelector("#analyzer-toggle"),
  analyzerState: document.querySelector("#analyzer-state"),
  audioControls: document.querySelector("#audio-controls"),
  volumeSlider: document.querySelector("#volume-slider"),
  volumeOutput: document.querySelector("#volume-output"),
  resetButton: document.querySelector("#reset-button"),
  muteButton: document.querySelector("#mute-button"),
  equalizerToggle: document.querySelector("#equalizer-toggle"),
  equalizerState: document.querySelector("#equalizer-state"),
  equalizerControls: document.querySelector("#equalizer-controls"),
  equalizerBands: [...document.querySelectorAll("[data-eq-band]")],
  presetSelect: document.querySelector("#preset-select"),
  factoryPresets: document.querySelector("#factory-presets"),
  customPresets: document.querySelector("#custom-presets"),
  savePreset: document.querySelector("#save-preset"),
  renamePreset: document.querySelector("#rename-preset"),
  deletePreset: document.querySelector("#delete-preset"),
  presetEditor: document.querySelector("#preset-editor"),
  presetEditorTitle: document.querySelector("#preset-editor-title"),
  presetNameRow: document.querySelector("#preset-name-row"),
  presetName: document.querySelector("#preset-name"),
  confirmPreset: document.querySelector("#confirm-preset"),
  cancelPreset: document.querySelector("#cancel-preset"),
  presetMessage: document.querySelector("#preset-message"),
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
let customPresets = [];
let presetBusy = false;
let presetEditor = null;
let presetMessageTimer;
let analyzerBusy = false;
let popupClosed = false;
const spectrum = new SpectrumView(
  document.querySelector("#spectrum-canvas"),
  document.querySelector("#spectrum-status"),
  // Direct local request: no worker relay, no capture creation, one in flight.
  () => chrome.runtime.sendMessage({ target: "offscreen", type: "GET_SPECTRUM", tabId: currentTabId })
);

function renderAnalyzer() {
  elements.analyzerToggle.checked = currentState.analyzerEnabled;
  elements.analyzerToggle.disabled = busy || analyzerBusy || !currentState.enabled;
  elements.analyzerState.textContent = currentState.analyzerEnabled ? "ON" : "OFF";
  const active = currentState.enabled && currentState.analyzerEnabled && !busy && !analyzerBusy
    && !popupClosed && !document.hidden;
  spectrum.update(active, currentState.analyzerEnabled
    ? "Inactive · audio processing off or popup paused" : "Analyzer off");
}

function showPresetMessage(text = "", error = false) {
  clearTimeout(presetMessageTimer);
  elements.presetMessage.textContent = text;
  elements.presetMessage.hidden = !text;
  elements.presetMessage.dataset.error = String(error);
  if (text && !error) presetMessageTimer = setTimeout(() => showPresetMessage(), 4500);
}

function appendPresetOption(group, value, name) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = name;
  group.append(option);
}

function updatePresetList(presets) {
  customPresets = validatedCustomPresets(presets);
  elements.customPresets.replaceChildren();
  for (const preset of customPresets) appendPresetOption(elements.customPresets, preset.id, preset.name);
  renderPresetControls();
}

function renderPresetControls() {
  const selected = customPresets.find((preset) => preset.id === currentState.selectedPreset);
  const available = Object.hasOwn(EQ_PRESETS, currentState.selectedPreset) || selected;
  elements.presetSelect.value = available ? currentState.selectedPreset : "Custom";
  elements.presetSelect.disabled = busy || eqBusy || currentTabId === null;
  elements.savePreset.disabled = busy || eqBusy || presetBusy || !currentState.eqDirty
    || currentState.selectedPreset !== "Custom" || !validPresetGains(currentState.eqGains);
  elements.renamePreset.disabled = presetBusy || !selected;
  elements.deletePreset.disabled = presetBusy || !selected;
  elements.confirmPreset.disabled = presetBusy;
  elements.cancelPreset.disabled = presetBusy;
  elements.presetName.disabled = presetBusy;
}

async function presetCommand(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ target: "service-worker", type, ...data });
  if (!response?.ok) throw new Error(response?.error || "Unable to update presets. Please try again.");
  return response;
}

async function loadCustomPresets() {
  try {
    const response = await presetCommand("PRESETS_LIST");
    updatePresetList(response.presets);
  } catch (error) {
    showPresetMessage(error.message, true);
  }
}

function openPresetEditor(action) {
  if (presetBusy) return;
  if (action === "SAVE" && elements.savePreset.disabled) return;
  const selected = customPresets.find((preset) => preset.id === currentState.selectedPreset);
  if (action !== "SAVE" && !selected) return;
  presetEditor = { action, id: selected?.id, gains: [...currentState.eqGains] };
  showPresetMessage();
  elements.presetEditor.hidden = false;
  elements.presetNameRow.hidden = action === "DELETE";
  elements.presetName.value = action === "RENAME" ? selected.name : "";
  elements.presetEditorTitle.textContent = action === "DELETE"
    ? `Delete “${selected.name}”? The current EQ curve will stay unchanged.`
    : action === "RENAME" ? "Rename preset" : "Save a copy of the current curve";
  elements.confirmPreset.textContent = { SAVE: "Save", RENAME: "Rename", DELETE: "Delete" }[action];
  renderPresetControls();
  (action === "DELETE" ? elements.cancelPreset : elements.presetName).focus();
}

function closePresetEditor() {
  const action = presetEditor?.action;
  presetEditor = null;
  elements.presetEditor.hidden = true;
  const trigger = action === "RENAME" ? elements.renamePreset : action === "DELETE" ? elements.deletePreset : elements.savePreset;
  (trigger.disabled ? elements.presetSelect : trigger).focus();
}

async function commitPreset(event) {
  event.preventDefault();
  if (presetBusy || !presetEditor) return;
  const edit = presetEditor;
  const result = edit.action === "DELETE" ? {} : validatePresetName(elements.presetName.value, customPresets, edit.action === "RENAME" ? edit.id : null);
  if (result.error) {
    showPresetMessage(result.error, true);
    elements.presetName.focus();
    return;
  }
  presetBusy = true;
  renderPresetControls();
  try {
    const data = edit.action === "SAVE"
      ? { name: result.name, gains: edit.gains, tabId: currentTabId }
      : { id: edit.id, ...(edit.action === "RENAME" ? { name: result.name } : {}) };
    const response = await presetCommand(`PRESETS_${edit.action}`, data);
    updatePresetList(response.presets);
    // Re-read the live tab; storage writes must not restore an older volume/EQ snapshot.
    await refreshState();
    showPresetMessage(response.warning || { SAVE: "Preset saved.", RENAME: "Preset renamed.", DELETE: "Preset deleted." }[edit.action], Boolean(response.warning));
    presetBusy = false;
    renderPresetControls();
    closePresetEditor();
  } catch (error) {
    showPresetMessage(error.message, true);
  } finally {
    presetBusy = false;
    renderPresetControls();
  }
}

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
    analyzerEnabled: Boolean(state.analyzerEnabled),
    eqDirty: Boolean(state.eqDirty),
    eqGains: normalizedEqGains(state.eqGains),
    selectedPreset: typeof state.selectedPreset === "string" ? state.selectedPreset : "Flat"
  };

  elements.processingToggle.checked = currentState.enabled;
  elements.processingToggle.disabled = busy || currentTabId === null;
  elements.audioControls.disabled = busy || !currentState.enabled;
  elements.volumeSlider.value = String(currentState.volume);
  elements.volumeSlider.setAttribute("aria-valuetext", `${currentState.volume}%`);
  elements.volumeOutput.value = `${currentState.volume}%`;
  elements.volumeOutput.textContent = `${currentState.volume}%`;
  elements.muteButton.setAttribute("aria-pressed", String(currentState.muted));
  elements.muteButton.textContent = currentState.muted ? "Unmute" : "Mute";
  elements.equalizerToggle.checked = currentState.eqEnabled;
  elements.equalizerToggle.disabled = busy || eqBusy || !currentState.enabled;
  elements.equalizerState.textContent = currentState.eqEnabled ? "ON" : "OFF";
  elements.equalizerControls.disabled = busy || eqBusy || !currentState.enabled || !currentState.eqEnabled;
  renderPresetControls();
  renderAnalyzer();
  elements.equalizerBands.forEach((slider, index) => {
    const gain = currentState.eqGains[index];
    slider.value = String(gain);
    slider.setAttribute("aria-valuetext", formatDb(gain));
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
    try {
      currentState = await sendCommand("GET_STATE");
    } catch {
      currentState = { ...DEFAULT_STATE };
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

async function applyEqualizerPreset(preset) {
  eqRequestNumber += 1;
  eqBusy = true;
  showMessage();
  render();

  try {
    currentState = await sendCommand("APPLY_EQ_PRESET", { preset });
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
  elements.volumeSlider.setAttribute("aria-valuetext", `${volume}%`);
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
    currentState = { ...currentState, eqGains, selectedPreset: "Custom", eqDirty: true };
    renderPresetControls();
    const output = slider.parentElement.querySelector("output");
    output.value = formatDb(gain);
    output.textContent = formatDb(gain);
    slider.setAttribute("aria-valuetext", formatDb(gain));
    void setEqBand(bandIndex, gain);
  });
});

elements.presetSelect.addEventListener("change", () => {
  void applyEqualizerPreset(elements.presetSelect.value);
});

elements.analyzerToggle.addEventListener("change", async () => {
  analyzerBusy = true;
  currentState.analyzerEnabled = elements.analyzerToggle.checked;
  renderAnalyzer(); // OFF cancels rendering immediately, before messaging.
  try {
    render(await sendCommand("SET_ANALYZER_ENABLED", { analyzerEnabled: currentState.analyzerEnabled }));
  } catch (error) {
    showMessage(error.message);
    await refreshState();
  } finally {
    analyzerBusy = false;
    renderAnalyzer();
  }
});

document.addEventListener("visibilitychange", renderAnalyzer);
window.addEventListener("pagehide", () => {
  popupClosed = true;
  spectrum.stop();
});

elements.savePreset.addEventListener("click", () => openPresetEditor("SAVE"));
elements.renamePreset.addEventListener("click", () => openPresetEditor("RENAME"));
elements.deletePreset.addEventListener("click", () => openPresetEditor("DELETE"));
elements.cancelPreset.addEventListener("click", closePresetEditor);
elements.presetEditor.addEventListener("submit", (event) => { void commitPreset(event); });
elements.presetEditor.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !presetBusy) {
    event.preventDefault();
    closePresetEditor();
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.hasOwn(changes, CUSTOM_PRESETS_KEY)) void loadCustomPresets();
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
  for (const name of Object.keys(EQ_PRESETS)) appendPresetOption(elements.factoryPresets, name, name);
  render();
  void loadCustomPresets();

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
