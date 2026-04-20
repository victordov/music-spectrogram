// Spectral mask + brush tool. The user paints on the spectrogram; we store a
// multiplicative gain mask (1.0 = pass, 0 = mute, >1 = boost) per (frame, bin),
// plus a separate "smooth" mask that marks regions to be bin-blurred at render
// time. When "Apply" is invoked, we send both masks + samples to the worker for
// offline ISTFT-based resynthesis.
//
// Brush modes:
//   'attenuate'        → blend mask toward gain (<1 = cut, >1 = boost)
//   'amplify'          → same as attenuate, but expects gain > 1
//   'erase'            → relax mask toward 1 (undo painting)
//   'smooth'           → paint into the smooth mask; worker blurs those bins
//   'harmonic-preserve'→ attenuate everywhere except near spectral peaks
(function (global) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  class SpectralMask {
    constructor(nFrames, nBins) {
      this.nFrames = nFrames;
      this.nBins = nBins; // one-sided (fftSize/2 + 1)
      this.data = new Float32Array(nFrames * nBins);
      this.data.fill(1);
      // Separate "smoothing mask": 0 = don't smooth, 1 = smooth aggressively.
      this.smooth = new Float32Array(nFrames * nBins);
      this.dirty = false;
    }

    clear() {
      this.data.fill(1);
      this.smooth.fill(0);
      this.dirty = false;
    }

    isClean() { return !this.dirty; }

    // Paint a soft circular brush into the mask.
    //   frame, bin:              center (float mask coordinates)
    //   radiusFrames, radiusBins: brush half-size in mask units
    //   gain:                    target gain at center
    //   mode:                    see top of file
    //   opts:                    {peakMags, preserveHalfBins} for harmonic-preserve
    paint(frame, bin, radiusFrames, radiusBins, gain, mode, opts) {
      mode = mode || 'attenuate';
      opts = opts || {};
      const fA = Math.max(0, Math.floor(frame - radiusFrames));
      const fB = Math.min(this.nFrames - 1, Math.ceil(frame + radiusFrames));
      const kA = Math.max(0, Math.floor(bin - radiusBins));
      const kB = Math.min(this.nBins - 1, Math.ceil(bin + radiusBins));

      // For harmonic-preserve, we need to know which bins in [kA, kB] are "peaks".
      let peakSet = null;
      if (mode === 'harmonic-preserve' && opts.peakMags) {
        const preserveHalf = opts.preserveHalfBins != null ? opts.preserveHalfBins : 3;
        const peaks = SpectralMask.findPeaks(opts.peakMags, opts.peakRelThresh || 0.15);
        peakSet = new Uint8Array(this.nBins);
        for (const p of peaks) {
          for (let d = -preserveHalf; d <= preserveHalf; d++) {
            const idx = p + d;
            if (idx >= 0 && idx < this.nBins) peakSet[idx] = 1;
          }
        }
      }

      for (let f = fA; f <= fB; f++) {
        const df = (f - frame) / Math.max(1e-6, radiusFrames);
        for (let k = kA; k <= kB; k++) {
          const dk = (k - bin) / Math.max(1e-6, radiusBins);
          const d = Math.sqrt(df * df + dk * dk);
          if (d > 1) continue;
          const falloff = 1 - d;
          const idx = f * this.nBins + k;

          if (mode === 'smooth') {
            // Paint into the smooth mask (not the gain mask).
            const cur = this.smooth[idx];
            const target = 1; // fully smooth at center
            this.smooth[idx] = cur * (1 - falloff) + target * falloff;
          } else if (mode === 'erase') {
            // Relax both masks back to identity (no edit).
            this.data[idx]   = this.data[idx]   * (1 - falloff) + 1 * falloff;
            this.smooth[idx] = this.smooth[idx] * (1 - falloff) + 0 * falloff;
          } else if (mode === 'harmonic-preserve') {
            // Attenuate everywhere except near peaks.
            if (peakSet && peakSet[k]) continue;
            const cur = this.data[idx];
            this.data[idx] = cur * (1 - falloff) + gain * falloff;
          } else {
            // 'attenuate' or 'amplify' — both just blend toward gain.
            const cur = this.data[idx];
            this.data[idx] = cur * (1 - falloff) + gain * falloff;
          }
          this.dirty = true;
        }
      }
    }

    // Harmonic-lock brush: paints at the fundamental bin AND at integer multiples
    // (2·bin, 3·bin, …) with a gentle strength falloff per harmonic.
    paintHarmonicLock(frame, binFund, radiusFrames, radiusBins, gain, mode, nHarmonics, opts) {
      nHarmonics = Math.max(1, nHarmonics || 6);
      for (let h = 1; h <= nHarmonics; h++) {
        const hBin = binFund * h;
        if (hBin >= this.nBins) break;
        // Decay paint strength toward higher harmonics: blend gain back toward 1.
        const decay = 1 / Math.sqrt(h);
        const effGain = 1 + (gain - 1) * decay;
        this.paint(frame, hBin, radiusFrames, radiusBins, effGain, mode, opts);
      }
    }

    // Flood-fill auto-select: from (seedF, seedB), grow a region while the
    // magnitude grid stays within `threshold` dB of the seed value, applying
    // `gain` via `mode` to every visited cell.
    //   packedGrid: Uint8Array nFrames * nBinsGrid (may be smaller than nBins -
    //               we map proportionally).
    //   gridMinDb, gridMaxDb: dB range used to encode the grid.
    //   thresholdDb: how many dB below the seed is still considered "in".
    autoSelect(packedGrid, nFramesGrid, nBinsGrid, seedF, seedB, gridMinDb, gridMaxDb, thresholdDb, gain, mode) {
      if (!packedGrid) return 0;
      mode = mode || 'attenuate';
      const range = Math.max(1e-6, gridMaxDb - gridMinDb);
      const gridValToDb = (v) => gridMinDb + (v / 255) * range;
      // Map mask coords → grid coords.
      const fScale = nFramesGrid / this.nFrames;
      const bScale = nBinsGrid / this.nBins;
      const gF = (f) => clamp(Math.floor(f * fScale), 0, nFramesGrid - 1);
      const gB = (b) => clamp(Math.floor(b * bScale), 0, nBinsGrid - 1);
      const seedVal = packedGrid[gF(seedF) * nBinsGrid + gB(seedB)];
      const seedDb = gridValToDb(seedVal);
      const lowerDb = seedDb - Math.max(1, thresholdDb);

      // Visited flags on mask grid to avoid double-work.
      const visited = new Uint8Array(this.nFrames * this.nBins);
      const queue = [[seedF | 0, seedB | 0]];
      let painted = 0;
      const MAX_CELLS = 60000; // safety cap
      while (queue.length && painted < MAX_CELLS) {
        const [f, b] = queue.pop();
        if (f < 0 || f >= this.nFrames || b < 0 || b >= this.nBins) continue;
        const vi = f * this.nBins + b;
        if (visited[vi]) continue;
        visited[vi] = 1;
        const cellDb = gridValToDb(packedGrid[gF(f) * nBinsGrid + gB(b)]);
        if (cellDb < lowerDb) continue;
        // Paint a 1-cell dot at this (f,b).
        this.paint(f, b, 0.5, 0.5, gain, mode);
        painted++;
        queue.push([f + 1, b], [f - 1, b], [f, b + 1], [f, b - 1]);
      }
      return painted;
    }

    // Find local maxima in a magnitude spectrum. Returns bin indices.
    static findPeaks(mag, relThresh) {
      relThresh = relThresh == null ? 0.1 : relThresh;
      let maxV = 0;
      for (let i = 0; i < mag.length; i++) if (mag[i] > maxV) maxV = mag[i];
      const thr = maxV * relThresh;
      const peaks = [];
      for (let i = 2; i < mag.length - 2; i++) {
        const v = mag[i];
        if (v < thr) continue;
        if (v > mag[i - 1] && v > mag[i + 1] && v > mag[i - 2] && v > mag[i + 2]) {
          peaks.push(i);
        }
      }
      return peaks;
    }

    // Draw mask as an overlay on top of the spec canvas.
    //   red   = attenuated (mask < 1)
    //   green = boosted    (mask > 1)
    //   cyan  = smoothing region
    renderOverlay(ctx, W, H, { tPan = 0, tZoom = 1, fPan = 0, fZoom = 1, yToBin }) {
      if (!this.dirty) return;
      const img = ctx.getImageData(0, 0, W, H);
      const data = img.data;
      const t0 = tPan, t1 = Math.min(1, tPan + 1 / tZoom);
      const nF = this.nFrames, nB = this.nBins;
      for (let x = 0; x < W; x++) {
        const tf = t0 + (x / (W - 1)) * (t1 - t0);
        const frame = clamp(Math.floor(tf * (nF - 1)), 0, nF - 1);
        for (let y = 0; y < H; y++) {
          const kFloat = yToBin(y, H);
          const k = clamp(Math.round(kFloat), 0, nB - 1);
          const idx = frame * nB + k;
          const m = this.data[idx];
          const s = this.smooth[idx];
          if (m === 1 && s === 0) continue;
          const di = (y * W + x) * 4;
          // Tint with an opacity floor so even a gentle brush (gain 0.9 or
          // smooth 0.2) is immediately visible on any color map. Without a
          // floor, attenuate at gain 0.9 gives ~5% red blend and users can't
          // tell anything changed.
          if (s > 0) {
            const a = Math.max(0.25, Math.min(0.85, s * 0.75));
            data[di]     = data[di]     * (1 - a) + 79  * a;
            data[di + 1] = data[di + 1] * (1 - a) + 209 * a;
            data[di + 2] = data[di + 2] * (1 - a) + 197 * a;
          } else if (m < 1) {
            const a = Math.max(0.3, Math.min(0.85, (1 - m) * 0.9));
            data[di]     = data[di]     * (1 - a) + 239 * a;
            data[di + 1] = data[di + 1] * (1 - a) + 68  * a;
            data[di + 2] = data[di + 2] * (1 - a) + 68  * a;
          } else {
            const a = Math.max(0.25, Math.min(0.8, (m - 1) * 0.7));
            data[di]     = data[di]     * (1 - a) + 110 * a;
            data[di + 1] = data[di + 1] * (1 - a) + 231 * a;
            data[di + 2] = data[di + 2] * (1 - a) + 183 * a;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    }
  }

  global.SpectralMask = SpectralMask;
})(typeof window !== 'undefined' ? window : globalThis);
