// Restoration preset masks (Phase 1, Pro).
//
// Each preset examines the precomputed STFT grid and builds a mask matching
// SpectralMask's layout (nFrames × nBins where nBins = fftSize/2 + 1). The
// returned object:
//   { data: Float32Array, smooth: Float32Array, description: string }
// can be dropped into state.mask.data / state.mask.smooth and applied via the
// existing ISTFT worker path — no new audio-engine code required.
//
// All preset gains are clamped so attenuation never drops below the preset's
// `floor` (default 0.1, i.e. -20 dB). This prevents destroying musical content
// even on aggressive settings.
(function (global) {
  'use strict';

  const EPS = 1e-7;

  function hzToBin(hz, sampleRate, nBins) {
    // nBins here is one-sided (fftSize/2 + 1)
    return (hz / (sampleRate / 2)) * (nBins - 1);
  }

  function bandEnergy(trackMags, sampleRate, fLo, fHi) {
    if (!trackMags || !trackMags.length) return 0;
    const nBinsGrid = trackMags[0].length; // fftSize/2
    const nBinsOneSided = nBinsGrid + 1;
    const kLo = Math.max(0, Math.floor(hzToBin(fLo, sampleRate, nBinsOneSided)));
    const kHi = Math.min(nBinsGrid - 1, Math.ceil(hzToBin(fHi, sampleRate, nBinsOneSided)));
    let e = 0;
    for (let f = 0; f < trackMags.length; f++) {
      const row = trackMags[f];
      for (let k = kLo; k <= kHi; k++) e += row[k] * row[k];
    }
    return e;
  }

  function allocMasks(nFrames, nBins) {
    const data = new Float32Array(nFrames * nBins);
    data.fill(1);
    const smooth = new Float32Array(nFrames * nBins);
    return { data, smooth };
  }

  // -- Preset: HUM removal ---------------------------------------------------
  //
  // Narrow notches at the mains fundamental + harmonics. Detects 50 vs 60 Hz
  // automatically by comparing band energy in a ±3 Hz window around each.
  function buildHumMask(trackMags, sampleRate, opts = {}) {
    const nFrames = trackMags.length;
    const nBinsGrid = trackMags[0].length; // fftSize/2
    const nBins = nBinsGrid + 1;
    const { data, smooth } = allocMasks(nFrames, nBins);

    // Auto-detect mains frequency.
    const forced = opts.mainsHz || 0;
    let mains = forced;
    if (!forced) {
      const e50 = bandEnergy(trackMags, sampleRate, 47, 53);
      const e60 = bandEnergy(trackMags, sampleRate, 57, 63);
      mains = e60 > e50 * 1.2 ? 60 : 50;
    }

    const nHarmonics = Math.max(1, opts.harmonics || 10);
    const floor = opts.floor != null ? opts.floor : 0.12; // ≈ -18 dB
    const notchBwHz = opts.notchBwHz || 4; // ±2 Hz around each harmonic

    for (let h = 1; h <= nHarmonics; h++) {
      const hz = mains * h;
      if (hz >= sampleRate / 2) break;
      const center = hzToBin(hz, sampleRate, nBins);
      const halfWidthBins = Math.max(
        1,
        hzToBin(notchBwHz / 2, sampleRate, nBins)
      );
      const kLo = Math.max(0, Math.floor(center - halfWidthBins));
      const kHi = Math.min(nBins - 1, Math.ceil(center + halfWidthBins));
      // Decay: higher harmonics usually weaker — let them through a bit more.
      const targetGain = Math.min(0.99, floor + (h - 1) * 0.05);
      for (let f = 0; f < nFrames; f++) {
        for (let k = kLo; k <= kHi; k++) {
          const d = Math.abs(k - center) / Math.max(1, halfWidthBins);
          const falloff = Math.max(0, 1 - d * d);
          const prev = data[f * nBins + k];
          data[f * nBins + k] = prev * (1 - falloff) + targetGain * falloff;
        }
      }
    }

    return {
      data, smooth,
      description: `Hum removal (${mains} Hz, ${nHarmonics} harmonics)`
    };
  }

  // -- Preset: RUMBLE (low-frequency) ---------------------------------------
  //
  // Smooth high-pass mask below cutoff: gain → floor below cutoff, 1 above.
  function buildRumbleMask(trackMags, sampleRate, opts = {}) {
    const nFrames = trackMags.length;
    const nBinsGrid = trackMags[0].length;
    const nBins = nBinsGrid + 1;
    const { data, smooth } = allocMasks(nFrames, nBins);

    const cutoffHz = opts.cutoffHz || 80;
    const widthHz = opts.widthHz || 20;
    const floor = opts.floor != null ? opts.floor : 0.1;
    const kLo = 0;
    const kHi = Math.min(nBins - 1, Math.ceil(hzToBin(cutoffHz + widthHz, sampleRate, nBins)));

    // Build a per-bin gain curve once.
    const gainCol = new Float32Array(nBins);
    gainCol.fill(1);
    const centerBin = hzToBin(cutoffHz, sampleRate, nBins);
    const widthBins = Math.max(1, hzToBin(widthHz, sampleRate, nBins));
    for (let k = 0; k <= kHi; k++) {
      const t = (k - (centerBin - widthBins / 2)) / widthBins;
      // Smooth s-curve: 0 below, 1 above.
      const s = t <= 0 ? 0 : t >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * t);
      gainCol[k] = floor + (1 - floor) * s;
    }
    for (let f = 0; f < nFrames; f++) {
      for (let k = kLo; k <= kHi; k++) {
        data[f * nBins + k] = gainCol[k];
      }
    }

    return {
      data, smooth,
      description: `Rumble filter (high-pass @ ${cutoffHz} Hz)`
    };
  }

  // -- Preset: HISS reduction (spectral subtraction / Wiener) ----------------
  //
  // Estimate a per-bin noise magnitude N(k) from the "quietest" portion of the
  // track (lowest RMS frame, ±windowFrames neighbours), then apply a Wiener-
  // style gain mask: G(f,k) = max(floor, 1 − α·N(k) / (M(f,k) + ε)).
  function buildHissMask(trackMags, sampleRate, opts = {}) {
    const nFrames = trackMags.length;
    const nBinsGrid = trackMags[0].length;
    const nBins = nBinsGrid + 1;
    const { data, smooth } = allocMasks(nFrames, nBins);

    const alpha = opts.alpha != null ? opts.alpha : 1.5;
    const floor = opts.floor != null ? opts.floor : 0.15;
    const minHz = opts.minHz != null ? opts.minHz : 3000;
    const kMin = Math.max(0, Math.floor(hzToBin(minHz, sampleRate, nBins)));

    // Use caller-supplied noise profile if provided.
    let noise = opts.noiseProfile;
    if (!noise) {
      // Find the 10% quietest frames and average their magnitudes per bin.
      const rms = new Float32Array(nFrames);
      for (let f = 0; f < nFrames; f++) {
        const row = trackMags[f];
        let s = 0;
        for (let k = 0; k < nBinsGrid; k++) s += row[k] * row[k];
        rms[f] = Math.sqrt(s / nBinsGrid);
      }
      const sorted = Array.from(rms).map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
      const nUse = Math.max(1, Math.floor(sorted.length * 0.1));
      noise = new Float32Array(nBins);
      for (let i = 0; i < nUse; i++) {
        const frame = trackMags[sorted[i].i];
        for (let k = 0; k < nBinsGrid; k++) noise[k] += frame[k];
      }
      for (let k = 0; k < nBinsGrid; k++) noise[k] /= nUse;
    }

    for (let f = 0; f < nFrames; f++) {
      const row = trackMags[f];
      for (let k = kMin; k < nBinsGrid; k++) {
        const m = row[k] + EPS;
        const g = 1 - alpha * noise[k] / m;
        const clamped = g < floor ? floor : g > 1 ? 1 : g;
        data[f * nBins + k] = clamped;
      }
      // Nyquist bin tracks the last grid bin.
      data[f * nBins + nBinsGrid] = data[f * nBins + nBinsGrid - 1];
    }

    return {
      data, smooth,
      description: `Hiss reduction (above ${minHz} Hz, α=${alpha})`,
      noiseProfile: noise
    };
  }

  // -- Preset: DE-ESS --------------------------------------------------------
  //
  // Per-frame sibilance detector in a configurable band (default 4-9 kHz).
  // When the band energy exceeds `threshold × median band energy`, attenuate
  // that band for that frame, linearly from 1 at the edges to `floor` at the
  // centre of the band.
  function buildDeessMask(trackMags, sampleRate, opts = {}) {
    const nFrames = trackMags.length;
    const nBinsGrid = trackMags[0].length;
    const nBins = nBinsGrid + 1;
    const { data, smooth } = allocMasks(nFrames, nBins);

    const fLo = opts.fLo != null ? opts.fLo : 4000;
    const fHi = opts.fHi != null ? opts.fHi : 9000;
    const threshold = opts.threshold != null ? opts.threshold : 1.8;
    const floor = opts.floor != null ? opts.floor : 0.25;

    const kLo = Math.max(0, Math.floor(hzToBin(fLo, sampleRate, nBins)));
    const kHi = Math.min(nBins - 1, Math.ceil(hzToBin(fHi, sampleRate, nBins)));

    // Compute per-frame band energy.
    const bandE = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      const row = trackMags[f];
      let s = 0;
      for (let k = kLo; k <= Math.min(nBinsGrid - 1, kHi); k++) s += row[k] * row[k];
      bandE[f] = s;
    }
    // Median via sort.
    const sorted = Array.from(bandE).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || EPS;
    const limit = median * threshold;

    // Attenuation kernel peaks at mid-band.
    const kernel = new Float32Array(kHi - kLo + 1);
    for (let i = 0; i < kernel.length; i++) {
      const t = i / Math.max(1, kernel.length - 1);
      const bump = Math.sin(Math.PI * t); // 0 → 1 → 0
      kernel[i] = bump;
    }

    for (let f = 0; f < nFrames; f++) {
      if (bandE[f] <= limit) continue;
      // Strength of attenuation scales with how far above the limit we are.
      const over = Math.min(3, bandE[f] / limit);
      const depth = (over - 1) / 2; // 0..1
      for (let i = 0; i < kernel.length; i++) {
        const k = kLo + i;
        const att = 1 - (1 - floor) * depth * kernel[i];
        const prev = data[f * nBins + k];
        data[f * nBins + k] = Math.min(prev, att);
      }
    }

    return {
      data, smooth,
      description: `De-ess (${fLo}-${fHi} Hz, threshold ${threshold}×)`
    };
  }

  // -- Preset: DECLICK -------------------------------------------------------
  //
  // Clicks appear as sudden broadband spikes in spectral flux. We detect frames
  // whose overall energy is `z` standard deviations above their neighbours and
  // attenuate those frames (and ±1 neighbour) across all high-frequency bins.
  function buildDeclickMask(trackMags, sampleRate, opts = {}) {
    const nFrames = trackMags.length;
    const nBinsGrid = trackMags[0].length;
    const nBins = nBinsGrid + 1;
    const { data, smooth } = allocMasks(nFrames, nBins);

    const minHz = opts.minHz != null ? opts.minHz : 2000;
    const zThresh = opts.zThresh != null ? opts.zThresh : 2.5;
    const floor = opts.floor != null ? opts.floor : 0.3;
    const kLo = Math.max(1, Math.floor(hzToBin(minHz, sampleRate, nBins)));

    // Per-frame flux (broadband).
    const flux = new Float32Array(nFrames);
    for (let f = 1; f < nFrames; f++) {
      const cur = trackMags[f];
      const prev = trackMags[f - 1];
      let s = 0;
      for (let k = 1; k < nBinsGrid; k++) {
        const d = cur[k] - prev[k];
        if (d > 0) s += d;
      }
      flux[f] = s;
    }
    // Local mean + std over ±11 frames.
    const window = 11;
    const half = window >> 1;
    for (let f = 0; f < nFrames; f++) {
      const a = Math.max(0, f - half);
      const b = Math.min(nFrames - 1, f + half);
      let sum = 0, sumSq = 0, n = 0;
      for (let i = a; i <= b; i++) { sum += flux[i]; sumSq += flux[i] * flux[i]; n++; }
      const mean = sum / n;
      const variance = Math.max(0, sumSq / n - mean * mean);
      const std = Math.sqrt(variance) || EPS;
      const z = (flux[f] - mean) / std;
      if (z <= zThresh) continue;
      // Hit: attenuate this frame + neighbours.
      for (let df = -1; df <= 1; df++) {
        const ff = f + df;
        if (ff < 0 || ff >= nFrames) continue;
        const w = df === 0 ? 1 : 0.5;
        const gain = 1 - (1 - floor) * w;
        for (let k = kLo; k < nBins; k++) {
          const idx = ff * nBins + k;
          if (data[idx] > gain) data[idx] = gain;
        }
      }
    }

    return {
      data, smooth,
      description: `Declick (z>${zThresh}, above ${minHz} Hz)`
    };
  }

  // -- Merge helper ----------------------------------------------------------
  //
  // Multiplies another mask into `dst` in place. Used when stacking presets
  // (e.g. hum + rumble + hiss).
  function mergeMaskInto(dst, other) {
    if (!dst || !other) return dst;
    if (dst.data.length !== other.data.length) return dst;
    for (let i = 0; i < dst.data.length; i++) dst.data[i] *= other.data[i];
    if (other.smooth) {
      for (let i = 0; i < dst.smooth.length; i++) {
        dst.smooth[i] = Math.max(dst.smooth[i], other.smooth[i]);
      }
    }
    return dst;
  }

  global.Restoration = {
    buildHumMask,
    buildRumbleMask,
    buildHissMask,
    buildDeessMask,
    buildDeclickMask,
    mergeMaskInto,
    _hzToBin: hzToBin
  };
})(typeof window !== 'undefined' ? window : globalThis);
