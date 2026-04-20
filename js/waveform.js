// Waveform overview: computes downsampled peak data and renders to a canvas.
// Click / drag to seek.
(function (global) {
  'use strict';

  class Waveform {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.peaks = null;        // Float32Array [min0, max0, min1, max1, ...]
      this.bins = 0;
      this.duration = 0;
      this.currentTime = 0;
      this.loop = null;
      this.onSeek = null;
      this._bindInput();
      this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.canvas.width = Math.max(1, r.width * this._dpr);
      this.canvas.height = Math.max(1, r.height * this._dpr);
    }

    computePeaks(buffer, targetBins) {
      // buffer: Float32Array (mono already)
      const len = buffer.length;
      const bins = Math.max(64, targetBins | 0);
      const step = len / bins;
      const peaks = new Float32Array(bins * 2);
      for (let b = 0; b < bins; b++) {
        const s0 = Math.floor(b * step);
        const s1 = Math.min(len, Math.floor((b + 1) * step));
        let mn = 0, mx = 0;
        for (let i = s0; i < s1; i++) {
          const v = buffer[i];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        peaks[b * 2] = mn;
        peaks[b * 2 + 1] = mx;
      }
      this.peaks = peaks;
      this.bins = bins;
    }

    setLoop(loop) { this.loop = loop; this.render(); }
    setTime(t, duration) {
      this.currentTime = t;
      if (duration != null) this.duration = duration;
      this.render();
    }

    render() {
      const { ctx, canvas } = this;
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      // bg
      ctx.fillStyle = '#05070a';
      ctx.fillRect(0, 0, w, h);
      // center line
      ctx.strokeStyle = '#1a1e27';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();

      if (this.peaks) {
        const bins = this.bins;
        const mid = h / 2;
        const scale = h / 2 * 0.95;
        ctx.fillStyle = '#4fd1c5';
        for (let x = 0; x < w; x++) {
          const b = Math.floor((x / w) * bins);
          const mn = this.peaks[b * 2];
          const mx = this.peaks[b * 2 + 1];
          const y0 = mid - mx * scale;
          const y1 = mid - mn * scale;
          ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
        }
      }

      // Loop region
      if (this.loop && this.duration) {
        const x0 = (this.loop.start / this.duration) * w;
        const x1 = (this.loop.end / this.duration) * w;
        ctx.fillStyle = 'rgba(139,92,246,0.25)';
        ctx.fillRect(x0, 0, x1 - x0, h);
      }

      // Cursor
      if (this.duration) {
        const x = (this.currentTime / this.duration) * w;
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.5 * this._dpr;
        ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    _bindInput() {
      let dragging = false;
      const onMove = (e) => {
        if (!dragging) return;
        const r = this.canvas.getBoundingClientRect();
        const x = e.clientX - r.left;
        const pct = Math.max(0, Math.min(1, x / r.width));
        if (this.onSeek) this.onSeek(pct);
      };
      this.canvas.addEventListener('mousedown', (e) => {
        dragging = true;
        onMove(e);
        const up = () => {
          dragging = false;
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', up);
      });
    }
  }

  global.Waveform = Waveform;
})(typeof window !== 'undefined' ? window : globalThis);
