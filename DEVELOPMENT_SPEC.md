# Tab Audio Control — Development Specification

## 1. Project Overview

**Working name:** Tab Audio Control
**Platform:** Google Chrome / Chromium-based browsers
**Extension architecture:** Chrome Extension Manifest V3

Tab Audio Control is a lightweight, privacy-focused browser extension designed to control the audio volume of individual browser tabs.

The extension must prioritize:

* Simplicity
* Stability
* Privacy
* Minimal permissions
* Clear user control
* Local-only audio processing
* Clean, maintainable source code

The initial version will focus exclusively on per-tab volume control.

Equalization and other audio-processing features may be added in later versions.

---

# 2. Core Philosophy

The extension should follow one guiding principle:

> Do one thing well, remain understandable, and never access more user data than necessary.

The application must avoid unnecessary complexity, external services, telemetry, advertising, tracking, analytics, remote scripts, and unnecessary browser permissions.

The source code should remain small enough to be manually reviewed.

---

# 3. Privacy Requirements

Privacy is a fundamental project requirement.

The extension MUST NOT:

* Collect browsing history.
* Read browsing history.
* Read page contents.
* Read form contents.
* Read passwords.
* Read cookies.
* Collect personally identifiable information.
* Record audio.
* Store captured audio.
* Transmit captured audio.
* Upload any user information.
* Use analytics.
* Use telemetry.
* Use advertising services.
* Contact external servers.
* Download executable code.
* Load remote JavaScript.
* Load external libraries from CDNs.
* Include tracking identifiers.

All audio processing must happen locally in the browser.

The extension should remain functional without an Internet connection, provided the webpage producing the audio is itself available.

---

# 4. Browser Permissions

Use the minimum permissions technically required.

Expected permissions may include:

* `tabCapture`
* `offscreen`
* `storage`

Other permissions should only be added if they are demonstrated to be technically necessary.

Permissions such as the following should NOT be used without explicit review:

* `history`
* `cookies`
* `browsingData`
* `downloads`
* `webRequest`
* `<all_urls>`

Avoid broad host permissions.

If a new permission becomes necessary during development, its purpose must be documented before adding it.

---

# 5. Default Behaviour

## Critical safety rule

The extension must be **inactive by default**.

Installing the extension must not alter audio.

Opening the extension popup must not alter audio.

Changing tabs must not automatically activate audio processing.

Audio processing begins only after the user explicitly enables it for the current tab.

---

# 6. Activation Model

The popup must contain an explicit control such as:

**Audio processing**

`OFF / ON`

Default state:

`OFF`

When OFF:

* The extension must not capture the tab audio.
* The original audio path must remain untouched.
* The website/browser controls audio normally.
* The volume slider should either be disabled or clearly shown as inactive.

When ON:

* The extension captures the current tab audio.
* The audio is routed through the extension audio engine.
* Volume control becomes available.
* The extension indicates clearly that the tab audio is being processed.

Turning the extension OFF again must:

* Stop extension processing for that tab.
* Release the captured stream/resources where possible.
* Restore normal browser audio behaviour.

---

# 7. Safe Activation Volume

This is a mandatory safety requirement.

When audio processing is enabled for a tab for the first time, the initial gain MUST be:

**100 % / gain 1.0**

Activation must never suddenly increase the perceived volume.

The extension must NOT automatically apply:

* 150 %
* 200 %
* The setting from another tab
* An arbitrary remembered global amplification value

A user must explicitly move the volume control before amplification above 100 % occurs.

This prevents unexpectedly loud audio when enabling the extension.

---

# 8. Independent Per-Tab Audio

The extension must support multiple tabs being processed simultaneously.

Each browser tab must maintain an independent audio session.

Example:

* YouTube tab → 140 %
* Online radio tab → 75 %
* Spotify Web tab → 110 %
* News website → extension OFF

Changing the volume of one tab must never change the volume of another tab.

Each audio session should be identified internally using the Chrome tab ID.

Conceptually:

```text
Tab 101
Gain: 1.40

Tab 204
Gain: 0.75

Tab 319
Gain: 1.10
```

Closing a tab must clean up its associated audio resources.

---

# 9. Version 0.1 Scope

Version 0.1 is deliberately small.

Its goal is to prove that per-tab audio capture and volume control work reliably.

Required features:

* Popup interface.
* Current-tab activation toggle.
* OFF by default.
* Volume slider.
* Independent volume for each active tab.
* Current percentage display.
* 100 % reset button.
* Mute control.
* Clear active/inactive status.
* Resource cleanup when a tab closes.
* Clean handling of tabs that cannot be captured.
* No external dependencies.
* No network communication.

---

# 10. Volume Range

Initial target:

**0 % to 200 %**

Mapping:

```text
0 %   = gain 0.0
50 %  = gain 0.5
100 % = gain 1.0
150 % = gain 1.5
200 % = gain 2.0
```

100 % represents the original audio level.

Values above 100 % amplify the signal and may cause clipping depending on the source material.

The UI should make 100 % visually easy to identify.

Consider a slider step of:

**5 %**

This may be adjusted after testing.

---

# 11. Reset Control

The interface must provide a clearly visible:

**Reset 100 %**

button.

Pressing it immediately returns the current tab gain to:

`1.0`

The extension remains enabled.

---

# 12. Mute

Provide a mute control.

Mute should set the effective output to silence without losing the user's selected volume.

Example:

```text
Selected volume: 135 %
Mute: ON

Output: 0 %

Mute: OFF

Output returns to: 135 %
```

Mute must therefore be logically separate from the stored gain value.

---

# 13. Popup Interface

The first version should use a compact, clean interface.

Approximate concept:

```text
┌─────────────────────────────┐
│ TAB AUDIO CONTROL           │
│                             │
│ Audio processing      ON ●  │
│                             │
│ Volume                     │
│ ─────────●────────────      │
│            125 %            │
│                             │
│ [ Reset 100% ]   [ Mute ]   │
│                             │
│ ● Audio processing active   │
└─────────────────────────────┘
```

When inactive:

```text
┌─────────────────────────────┐
│ TAB AUDIO CONTROL           │
│                             │
│ Audio processing     OFF ○  │
│                             │
│ Volume                     │
│ ─────────────────────       │
│            100 %            │
│                             │
│ [ Reset 100% ]   [ Mute ]   │
│                             │
│ ○ Not active on this tab    │
└─────────────────────────────┘
```

The visual design may evolve, but usability takes priority over decoration.

---

# 14. UI Design Principles

The interface should be:

* Clean.
* Compact.
* Legible.
* Modern but restrained.
* Immediately understandable.
* Usable without instructions.

Avoid:

* Excessive animations.
* Tiny controls.
* Decorative clutter.
* Very low contrast.
* Hidden essential controls.

The ON/OFF state must be unmistakable.

The current percentage must always be visible.

---

# 15. Audio Architecture

Preferred architecture:

```text
Browser tab audio
        ↓
chrome.tabCapture
        ↓
MediaStream
        ↓
AudioContext
        ↓
GainNode
        ↓
Future EQ processing
        ↓
Audio destination
```

Version 0.1 should contain only the processing required for volume control.

Do not implement the equalizer yet.

The architecture should nevertheless avoid making future EQ implementation unnecessarily difficult.

---

# 16. Manifest V3 Architecture

The project should use Chrome Extension Manifest V3.

Expected components:

```text
manifest.json

popup/
    popup.html
    popup.css
    popup.js

background/
    service-worker.js

audio/
    offscreen.html
    offscreen.js

icons/

README.md
DEVELOPMENT_SPEC.md
```

Exact filenames may be adjusted if there is a clear architectural reason.

Keep responsibilities separated.

Do NOT implement the entire extension inside one large JavaScript file.

---

# 17. Component Responsibilities

## manifest.json

Defines:

* Extension identity.
* Manifest V3 configuration.
* Required permissions.
* Popup.
* Service worker.
* Icons.

No unnecessary permissions.

---

## popup

Responsible only for user interaction.

Examples:

* Display current state.
* Toggle processing.
* Change volume.
* Reset volume.
* Mute/unmute.
* Display errors/status.

The popup should not contain the main persistent audio engine.

Closing the popup must NOT stop audio processing.

---

## service worker

Responsible for extension coordination.

Examples:

* Identifying the active tab.
* Creating audio sessions.
* Communicating between popup and audio engine.
* Tracking tab lifecycle.
* Cleaning sessions when tabs close.
* Creating/managing the offscreen document.

It should not perform DOM/Web Audio processing that belongs in the offscreen document.

---

## offscreen audio document

Responsible for persistent audio processing.

Examples:

* AudioContext.
* Captured MediaStreams.
* GainNodes.
* Future equalizer nodes.
* Per-tab audio-session objects.

Each controlled tab should have its own audio processing chain.

---

# 18. Session Model

Conceptual data structure:

```text
audioSessions
    tabId
        stream
        audioContext
        sourceNode
        gainNode
        volume
        muted
```

This is conceptual, not mandatory implementation code.

Codex may propose a technically superior structure provided it preserves independent per-tab processing.

---

# 19. Persistence

For V0.1, avoid excessive persistence.

Runtime per-tab volume may be stored while that tab exists.

Do NOT automatically use the volume of one tab when enabling another.

Future versions may optionally support remembered settings.

If persistent settings are later introduced, privacy must remain a priority.

Never store complete browsing URLs merely to remember audio settings.

---

# 20. Error Handling

The extension must fail safely.

Possible situations include:

* Chrome internal pages.
* Chrome Web Store pages.
* Tabs with no audio.
* Tab capture failure.
* Tab closed during initialization.
* AudioContext failure.
* Offscreen document unavailable.
* Browser permission failure.

The extension must not crash silently.

Display concise user-friendly messages such as:

```text
This tab cannot be controlled.
```

or:

```text
Unable to start audio processing.
```

Technical errors may also be logged to the developer console.

---

# 21. Resource Management

Prevent leaked audio contexts or media streams.

When processing stops:

* Disconnect audio nodes.
* Stop/release tracks where appropriate.
* Remove the tab session.
* Release unused objects.

When a controlled tab closes:

* Automatically destroy its session.

The extension should remain stable during long browser sessions with many tabs being opened and closed.

---

# 22. External Dependencies

Version 0.1 should use:

* Vanilla HTML
* Vanilla CSS
* Vanilla JavaScript
* Chrome Extension APIs
* Web Audio API

No frameworks are required.

Do not include:

* React
* Vue
* Angular
* jQuery
* Bootstrap
* Remote fonts
* CDN dependencies

unless explicitly approved later.

---

# 23. Network Policy

The extension itself should make **zero network requests**.

The extension must not contain:

```text
fetch()
XMLHttpRequest
WebSocket
remote scripts
analytics endpoints
telemetry endpoints
```

unless a future specification explicitly changes this requirement.

The webpages themselves obviously remain free to access the network normally.

---

# 24. Security Principles

Use:

* Manifest V3.
* Local scripts only.
* Minimal permissions.
* Chrome extension Content Security Policy.
* No inline remote executable content.
* No `eval`.
* No dynamically downloaded JavaScript.

The implementation should be easy to audit.

---

# 25. Development Rules for Codex

Before modifying the project, Codex must read:

**DEVELOPMENT_SPEC.md**

The specification is the authoritative design document.

Codex must:

1. Preserve existing working functionality.
2. Make focused changes.
3. Avoid unnecessary rewrites.
4. Avoid adding dependencies without justification.
5. Avoid adding browser permissions without justification.
6. Maintain privacy requirements.
7. Keep files logically separated.
8. Comment non-obvious audio or Chrome API behaviour.
9. Handle errors explicitly.
10. Keep code understandable and auditable.

If an implementation requirement conflicts with this specification, Codex should explain the conflict rather than silently changing the architecture.

---

# 26. Non-Goals for Version 0.1

Version 0.1 will NOT:

* Modify Windows master volume.
* Modify other applications.
* Record audio.
* Save audio.
* Stream audio.
* Download audio.
* Modify webpage contents.
* Inject visual controls into websites.
* Read page contents.
* Implement an equalizer.
* Implement audio effects.
* Implement a spectrum analyzer.
* Implement per-site remembered profiles.
* Synchronize settings online.
* Require a user account.

---

# 27. Future Roadmap

## Version 0.1 — Core volume control

* Per-tab capture.
* ON/OFF.
* Volume 0–200 %.
* Reset.
* Mute.
* Independent tab sessions.
* Error handling.
* Resource cleanup.

---

## Version 0.2 — UX and persistence

Possible features:

* Improved visual feedback.
* Remember last settings during browser session.
* Better tab status.
* Better error diagnostics.
* Optional global defaults.

Any automatic amplification must still respect the safety rules.

---

## Version 0.3 — Equalizer

Add a multi-band equalizer using Web Audio API filters.

Possible initial bands:

```text
60 Hz
170 Hz
350 Hz
1 kHz
3.5 kHz
10 kHz
```

Approximate range:

`-12 dB to +12 dB`

Possible presets:

* Flat
* Bass Boost
* Voice
* Rock
* Classical
* Treble Boost
* Custom

EQ implementation must remain entirely local.

---

## Version 0.4 — Audio profiles

Possible optional features:

* User-defined presets.
* Remember settings by hostname.
* Import/export presets.

If site-based persistence is implemented:

Store only the minimum necessary identifier such as hostname.

Do not build or retain browsing history.

---

## Version 0.5 — Optional visualizer

Possible spectrum visualization using Web Audio API `AnalyserNode`.

This should remain optional and lightweight.

---

# 28. Acceptance Criteria for V0.1

Version 0.1 is considered successful when all the following are true:

1. Extension installs locally through Chrome Developer Mode.
2. Extension loads with no manifest errors.
3. Opening the popup does not change audio.
4. Processing is OFF by default.
5. User explicitly enables processing.
6. Activation begins at exactly 100 % gain.
7. No sudden amplification occurs during activation.
8. User can change volume from 0–200 %.
9. User can return instantly to 100 %.
10. User can mute and unmute.
11. Two different tabs can use different volume levels simultaneously.
12. Changing one tab does not affect another.
13. Closing the popup does not stop processed audio.
14. Turning processing OFF restores normal tab audio.
15. Closing a controlled tab releases its resources.
16. Browser restart does not unexpectedly enable processing.
17. Extension performs no external network requests.
18. Extension requires no unnecessary host permissions.
19. Extension does not read page contents.
20. Extension console contains no persistent runtime errors during normal use.

---

# 29. Testing Scenarios

At minimum test:

### Test A — Safe activation

1. Play audio normally.
2. Open extension.
3. Confirm state is OFF.
4. Enable extension.
5. Confirm perceived volume does not jump.
6. Confirm displayed value is 100 %.

### Test B — Amplification

1. Enable extension.
2. Move volume to 150 %.
3. Confirm audio becomes louder.
4. Reset to 100 %.
5. Confirm normal level returns.

### Test C — Independent tabs

1. Open two audio-producing tabs.
2. Enable extension on both.
3. Set Tab A to 150 %.
4. Set Tab B to 60 %.
5. Switch repeatedly between them.
6. Confirm each retains its own value.

### Test D — Mute

1. Set volume to 135 %.
2. Enable Mute.
3. Confirm silence.
4. Disable Mute.
5. Confirm volume returns to 135 %.

### Test E — Disable

1. Enable processing.
2. Change volume.
3. Turn processing OFF.
4. Confirm normal browser audio path resumes.

### Test F — Cleanup

1. Enable audio processing.
2. Close the controlled tab.
3. Verify no errors or orphaned audio remain.

### Test G — Browser restart

1. Close Chrome with controlled tabs.
2. Restart Chrome.
3. Confirm extension does not unexpectedly amplify any tab.

---

# 30. Project Priority

When choices must be made, use this priority order:

1. User hearing safety
2. Privacy
3. Stability
4. Correct audio behaviour
5. Minimal permissions
6. Simplicity
7. User experience
8. Visual appearance
9. Additional features

A visually attractive feature must never compromise the priorities above.
