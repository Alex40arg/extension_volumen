// Shared display contract. Only grouped magnitudes cross local runtime messaging.
const SPECTRUM = Object.freeze({
  fftSize: 2048, // ~23 Hz bins at 48 kHz; compact buffers and responsive analysis.
  smoothing: 0.8, // Moderate temporal smoothing without a slow visual trail.
  minDecibels: -90,
  maxDecibels: -10,
  bars: 48,
  minHz: 30,
  maxHz: 15000,
  frameMs: 40 // At most 25 requests/second; only while the popup is visible.
});
