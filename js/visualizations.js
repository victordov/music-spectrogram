// Alternative visualizations: mel, chroma, scalogram, cochleagram, reassigned,
// cepstrum, waterfall 3D, spectral features. Each takes precomputed track data
// and draws into the renderer's canvas.
(function (global) {
  'use strict';

  function drawHeatGrid(ctx, w, h, grid, nCols, nRows, colormap, {
    minDb = -80, maxDb = 0, gamma = 1, tPan = 0, tZoom = 1, fPan = 0, fZoom = 1
  } = {}) {
    const img = ctx.createImageData(w, h);
    const data = img.data;
    const lut = global.Colormaps.LUTS[colormap] || global.Colormaps.LUTS.viridis;
    const range = Math.max(1e-6, maxDb - minDb);
    const t0 = tPan, t1 = Math.min(1, tPan + 1 / tZoom);
    const f0 = fPan, f1 = Math.min(1, fPan + 1 / fZoom);
    for (let px = 0; px < w; px++) {
      const tf = t0 + (px / (w - 1)) * (t1 - t0);
      const col = Math.max(0, Math.min(nCols - 1, Math.floor(tf * (nCols - 1))));
      const base = col * nRows;
      for (let py = 0; py < h; py++) {
        const ff = f1 - (py / (h - 1)) * (f1 - f0); // top-high
        const row = Math.max(0, Math.min(nRows - 1, Math.floor(ff * (nRows - 1))));
        const v = grid[base + row] / 255;
        // Re-scale to user's dB window (grid is already normalized).
        let t = v;
        if (gamma !== 1) t = Math.pow(t, gamma);
        const ci = Math.min(255, Math.max(0, (t * 255) | 0)) * 3;
        const di = (py * w + px) * 4;
        data[di] = lut[ci];
        data[di + 1] = lut[ci + 1];
        data[di + 2] = lut[ci + 2];
        data[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // Build mel spectrogram grid from STFT magnitudes grid.
  function buildMelGrid(trackMags, sampleRate, nMels = 128, fMin = 20, fMax = 20000) {
    // trackMags: Float32Array[] frames (magnitude, unpacked). nBins = fftSize/2.
    const nFrames = trackMags.length;
    const nBins = trackMags[0].length;
    const fftSize = nBins * 2;
    const { filters, centers } = global.Analyzer.buildMelFilterbank(fftSize, sampleRate, nMels, fMin, fMax);
    const grid = new Uint8Array(nFrames * nMels);
    // compute logs then normalize frame-independent; use a global min/max.
    const tmp = new Float32Array(nFrames * nMels);
    let gmin = Infinity, gmax = -Infinity;
    for (let f = 0; f < nFrames; f++) {
      const mel = global.Analyzer.applyFilterbank(trackMags[f], filters);
      for (let i = 0; i < nMels; i++) {
        const db = 10 * Math.log10(Math.max(mel[i] * mel[i], 1e-10));
        tmp[f * nMels + i] = db;
        if (db < gmin) gmin = db;
        if (db > gmax) gmax = db;
      }
    }
    const range = Math.max(1e-6, gmax - gmin);
    for (let i = 0; i < tmp.length; i++) {
      const t = Math.max(0, Math.min(1, (tmp[i] - gmin) / range));
      grid[i] = (t * 255) | 0;
    }
    return { grid, nFrames, nRows: nMels, centers, minDb: gmin, maxDb: gmax };
  }

  // Chroma grid.
  function buildChromaGrid(trackMags, sampleRate) {
    const nFrames = trackMags.length;
    const nBins = trackMags[0].length;
    const fftSize = nBins * 2;
    const chromaW = global.Analyzer.buildChromaWeights(fftSize, sampleRate);
    const grid = new Uint8Array(nFrames * 12);
    for (let f = 0; f < nFrames; f++) {
      const c = global.Analyzer.applyChroma(trackMags[f], chromaW);
      // Normalize each frame.
      let m = 0; for (let i = 0; i < 12; i++) m = Math.max(m, c[i]);
      const inv = m > 1e-7 ? 1 / m : 0;
      for (let i = 0; i < 12; i++) grid[f * 12 + i] = (Math.min(1, c[i] * inv) * 255) | 0;
    }
    return { grid, nFrames, nRows: 12 };
  }

  // Cochleagram grid.
  function buildCochleagramGrid(trackMags, sampleRate, nFilters = 96) {
    const nFrames = trackMags.length;
    const nBins = trackMags[0].length;
    const fftSize = nBins * 2;
    const { filters, centers } = global.Analyzer.buildGammatoneFilterbank(fftSize, sampleRate, nFilters, 50, Math.min(20000, sampleRate / 2));
    const grid = new Uint8Array(nFrames * nFilters);
    const tmp = new Float32Array(nFrames * nFilters);
    let gmin = Infinity, gmax = -Infinity;
    for (let f = 0; f < nFrames; f++) {
      const out = global.Analyzer.applyFilterbank(trackMags[f], filters);
      for (let i = 0; i < nFilters; i++) {
        const db = 20 * Math.log10(Math.max(out[i], 1e-7));
        tmp[f * nFilters + i] = db;
        if (db < gmin) gmin = db;
        if (db > gmax) gmax = db;
      }
    }
    const range = Math.max(1e-6, gmax - gmin);
    for (let i = 0; i < tmp.length; i++) {
      const t = Math.max(0, Math.min(1, (tmp[i] - gmin) / range));
      grid[i] = (t * 255) | 0;
    }
    return { grid, nFrames, nRows: nFilters, centers };
  }

  // Reassigned spectrogram: lightweight version via local peak sharpening.
  // For each column, we take magnitudes, and for each bin, we shift energy to the
  // local peak within a small neighborhood. Then apply a small log transform. This
  // gives sharper peaks without computing true reassignment (which requires phase).
  function buildReassignedGrid(trackMags) {
    const nFrames = trackMags.length;
    const nBins = trackMags[0].length;
    const grid = new Uint8Array(nFrames * nBins);
    const tmp = new Float32Array(nFrames * nBins);
    let gmin = Infinity, gmax = -Infinity;
    for (let f = 0; f < nFrames; f++) {
      const src = trackMags[f];
      // local peak sharpening
      for (let k = 0; k < nBins; k++) {
        const l = src[Math.max(0, k - 1)] || 0;
        const c = src[k];
        const r = src[Math.min(nBins - 1, k + 1)] || 0;
        const isPeak = c >= l && c >= r ? 1 : 0.2;
        const db = 20 * Math.log10(Math.max(c * isPeak, 1e-7));
        tmp[f * nBins + k] = db;
        if (db < gmin) gmin = db;
        if (db > gmax) gmax = db;
      }
    }
    const range = Math.max(1e-6, gmax - gmin);
    for (let i = 0; i < tmp.length; i++) {
      const t = Math.max(0, Math.min(1, (tmp[i] - gmin) / range));
      grid[i] = (t * 255) | 0;
    }
    return { grid, nFrames, nRows: nBins };
  }

  // Cepstrum grid (quefrency vs time).
  function buildCepstrumGrid(trackMags, fftSize) {
    const nFrames = trackMags.length;
    const nRows = fftSize / 2;
    const grid = new Uint8Array(nFrames * nRows);
    const tmp = new Float32Array(nFrames * nRows);
    let gmin = Infinity, gmax = -Infinity;
    for (let f = 0; f < nFrames; f++) {
      const cep = global.Analyzer.computeCepstrum(trackMags[f], fftSize);
      for (let q = 0; q < nRows; q++) {
        const v = 20 * Math.log10(Math.max(cep[q], 1e-7));
        tmp[f * nRows + q] = v;
        if (v < gmin) gmin = v;
        if (v > gmax) gmax = v;
      }
    }
    const range = Math.max(1e-6, gmax - gmin);
    for (let i = 0; i < tmp.length; i++) {
      const t = Math.max(0, Math.min(1, (tmp[i] - gmin) / range));
      grid[i] = (t * 255) | 0;
    }
    return { grid, nFrames, nRows };
  }

  // Feature plots: centroid, bandwidth, rolloff, flux, rms over time.
  function buildFeatures(trackMags, buffer, sampleRate, hop) {
    const nFrames = trackMags.length;
    const centroid = new Float32Array(nFrames);
    const bandwidth = new Float32Array(nFrames);
    const rolloff = new Float32Array(nFrames);
    const flux = new Float32Array(nFrames);
    const rms = new Float32Array(nFrames);
    let prev = new Float32Array(trackMags[0].length);
    for (let f = 0; f < nFrames; f++) {
      const mag = trackMags[f];
      const c = global.Analyzer.spectralCentroid(mag, sampleRate);
      centroid[f] = c;
      bandwidth[f] = global.Analyzer.spectralBandwidth(mag, sampleRate, c);
      rolloff[f] = global.Analyzer.spectralRolloff(mag, sampleRate);
      flux[f] = global.Analyzer.spectralFlux(prev, mag);
      rms[f] = global.Analyzer.rms(buffer, f * hop, Math.min(hop, buffer.length - f * hop));
      prev = mag;
    }
    return { centroid, bandwidth, rolloff, flux, rms, nFrames, sampleRate };
  }

  function drawFeatures(ctx, w, h, features, opts = {}) {
    const tPan = opts.tPan || 0, tZoom = opts.tZoom || 1;
    const t0 = tPan, t1 = Math.min(1, tPan + 1 / tZoom);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, w, h);
    const rows = [
      { name: 'Spectral centroid (Hz)', data: features.centroid, color: '#4fd1c5', max: features.sampleRate / 2 },
      { name: 'Spectral bandwidth (Hz)', data: features.bandwidth, color: '#a78bfa', max: features.sampleRate / 4 },
      { name: 'Spectral rolloff (Hz)', data: features.rolloff, color: '#f472b6', max: features.sampleRate / 2 },
      { name: 'Spectral flux', data: features.flux, color: '#fbbf24', max: null },
      { name: 'RMS energy', data: features.rms, color: '#60a5fa', max: null }
    ];
    const rowH = h / rows.length;
    ctx.font = '11px ui-monospace, monospace';
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const y0 = r * rowH + 4;
      const yH = rowH - 8;
      // bg
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(0, r * rowH, w, rowH);
      // label
      ctx.fillStyle = '#9aa3b2';
      ctx.fillText(row.name, 6, r * rowH + 14);
      // data
      let maxVal = row.max;
      if (!maxVal) {
        let m = 0;
        for (let i = 0; i < row.data.length; i++) if (row.data[i] > m) m = row.data[i];
        maxVal = m || 1;
      }
      ctx.strokeStyle = row.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const n = row.data.length;
      let started = false;
      for (let x = 0; x < w; x++) {
        const tf = t0 + (x / (w - 1)) * (t1 - t0);
        const idx = Math.max(0, Math.min(n - 1, Math.floor(tf * (n - 1))));
        const v = row.data[idx];
        const y = y0 + yH - (v / maxVal) * yH;
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  // Waterfall 3D: draw stacked recent frames with perspective skew.
  class Waterfall {
    constructor() {
      this.frames = []; // newest first; each {mag: Float32Array}
      this.maxFrames = 80;
    }
    push(mag) {
      this.frames.unshift(new Float32Array(mag));
      if (this.frames.length > this.maxFrames) this.frames.length = this.maxFrames;
    }
    draw(ctx, w, h, opts) {
      const { colorMap = 'viridis', minDb = -90, maxDb = -10, gamma = 1, fPan = 0, fZoom = 1, sampleRate = 44100, minFreq = 20, maxFreq = 20000, freqScale = 'log' } = opts;
      ctx.fillStyle = '#05070a';
      ctx.fillRect(0, 0, w, h);
      const n = this.frames.length;
      if (!n) return;
      const lut = global.Colormaps.LUTS[colorMap] || global.Colormaps.LUTS.viridis;
      const range = Math.max(1e-6, maxDb - minDb);
      const ampH = h * 0.55;
      const rowSkew = w * 0.12;
      const rowYStep = (h - ampH) / Math.max(1, n);
      // Far to near.
      for (let i = n - 1; i >= 0; i--) {
        const mag = this.frames[i];
        const nBins = mag.length;
        const depth = i / (n - 1 || 1);
        const ySkew = depth * (h - ampH);
        const xOff = rowSkew * (1 - depth);
        const rowW = w - rowSkew * 2 * (1 - depth);
        const rowBaseY = h - ySkew - 6;
        // Amplitude-colored filled polyline.
        ctx.beginPath();
        for (let px = 0; px < rowW; px++) {
          const frac = px / rowW;
          const hz = freqScale === 'log'
            ? Math.max(1, minFreq) * Math.pow(maxFreq / Math.max(1, minFreq), fPan + frac / fZoom)
            : minFreq + (maxFreq - minFreq) * (fPan + frac / fZoom);
          const k = Math.max(0, Math.min(nBins - 1, Math.floor((hz / (sampleRate / 2)) * nBins)));
          const v = mag[k];
          const db = 20 * Math.log10(Math.max(v, 1e-7));
          let t = (db - minDb) / range;
          t = Math.max(0, Math.min(1, t));
          if (gamma !== 1) t = Math.pow(t, gamma);
          const y = rowBaseY - t * ampH * (0.3 + 0.7 * (1 - depth));
          if (px === 0) ctx.moveTo(xOff + px, y);
          else ctx.lineTo(xOff + px, y);
        }
        ctx.lineTo(xOff + rowW, rowBaseY);
        ctx.lineTo(xOff, rowBaseY);
        ctx.closePath();
        // Color by depth.
        const ci = Math.min(255, Math.max(0, Math.floor((1 - depth) * 255))) * 3;
        const alpha = 0.18 + 0.55 * (1 - depth);
        ctx.fillStyle = `rgba(${lut[ci]},${lut[ci + 1]},${lut[ci + 2]},${alpha.toFixed(3)})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${lut[ci]},${lut[ci + 1]},${lut[ci + 2]},${(alpha + 0.3).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  global.Visualizations = {
    drawHeatGrid,
    buildMelGrid,
    buildChromaGrid,
    buildCochleagramGrid,
    buildReassignedGrid,
    buildCepstrumGrid,
    buildFeatures,
    drawFeatures,
    Waterfall
  };
})(typeof window !== 'undefined' ? window : globalThis);
