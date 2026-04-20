// Anomaly detector: scans an already-computed STFT grid (raw magnitudes)
// plus the decoded AudioBuffer and flags non-musical structure that might
// indicate steganography, hidden images, ultrasonic beacons or data
// payloads.
//
// It does NOT need to know the shape in advance. It looks for:
//
//   1. Ultrasonic energy (> 18 kHz): fraction of spectral energy above the
//      audible range — the most common carrier for hidden content.
//   2. Sustained narrow-band tones: bins that stay strongly above the
//      per-frame median for ≥ 1 s. Typical pilot tones / data carriers.
//   3. Broadband vertical bursts: single frames whose wideband energy is
//      many sigma above neighbours. Typical data-packet fingerprints.
//   4. Geometric structure in the spectrogram image: edge density +
//      orientation concentration. Natural music has mostly horizontal
//      partials; straight diagonals or right angles indicate drawn shapes.
//   5. LSB steganalysis on 16-bit PCM: classical Westfeld-Pfitzmann
//      pairs-of-values chi-square + LSB autocorrelation. If LSBs look
//      random instead of correlated, embedded data is very likely.
//
// Exposes global `Anomaly.scanTrack(opts)` which returns a structured
// report; the UI layer just reads the fields and renders cards + overlay
// markers.
(function (global) {
  'use strict';

  function erfc(x) {
    // Abramowitz & Stegun 7.1.26 — accurate to ~1.5e-7.
    const t = 1.0 / (1.0 + 0.5 * Math.abs(x));
    const y = t * Math.exp(
      -x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
        t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
          t * (-0.82215223 + t * 0.17087277))))))))
    );
    return x >= 0 ? y : 2 - y;
  }

  // ---- 1. Ultrasonic energy ------------------------------------------------
  function ultrasonicStats(rawMags, sr, fftSize, thresholdHz = 18000) {
    if (!rawMags || !rawMags.length) return null;
    const nBins = rawMags[0].length;
    const binHz = sr / fftSize;
    const kMin = Math.min(nBins - 1, Math.ceil(thresholdHz / binHz));
    if (kMin >= nBins - 1) {
      return { available: false, reason: 'sample rate too low for ultrasonic analysis' };
    }
    let total = 0, ultra = 0, peakMag = 0, peakK = -1;
    for (let f = 0; f < rawMags.length; f++) {
      const row = rawMags[f];
      for (let k = 0; k < nBins; k++) {
        const e = row[k] * row[k];
        total += e;
        if (k >= kMin) {
          ultra += e;
          if (row[k] > peakMag) { peakMag = row[k]; peakK = k; }
        }
      }
    }
    const fraction = total > 0 ? ultra / total : 0;
    const meanE = ultra / rawMags.length;
    const energyDb = meanE > 0 ? 10 * Math.log10(meanE) : -120;
    const peakDb = peakMag > 0 ? 20 * Math.log10(peakMag) : -120;
    return {
      available: true,
      thresholdHz,
      hasContent: fraction > 1e-4 && peakDb > -90,
      fraction,
      energyDb,
      peakFreq: peakK >= 0 ? peakK * binHz : 0,
      peakDb,
      nyquist: sr / 2,
      significant: fraction > 1e-3 || peakDb > -60
    };
  }

  // ---- 2. Sustained narrow-band tones --------------------------------------
  function detectTones(rawMags, sr, fftSize, hopSize, opts = {}) {
    const dbOverMedian = opts.dbOverMedian != null ? opts.dbOverMedian : 18;
    const minDurationSec = opts.minDurationSec != null ? opts.minDurationSec : 0.8;
    const nFrames = rawMags.length;
    if (nFrames < 4) return [];
    const nBins = rawMags[0].length;
    const binHz = sr / fftSize;
    const hopSec = hopSize / sr;
    const threshRatio = Math.pow(10, dbOverMedian / 20);
    const minFrames = Math.ceil(minDurationSec / hopSec);

    // Per-frame median as rough noise floor.
    const medians = new Float32Array(nFrames);
    const tmp = new Float32Array(nBins);
    for (let f = 0; f < nFrames; f++) {
      const row = rawMags[f];
      for (let k = 0; k < nBins; k++) tmp[k] = row[k];
      tmp.sort();
      medians[f] = tmp[Math.floor(nBins * 0.5)] || 1e-12;
    }

    // For each bin, run-length scan of "active" frames (peak vs neighbours
    // AND > threshold*median).
    const tones = [];
    for (let k = 2; k < nBins - 2; k++) {
      let runStart = -1;
      let runEnergy = 0;
      for (let f = 0; f < nFrames; f++) {
        const row = rawMags[f];
        const active = row[k] > medians[f] * threshRatio &&
          row[k] >= row[k - 1] && row[k] >= row[k + 1];
        if (active) {
          if (runStart < 0) { runStart = f; runEnergy = 0; }
          runEnergy += row[k];
        } else if (runStart >= 0) {
          const runFrames = f - runStart;
          if (runFrames >= minFrames) {
            tones.push({
              freq: k * binHz,
              startT: runStart * hopSec,
              endT: f * hopSec,
              persistenceFrames: runFrames,
              meanDb: 20 * Math.log10(Math.max(1e-12, runEnergy / runFrames))
            });
          }
          runStart = -1;
        }
      }
      if (runStart >= 0) {
        const runFrames = nFrames - runStart;
        if (runFrames >= minFrames) {
          tones.push({
            freq: k * binHz,
            startT: runStart * hopSec,
            endT: nFrames * hopSec,
            persistenceFrames: runFrames,
            meanDb: 20 * Math.log10(Math.max(1e-12, runEnergy / runFrames))
          });
        }
      }
    }
    // Merge tones at adjacent bins that overlap in time.
    tones.sort((a, b) => a.freq - b.freq || a.startT - b.startT);
    const merged = [];
    for (const t of tones) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(t.freq - last.freq) <= 2 * binHz &&
          t.startT < last.endT + 0.5) {
        last.endT = Math.max(last.endT, t.endT);
        last.persistenceFrames = Math.max(last.persistenceFrames, t.persistenceFrames);
        last.meanDb = Math.max(last.meanDb, t.meanDb);
      } else {
        merged.push(Object.assign({}, t));
      }
    }
    // Sort loudest / longest first for display.
    merged.sort((a, b) => (b.endT - b.startT) - (a.endT - a.startT));
    return merged;
  }

  // ---- 3. Broadband vertical bursts ---------------------------------------
  function detectBursts(rawMags, sr, fftSize, hopSize, opts = {}) {
    const sigmaK = opts.sigmaK != null ? opts.sigmaK : 4.0;
    const minFreqHz = opts.minFreqHz != null ? opts.minFreqHz : 400;
    const nFrames = rawMags.length;
    if (nFrames < 10) return [];
    const nBins = rawMags[0].length;
    const binHz = sr / fftSize;
    const hopSec = hopSize / sr;
    const kMin = Math.max(1, Math.floor(minFreqHz / binHz));

    // Broadband magnitude per frame.
    const energy = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      let s = 0;
      const row = rawMags[f];
      for (let k = kMin; k < nBins; k++) s += row[k];
      energy[f] = s;
    }

    // Global mean + sd (simple, avoids edge issues at start/end of track).
    let mean = 0;
    for (let f = 0; f < nFrames; f++) mean += energy[f];
    mean /= nFrames;
    let varS = 0;
    for (let f = 0; f < nFrames; f++) { const d = energy[f] - mean; varS += d * d; }
    const sd = Math.sqrt(varS / nFrames);
    if (sd <= 0) return [];

    const bursts = [];
    for (let f = 0; f < nFrames; f++) {
      const z = (energy[f] - mean) / sd;
      if (z > sigmaK) {
        // Broadband metric: fraction of bins above 30% of row peak.
        const row = rawMags[f];
        let peak = 0;
        for (let k = kMin; k < nBins; k++) if (row[k] > peak) peak = row[k];
        let wideBins = 0;
        if (peak > 0) {
          const cut = peak * 0.3;
          for (let k = kMin; k < nBins; k++) if (row[k] > cut) wideBins++;
        }
        bursts.push({
          t: f * hopSec,
          durationMs: hopSec * 1000,
          bandwidthHz: wideBins * binHz,
          peakDb: peak > 0 ? 20 * Math.log10(peak) : -120,
          zScore: z
        });
      }
    }
    // Merge temporally adjacent (≤ 4 frames apart).
    const gap = 4 * hopSec;
    bursts.sort((a, b) => a.t - b.t);
    const merged = [];
    for (const b of bursts) {
      const last = merged[merged.length - 1];
      if (last && b.t - (last.t + last.durationMs / 1000) <= gap) {
        last.durationMs = Math.round((b.t + b.durationMs / 1000 - last.t) * 1000);
        last.bandwidthHz = Math.max(last.bandwidthHz, b.bandwidthHz);
        last.peakDb = Math.max(last.peakDb, b.peakDb);
        last.zScore = Math.max(last.zScore, b.zScore);
      } else {
        merged.push(Object.assign({}, b));
      }
    }
    return merged;
  }

  // ---- 4. Geometric structure (edge orientation concentration) -------------
  // Returns edge density + orientation entropy. Low entropy ⇒ edges aligned
  // (natural music is mostly horizontal). Out-of-distribution high density
  // + unusual orientations ⇒ possible drawn shape.
  function detectGeometry(packedGrid, nFrames, nBins) {
    if (!packedGrid || nFrames < 4 || nBins < 4) return null;
    let edgeCount = 0;
    const orient = new Uint32Array(8);
    const total = (nFrames - 2) * (nBins - 2);
    const threshold = 90; // on a 0..255 greyscale
    // Track density to localize "hot regions".
    const tileT = Math.max(4, Math.floor(nFrames / 16));
    const tileF = Math.max(4, Math.floor(nBins / 16));
    const nTileT = Math.ceil(nFrames / tileT);
    const nTileF = Math.ceil(nBins / tileF);
    const tileEdges = new Uint32Array(nTileT * nTileF);

    for (let f = 1; f < nFrames - 1; f++) {
      for (let k = 1; k < nBins - 1; k++) {
        const i = f * nBins + k;
        const gx = (
          -packedGrid[(f - 1) * nBins + k - 1] + packedGrid[(f - 1) * nBins + k + 1] +
          -2 * packedGrid[f * nBins + k - 1] + 2 * packedGrid[f * nBins + k + 1] +
          -packedGrid[(f + 1) * nBins + k - 1] + packedGrid[(f + 1) * nBins + k + 1]
        ) / 4;
        const gy = (
          -packedGrid[(f - 1) * nBins + k - 1] - 2 * packedGrid[(f - 1) * nBins + k] - packedGrid[(f - 1) * nBins + k + 1] +
          packedGrid[(f + 1) * nBins + k - 1] + 2 * packedGrid[(f + 1) * nBins + k] + packedGrid[(f + 1) * nBins + k + 1]
        ) / 4;
        const mag = Math.hypot(gx, gy);
        if (mag > threshold) {
          edgeCount++;
          const ang = Math.atan2(gy, gx);
          const idx = ((Math.floor((ang + Math.PI) * 8 / (2 * Math.PI)) % 8) + 8) % 8;
          orient[idx]++;
          const ti = Math.floor(f / tileT);
          const fi = Math.floor(k / tileF);
          tileEdges[ti * nTileF + fi]++;
        }
      }
    }
    const edgeDensity = edgeCount / Math.max(1, total);

    let totalO = 0;
    for (let i = 0; i < 8; i++) totalO += orient[i];
    let entropy = 0;
    for (let i = 0; i < 8; i++) {
      if (orient[i] > 0) { const p = orient[i] / totalO; entropy -= p * Math.log2(p); }
    }

    // Find hot tiles (edge density > 4× global mean).
    const meanTile = totalO > 0 ? totalO / (nTileT * nTileF) : 0;
    const hotSpots = [];
    for (let ti = 0; ti < nTileT; ti++) {
      for (let fi = 0; fi < nTileF; fi++) {
        if (meanTile > 0 && tileEdges[ti * nTileF + fi] > 4 * meanTile) {
          hotSpots.push({
            tileT: ti, tileF: fi, tileSizeT: tileT, tileSizeF: tileF,
            edges: tileEdges[ti * nTileF + fi]
          });
        }
      }
    }
    hotSpots.sort((a, b) => b.edges - a.edges);
    return {
      edgeDensity,
      orientationEntropy: entropy,      // 0 (one direction) .. 3 (uniform)
      orientationBins: Array.from(orient),
      hotSpots: hotSpots.slice(0, 10),
      // "Concentration" is high when edges are clustered in few directions.
      orientationConcentration: totalO > 0 ? (3 - entropy) / 3 : 0
    };
  }

  // ---- 5. LSB steganalysis ------------------------------------------------
  // Westfeld-Pfitzmann pairs-of-values chi-square + LSB lag-1 autocorrelation.
  // A clean 16-bit PCM signal has highly *correlated* LSBs (audio is smooth).
  // LSB steganography replaces them with near-random bits.
  //
  // Accepts an AudioBuffer (the Web Audio decoded format) and samples a chunk
  // so long files stay fast.
  function lsbSteganalysis(buffer, opts = {}) {
    if (!buffer) return { available: false, reason: 'no buffer' };
    const maxSamples = opts.maxSamples != null ? opts.maxSamples : 200000;
    const len = buffer.length;
    const channels = buffer.numberOfChannels;
    const stride = Math.max(1, Math.floor(len / Math.max(1, maxSamples / Math.max(1, channels))));
    const counts = new Uint32Array(65536);
    let lsbCur = -1, lsbPrev = -1;
    let autoN = 0, autoSum = 0, autoSumSq = 0, autoCross = 0;

    for (let ch = 0; ch < channels; ch++) {
      const data = buffer.getChannelData(ch);
      lsbPrev = -1;
      for (let i = 0; i < len; i += stride) {
        let v = Math.round(data[i] * 32768);
        if (v < -32768) v = -32768;
        if (v > 32767) v = 32767;
        counts[v + 32768]++;
        lsbCur = ((v % 2) + 2) % 2;
        if (lsbPrev >= 0) {
          autoN++;
          autoSum += lsbCur + lsbPrev;
          autoSumSq += lsbCur * lsbCur + lsbPrev * lsbPrev;
          autoCross += lsbCur * lsbPrev;
        }
        lsbPrev = lsbCur;
      }
    }

    // PoV chi-square across all adjacent pairs (2i, 2i+1).
    let chi = 0, df = 0;
    for (let i = 0; i < 65536; i += 2) {
      const c0 = counts[i], c1 = counts[i + 1];
      const exp = (c0 + c1) / 2;
      if (exp > 5) {
        chi += ((c0 - exp) * (c0 - exp) + (c1 - exp) * (c1 - exp)) / exp;
        df++;
      }
    }
    if (df < 10) {
      return { available: false, reason: 'too few distinct sample values' };
    }
    const z = (chi - df) / Math.sqrt(2 * df);
    const pValueChi = 0.5 * erfc(-z / Math.sqrt(2));

    // LSB lag-1 Pearson correlation.
    let autoCorr = 0;
    if (autoN > 0) {
      const n = 2 * autoN;
      const mean = autoSum / n;
      const varV = autoSumSq / n - mean * mean;
      autoCorr = varV > 0 ? (autoCross / autoN - mean * mean) / varV : 0;
    }

    // Interpretation:
    //   The Westfeld-Pfitzmann pairs-of-values chi-square is the primary
    //   test. z < -3 means the PoV pairs are *suspiciously* equalized — a
    //   classic LSB-replacement fingerprint. We also report the lag-1 LSB
    //   autocorrelation for reference (real recorded audio usually has
    //   |autocorr| > 0.05 from dither/quantization coupling, while LSB
    //   stego pushes it toward 0), but don't flag on autocorr alone because
    //   pure tonal synthetic signals naturally have near-zero LSB autocorr.
    const suspicious = z < -3;

    return {
      available: true,
      chiSquare: chi,
      df,
      zScore: z,
      pValue: pValueChi,
      lsbAutocorr: autoCorr,
      suspicious,
      verdict: suspicious
        ? 'LSBs equalized — possible LSB steganography (z = ' + z.toFixed(1) + ')'
        : (Math.abs(autoCorr) > 0.05
            ? 'LSBs show natural structure'
            : 'Inconclusive (low-structure signal)')
    };
  }

  // ---- Aggregate score ----------------------------------------------------
  function combineScore(parts) {
    let score = 0;
    const notes = [];
    if (parts.ultrasonic && parts.ultrasonic.significant) {
      score += 0.3;
      notes.push('Significant ultrasonic energy (>' +
        (parts.ultrasonic.thresholdHz / 1000).toFixed(0) + ' kHz)');
    } else if (parts.ultrasonic && parts.ultrasonic.hasContent) {
      score += 0.1;
      notes.push('Minor ultrasonic content');
    }
    const longTones = (parts.tones || []).filter(t => (t.endT - t.startT) >= 1.0);
    if (longTones.length) {
      score += Math.min(0.3, longTones.length * 0.08);
      notes.push(longTones.length + ' sustained tone(s) ≥ 1 s');
    }
    const hotBursts = (parts.bursts || []).filter(b => b.zScore >= 6);
    if (hotBursts.length) {
      score += Math.min(0.2, hotBursts.length * 0.05);
      notes.push(hotBursts.length + ' broadband burst(s) (z ≥ 6σ)');
    }
    if (parts.lsb && parts.lsb.available && parts.lsb.suspicious) {
      score += 0.3;
      notes.push('LSB statistics unnatural (' + parts.lsb.verdict + ')');
    }
    if (parts.geometry && parts.geometry.edgeDensity > 0.18 &&
        parts.geometry.orientationConcentration < 0.2) {
      score += 0.1;
      notes.push('High edge density with diffuse orientations (possible drawn shape)');
    }
    return {
      score: Math.min(1, score),
      suspicious: score >= 0.35,
      notes
    };
  }

  // ---- Public entry point -------------------------------------------------
  function scanTrack(opts) {
    const rawMags = opts.rawMags;
    const buffer = opts.buffer || null;
    const packedGrid = opts.packedGrid || null;
    const nFrames = opts.nFrames || (rawMags ? rawMags.length : 0);
    const nBins = opts.nBins || (rawMags && rawMags[0] ? rawMags[0].length : 0);
    const sr = opts.sampleRate;
    const fftSize = opts.fftSize;
    const hop = opts.hop;
    const thresholdHz = opts.ultrasonicHz || 18000;

    const ultrasonic = rawMags ? ultrasonicStats(rawMags, sr, fftSize, thresholdHz) : null;
    const tones = rawMags ? detectTones(rawMags, sr, fftSize, hop, opts.toneOpts) : [];
    const bursts = rawMags ? detectBursts(rawMags, sr, fftSize, hop, opts.burstOpts) : [];
    const geometry = packedGrid ? detectGeometry(packedGrid, nFrames, nBins) : null;
    const lsb = buffer ? lsbSteganalysis(buffer, opts.lsbOpts) : { available: false };
    const summary = combineScore({ ultrasonic, tones, bursts, geometry, lsb });
    return { summary, ultrasonic, tones, bursts, geometry, lsb };
  }

  global.Anomaly = {
    scanTrack,
    ultrasonicStats,
    detectTones,
    detectBursts,
    detectGeometry,
    lsbSteganalysis,
    combineScore,
    _erfc: erfc
  };
})(typeof self !== 'undefined' ? self : this);
