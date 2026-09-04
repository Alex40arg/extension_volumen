(() => {
  if (globalThis.__TAB_AUDIO_CONTROL_CONFIG) return;

  const config = Object.freeze({
    bands: Object.freeze([
      Object.freeze({ frequency: 30, type: "lowshelf" }),
      Object.freeze({ frequency: 90, type: "peaking", q: 1 }),
      Object.freeze({ frequency: 300, type: "peaking", q: 1 }),
      Object.freeze({ frequency: 1000, type: "peaking", q: 1 }),
      Object.freeze({ frequency: 3000, type: "peaking", q: 1 }),
      Object.freeze({ frequency: 8000, type: "peaking", q: 1 }),
      Object.freeze({ frequency: 15000, type: "highshelf" })
    ]),
    rampSeconds: 0.02,
    spectrum: Object.freeze({
      fftSize: 2048,
      smoothing: 0.8,
      minDecibels: -90,
      maxDecibels: -10,
      bars: 48,
      minHz: 30,
      maxHz: 15000
    })
  });

  Object.defineProperty(globalThis, "__TAB_AUDIO_CONTROL_CONFIG", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: config
  });
})();
