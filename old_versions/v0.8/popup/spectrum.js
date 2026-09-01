// The popup owns the only analysis loop. The offscreen engine has no polling.
class SpectrumView {
  constructor(canvas, status, request) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.status = status;
    this.request = request;
    this.active = false;
    this.pending = false;
    this.failed = false;
    this.generation = 0;
    this.frame = null;
    this.lastRequest = -Infinity;
    this.bars = new Uint8Array(SPECTRUM.bars);
    this.dirty = false;
    this.inactiveText = null;
  }

  update(active, inactiveText) {
    if (!active) {
      const needsDraw = this.active || this.inactiveText !== inactiveText;
      this.stop();
      this.failed = false;
      this.status.textContent = inactiveText;
      this.inactiveText = inactiveText;
      if (needsDraw) this.draw();
      return;
    }
    if (this.active || this.failed || !this.context) return;
    this.active = true;
    this.inactiveText = null;
    this.lastRequest = -Infinity;
    this.status.textContent = "Live · after EQ / before volume & mute";
    this.frame = requestAnimationFrame((time) => this.tick(time));
  }

  stop() {
    this.active = false;
    this.generation += 1;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.bars.fill(0);
    this.dirty = false;
    // An already sent request can finish, but its generation cannot draw.
  }

  tick(time) {
    if (!this.active) return;
    if (this.dirty) {
      this.draw();
      this.dirty = false;
    }
    if (!this.pending && time - this.lastRequest >= SPECTRUM.frameMs) {
      this.lastRequest = time;
      this.pending = true;
      const generation = this.generation;
      void this.request().then((response) => {
        if (!this.active || generation !== this.generation) return;
        if (!response?.ok || !response.active || !Array.isArray(response.bars)
            || response.bars.length !== SPECTRUM.bars) {
          throw new Error("Spectrum unavailable");
        }
        this.bars.set(response.bars);
        this.dirty = true;
      }).catch(() => {
        if (!this.active || generation !== this.generation) return;
        this.stop();
        this.failed = true;
        this.status.textContent = "Analyzer unavailable · toggle OFF / ON to retry";
        this.draw();
      }).finally(() => { this.pending = false; });
    }
    this.frame = requestAnimationFrame((nextTime) => this.tick(nextTime));
  }

  draw() {
    const ctx = this.context;
    if (!ctx) return;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const left = 9, right = width - 9, bottom = height - 19;
    const plotHeight = bottom - 2;
    ctx.strokeStyle = "#29435f";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let line = 0; line <= 4; line += 1) {
      const y = bottom - plotHeight * line / 4;
      ctx.moveTo(left, y); ctx.lineTo(right, y);
    }
    const labels = [[30, "30"], [100, "100"], [300, "300"], [1000, "1k"], [3000, "3k"], [8000, "8k"], [15000, "15k"]];
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.fillStyle = "#a9b8ca";
    labels.forEach(([hz, label], index) => {
      const x = left + Math.log(hz / SPECTRUM.minHz) / Math.log(SPECTRUM.maxHz / SPECTRUM.minHz) * (right - left);
      ctx.moveTo(x, 2); ctx.lineTo(x, bottom);
      ctx.textAlign = index === 0 ? "left" : index === labels.length - 1 ? "right" : "center";
      ctx.fillText(label, x, height - 3);
    });
    ctx.stroke();
    if (!this.active) return;
    ctx.fillStyle = "#d75b5b";
    const step = (right - left) / SPECTRUM.bars;
    for (let index = 0; index < this.bars.length; index += 1) {
      const barHeight = this.bars[index] / 255 * plotHeight;
      if (barHeight > 0) ctx.fillRect(left + index * step + 1, bottom - barHeight, step - 2, barHeight);
    }
  }
}
