// Factory curves are immutable code; only user-created presets go into storage.
const EQ_PRESETS = Object.freeze({
  Flat: Object.freeze([0, 0, 0, 0, 0, 0, 0]),
  "Soft V": Object.freeze([4, 3, -1, -3, -1, 2, 4]),
  Bass: Object.freeze([6, 5, 2, 0, -1, 0, 0]),
  Voice: Object.freeze([-4, -2, 0, 3, 4, 1, -1]),
  Treble: Object.freeze([-1, 0, 0, 0, 2, 5, 6])
});
const CUSTOM_PRESETS_KEY = "customPresets";
const CUSTOM_PRESET_ID = /^user:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function validPresetGains(gains) {
  return Array.isArray(gains) && gains.length === 7
    && Array.from(gains).every((gain) => Number.isInteger(gain) && gain >= -12 && gain <= 12);
}

function presetNameKey(name) {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
}

function validatePresetName(value, presets, exceptId = null) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { error: "Enter a preset name." };
  if (name.length > 30) return { error: "Use 30 characters or fewer." };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { error: "Use a single-line preset name." };
  const key = presetNameKey(name);
  if ([...Object.keys(EQ_PRESETS), "Custom"].some((item) => presetNameKey(item) === key)
      || presets.some((item) => item.id !== exceptId && presetNameKey(item.name) === key)) {
    return { error: "Name already exists. Choose a different name." };
  }
  return { name };
}

function validatedCustomPresets(value) {
  const presets = [];
  if (!Array.isArray(value)) return presets;
  for (const item of value) {
    if (!item || typeof item.id !== "string" || !CUSTOM_PRESET_ID.test(item.id)
        || presets.some((preset) => preset.id === item.id) || !validPresetGains(item.gains)) {
      console.warn("Tab Audio Control: ignored an invalid custom preset.");
      continue;
    }
    const result = validatePresetName(item.name, presets);
    if (result.error) {
      console.warn("Tab Audio Control: ignored an invalid preset name.");
      continue;
    }
    // Strip unexpected fields; never propagate unrelated stored data.
    presets.push({ id: item.id, name: result.name, gains: [...item.gains] });
  }
  return presets;
}
