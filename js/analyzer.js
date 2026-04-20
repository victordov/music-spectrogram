// Analyzer: frame-based STFT on a given Float32Array, mel filterbanks,
// chromagram, spectral features, cepstrum, harmonic tracking.
// Pure, no DOM. Can also be instantiated inside a worker.
(function (global) {
  'use strict';

  function mixdown(channelData, mode) {
    // channelData: Float32Array[]
    if (channelData.length === 1) return channelData[0];
    if (mode === 'left') return channelData[0];
    if (mode === 'right') return channelData[1] || channelData[0];
    // default mono mix
    const n = channelData[0].length;
    const out = new Float32Array(n);
    const c = channelData.length;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < c; k++) s += channelData[k][i];
      out[i] = s / c;
    }
    return out;
  }

  function dbFromPower(p, ref) {
    // 10*log10 with floor.
    return 10 * Math.log10(Math.max(p, 1e-12) / (ref || 1));
  }

  // Compute a single STFT frame. Returns magnitude array of length fftSize/2.
  function computeFrameMagnitudes(fft, buffer, frameStart, win, re, im) {
    const n = win.length;
    const src = buffer;
    const srcLen = src.length;
    for (let i = 0; i < n; i++) {
      const s = frameStart + i;
      re[i] = (s >= 0 && s < srcLen ? src[s] : 0) * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    const half = n / 2;
    const mag = new Float32Array(half);
    for (let k = 0; k < half; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    return mag;
  }

  // Full-track STFT. Returns { frames: Float32Array[], hop, fftSize, nFrames, nBins }.
  // For large files we flatten into a Uint8Array grid (normalized 0-255) to save memory.
  function computeSpectrogram(buffer, sampleRate, {
    fftSize = 1024,
    hop = 512,
    windowName = 'hann',
    minDb = -90,
    maxDb = -10,
    packed = true,
    onProgress = null
  } = {}) {
    const fft = new global.FFT(fftSize);
    const win = global.Windows.build(windowName, fftSize);
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    const nBins = fftSize / 2;
    const nFrames = Math.max(1, Math.floor((buffer.length - fftSize) / hop) + 1);
    // Window power correction for amplitude.
    let winSum = 0;
    for (let i = 0; i < fftSize; i++) winSum += win[i];
    const norm = 1 / (winSum || 1);

    let grid;
    if (packed) grid = new Uint8Array(nFrames * nBins);
    else grid = new Array(nFrames);

    const range = Math.max(1e-6, maxDb - minDb);
    const lastReport = { t: Date.now() };
    for (let f = 0; f < nFrames; f++) {
      const start = f * hop;
      for (let i = 0; i < fftSize; i++) {
        const s = start + i;
        re[i] = (s < buffer.length ? buffer[s] : 0) * win[i];
        im[i] = 0;
      }
      fft.forward(re, im);
      if (packed) {
        const off = f * nBins;
        for (let k = 0; k < nBins; k++) {
          const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
          const db = 20 * Math.log10(Math.max(mag, 1e-7));
          const t = Math.max(0, Math.min(1, (db - minDb) / range));
          grid[off + k] = (t * 255) | 0;
        }
      } else {
        const arr = new Float32Array(nBins);
        for (let k = 0; k < nBins; k++) arr[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
        grid[f] = arr;
      }
      if (onProgress && (Date.now() - lastReport.t > 40)) {
        onProgress(f / nFrames);
        lastReport.t = Date.now();
      }
    }
    if (onProgress) onProgress(1);

    return { grid, nFrames, nBins, fftSize, hop, sampleRate, packed, minDb, maxDb };
  }

  // Mel filterbank: returns {filters: Float32Array[], centers: Float32Array}
  function buildMelFilterbank(nFft, sampleRate, nMels, fMin, fMax) {
    const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
    const melToHz = (m) => 700 * (Math.pow(10, m / 2595) - 1);
    const melMin = hzToMel(Math.max(0, fMin));
    const melMax = hzToMel(Math.min(sampleRate / 2, fMax));
    const mels = new Float32Array(nMels + 2);
    for (let i = 0; i < mels.length; i++) mels[i] = melMin + (melMax - melMin) * (i / (nMels + 1));
    const hz = new Float32Array(mels.length);
    for (let i = 0; i < mels.length; i++) hz[i] = melToHz(mels[i]);
    const bins = new Float32Array(mels.length);
    const nBins = nFft / 2;
    for (let i = 0; i < mels.length; i++) bins[i] = (hz[i] / (sampleRate / 2)) * (nBins - 1);
    const filters = [];
    for (let m = 1; m <= nMels; m++) {
      const f = new Float32Array(nBins);
      const l = bins[m - 1], c = bins[m], r = bins[m + 1];
      for (let k = 0; k < nBins; k++) {
        if (k < l || k > r) continue;
        if (k <= c) f[k] = (k - l) / Math.max(1e-6, (c - l));
        else f[k] = (r - k) / Math.max(1e-6, (r - c));
      }
      filters.push(f);
    }
    const centers = new Float32Array(nMels);
    for (let m = 1; m <= nMels; m++) centers[m - 1] = hz[m];
    return { filters, centers };
  }

  function applyFilterbank(mag, filters) {
    const out = new Float32Array(filters.length);
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i];
      let s = 0;
      for (let k = 0; k < f.length; k++) s += f[k] * mag[k];
      out[i] = s;
    }
    return out;
  }

  // Chroma: collapse frequencies into 12 pitch classes.
  // Returns chroma[12] from a magnitude spectrum.
  function buildChromaWeights(nFft, sampleRate, fMin = 55, fMax = 8000) {
    const nBins = nFft / 2;
    const weights = new Float32Array(nBins * 12);
    const a4 = 440;
    for (let k = 1; k < nBins; k++) {
      const hz = (k / nBins) * (sampleRate / 2);
      if (hz < fMin || hz > fMax) continue;
      const midi = 69 + 12 * Math.log2(hz / a4);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      weights[k * 12 + pc] += 1;
    }
    return { weights, nBins };
  }

  function applyChroma(mag, chromaW) {
    const out = new Float32Array(12);
    const nBins = chromaW.nBins;
    const w = chromaW.weights;
    for (let k = 0; k < nBins; k++) {
      const m = mag[k];
      if (!m) continue;
      const base = k * 12;
      for (let p = 0; p < 12; p++) out[p] += m * w[base + p];
    }
    return out;
  }

  // Spectral features.
  function spectralCentroid(mag, sampleRate) {
    const n = mag.length;
    let num = 0, den = 0;
    for (let k = 0; k < n; k++) {
      const hz = (k / n) * (sampleRate / 2);
      num += hz * mag[k];
      den += mag[k];
    }
    return den ? num / den : 0;
  }
  function spectralRolloff(mag, sampleRate, pct = 0.85) {
    const n = mag.length;
    let total = 0;
    for (let k = 0; k < n; k++) total += mag[k] * mag[k];
    const limit = total * pct;
    let cum = 0;
    for (let k = 0; k < n; k++) {
      cum += mag[k] * mag[k];
      if (cum >= limit) return (k / n) * (sampleRate / 2);
    }
    return sampleRate / 2;
  }
  function spectralBandwidth(mag, sampleRate, centroid) {
    const n = mag.length;
    let num = 0, den = 0;
    for (let k = 0; k < n; k++) {
      const hz = (k / n) * (sampleRate / 2);
      num += Math.pow(hz - centroid, 2) * mag[k];
      den += mag[k];
    }
    return den ? Math.sqrt(num / den) : 0;
  }
  function rms(buffer, start, len) {
    let s = 0;
    for (let i = 0; i < len; i++) {
      const v = buffer[start + i] || 0;
      s += v * v;
    }
    return Math.sqrt(s / len);
  }
  function spectralFlux(prev, cur) {
    const n = cur.length;
    let s = 0;
    for (let k = 0; k < n; k++) {
      const d = cur[k] - prev[k];
      if (d > 0) s += d * d;
    }
    return Math.sqrt(s);
  }

  // Cepstrum: inverse FFT of log magnitude spectrum.
  function computeCepstrum(mag, fftSize) {
    const n = fftSize;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const half = mag.length;
    // Build symmetric log-magnitude spectrum.
    for (let k = 0; k < half; k++) re[k] = Math.log(Math.max(mag[k], 1e-7));
    for (let k = 1; k < half; k++) re[n - k] = re[k];
    const fft = new global.FFT(n);
    fft.forward(re, im);
    const out = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) out[i] = Math.abs(re[i]) / n;
    return out;
  }

  // Simple harmonic tracking: find peak, then report multiples.
  function trackHarmonics(mag, sampleRate, fMin = 60, fMax = 1000, nHarm = 6) {
    const n = mag.length;
    const nyq = sampleRate / 2;
    const kMin = Math.max(1, Math.floor((fMin / nyq) * n));
    const kMax = Math.min(n - 1, Math.ceil((fMax / nyq) * n));
    let peak = kMin, peakVal = mag[kMin];
    for (let k = kMin; k <= kMax; k++) {
      if (mag[k] > peakVal) { peakVal = mag[k]; peak = k; }
    }
    // Parabolic interpolation for more precise fundamental.
    let kRef = peak;
    if (peak > 0 && peak < n - 1) {
      const a = mag[peak - 1], b = mag[peak], c = mag[peak + 1];
      const denom = a - 2 * b + c;
      if (denom !== 0) kRef = peak + 0.5 * (a - c) / denom;
    }
    const f0 = (kRef / n) * nyq;
    const series = [];
    for (let h = 1; h <= nHarm; h++) series.push(f0 * h);
    return { f0, series, energy: peakVal };
  }

  // Gammatone filterbank magnitude envelope approximation via weighted FFT bins.
  function buildGammatoneFilterbank(nFft, sampleRate, nFilters = 64, fMin = 50, fMax = 20000) {
    // ERB-scale center frequencies.
    const erbToHz = (e) => (Math.pow(10, e / 21.4) - 1) * 229;
    const hzToErb = (hz) => 21.4 * Math.log10(1 + hz / 229);
    const eMin = hzToErb(fMin), eMax = hzToErb(Math.min(sampleRate / 2, fMax));
    const centers = new Float32Array(nFilters);
    for (let i = 0; i < nFilters; i++) centers[i] = erbToHz(eMin + (eMax - eMin) * i / (nFilters - 1));
    const nBins = nFft / 2;
    const filters = [];
    for (let i = 0; i < nFilters; i++) {
      const cf = centers[i];
      const erb = 24.7 + 0.108 * cf;
      const bw = erb * 1.019;
      const f = new Float32Array(nBins);
      for (let k = 0; k < nBins; k++) {
        const hz = (k / nBins) * (sampleRate / 2);
        // Gammatone magnitude: (1 + ((hz - cf)/bw)^2)^(-2)
        const x = (hz - cf) / bw;
        f[k] = Math.pow(1 + x * x, -2);
      }
      filters.push(f);
    }
    return { filters, centers };
  }

  // Simple Morlet wavelet scalogram (CWT).
  // buffer: Float32Array; returns packed Uint8Array grid of scales x time.
  function computeScalogram(buffer, sampleRate, {
    nScales = 96,
    fMin = 50,
    fMax = 8000,
    hop = 256,
    minDb = -60,
    maxDb = 0,
    onProgress = null
  } = {}) {
    const nFrames = Math.max(1, Math.floor(buffer.length / hop));
    const grid = new Uint8Array(nFrames * nScales);
    const scales = new Float32Array(nScales); // center freq per scale
    // Logarithmic freq spacing.
    for (let s = 0; s < nScales; s++) {
      scales[s] = fMin * Math.pow(fMax / fMin, s / (nScales - 1));
    }
    // Morlet wavelet params
    const w0 = 6;
    const lastReport = { t: Date.now() };
    for (let s = 0; s < nScales; s++) {
      const cf = scales[s];
      // Support: enough samples to cover ~6 wavelengths.
      const sigma = w0 / (2 * Math.PI * cf); // seconds
      const halfLen = Math.min(2048, Math.ceil(3 * sigma * sampleRate));
      const kernelRe = new Float32Array(2 * halfLen + 1);
      const kernelIm = new Float32Array(2 * halfLen + 1);
      let norm = 0;
      for (let i = -halfLen; i <= halfLen; i++) {
        const t = i / sampleRate;
        const gauss = Math.exp(-0.5 * Math.pow(t / sigma, 2));
        const arg = 2 * Math.PI * cf * t;
        const kr = gauss * Math.cos(arg);
        const ki = gauss * Math.sin(arg);
        kernelRe[i + halfLen] = kr;
        kernelIm[i + halfLen] = ki;
        norm += gauss * gauss;
      }
      norm = 1 / Math.sqrt(norm);
      for (let i = 0; i < kernelRe.length; i++) { kernelRe[i] *= norm; kernelIm[i] *= norm; }

      const range = Math.max(1e-6, maxDb - minDb);
      for (let f = 0; f < nFrames; f++) {
        const center = f * hop;
        let acRe = 0, acIm = 0;
        for (let i = -halfLen; i <= halfLen; i++) {
          const idx = center + i;
          if (idx < 0 || idx >= buffer.length) continue;
          const x = buffer[idx];
          acRe += x * kernelRe[i + halfLen];
          acIm += x * kernelIm[i + halfLen];
        }
        const mag = Math.sqrt(acRe * acRe + acIm * acIm);
        const db = 20 * Math.log10(Math.max(mag, 1e-7));
        const t = Math.max(0, Math.min(1, (db - minDb) / range));
        grid[f * nScales + s] = (t * 255) | 0;
      }
      if (onProgress && (Date.now() - lastReport.t > 40)) {
        onProgress(s / nScales);
        lastReport.t = Date.now();
      }
    }
    if (onProgress) onProgress(1);
    return { grid, nFrames, nScales, scales, hop, sampleRate, minDb, maxDb };
  }

  // ---------- Complex STFT + ISTFT (for spectral editing / HPS / resynthesis) ----------

  // Returns { re: Float32Array[nFrames], im: Float32Array[nFrames], nFrames, nBins, fftSize, hop, windowName }
  // Each re[f] / im[f] is length (fftSize/2 + 1) for one-sided spectrum including Nyquist bin.
  function computeSTFTComplex(buffer, sampleRate, {
    fftSize = 1024, hop = 512, windowName = 'hann', onProgress = null
  } = {}) {
    const fft = new global.FFT(fftSize);
    const win = global.Windows.build(windowName, fftSize);
    const reBuf = new Float32Array(fftSize);
    const imBuf = new Float32Array(fftSize);
    const nBins = fftSize / 2 + 1;
    const nFrames = Math.max(1, Math.floor((buffer.length - fftSize) / hop) + 1);
    const re = new Array(nFrames);
    const im = new Array(nFrames);
    const lastReport = { t: Date.now() };
    for (let f = 0; f < nFrames; f++) {
      const start = f * hop;
      for (let i = 0; i < fftSize; i++) {
        const s = start + i;
        reBuf[i] = (s < buffer.length ? buffer[s] : 0) * win[i];
        imBuf[i] = 0;
      }
      fft.forward(reBuf, imBuf);
      const r = new Float32Array(nBins);
      const im_ = new Float32Array(nBins);
      for (let k = 0; k < nBins; k++) { r[k] = reBuf[k]; im_[k] = imBuf[k]; }
      re[f] = r; im[f] = im_;
      if (onProgress && (Date.now() - lastReport.t > 40)) {
        onProgress(f / nFrames * 0.5);
        lastReport.t = Date.now();
      }
    }
    return { re, im, nFrames, nBins, fftSize, hop, windowName, sampleRate };
  }

  // Inverse STFT via overlap-add.
  // Accepts per-frame re/im arrays of length (fftSize/2 + 1) (one-sided spectrum).
  function istft(reFrames, imFrames, { fftSize, hop, windowName = 'hann', onProgress = null } = {}) {
    const fft = new global.FFT(fftSize);
    const win = global.Windows.build(windowName, fftSize);
    const nFrames = reFrames.length;
    const totalLen = (nFrames - 1) * hop + fftSize;
    const out = new Float32Array(totalLen);
    const normBuf = new Float32Array(totalLen);
    const reBuf = new Float32Array(fftSize);
    const imBuf = new Float32Array(fftSize);
    const lastReport = { t: Date.now() };
    for (let f = 0; f < nFrames; f++) {
      const r = reFrames[f], i = imFrames[f];
      // Rebuild full symmetric spectrum from the one-sided bins.
      for (let k = 0; k < fftSize; k++) {
        if (k < r.length) { reBuf[k] = r[k]; imBuf[k] = i[k]; }
        else {
          const m = fftSize - k;
          reBuf[k] = r[m] || 0;
          imBuf[k] = -(i[m] || 0);
        }
      }
      // Inverse FFT via conjugate trick: IFFT(X) = conj(FFT(conj(X))) / N
      for (let k = 0; k < fftSize; k++) imBuf[k] = -imBuf[k];
      fft.forward(reBuf, imBuf);
      // real part of IFFT output is our time-domain signal (imag ~= 0 for real input spectrum).
      const invN = 1 / fftSize;
      const start = f * hop;
      for (let s = 0; s < fftSize; s++) {
        const v = reBuf[s] * invN * win[s];
        out[start + s] += v;
        normBuf[start + s] += win[s] * win[s];
      }
      if (onProgress && (Date.now() - lastReport.t > 40)) {
        onProgress(0.5 + f / nFrames * 0.5);
        lastReport.t = Date.now();
      }
    }
    // Normalize overlap-add: divide by sum of squared windows.
    for (let i = 0; i < totalLen; i++) {
      if (normBuf[i] > 1e-10) out[i] /= normBuf[i];
    }
    return out;
  }

  // Median of a Float32Array (small, via quickselect-lite copy+sort).
  function median(arr, n) {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = arr[i];
    a.sort((x, y) => x - y);
    return a[n >> 1];
  }

  // Harmonic-Percussive Separation (Fitzgerald, 2010). Takes an array of magnitude
  // frames and returns masks Mh/Mp that multiply into the original STFT.
  // kernelH: median filter length across time (horizontal) -> harmonic smoothing.
  // kernelP: median filter length across frequency (vertical) -> percussive smoothing.
  function hpsMasks(magFrames, { kernelH = 17, kernelP = 17, onProgress = null } = {}) {
    const nFrames = magFrames.length;
    const nBins = magFrames[0].length;
    const H = new Array(nFrames);
    const P = new Array(nFrames);
    for (let f = 0; f < nFrames; f++) { H[f] = new Float32Array(nBins); P[f] = new Float32Array(nBins); }
    const halfH = kernelH >> 1, halfP = kernelP >> 1;
    const buf = new Float32Array(Math.max(kernelH, kernelP));
    const lastReport = { t: Date.now() };

    // Harmonic: median across time for each bin.
    for (let k = 0; k < nBins; k++) {
      for (let f = 0; f < nFrames; f++) {
        let n = 0;
        for (let i = -halfH; i <= halfH; i++) {
          const ff = Math.max(0, Math.min(nFrames - 1, f + i));
          buf[n++] = magFrames[ff][k];
        }
        H[f][k] = median(buf, n);
      }
      if (onProgress && (Date.now() - lastReport.t > 40)) {
        onProgress(k / nBins * 0.5);
        lastReport.t = Date.now();
      }
    }
    // Percussive: median across frequency for each frame.
    for (let f = 0; f < nFrames; f++) {
      for (let k = 0; k < nBins; k++) {
        let n = 0;
        for (let i = -halfP; i <= halfP; i++) {
          const kk = Math.max(0, Math.min(nBins - 1, k + i));
          buf[n++] = magFrames[f][kk];
        }
        P[f][k] = median(buf, n);
      }
      if (onProgress && (Date.now() - lastReport.t > 40)) {
        onProgress(0.5 + f / nFrames * 0.5);
        lastReport.t = Date.now();
      }
    }
    // Wiener-like soft masks.
    const Mh = new Array(nFrames), Mp = new Array(nFrames);
    const eps = 1e-10;
    for (let f = 0; f < nFrames; f++) {
      const mh = new Float32Array(nBins), mp = new Float32Array(nBins);
      for (let k = 0; k < nBins; k++) {
        const h2 = H[f][k] * H[f][k];
        const p2 = P[f][k] * P[f][k];
        const d = h2 + p2 + eps;
        mh[k] = h2 / d;
        mp[k] = p2 / d;
      }
      Mh[f] = mh; Mp[f] = mp;
    }
    return { Mh, Mp, H, P };
  }

  // Apply a mask (real-valued, nFrames x nBins) to a complex STFT in-place.
  // maskFrames is an array of Float32Array[nBins].
  function applyMaskComplex(re, im, maskFrames) {
    const nFrames = re.length;
    for (let f = 0; f < nFrames; f++) {
      const r = re[f], i = im[f], m = maskFrames[f];
      const n = Math.min(r.length, m.length);
      for (let k = 0; k < n; k++) { r[k] *= m[k]; i[k] *= m[k]; }
    }
  }

  global.Analyzer = {
    mixdown,
    computeFrameMagnitudes,
    computeSpectrogram,
    buildMelFilterbank,
    applyFilterbank,
    buildChromaWeights,
    applyChroma,
    spectralCentroid,
    spectralRolloff,
    spectralBandwidth,
    spectralFlux,
    rms,
    computeCepstrum,
    trackHarmonics,
    buildGammatoneFilterbank,
    computeScalogram,
    dbFromPower,
    computeSTFTComplex,
    istft,
    hpsMasks,
    applyMaskComplex
  };
})(typeof window !== 'undefined' ? window : globalThis);
