// Main spectrogram renderer. Handles two modes:
//   - "scroll": real-time scrolling spectrogram fed frame-by-frame during playback
//   - "static": full-track precomputed spectrogram with playhead cursor (also used for
//               zoom/pan inspection of completed analysis)
// Supports linear/log freq scale, colormaps, dB scaling, gridlines, harmonic overlay.
(function (global) {
  'use strict';

  class SpectrogramRenderer {
    constructor(canvas, overlay) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.overlay = overlay;
      this.octx = overlay.getContext('2d');
      this._dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Back buffer for scrolling mode.
      this.backBuf = document.createElement('canvas');
      this.backCtx = this.backBuf.getContext('2d');
      this.backW = 0;
      this.backH = 0;
      // Current analysis params.
      this.sampleRate = 44100;
      this.fftSize = 1024;
      this.minFreq = 20;
      this.maxFreq = 20000;
      this.freqScale = 'log';
      this.colorMap = 'viridis';
      this.minDb = -90;
      this.maxDb = -10;
      this.gamma = 1;
      this.grid = true;
      this.showFrequencyGrid = true;
      this.harmonic = false;

      // Full-track grid (Uint8Array packed).
      this.trackGrid = null;
      this.nFrames = 0;
      this.nBins = 0;
      this.hop = 512;
      this.duration = 0;

      // Zoom/pan [0..1] fractional viewport.
      this.tZoom = 1; this.tPan = 0;
      this.fZoom = 1; this.fPan = 0;

      this.mode = 'scroll'; // scroll | static
      this.cursorTime = 0;
      this.loop = null;
      this.harmonicPoints = null; // [{t, freq}]
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      const w = Math.max(1, r.width * this._dpr);
      const h = Math.max(1, r.height * this._dpr);
      this.canvas.width = w; this.canvas.height = h;
      this.overlay.width = w; this.overlay.height = h;
      this._staticCacheValid = false;

      if (this.mode === 'scroll') {
        // Keep existing scroll history when resizing: create a new back buffer, copy old.
        const prev = this.backBuf;
        const nb = document.createElement('canvas');
        nb.width = w; nb.height = h;
        const nbCtx = nb.getContext('2d');
        if (prev.width && prev.height) {
          nbCtx.drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, w, h);
        }
        this.backBuf = nb; this.backCtx = nbCtx; this.backW = w; this.backH = h;
      } else {
        this.render();
      }
    }

    // Mark the static-spec cache as stale — any change that alters the pixel
    // output (zoom/pan/colormap/gamma/dB/freq scale/track) must call this.
    invalidateStaticCache() { this._staticCacheValid = false; }

    setParams(params) {
      Object.assign(this, params);
      // Changing mode or freq scale invalidates the scroll history.
      if (params.mode || params.freqScale || params.minFreq != null || params.maxFreq != null) {
        this.clearScrollHistory();
      }
      // Any display-param change invalidates the cached static spec.
      this._staticCacheValid = false;
      this.render();
    }

    clearScrollHistory() {
      if (this.backCtx) {
        this.backCtx.fillStyle = '#05070a';
        this.backCtx.fillRect(0, 0, this.backBuf.width, this.backBuf.height);
      }
    }

    setTrack(track, duration) {
      this.trackGrid = track.grid;
      this.nFrames = track.nFrames;
      this.nBins = track.nBins;
      this.hop = track.hop;
      this.sampleRate = track.sampleRate;
      this.fftSize = track.fftSize;
      this.trackMinDb = track.minDb;
      this.trackMaxDb = track.maxDb;
      this.duration = duration;
      this.render();
    }

    setCursor(t) { this.cursorTime = t; this.renderOverlay(); }
    setLoop(loop) { this.loop = loop; this.renderOverlay(); }
    setHarmonicPoints(pts) { this.harmonicPoints = pts; this.renderOverlay(); }

    // --- Frequency axis mapping helpers ---
    // Map a pixel y [0, H] back to frequency in Hz, respecting zoom/pan and freqScale.
    yToFreq(y, H) {
      const frac = 1 - (y / H); // 0 at bottom, 1 at top
      // Zoomed fraction into [0,1] of whole display:
      const zFrac = this.fPan + frac / this.fZoom;
      return this._fracToFreq(zFrac);
    }
    _fracToFreq(zFrac) {
      const fmin = Math.max(1, this.minFreq);
      const fmax = Math.max(fmin + 1, Math.min(this.sampleRate / 2, this.maxFreq));
      if (this.freqScale === 'log') {
        return fmin * Math.pow(fmax / fmin, zFrac);
      } else {
        return fmin + (fmax - fmin) * zFrac;
      }
    }
    _freqToFrac(hz) {
      const fmin = Math.max(1, this.minFreq);
      const fmax = Math.max(fmin + 1, Math.min(this.sampleRate / 2, this.maxFreq));
      if (this.freqScale === 'log') {
        return Math.log(hz / fmin) / Math.log(fmax / fmin);
      }
      return (hz - fmin) / (fmax - fmin);
    }
    // Convert frequency to pixel y in viewport.
    freqToY(hz, H) {
      const zFrac = this._freqToFrac(hz);
      const frac = (zFrac - this.fPan) * this.fZoom;
      return (1 - frac) * H;
    }

    // Map a y pixel to an FFT bin index (fractional), given current freq viewport.
    // Returns a float bin index into [0, nBins-1].
    yToBin(y, H) {
      const hz = this.yToFreq(y, H);
      return (hz / (this.sampleRate / 2)) * (this.nBins || (this.fftSize / 2));
    }

    // --- Scrolling mode ---
    // Push a column (Float32Array magnitudes of length nBins) into scroll buffer.
    pushColumn(mag) {
      if (this.mode !== 'scroll') return;
      const w = this.backBuf.width, h = this.backBuf.height;
      if (!w || !h) return;
      // Shift left by 1px (or dpr px).
      const step = this._dpr;
      this.backCtx.drawImage(this.backBuf, step, 0, w - step, h, 0, 0, w - step, h);
      // Draw new column at right.
      this._drawColumn(this.backCtx, w - step, step, h, mag);
      this.render();
    }

    _drawColumn(ctx, x, colW, H, mag) {
      const nBins = mag.length;
      const lut = global.Colormaps.LUTS[this.colorMap] || global.Colormaps.LUTS.viridis;
      const range = Math.max(1e-6, this.maxDb - this.minDb);
      const img = ctx.getImageData(x, 0, colW, H);
      const data = img.data;
      // For each output pixel, find corresponding bin(s) and take the max magnitude.
      for (let py = 0; py < H; py++) {
        const hz0 = this.yToFreq(py + 1, H);
        const hz1 = this.yToFreq(py, H);
        const lo = Math.max(0, Math.min(nBins - 1, (hz0 / (this.sampleRate / 2)) * nBins));
        const hi = Math.max(0, Math.min(nBins - 1, (hz1 / (this.sampleRate / 2)) * nBins));
        let a = Math.min(lo, hi), b = Math.max(lo, hi);
        let lo_i = Math.floor(a), hi_i = Math.ceil(b);
        let v = 0;
        for (let k = lo_i; k <= hi_i; k++) v = Math.max(v, mag[k] || 0);
        const db = 20 * Math.log10(Math.max(v, 1e-7));
        let t = (db - this.minDb) / range;
        t = Math.max(0, Math.min(1, t));
        if (this.gamma !== 1) t = Math.pow(t, this.gamma);
        const idx = Math.min(255, Math.max(0, (t * 255) | 0)) * 3;
        const r = lut[idx], g = lut[idx + 1], bl = lut[idx + 2];
        for (let cx = 0; cx < colW; cx++) {
          const di = (py * colW + cx) * 4;
          data[di] = r; data[di + 1] = g; data[di + 2] = bl; data[di + 3] = 255;
        }
      }
      ctx.putImageData(img, x, 0);
    }

    render() {
      if (this.mode === 'scroll') this._renderScroll();
      else if (this.mode === 'static') this._renderStatic();
      else if (typeof this._renderAlt === 'function') this._renderAlt();
      this.renderOverlay();
    }

    _renderScroll() {
      const w = this.canvas.width, h = this.canvas.height;
      this.ctx.clearRect(0, 0, w, h);
      if (this.backBuf.width) {
        this.ctx.drawImage(this.backBuf, 0, 0, w, h);
      }
    }

    // Build an offscreen image of the full track at native resolution (nFrames x H),
    // stretched by canvas. Respects dB re-scaling (re-derived from stored min/max) and
    // time/freq zoom via drawImage source rect.
    //
    // Performance note: the per-pixel loop below costs ~10-20ms per call at 2000x800.
    // The brush tool calls render() after every mousemove, so we cache the rendered
    // pixels into an offscreen canvas and blit it with drawImage() on subsequent calls.
    // The cache is invalidated (via _staticCacheValid = false) whenever anything that
    // would change the output pixels changes: zoom/pan, colormap, gamma, dB range,
    // freq scale, or the underlying track.
    _renderStatic() {
      const w = this.canvas.width, h = this.canvas.height;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, w, h);
      if (!this.trackGrid || !this.nFrames) return;

      // Fast path: reuse the cached pixel buffer if nothing has changed.
      if (this._staticCacheValid && this._staticCache &&
          this._staticCache.width === w && this._staticCache.height === h) {
        ctx.drawImage(this._staticCache, 0, 0);
        return;
      }

      // Build a canvas of size (viewWidth, h) by sampling grid with current zoom/pan.
      // For speed, use an ImageData buffer sized to the canvas.
      const img = ctx.createImageData(w, h);
      const data = img.data;
      const lut = global.Colormaps.LUTS[this.colorMap] || global.Colormaps.LUTS.viridis;
      const range = Math.max(1e-6, this.maxDb - this.minDb);
      const trackRange = Math.max(1e-6, this.trackMaxDb - this.trackMinDb);
      const nF = this.nFrames, nB = this.nBins;
      // time viewport fraction [t0, t1]
      const t0 = this.tPan;
      const t1 = Math.min(1, this.tPan + 1 / this.tZoom);

      // precompute per-y bin range once
      const binLo = new Int32Array(h);
      const binHi = new Int32Array(h);
      for (let py = 0; py < h; py++) {
        const hz0 = this.yToFreq(py + 1, h);
        const hz1 = this.yToFreq(py, h);
        const lo = Math.max(0, Math.min(nB - 1, Math.floor((hz0 / (this.sampleRate / 2)) * nB)));
        const hi = Math.max(0, Math.min(nB - 1, Math.ceil((hz1 / (this.sampleRate / 2)) * nB)));
        binLo[py] = Math.min(lo, hi);
        binHi[py] = Math.max(lo, hi);
      }

      for (let px = 0; px < w; px++) {
        const tf = t0 + (px / (w - 1)) * (t1 - t0);
        const fIdx = Math.max(0, Math.min(nF - 1, Math.floor(tf * (nF - 1))));
        const off = fIdx * nB;
        for (let py = 0; py < h; py++) {
          let v = 0;
          const lo = binLo[py], hi = binHi[py];
          for (let k = lo; k <= hi; k++) {
            const g = this.trackGrid[off + k];
            if (g > v) v = g;
          }
          // grid value is t normalized to trackMin/trackMax dB range.
          // convert back to dB then re-normalize with current min/max dB.
          const origT = v / 255;
          const db = this.trackMinDb + origT * trackRange;
          let t = (db - this.minDb) / range;
          t = Math.max(0, Math.min(1, t));
          if (this.gamma !== 1) t = Math.pow(t, this.gamma);
          const ci = Math.min(255, Math.max(0, (t * 255) | 0)) * 3;
          const di = (py * w + px) * 4;
          data[di] = lut[ci];
          data[di + 1] = lut[ci + 1];
          data[di + 2] = lut[ci + 2];
          data[di + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      // Cache the result for future blits. Keeping the cache as an offscreen
      // canvas (rather than ImageData) lets subsequent frames use drawImage,
      // which is GPU-accelerated and much cheaper than re-running the loop.
      if (!this._staticCache) this._staticCache = document.createElement('canvas');
      if (this._staticCache.width !== w || this._staticCache.height !== h) {
        this._staticCache.width = w;
        this._staticCache.height = h;
      }
      this._staticCache.getContext('2d').drawImage(this.canvas, 0, 0);
      this._staticCacheValid = true;
    }

    renderOverlay() {
      const ctx = this.octx;
      const w = this.overlay.width, h = this.overlay.height;
      ctx.clearRect(0, 0, w, h);
      // Gridlines
      if (this.grid) {
        this._drawGrid(ctx, w, h, { showFrequencyGrid: this.showFrequencyGrid });
      }
      // Loop region
      if (this.loop && this.duration) {
        const t0 = this.tPan;
        const t1 = Math.min(1, this.tPan + 1 / this.tZoom);
        const ls = this.loop.start / this.duration;
        const le = this.loop.end / this.duration;
        const x0 = ((ls - t0) / (t1 - t0)) * w;
        const x1 = ((le - t0) / (t1 - t0)) * w;
        ctx.fillStyle = 'rgba(139,92,246,0.18)';
        ctx.fillRect(x0, 0, x1 - x0, h);
      }
      // Playback cursor for static mode.
      if (this.mode === 'static' && this.duration) {
        const t0 = this.tPan;
        const t1 = Math.min(1, this.tPan + 1 / this.tZoom);
        const c = this.cursorTime / this.duration;
        if (c >= t0 && c <= t1) {
          const x = ((c - t0) / (t1 - t0)) * w;
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 1.5 * this._dpr;
          ctx.beginPath();
          ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
        }
      }
      // Harmonic overlay
      if (this.showFrequencyGrid && this.harmonic && this.harmonicPoints && this.harmonicPoints.length) {
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1 * this._dpr;
        const pts = this.harmonicPoints;
        // Draw fundamental trace.
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          if (!p) continue;
          const x = this._timeToX(p.t, w);
          if (x < 0 || x > w) continue;
          const y = this.freqToY(p.freq, h);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // Post-overlay hook: lets the app draw persistent overlays (EQ curve,
      // mask tint, etc.) that would otherwise be wiped on every cursor update.
      if (typeof this.onOverlayDraw === 'function') {
        this.onOverlayDraw(ctx, w, h);
      }
    }

    _timeToX(t, w) {
      if (this.mode === 'scroll') {
        // Cursor is always at right edge in scroll mode.
        return w;
      }
      if (!this.duration) return 0;
      const t0 = this.tPan;
      const t1 = Math.min(1, this.tPan + 1 / this.tZoom);
      return ((t / this.duration - t0) / (t1 - t0)) * w;
    }

    _drawGrid(ctx, w, h, { showFrequencyGrid = true } = {}) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.font = `${10 * this._dpr}px ui-monospace, monospace`;
      ctx.fillStyle = 'rgba(230,233,239,0.6)';
      if (showFrequencyGrid) {
        const lines = this.freqScale === 'log'
          ? [50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000]
          : [1000, 2000, 5000, 10000, 15000, 20000];
        for (const hz of lines) {
          if (hz < this.minFreq || hz > this.maxFreq) continue;
          const y = this.freqToY(hz, h);
          if (y < 0 || y > h) continue;
          ctx.beginPath();
          ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
          ctx.fillText(hz >= 1000 ? (hz / 1000) + 'k' : String(hz), 4, y - 2);
        }
      }
      // Time lines (static mode)
      if (this.mode === 'static' && this.duration) {
        const t0 = this.tPan * this.duration;
        const t1 = (this.tPan + 1 / this.tZoom) * this.duration;
        const span = t1 - t0;
        const stepCandidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
        let step = stepCandidates[0];
        for (const s of stepCandidates) { if (span / s < 12) { step = s; break; } }
        const startS = Math.ceil(t0 / step) * step;
        for (let t = startS; t <= t1; t += step) {
          const x = ((t / this.duration - this.tPan) / (1 / this.tZoom)) * w;
          ctx.beginPath();
          ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
          ctx.fillText(formatTime(t), x + 2, 12 * this._dpr);
        }
      }
      ctx.restore();
    }
  }

  function formatTime(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(s < 10 ? 1 : 0).padStart(4, '0')}`;
  }

  global.SpectrogramRenderer = SpectrogramRenderer;
  global.formatTime = formatTime;
})(typeof window !== 'undefined' ? window : globalThis);
