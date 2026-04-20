// Key + BPM detection (Phase 1, Pro).
//
// Key detection: Krumhansl-Schmuckler profile correlation against a global
// 12-bin chroma vector summed over time. 24 candidates (12 major + 12 minor),
// winner = argmax Pearson correlation. Confidence = best / second-best.
//
// BPM detection: onset-detection function (half-wave-rectified spectral flux)
// with simple autocorrelation peak picking in the 60-200 BPM band, followed by
// octave correction (prefer tempi in 70-150). Confidence = peak / mean.
//
// Both operate on the precomputed STFT magnitudes produced by the analyzer,
// so nothing extra is computed per playback frame.
(function (global) {
  'use strict';

  // Krumhansl-Kessler key profiles (normalized so the mean is 1).
  const KK_MAJOR = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09,
    2.52, 5.19, 2.39, 3.66, 2.29, 2.88
  ];
  const KK_MINOR = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53,
    2.54, 4.75, 3.98, 2.69, 3.34, 3.17
  ];
  const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // -- Key detection ---------------------------------------------------------

  function globalChroma(trackMags, sampleRate) {
    // trackMags: Float32Array[] frames, each length fftSize/2
    // Returns a 12-element normalized chroma vector summed over all frames.
    if (!trackMags || !trackMags.length) return new Float32Array(12);
    const nBins = trackMags[0].length;
    const fftSize = nBins * 2;
    const chromaW = global.Analyzer.buildChromaWeights(fftSize, sampleRate);
    const acc = new Float32Array(12);
    for (let f = 0; f < trackMags.length; f++) {
      const c = global.Analyzer.applyChroma(trackMags[f], chromaW);
      for (let p = 0; p < 12; p++) acc[p] += c[p];
    }
    let m = 0; for (let i = 0; i < 12; i++) m = Math.max(m, acc[i]);
    if (m > 0) for (let i = 0; i < 12; i++) acc[i] /= m;
    return acc;
  }

  function pearson(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma;
      const y = b[i] - mb;
      num += x * y;
      da += x * x;
      db += y * y;
    }
    const den = Math.sqrt(da * db);
    return den > 0 ? num / den : 0;
  }

  function rotate(vec, k) {
    const n = vec.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = vec[(i - k + n) % n];
    return out;
  }

  function detectKey(chromaOrTrackMags, sampleRate) {
    // Accept either a 12-vector (already summed) or a trackMags array.
    let chroma;
    if (chromaOrTrackMags && chromaOrTrackMags.length === 12 &&
        typeof chromaOrTrackMags[0] === 'number') {
      chroma = chromaOrTrackMags;
    } else {
      chroma = globalChroma(chromaOrTrackMags, sampleRate);
    }
    // Sanity: if the chroma vector is ~empty, don't return a bogus key.
    let energy = 0; for (let i = 0; i < 12; i++) energy += chroma[i];
    if (energy < 1e-6) {
      return { key: null, mode: null, label: 'Unclear', confidence: 0, scores: [] };
    }
    const scores = [];
    for (let pc = 0; pc < 12; pc++) {
      scores.push({
        tonic: pc, mode: 'major',
        r: pearson(chroma, rotate(KK_MAJOR, pc))
      });
      scores.push({
        tonic: pc, mode: 'minor',
        r: pearson(chroma, rotate(KK_MINOR, pc))
      });
    }
    scores.sort((a, b) => b.r - a.r);
    const best = scores[0];
    const second = scores[1];
    // Confidence: how much the winner beats runner-up (both bounded to [-1,1]).
    // Map (best - second) ∈ [0, 2] into [0, 1] with a gentle stretch.
    const gap = Math.max(0, best.r - second.r);
    const confidence = Math.min(1, gap * 3 + Math.max(0, best.r - 0.4) * 0.5);
    const modeLabel = best.mode === 'major' ? 'maj' : 'min';
    const label = confidence < 0.35
      ? 'Unclear'
      : `${PITCH_CLASSES[best.tonic]} ${modeLabel}`;
    return {
      key: PITCH_CLASSES[best.tonic],
      mode: best.mode,
      label,
      confidence,
      scores
    };
  }

  // -- BPM detection ---------------------------------------------------------

  // Onset-detection function from half-wave-rectified spectral flux.
  function onsetEnvelope(trackMags) {
    const nFrames = trackMags.length;
    if (nFrames < 2) return new Float32Array(nFrames);
    const nBins = trackMags[0].length;
    const env = new Float32Array(nFrames);
    for (let f = 1; f < nFrames; f++) {
      const cur = trackMags[f];
      const prev = trackMags[f - 1];
      let flux = 0;
      for (let k = 1; k < nBins; k++) {
        const d = cur[k] - prev[k];
        if (d > 0) flux += d;
      }
      env[f] = flux;
    }
    // Normalize (robust): subtract local mean, divide by std.
    let mean = 0;
    for (let i = 0; i < env.length; i++) mean += env[i];
    mean /= env.length;
    let variance = 0;
    for (let i = 0; i < env.length; i++) {
      const d = env[i] - mean;
      variance += d * d;
    }
    const std = Math.sqrt(variance / env.length) || 1;
    for (let i = 0; i < env.length; i++) env[i] = Math.max(0, (env[i] - mean) / std);
    return env;
  }

  // Autocorrelation of env up to maxLag.
  function autocorr(env, maxLag) {
    const n = env.length;
    const out = new Float32Array(maxLag + 1);
    for (let lag = 0; lag <= maxLag; lag++) {
      let s = 0;
      const upper = n - lag;
      for (let i = 0; i < upper; i++) s += env[i] * env[i + lag];
      out[lag] = s;
    }
    return out;
  }

  function detectBPM(trackMags, sampleRate, hopSize) {
    if (!trackMags || trackMags.length < 4) {
      return { bpm: null, label: 'Variable', confidence: 0, envelope: null };
    }
    const env = onsetEnvelope(trackMags);
    // Frames per second.
    const fps = sampleRate / hopSize;
    // Search range: 40-240 BPM in autocorrelation lag space.
    const bpmLo = 40, bpmHi = 240;
    const lagMin = Math.max(1, Math.floor(60 * fps / bpmHi));
    const lagMax = Math.min(env.length - 2, Math.ceil(60 * fps / bpmLo));
    if (lagMax <= lagMin + 1) {
      return { bpm: null, label: 'Variable', confidence: 0, envelope: env };
    }
    const ac = autocorr(env, lagMax);
    // Find peak in [lagMin, lagMax].
    let bestLag = lagMin;
    let bestVal = -Infinity;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      if (ac[lag] > bestVal) {
        bestVal = ac[lag];
        bestLag = lag;
      }
    }
    // Octave correction: consider half / double tempi and prefer 70-150.
    const candidates = [bestLag, bestLag * 2, Math.round(bestLag / 2)].filter(
      (l) => l >= 1 && l <= env.length - 2
    );
    const scored = candidates.map((l) => {
      const bpm = 60 * fps / l;
      // Preference kernel: gaussian around 100 BPM.
      const pref = Math.exp(-Math.pow((bpm - 100) / 45, 2));
      // Autocorr strength (handle half-lag by summing first valid bin).
      const strength = l < ac.length ? ac[l] : ac[bestLag] * 0.5;
      return { lag: l, bpm, score: strength * pref };
    });
    scored.sort((a, b) => b.score - a.score);
    const chosen = scored[0];
    // Confidence: peak vs. mean of autocorr band.
    let acMean = 0, acCount = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      acMean += ac[lag];
      acCount++;
    }
    acMean = acCount > 0 ? acMean / acCount : 1;
    const peakRatio = acMean > 0 ? bestVal / acMean : 0;
    // Normalise peakRatio roughly: very rhythmic music ~3-6x mean, speech ~1.5x.
    const confidence = Math.min(1, Math.max(0, (peakRatio - 1.3) / 3));
    const bpmRounded = Math.round(chosen.bpm * 10) / 10;
    const label = confidence < 0.35 ? 'Variable' : `${bpmRounded} BPM`;
    return {
      bpm: bpmRounded,
      label,
      confidence,
      envelope: env,
      candidates: scored
    };
  }

  // -- Combined helper -------------------------------------------------------

  function analyzeTrack(trackMags, sampleRate, hopSize) {
    const chroma = globalChroma(trackMags, sampleRate);
    const key = detectKey(chroma, sampleRate);
    const tempo = detectBPM(trackMags, sampleRate, hopSize);
    return { chroma, key, tempo };
  }

  global.KeyTempo = {
    detectKey,
    detectBPM,
    analyzeTrack,
    globalChroma,
    onsetEnvelope,
    KK_MAJOR,
    KK_MINOR,
    PITCH_CLASSES,
    _pearson: pearson
  };
})(typeof window !== 'undefined' ? window : globalThis);
