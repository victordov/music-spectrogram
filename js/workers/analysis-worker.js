// Web Worker: offloads full-track STFT, scalogram, HPS, and spectral-edit
// resynthesis (ISTFT) off the UI thread.
self.importScripts('../fft.js', '../analyzer.js');

// Helper: given samples + params, compute complex STFT and magnitudes.
function stftBundle(samples, sampleRate, fftSize, hop, windowName, progressLabel) {
  const stft = self.Analyzer.computeSTFTComplex(samples, sampleRate, {
    fftSize, hop, windowName,
    onProgress: (p) => self.postMessage({ type: 'progress', stage: progressLabel || 'stft', p })
  });
  const mags = new Array(stft.nFrames);
  for (let f = 0; f < stft.nFrames; f++) {
    const r = stft.re[f], i = stft.im[f];
    const m = new Float32Array(r.length);
    for (let k = 0; k < r.length; k++) m[k] = Math.hypot(r[k], i[k]);
    mags[f] = m;
  }
  return { stft, mags };
}

// Convert complex STFT to packed Uint8Array grid for visualization.
// Uses one-sided magnitudes; packs into nFrames * (fftSize/2) bins (drops Nyquist bin for compatibility).
function packMags(mags, fftSize, minDb, maxDb) {
  const nFrames = mags.length;
  const nBins = fftSize / 2;
  const grid = new Uint8Array(nFrames * nBins);
  const range = Math.max(1e-6, maxDb - minDb);
  for (let f = 0; f < nFrames; f++) {
    const m = mags[f];
    for (let k = 0; k < nBins; k++) {
      const db = 20 * Math.log10(Math.max(m[k], 1e-7));
      const t = Math.max(0, Math.min(1, (db - minDb) / range));
      grid[f * nBins + k] = (t * 255) | 0;
    }
  }
  return grid;
}

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.cmd === 'stft') {
      const { samples, sampleRate, fftSize, hop, windowName, minDb, maxDb, keepRaw } = msg;
      const res = self.Analyzer.computeSpectrogram(samples, sampleRate, {
        fftSize, hop, windowName, minDb, maxDb, packed: true,
        onProgress: (p) => self.postMessage({ type: 'progress', stage: 'stft', p })
      });
      let rawMags = null;
      if (keepRaw) {
        rawMags = new Array(res.nFrames);
        const fft = new self.FFT(fftSize);
        const win = self.Windows.build(windowName, fftSize);
        const re = new Float32Array(fftSize);
        const im = new Float32Array(fftSize);
        let winSum = 0;
        for (let i = 0; i < fftSize; i++) winSum += win[i];
        const norm = 1 / (winSum || 1);
        for (let f = 0; f < res.nFrames; f++) {
          const start = f * hop;
          for (let i = 0; i < fftSize; i++) {
            const s = start + i;
            re[i] = (s < samples.length ? samples[s] : 0) * win[i];
            im[i] = 0;
          }
          fft.forward(re, im);
          const arr = new Float32Array(fftSize / 2);
          for (let k = 0; k < fftSize / 2; k++) arr[k] = Math.hypot(re[k], im[k]) * norm;
          rawMags[f] = arr;
        }
      }
      self.postMessage({
        type: 'stft-done',
        grid: res.grid, nFrames: res.nFrames, nBins: res.nBins,
        fftSize: res.fftSize, hop: res.hop, sampleRate: res.sampleRate,
        minDb: res.minDb, maxDb: res.maxDb, rawMags
      }, [res.grid.buffer]);
    }

    else if (msg.cmd === 'scalogram') {
      const { samples, sampleRate, nScales, fMin, fMax, hop, minDb, maxDb } = msg;
      const res = self.Analyzer.computeScalogram(samples, sampleRate, {
        nScales, fMin, fMax, hop, minDb, maxDb,
        onProgress: (p) => self.postMessage({ type: 'progress', stage: 'scalogram', p })
      });
      self.postMessage({
        type: 'scalogram-done',
        grid: res.grid, nFrames: res.nFrames, nScales: res.nScales,
        scales: res.scales, hop: res.hop, sampleRate: res.sampleRate,
        minDb: res.minDb, maxDb: res.maxDb
      }, [res.grid.buffer]);
    }

    else if (msg.cmd === 'hps') {
      // Compute complex STFT, HPS masks, and optionally render the selected component.
      const { samples, sampleRate, fftSize, hop, windowName, kernelH, kernelP, render } = msg;
      const { stft, mags } = stftBundle(samples, sampleRate, fftSize, hop, windowName, 'stft');
      self.postMessage({ type: 'progress', stage: 'hps-masks', p: 0 });
      const { Mh, Mp } = self.Analyzer.hpsMasks(mags, {
        kernelH, kernelP,
        onProgress: (p) => self.postMessage({ type: 'progress', stage: 'hps-masks', p })
      });
      // Pack harmonic + percussive magnitude grids for visualization.
      const gridH = new Uint8Array(stft.nFrames * (fftSize / 2));
      const gridP = new Uint8Array(stft.nFrames * (fftSize / 2));
      const minDb = -90, maxDb = 0, range = maxDb - minDb;
      for (let f = 0; f < stft.nFrames; f++) {
        for (let k = 0; k < fftSize / 2; k++) {
          const mh = mags[f][k] * Mh[f][k];
          const mp = mags[f][k] * Mp[f][k];
          const dh = 20 * Math.log10(Math.max(mh, 1e-7));
          const dp = 20 * Math.log10(Math.max(mp, 1e-7));
          gridH[f * (fftSize / 2) + k] = Math.max(0, Math.min(255, ((dh - minDb) / range * 255) | 0));
          gridP[f * (fftSize / 2) + k] = Math.max(0, Math.min(255, ((dp - minDb) / range * 255) | 0));
        }
      }
      let rendered = null;
      if (render === 'harmonic' || render === 'percussive') {
        const mask = render === 'harmonic' ? Mh : Mp;
        const reC = stft.re.map(r => new Float32Array(r));
        const imC = stft.im.map(i => new Float32Array(i));
        self.Analyzer.applyMaskComplex(reC, imC, mask);
        rendered = self.Analyzer.istft(reC, imC, {
          fftSize, hop, windowName,
          onProgress: (p) => self.postMessage({ type: 'progress', stage: 'istft', p })
        });
      }
      const transfer = [gridH.buffer, gridP.buffer];
      if (rendered) transfer.push(rendered.buffer);
      self.postMessage({
        type: 'hps-done',
        gridH, gridP,
        nFrames: stft.nFrames, nBins: fftSize / 2, fftSize, hop, sampleRate,
        minDb, maxDb,
        rendered, renderedSampleRate: sampleRate
      }, transfer);
    }

    else if (msg.cmd === 'render-masked') {
      // Apply arbitrary real-valued gain mask + optional smoothing mask to a
      // complex STFT, then ISTFT back to samples.
      const { samples, sampleRate, fftSize, hop, windowName, mask, smoothMask } = msg;
      const stft = self.Analyzer.computeSTFTComplex(samples, sampleRate, {
        fftSize, hop, windowName,
        onProgress: (p) => self.postMessage({ type: 'progress', stage: 'stft', p })
      });
      const nBinsOne = fftSize / 2 + 1;

      // Optional smoothing: in cells where smoothMask > 0, replace (re, im) with
      // a weighted average of neighbouring bins (same frame). This smears
      // narrow-band energy while preserving phase continuity reasonably well.
      if (smoothMask) {
        const K = 3; // half-window for smoothing (± bins)
        for (let f = 0; f < stft.nFrames; f++) {
          const r = stft.re[f], im = stft.im[f];
          const rOut = new Float32Array(r);
          const iOut = new Float32Array(im);
          const base = f * nBinsOne;
          for (let k = 0; k < nBinsOne; k++) {
            const s = smoothMask[base + k];
            if (s <= 0) continue;
            let sumR = 0, sumI = 0, w = 0;
            for (let d = -K; d <= K; d++) {
              const kk = k + d;
              if (kk < 0 || kk >= nBinsOne) continue;
              const ww = 1 - Math.abs(d) / (K + 1);
              sumR += r[kk] * ww;
              sumI += im[kk] * ww;
              w += ww;
            }
            const sr = sumR / (w || 1);
            const si = sumI / (w || 1);
            rOut[k] = r[k] * (1 - s) + sr * s;
            iOut[k] = im[k] * (1 - s) + si * s;
          }
          stft.re[f] = rOut;
          stft.im[f] = iOut;
        }
      }

      // Apply gain mask.
      const maskFrames = new Array(stft.nFrames);
      for (let f = 0; f < stft.nFrames; f++) {
        maskFrames[f] = mask.subarray(f * nBinsOne, (f + 1) * nBinsOne);
      }
      self.Analyzer.applyMaskComplex(stft.re, stft.im, maskFrames);
      const rendered = self.Analyzer.istft(stft.re, stft.im, {
        fftSize, hop, windowName,
        onProgress: (p) => self.postMessage({ type: 'progress', stage: 'istft', p })
      });
      self.postMessage({ type: 'render-done', rendered, sampleRate }, [rendered.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
