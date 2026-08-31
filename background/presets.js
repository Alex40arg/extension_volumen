// One worker queue serializes read/validate/write across all popup windows.
let presetOperations = Promise.resolve();

function enqueuePresetOperation(operation) {
  const result = presetOperations.then(operation, operation);
  presetOperations = result.catch(() => undefined);
  return result;
}

async function readCustomPresets() {
  const data = await chrome.storage.local.get(CUSTOM_PRESETS_KEY);
  return validatedCustomPresets(data[CUSTOM_PRESETS_KEY]);
}

async function handlePresetRequest(message) {
  const presets = await readCustomPresets();
  if (message.type === "PRESETS_LIST") return { presets };

  const existing = presets.find((preset) => preset.id === message.id);
  if (message.type !== "PRESETS_SAVE" && !existing) {
    return { error: "This custom preset no longer exists." };
  }

  let preset;
  if (message.type === "PRESETS_SAVE" || message.type === "PRESETS_RENAME") {
    const result = validatePresetName(message.name, presets, message.type === "PRESETS_RENAME" ? existing.id : null);
    if (result.error) return result;
    if (message.type === "PRESETS_SAVE") {
      if (!validPresetGains(message.gains)) return { error: "The EQ curve is invalid." };
      preset = { id: `user:${crypto.randomUUID()}`, name: result.name, gains: [...message.gains] };
      presets.push(preset);
    } else {
      existing.name = result.name;
      preset = existing;
    }
  } else if (message.type === "PRESETS_DELETE") {
    presets.splice(presets.indexOf(existing), 1);
  } else {
    return { error: "Unknown preset action." };
  }

  // Commit first. A failed write must not change the selected curve or the UI list.
  await chrome.storage.local.set({ [CUSTOM_PRESETS_KEY]: presets });
  let warning = "";
  try {
    if (message.type === "PRESETS_SAVE" && Number.isInteger(message.tabId)) {
      await enqueueForTab(message.tabId, async () => {
        await ensureOffscreenDocument();
        await sendToAudioEngine("MARK_SAVED_PRESET", {
          tabId: message.tabId, preset: preset.id, gains: preset.gains
        });
      });
    } else if (message.type === "PRESETS_DELETE" && await hasOffscreenDocument()) {
      await sendToAudioEngine("FORGET_PRESET", { preset: existing.id });
    }
  } catch (error) {
    // Persistence succeeded: do not invite a retry that would create a duplicate.
    console.warn("Tab Audio Control: preset stored, temporary selection update failed.", error);
    warning = "Preset library updated. Reopen the popup to refresh the selection.";
  }
  return { presets, warning };
}
