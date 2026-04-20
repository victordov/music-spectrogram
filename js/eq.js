// Parametric EQ: manages a chain of BiquadFilterNodes for real-time processing
// and computes the combined magnitude response curve for on-screen visualization.
// The coefficient math matches the Audio EQ Cookbook, which is what the Web Audio
// BiquadFilterNode uses internally, so our drawn curve matches what you hear.
(function (global) {
  'use strict';

  const DEFAULTS = () => [
    { type: 'highpass',  freq: 40,    gain: 0,  q: 0.707, enabled: true },
    { type: 'peaking',   freq: 200,   gain: 0,  q: 1.0,   enabled: true },
    { type: 'peaking',   freq: 1000,  gain: 0,  q: 1.0,   enabled: true },
    { type: 'peaking',   freq: 4000,  gain: 0,  q: 1.0,   enabled: true },
    { type: 'highshelf', freq: 10000, gain: 0,  q: 0.707, enabled: true },
  ];

  class ParametricEQ {
    constructor(sampleRate = 44100) {
      this.sampleRate = sampleRate;
      this.bands = DEFAULTS();
      this.bypass = false;
    }

    reset() { this.bands = DEFAULTS(); this.bypass = false; }

    // Set sample rate - recompute coefficient cache.
    setSampleRate(sr) { this.sampleRate = sr; }

    // Cookbook biquad coefficients. Matches Web Audio BiquadFilterNode.
    static coeffs(band, sr) {
      const w0 = 2 * Math.PI * band.freq / sr;
      const cosW = Math.cos(w0), sinW = Math.sin(w0);
      const A = Math.pow(10, band.gain / 40);
      const Q = Math.max(0.0001, band.q);
      const alpha = sinW / (2 * Q);
      let b0, b1, b2, a0, a1, a2;
      switch (band.type) {
        case 'lowpass':
          b0 = (1 - cosW) / 2; b1 = 1 - cosW; b2 = (1 - cosW) / 2;
          a0 = 1 + alpha; a1 = -2 * cosW; a2 = 1 - alpha;
          break;
        case 'highpass':
          b0 = (1 + cosW) / 2; b1 = -(1 + cosW); b2 = (1 + cosW) / 2;
          a0 = 1 + alpha; a1 = -2 * cosW; a2 = 1 - alpha;
          break;
        case 'bandpass':
          b0 = alpha; b1 = 0; b2 = -alpha;
          a0 = 1 + alpha; a1 = -2 * cosW; a2 = 1 - alpha;
          break;
        case 'notch':
          b0 = 1; b1 = -2 * cosW; b2 = 1;
          a0 = 1 + alpha; a1 = -2 * cosW; a2 = 1 - alpha;
          break;
        case 'peaking':
          b0 = 1 + alpha * A; b1 = -2 * cosW; b2 = 1 - alpha * A;
          a0 = 1 + alpha / A; a1 = -2 * cosW; a2 = 1 - alpha / A;
          break;
        case 'lowshelf': {
          const sq = 2 * Math.sqrt(A) * alpha;
          b0 = A * ((A + 1) - (A - 1) * cosW + sq);
          b1 = 2 * A * ((A - 1) - (A + 1) * cosW);
          b2 = A * ((A + 1) - (A - 1) * cosW - sq);
          a0 = (A + 1) + (A - 1) * cosW + sq;
          a1 = -2 * ((A - 1) + (A + 1) * cosW);
          a2 = (A + 1) + (A - 1) * cosW - sq;
        } break;
        case 'highshelf': {
          const sq = 2 * Math.sqrt(A) * alpha;
          b0 = A * ((A + 1) + (A - 1) * cosW + sq);
          b1 = -2 * A * ((A - 1) + (A + 1) * cosW);
          b2 = A * ((A + 1) + (A - 1) * cosW - sq);
          a0 = (A + 1) - (A - 1) * cosW + sq;
          a1 = 2 * ((A - 1) - (A + 1) * cosW);
          a2 = (A + 1) - (A - 1) * cosW - sq;
        } break;
        default:
          b0 = 1; b1 = 0; b2 = 0; a0 = 1; a1 = 0; a2 = 0;
      }
      return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
    }

    // |H(e^jw)| for a normalized biquad (a0=1).
    static biquadMag(c, w) {
      const cosW = Math.cos(w), cos2W = Math.cos(2 * w);
      const sinW = Math.sin(w), sin2W = Math.sin(2 * w);
      const bR = c.b0 + c.b1 * cosW + c.b2 * cos2W;
      const bI = -c.b1 * sinW - c.b2 * sin2W;
      const aR = 1 + c.a1 * cosW + c.a2 * cos2W;
      const aI = -c.a1 * sinW - c.a2 * sin2W;
      return Math.sqrt((bR * bR + bI * bI) / (aR * aR + aI * aI + 1e-30));
    }

    // Combined response magnitude (linear) at given frequencies.
    response(freqs) {
      const out = new Float32Array(freqs.length);
      out.fill(1);
      if (this.bypass) return out;
      for (const b of this.bands) {
        if (!b.enabled) continue;
        const c = ParametricEQ.coeffs(b, this.sampleRate);
        for (let i = 0; i < freqs.length; i++) {
          const w = 2 * Math.PI * freqs[i] / this.sampleRate;
          out[i] *= ParametricEQ.biquadMag(c, w);
        }
      }
      return out;
    }
  }

  // Draw EQ curve on an overlay canvas context, mapping dB to y and freq to x
  // using the provided freq-axis mapping functions.
  function drawEqCurve(ctx, W, H, eq, opts) {
    const { freqToX, minDb = -24, maxDb = 24, color = '#4fd1c5' } = opts;
    const freqs = new Float32Array(W);
    for (let x = 0; x < W; x++) freqs[x] = opts.xToFreq(x);
    const resp = eq.response(freqs);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const db = 20 * Math.log10(Math.max(resp[x], 1e-6));
      const y = H * (1 - (db - minDb) / (maxDb - minDb));
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // Band handles
    for (let i = 0; i < eq.bands.length; i++) {
      const b = eq.bands[i];
      if (!b.enabled) continue;
      const x = freqToX(b.freq);
      const y = H * (1 - (b.gain - minDb) / (maxDb - minDb));
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = '#001818';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(String(i + 1), x - 3, y + 3);
    }
    ctx.restore();
  }

  global.ParametricEQ = ParametricEQ;
  global.drawEqCurve = drawEqCurve;
  global.EQ_DEFAULTS = DEFAULTS;
})(typeof window !== 'undefined' ? window : globalThis);
