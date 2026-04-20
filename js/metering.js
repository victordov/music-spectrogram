// Professional broadcast metering: LUFS (ITU-R BS.1770-4), True-peak (dBTP),
// stereo correlation, Mid/Side energy ratio.
//
// Implements the two-stage K-weighting filter (shelving HPF + RLB HPF), block
// loudness per 400 ms (overlap 75%), absolute gate at −70 LUFS, relative gate
// at −10 LU, and 4× polyphase oversampling for true peak.
//
// All signals accepted are Float32Array channels. LUFS formula uses channel
// weights G_L = G_R = 1.0, G_C = 1.0, G_Ls = G_Rs = 1.41 (surround); for
// mono/stereo we use only L (and R).
//
// References:
//   EBU TECH 3341 (loudness meters)
//   ITU-R BS.1770-4 (algorithm)
//   ITU-R BS.1770-4 Annex 2 (true-peak oversampling)
(function (global) {
  'use strict';

  // Two-pole IIR (Direct Form II Transposed) with state across blocks.
  class Biquad {
    constructor(b0, b1, b2, a1, a2) {
      this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2;
      this.z1 = 0; this.z2 = 0;
    }
    reset() { this.z1 = 0; this.z2 = 0; }
    processSample(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      return y;
    }
    process(inArr, outArr) {
      for (let i = 0; i < inArr.length; i++) outArr[i] = this.processSample(inArr[i]);
      return outArr;
    }
  }

  // ITU-R BS.1770-4 K-weighting coefficients — sample-rate adapted via bilinear
  // transform from the reference 48 kHz coefficients. For speed we hardcode
  // the 48 kHz set and re-derive for other sample rates on demand.
  //
  // Stage 1 — shelving HPF ~1681 Hz, +4 dB boost.
  // Stage 2 — RLB HPF 38 Hz, Q = 0.5.
  function kWeightingCoeffs(sr) {
    // Analog prototype poles/zeros solved to match 48 kHz reference.
    // Here we implement the standard approach from
    // https://github.com/BrechtDeMan/loudness.py — bilinear-transform the
    // analog prototype at `sr`.
    const f0_1 = 1681.974450955533;
    const G_1 = 3.999843853973347;
    const Q_1 = 0.7071752369554196;
    const K_1 = Math.tan((Math.PI * f0_1) / sr);
    const Vh = Math.pow(10, G_1 / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0_1 = 1 + K_1 / Q_1 + K_1 * K_1;
    const b0_1 = (Vh + Vb * K_1 / Q_1 + K_1 * K_1) / a0_1;
    const b1_1 = 2 * (K_1 * K_1 - Vh) / a0_1;
    const b2_1 = (Vh - Vb * K_1 / Q_1 + K_1 * K_1) / a0_1;
    const a1_1 = 2 * (K_1 * K_1 - 1) / a0_1;
    const a2_1 = (1 - K_1 / Q_1 + K_1 * K_1) / a0_1;

    const f0_2 = 38.13547087602444;
    const Q_2 = 0.5003270373253953;
    const K_2 = Math.tan((Math.PI * f0_2) / sr);
    const a0_2 = 1 + K_2 / Q_2 + K_2 * K_2;
    const b0_2 = 1;
    const b1_2 = -2;
    const b2_2 = 1;
    const a1_2 = 2 * (K_2 * K_2 - 1) / a0_2;
    const a2_2 = (1 - K_2 / Q_2 + K_2 * K_2) / a0_2;

    return {
      stage1: { b0: b0_1, b1: b1_1, b2: b2_1, a1: a1_1, a2: a2_1 },
      stage2: { b0: b0_2 / 1, b1: b1_2 / 1, b2: b2_2 / 1, a1: a1_2, a2: a2_2 }
    };
  }

  // Apply the two K-weighting stages to a channel in-place.
  function applyKWeighting(samples, sr) {
    const { stage1, stage2 } = kWeightingCoeffs(sr);
    const bq1 = new Biquad(stage1.b0, stage1.b1, stage1.b2, stage1.a1, stage1.a2);
    const bq2 = new Biquad(stage2.b0, stage2.b1, stage2.b2, stage2.a1, stage2.a2);
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = bq2.processSample(bq1.processSample(samples[i]));
    }
    return out;
  }

  // Mean square of a buffer.
  function meanSquare(buf, start, len) {
    let s = 0;
    const end = Math.min(buf.length, start + len);
    for (let i = start; i < end; i++) s += buf[i] * buf[i];
    return s / Math.max(1, end - start);
  }

  // Compute block-wise loudness (sum of channel mean-squares, in LUFS) for
  // 400 ms blocks with 75 % overlap (hop = 100 ms).
  function blockLoudness(channels, sr) {
    const block = Math.round(0.4 * sr);
    const hop = Math.round(0.1 * sr);
    const nSamples = channels[0].length;
    const nBlocks = Math.max(0, Math.floor((nSamples - block) / hop) + 1);
    const out = new Float32Array(nBlocks);
    for (let b = 0; b < nBlocks; b++) {
      const start = b * hop;
      let sumSq = 0;
      for (const ch of channels) sumSq += meanSquare(ch, start, block);
      // Loudness in LUFS: L = -0.691 + 10 * log10(sum(G_i * ms_i))
      out[b] = -0.691 + 10 * Math.log10(Math.max(sumSq, 1e-20));
    }
    return out;
  }

  // Integrated LUFS: apply absolute gate (−70) then relative gate (−10 below
  // mean of ungated blocks), re-average in linear energy domain.
  function integratedFromBlocks(blocks) {
    // Absolute gate.
    const abs = [];
    for (const l of blocks) if (l > -70) abs.push(l);
    if (!abs.length) return -Infinity;
    // Mean energy of abs-gated blocks.
    let sumE = 0;
    for (const l of abs) sumE += Math.pow(10, (l + 0.691) / 10);
    const absMean = -0.691 + 10 * Math.log10(sumE / abs.length);
    // Relative gate threshold.
    const rel = absMean - 10;
    let sumE2 = 0, count = 0;
    for (const l of abs) {
      if (l > rel) { sumE2 += Math.pow(10, (l + 0.691) / 10); count++; }
    }
    if (!count) return absMean;
    return -0.691 + 10 * Math.log10(sumE2 / count);
  }

  // Loudness Range (LRA) per EBU TECH 3342 simplified: 10..95 percentiles of
  // the relative-gated 3 s window loudness.
  function loudnessRange(channels, sr) {
    // 3 s window, 1 s hop.
    const block = Math.round(3 * sr);
    const hop = Math.round(1 * sr);
    const n = channels[0].length;
    const nBlocks = Math.max(0, Math.floor((n - block) / hop) + 1);
    const loud = [];
    for (let b = 0; b < nBlocks; b++) {
      const start = b * hop;
      let sumSq = 0;
      for (const ch of channels) sumSq += meanSquare(ch, start, block);
      const L = -0.691 + 10 * Math.log10(Math.max(sumSq, 1e-20));
      if (L > -70) loud.push(L);
    }
    if (!loud.length) return 0;
    // Relative gate: mean energy of abs-gated, minus 20 LU.
    let sumE = 0;
    for (const l of loud) sumE += Math.pow(10, (l + 0.691) / 10);
    const mean = -0.691 + 10 * Math.log10(sumE / loud.length);
    const gate = mean - 20;
    const kept = loud.filter(l => l > gate).sort((a, b) => a - b);
    if (kept.length < 2) return 0;
    const p10 = kept[Math.floor(0.10 * (kept.length - 1))];
    const p95 = kept[Math.floor(0.95 * (kept.length - 1))];
    return p95 - p10;
  }

  // 4× polyphase FIR-based oversampling true-peak (ITU-R BS.1770-4 Annex 2).
  // We use a simple 48-tap windowed-sinc at cutoff 0.5 / 4.
  function truePeakDbTP(samples) {
    const L = 4; // upsample factor
    const N = 48; // filter length
    const h = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      const x = n - (N - 1) / 2;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x / L) / (Math.PI * x / L);
      // Hann window
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * n / (N - 1)));
      h[n] = sinc * w / L;
    }
    // Normalize
    let sum = 0;
    for (let i = 0; i < N; i++) sum += h[i];
    for (let i = 0; i < N; i++) h[i] /= sum;
    // Polyphase: evaluate L positions per input sample.
    let peak = 0;
    // Need window of input samples; process linear convolution of upsampled
    // signal by folding through the filter.
    const buf = new Float32Array(N);
    let w = 0;
    for (let i = 0; i < samples.length; i++) {
      buf[w] = samples[i];
      w = (w + 1) % N;
      for (let p = 0; p < L; p++) {
        let acc = 0;
        for (let k = 0; k < N; k++) {
          if ((k % L) !== p) continue;
          const idx = (w - 1 - Math.floor(k / L) + N) % N;
          acc += h[k] * buf[idx];
        }
        const v = Math.abs(acc * L);
        if (v > peak) peak = v;
      }
    }
    // Also consider raw samples.
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    return 20 * Math.log10(Math.max(peak, 1e-12));
  }

  // Sample-peak (non-oversampled) in dBFS.
  function samplePeakDb(samples) {
    let p = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > p) p = v;
    }
    return 20 * Math.log10(Math.max(p, 1e-12));
  }

  // Pearson correlation of L and R signals (−1 .. +1).
  function stereoCorrelation(L, R) {
    const n = Math.min(L.length, R.length);
    if (!n) return 0;
    let sumL = 0, sumR = 0, sumLR = 0, sumL2 = 0, sumR2 = 0;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      sumL += l; sumR += r;
      sumLR += l * r;
      sumL2 += l * l;
      sumR2 += r * r;
    }
    const meanL = sumL / n, meanR = sumR / n;
    const cov = sumLR / n - meanL * meanR;
    const varL = sumL2 / n - meanL * meanL;
    const varR = sumR2 / n - meanR * meanR;
    const denom = Math.sqrt(Math.max(0, varL) * Math.max(0, varR));
    return denom < 1e-12 ? 0 : cov / denom;
  }

  // Mid/Side energy ratio. Returns {midDb, sideDb, widthPct} where widthPct
  // is sideEnergy / (midEnergy + sideEnergy) * 100.
  function midSideEnergy(L, R) {
    let midSq = 0, sideSq = 0;
    const n = Math.min(L.length, R.length);
    for (let i = 0; i < n; i++) {
      const m = (L[i] + R[i]) * 0.5;
      const s = (L[i] - R[i]) * 0.5;
      midSq += m * m;
      sideSq += s * s;
    }
    const mid = Math.sqrt(midSq / Math.max(1, n));
    const side = Math.sqrt(sideSq / Math.max(1, n));
    const widthPct = (midSq + sideSq) > 0 ? (sideSq / (midSq + sideSq)) * 100 : 0;
    return {
      midDb: 20 * Math.log10(Math.max(mid, 1e-12)),
      sideDb: 20 * Math.log10(Math.max(side, 1e-12)),
      widthPct
    };
  }

  // Full analysis (integrated LUFS, momentary, short-term, peaks, LRA, corr,
  // M/S) on a buffer's channels. `channels` is an array of Float32Array.
  // Returns a plain object suitable for display and JSON export.
  function analyzeBuffer(channels, sr) {
    // K-weight each channel.
    const k = channels.map(ch => applyKWeighting(ch, sr));
    // 400 ms blocks.
    const blocks = blockLoudness(k, sr);
    const integrated = integratedFromBlocks(blocks);
    // Peaks.
    let sPeak = -Infinity, tPeak = -Infinity;
    for (const ch of channels) {
      sPeak = Math.max(sPeak, samplePeakDb(ch));
      tPeak = Math.max(tPeak, truePeakDbTP(ch));
    }
    // LRA
    const lra = loudnessRange(k, sr);
    // Correlation + M/S (stereo only; else null).
    let correlation = null, midSide = null;
    if (channels.length >= 2) {
      correlation = stereoCorrelation(channels[0], channels[1]);
      midSide = midSideEnergy(channels[0], channels[1]);
    }
    // Momentary / short-term time series.
    const momentary = blocks; // 400 ms / 75% overlap: that's exactly momentary.
    const stBlockMs = 3000, stHop = 1000;
    const stBlk = Math.round((stBlockMs / 1000) * sr);
    const stHopS = Math.round((stHop / 1000) * sr);
    const nS = Math.max(0, Math.floor((k[0].length - stBlk) / stHopS) + 1);
    const shortTerm = new Float32Array(nS);
    for (let b = 0; b < nS; b++) {
      const start = b * stHopS;
      let sumSq = 0;
      for (const ch of k) sumSq += meanSquare(ch, start, stBlk);
      shortTerm[b] = -0.691 + 10 * Math.log10(Math.max(sumSq, 1e-20));
    }
    // Max over time of momentary / short-term (clamped at -70 LUFS).
    let maxMomentary = -Infinity;
    for (let i = 0; i < momentary.length; i++) {
      if (momentary[i] > maxMomentary) maxMomentary = momentary[i];
    }
    let maxShort = -Infinity;
    for (let i = 0; i < shortTerm.length; i++) {
      if (shortTerm[i] > maxShort) maxShort = shortTerm[i];
    }
    // Noise floor estimate: 10th-percentile short-term (or -∞ if too short).
    let noiseFloorDb = -Infinity;
    if (shortTerm.length >= 4) {
      const sorted = Array.from(shortTerm).sort((a, b) => a - b);
      noiseFloorDb = sorted[Math.floor(sorted.length * 0.10)];
    } else {
      // Fall back: use the quietest block's sample-peak across channels.
      const block = Math.round(0.4 * sr);
      const hop = Math.round(0.1 * sr);
      const nSamples = channels[0].length;
      const nBlocks = Math.max(0, Math.floor((nSamples - block) / hop) + 1);
      let minBlockPk = Infinity;
      for (let b = 0; b < nBlocks; b++) {
        let pk = 0;
        for (const ch of channels) {
          const end = b * hop + block;
          for (let i = b * hop; i < end; i++) {
            const v = Math.abs(ch[i]);
            if (v > pk) pk = v;
          }
        }
        if (pk < minBlockPk) minBlockPk = pk;
      }
      if (minBlockPk > 0 && isFinite(minBlockPk)) {
        noiseFloorDb = 20 * Math.log10(minBlockPk);
      }
    }
    return {
      integratedLufs: integrated,
      momentaryMaxLufs: maxMomentary,
      shortTermMaxLufs: maxShort,
      momentaryLufs: momentary,   // length nBlocks
      shortTermLufs: shortTerm,   // length nS
      samplePeakDb: sPeak,
      truePeakDb: tPeak,
      loudnessRange: lra,
      stereoCorrelation: correlation,
      midSide,
      midSideRatio: midSide ? (midSide.widthPct / Math.max(1e-6, 100 - midSide.widthPct)) : null,
      noiseFloorDb,
      sampleRate: sr,
      blockHopSec: 0.1,
      shortHopSec: 1.0
    };
  }

  // Live real-time running LUFS: maintain K-weighted state + 400 ms buffer.
  // Call .push(L, R) with new samples, read .momentary() / .integrated().
  class RunningLufs {
    constructor(sampleRate) {
      this.sampleRate = sampleRate;
      const c = kWeightingCoeffs(sampleRate);
      this.bqL1 = new Biquad(c.stage1.b0, c.stage1.b1, c.stage1.b2, c.stage1.a1, c.stage1.a2);
      this.bqL2 = new Biquad(c.stage2.b0, c.stage2.b1, c.stage2.b2, c.stage2.a1, c.stage2.a2);
      this.bqR1 = new Biquad(c.stage1.b0, c.stage1.b1, c.stage1.b2, c.stage1.a1, c.stage1.a2);
      this.bqR2 = new Biquad(c.stage2.b0, c.stage2.b1, c.stage2.b2, c.stage2.a1, c.stage2.a2);
      this.blockSize = Math.round(0.4 * sampleRate);
      this.stBlockSize = Math.round(3 * sampleRate);
      this.ringL = new Float32Array(this.stBlockSize);
      this.ringR = new Float32Array(this.stBlockSize);
      this.ringPos = 0;
      this.filled = 0;
      this.blocks = []; // block loudness history (ungated)
      this.peak = 0;
    }
    reset() {
      this.bqL1.reset(); this.bqL2.reset(); this.bqR1.reset(); this.bqR2.reset();
      this.ringL.fill(0); this.ringR.fill(0);
      this.ringPos = 0; this.filled = 0;
      this.blocks = [];
      this.peak = 0;
    }
    push(L, R) {
      // Accept push([L, R]) or push(L, R).
      if (Array.isArray(L) && L.length && L[0] && L[0].length != null) {
        R = L[1] != null ? L[1] : L[0];
        L = L[0];
      }
      const n = L.length;
      for (let i = 0; i < n; i++) {
        const l = this.bqL2.processSample(this.bqL1.processSample(L[i]));
        const r = R ? this.bqR2.processSample(this.bqR1.processSample(R[i])) : l;
        this.ringL[this.ringPos] = l;
        this.ringR[this.ringPos] = r;
        this.ringPos = (this.ringPos + 1) % this.stBlockSize;
        this.filled = Math.min(this.stBlockSize, this.filled + 1);
        // Peak on raw input (not K-weighted).
        const pk = Math.max(Math.abs(L[i]), R ? Math.abs(R[i]) : 0);
        if (pk > this.peak) this.peak = pk;
      }
    }
    _windowMeanSq(size) {
      // Mean-square of the most recent `size` samples in ring buffers.
      size = Math.min(size, this.filled);
      if (size <= 0) return 0;
      let sum = 0;
      let idx = (this.ringPos - size + this.stBlockSize) % this.stBlockSize;
      for (let i = 0; i < size; i++) {
        const l = this.ringL[idx], r = this.ringR[idx];
        sum += l * l + r * r;
        idx = (idx + 1) % this.stBlockSize;
      }
      return sum / size;
    }
    momentary() {
      const ms = this._windowMeanSq(this.blockSize);
      return ms <= 0 ? -Infinity : -0.691 + 10 * Math.log10(ms);
    }
    shortTerm() {
      const ms = this._windowMeanSq(this.stBlockSize);
      return ms <= 0 ? -Infinity : -0.691 + 10 * Math.log10(ms);
    }
    peakDb() {
      return 20 * Math.log10(Math.max(this.peak, 1e-12));
    }
  }

  global.Metering = {
    // Offline analysis.
    analyzeBuffer,
    applyKWeighting,
    blockLoudness,
    integratedFromBlocks,
    loudnessRange,
    truePeakDbTP,
    samplePeakDb,
    stereoCorrelation,
    midSideEnergy,
    // Realtime helper.
    RunningLufs,
    // Internal plumbing (exposed for tests).
    _kWeightingCoeffs: kWeightingCoeffs,
    _Biquad: Biquad
  };
})(typeof window !== 'undefined' ? window : globalThis);
