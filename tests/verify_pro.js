// Verify Phase-1 Pro modules: metering, key-tempo, restoration, compliance.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = '/sessions/laughing-magical-bell/mnt/music-spectrogram-claude/js';

const ctx = {
  console, Math, Float32Array, Float64Array, Uint8Array, Int32Array, Array,
  Object, Number, String, Boolean, Error, Map, Set, Date, JSON,
  performance: { now: () => Date.now() }
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);

const files = [
  'fft.js', 'analyzer.js',
  'metering.js', 'key-tempo.js', 'restoration.js', 'compliance.js',
  'anomaly.js'
];
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  vm.runInContext(src, ctx, { filename: f });
}
const { Metering, KeyTempo, Restoration, Compliance, Analyzer, Anomaly } = ctx;

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2714 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u2716 ${name}: ${e.message}`);
    failed++;
  }
}
function approx(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg || ''} expected ${b}±${tol}, got ${a}`);
}

// -- Signal helpers --------------------------------------------------------
function makeSine(freq, sr, seconds, amp = 1) {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * i / sr);
  return out;
}
function makeNoise(n, amp = 0.1, seed = 1) {
  // Deterministic LCG.
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = amp * ((s / 4294967296) * 2 - 1);
  }
  return out;
}
function addSignals(...arrs) {
  const n = Math.min(...arrs.map((a) => a.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const a of arrs) v += a[i];
    out[i] = v;
  }
  return out;
}

// ==========================================================================
// 1. METERING
// ==========================================================================
console.log('\n== METERING ==');

test('K-weighting: a 1 kHz sine passes near unity gain', () => {
  const sr = 48000;
  const sig = makeSine(1000, sr, 1, 0.5);
  const out = Metering.applyKWeighting(sig.slice(), sr);
  let eIn = 0, eOut = 0;
  for (let i = 0; i < sig.length; i++) { eIn += sig[i] * sig[i]; eOut += out[i] * out[i]; }
  const rmsIn = Math.sqrt(eIn / sig.length);
  const rmsOut = Math.sqrt(eOut / sig.length);
  const gainDb = 20 * Math.log10(rmsOut / rmsIn);
  // K-weighting is near flat at 1 kHz (within ~1 dB once filter settles).
  approx(gainDb, 0, 1.5, '1 kHz K-weighted gain');
});

test('K-weighting: 30 Hz is attenuated (below RLB HPF)', () => {
  const sr = 48000;
  const sig = makeSine(30, sr, 1, 0.5);
  const out = Metering.applyKWeighting(sig.slice(), sr);
  let eIn = 0, eOut = 0;
  for (let i = 1000; i < sig.length; i++) { // skip transient
    eIn += sig[i] * sig[i]; eOut += out[i] * out[i];
  }
  const gainDb = 20 * Math.log10(Math.sqrt(eOut / eIn));
  // 30 Hz is close to the 38 Hz RLB cutoff (2nd-order Q=0.5) → ~-5 to -10 dB.
  if (gainDb > -3) throw new Error(`30 Hz not attenuated enough: ${gainDb.toFixed(2)} dB`);
});

test('Integrated LUFS: −20 dBFS sine at 1 kHz (mono) ≈ −20 LUFS', () => {
  const sr = 48000;
  // peak for -20 dBFS RMS is sqrt(2) * 0.1
  const amp = Math.SQRT2 * Math.pow(10, -20 / 20);
  const ch = makeSine(1000, sr, 3, amp);
  const rep = Metering.analyzeBuffer([ch], sr);
  // 1 kHz K-weighting is near unity; mono ms = 0.01, L = -0.691 + -20 = -20.7
  approx(rep.integratedLufs, -20.7, 1.5, 'integrated LUFS mono');
});

test('Integrated LUFS: stereo is ~3 LU louder than the same channel mono', () => {
  const sr = 48000;
  const amp = Math.SQRT2 * Math.pow(10, -20 / 20);
  const ch = makeSine(1000, sr, 3, amp);
  const mono = Metering.analyzeBuffer([ch], sr).integratedLufs;
  const stereo = Metering.analyzeBuffer([ch, ch], sr).integratedLufs;
  approx(stereo - mono, 3.01, 0.3, 'stereo vs mono');
});

test('True peak: catches inter-sample peaks above sample peak', () => {
  const sr = 48000;
  // A sine that aliases to produce a peak between samples.
  const sig = makeSine(15000, sr, 1, 0.95);
  const rep = Metering.analyzeBuffer([sig], sr);
  if (rep.truePeakDb < rep.samplePeakDb - 0.1) {
    throw new Error(`truePeak(${rep.truePeakDb}) < samplePeak(${rep.samplePeakDb})`);
  }
});

test('Stereo correlation: identical L/R → +1', () => {
  const sr = 48000;
  const sig = makeSine(440, sr, 1);
  const rep = Metering.analyzeBuffer([sig, sig], sr);
  approx(rep.stereoCorrelation, 1.0, 0.02, 'correlation identical');
});

test('Stereo correlation: anti-phase L/R → −1', () => {
  const sr = 48000;
  const sig = makeSine(440, sr, 1);
  const anti = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) anti[i] = -sig[i];
  const rep = Metering.analyzeBuffer([sig, anti], sr);
  approx(rep.stereoCorrelation, -1.0, 0.02, 'correlation anti-phase');
});

test('Running LUFS: momentary and short-term return finite values', () => {
  const sr = 48000;
  const rl = new Metering.RunningLufs(sr);
  const amp = Math.pow(10, -20 / 20) * Math.SQRT2;
  for (let b = 0; b < 40; b++) {
    const L = makeSine(1000, sr, 0.1, amp);
    const R = makeSine(1000, sr, 0.1, amp);
    rl.push(L, R);
  }
  const m = rl.momentary();
  const s = rl.shortTerm();
  if (!isFinite(m) || m > 0) throw new Error(`bad momentary: ${m}`);
  if (!isFinite(s) || s > 0) throw new Error(`bad short-term: ${s}`);
});

// ==========================================================================
// 2. KEY + BPM
// ==========================================================================
console.log('\n== KEY + BPM ==');

// Build a Float32Array[] of magnitudes (what key-tempo/restoration need).
function buildMags(sig, sr, fftSize, hop) {
  const r = Analyzer.computeSpectrogram(sig, sr, {
    fftSize, hop, windowName: 'hann', packed: false
  });
  return { frames: r.grid, nBins: r.nBins, nFrames: r.nFrames, hop };
}

// Synthesize a C-major chord (C4 E4 G4) and detect key.
test('detectKey: C major chord detected as C maj', () => {
  const sr = 22050;
  const t = 4; // seconds
  const C4 = makeSine(261.63, sr, t, 0.4);
  const E4 = makeSine(329.63, sr, t, 0.4);
  const G4 = makeSine(392.0,  sr, t, 0.4);
  const sig = addSignals(C4, E4, G4);
  const stft = buildMags(sig, sr, 2048, 512);
  const res = KeyTempo.detectKey(stft.frames, sr);
  console.log('    → detected:', res.label, 'confidence:', res.confidence.toFixed(2));
  if (res.key !== 'C' || res.mode !== 'major') {
    throw new Error(`expected C major, got ${res.label}`);
  }
});

test('detectKey: A minor chord detected as A min', () => {
  const sr = 22050;
  const t = 4;
  const A4 = makeSine(440.0, sr, t, 0.4);
  const C5 = makeSine(523.25, sr, t, 0.4);
  const E5 = makeSine(659.25, sr, t, 0.4);
  const sig = addSignals(A4, C5, E5);
  const stft = buildMags(sig, sr, 2048, 512);
  const res = KeyTempo.detectKey(stft.frames, sr);
  console.log('    → detected:', res.label, 'confidence:', res.confidence.toFixed(2));
  if (res.key !== 'A' || res.mode !== 'minor') {
    throw new Error(`expected A minor, got ${res.label}`);
  }
});

test('detectKey: silence → Unclear', () => {
  const sr = 22050;
  const sig = new Float32Array(sr * 2);
  const stft = buildMags(sig, sr, 2048, 512);
  const res = KeyTempo.detectKey(stft.frames, sr);
  if (res.label !== 'Unclear') {
    throw new Error(`expected Unclear, got ${res.label} (conf ${res.confidence})`);
  }
});

test('detectBPM: 120 BPM click train → ~120 BPM', () => {
  const sr = 22050;
  const seconds = 10;
  const bpm = 120;
  const periodSamples = Math.floor(sr * 60 / bpm);
  const sig = new Float32Array(sr * seconds);
  for (let i = 0; i < sig.length; i += periodSamples) {
    // Click: 10-sample burst of white noise
    for (let j = 0; j < 10 && i + j < sig.length; j++) sig[i + j] = 0.5 * Math.sin(j * 2);
  }
  // Add a low-amp sine so the spectrum isn't empty.
  const carrier = makeSine(440, sr, seconds, 0.05);
  for (let i = 0; i < sig.length; i++) sig[i] += carrier[i];
  const stft = buildMags(sig, sr, 1024, 256);
  const res = KeyTempo.detectBPM(stft.frames, sr, stft.hop);
  console.log('    → detected:', res.label, 'confidence:', res.confidence.toFixed(2));
  if (res.bpm == null || Math.abs(res.bpm - 120) > 5) {
    throw new Error(`expected ~120 BPM, got ${res.bpm}`);
  }
});

test('detectBPM: silence → Variable', () => {
  const sr = 22050;
  const sig = new Float32Array(sr * 4);
  const stft = buildMags(sig, sr, 1024, 256);
  const res = KeyTempo.detectBPM(stft.frames, sr, stft.hop);
  if (res.bpm != null && res.confidence >= 0.35) {
    throw new Error(`expected Variable, got ${res.label}`);
  }
});

// ==========================================================================
// 3. RESTORATION
// ==========================================================================
console.log('\n== RESTORATION ==');

test('buildHumMask: notches 60 Hz harmonics when 60 Hz dominates', () => {
  const sr = 22050;
  const t = 2;
  const hum = makeSine(60, sr, t, 0.3);
  const h2  = makeSine(120, sr, t, 0.15);
  const music = makeSine(1000, sr, t, 0.2);
  const sig = addSignals(hum, h2, music);
  const stft = buildMags(sig, sr, 4096, 1024);
  const mask = Restoration.buildHumMask(stft.frames, sr, { harmonics: 5 });
  const nBins = stft.nBins + 1;
  // hzToBin: 60 Hz bin
  const bin60 = Math.round((60 / (sr / 2)) * (nBins - 1));
  const bin1k = Math.round((1000 / (sr / 2)) * (nBins - 1));
  const centerFrame = Math.floor(stft.frames.length / 2);
  const g60 = mask.data[centerFrame * nBins + bin60];
  const g1k = mask.data[centerFrame * nBins + bin1k];
  console.log(`    → gain@60=${g60.toFixed(2)}  gain@1k=${g1k.toFixed(2)}  (${mask.description})`);
  if (g60 >= 0.99) throw new Error(`60 Hz not attenuated: gain=${g60}`);
  if (g1k < 0.99) throw new Error(`1 kHz affected: gain=${g1k}`);
  if (!mask.description.includes('60')) throw new Error(`expected 60 Hz detection in "${mask.description}"`);
});

test('buildRumbleMask: attenuates below cutoff, passes above', () => {
  const sr = 22050;
  const t = 1;
  const sig = makeSine(40, sr, t, 0.3);
  const stft = buildMags(sig, sr, 4096, 1024);
  const mask = Restoration.buildRumbleMask(stft.frames, sr, { cutoffHz: 80, widthHz: 20 });
  const nBins = stft.nBins + 1;
  const bin40 = Math.round((40 / (sr / 2)) * (nBins - 1));
  const bin500 = Math.round((500 / (sr / 2)) * (nBins - 1));
  const g40 = mask.data[0 * nBins + bin40];
  const g500 = mask.data[0 * nBins + bin500];
  if (g40 > 0.25) throw new Error(`40 Hz not attenuated: ${g40}`);
  if (g500 < 0.99) throw new Error(`500 Hz affected: ${g500}`);
});

test('buildHissMask: creates valid mask without error', () => {
  const sr = 22050;
  const noise = makeNoise(sr * 2, 0.05);
  const stft = buildMags(noise, sr, 2048, 512);
  const mask = Restoration.buildHissMask(stft.frames, sr, { minHz: 3000 });
  // Mask should have values in [floor, 1].
  let mn = 1, mx = 0;
  for (let i = 0; i < mask.data.length; i++) {
    const v = mask.data[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (mn < 0.14 || mn > 1) throw new Error(`floor: ${mn}`);
  if (mx > 1.01) throw new Error(`max > 1: ${mx}`);
});

test('buildDeessMask: mask shape is valid', () => {
  const sr = 22050;
  const hiss = makeNoise(sr * 2, 0.2);
  const stft = buildMags(hiss, sr, 2048, 512);
  const mask = Restoration.buildDeessMask(stft.frames, sr);
  if (mask.data.length !== stft.frames.length * (stft.nBins + 1)) {
    throw new Error('wrong shape');
  }
});

test('buildDeclickMask: detects broadband spike frame', () => {
  const sr = 22050;
  const t = 2;
  const sig = makeSine(440, sr, t, 0.1);
  // Inject a click at 1 second: broadband spike.
  const clickIdx = sr;
  for (let j = 0; j < 20; j++) sig[clickIdx + j] = (j % 2 === 0 ? 1 : -1) * 0.8;
  const stft = buildMags(sig, sr, 1024, 256);
  const mask = Restoration.buildDeclickMask(stft.frames, sr);
  // Find any attenuated bin anywhere — presence proves detection fired.
  let anyAttenuated = false;
  for (let i = 0; i < mask.data.length && !anyAttenuated; i++) {
    if (mask.data[i] < 0.99) anyAttenuated = true;
  }
  if (!anyAttenuated) throw new Error('declick did not attenuate any frames');
});

test('mergeMaskInto: multiplies gains and merges smooth', () => {
  const nFrames = 4, nBins = 5;
  const a = { data: new Float32Array(nFrames * nBins).fill(0.5), smooth: new Float32Array(nFrames * nBins) };
  const b = { data: new Float32Array(nFrames * nBins).fill(0.4), smooth: new Float32Array(nFrames * nBins) };
  b.smooth[0] = 1;
  Restoration.mergeMaskInto(a, b);
  approx(a.data[0], 0.2, 1e-6, 'merge product');
  approx(a.smooth[0], 1, 1e-6, 'merge smooth');
});

// ==========================================================================
// 4. COMPLIANCE
// ==========================================================================
console.log('\n== COMPLIANCE ==');

test('listTargets: returns known targets', () => {
  const ts = Compliance.listTargets();
  const ids = ts.map((t) => t.id);
  if (!ids.includes('spotify')) throw new Error('missing spotify');
  if (!ids.includes('ebu_r128')) throw new Error('missing ebu_r128');
});

test('evaluateTarget: Spotify passes at -14 LUFS, -1.5 dBTP', () => {
  const report = { integratedLufs: -14, truePeakDb: -1.5, samplePeakDb: -2 };
  const res = Compliance.evaluateTarget('spotify', report);
  if (!res.pass) throw new Error(`expected PASS, got ${JSON.stringify(res.checks)}`);
});

test('evaluateTarget: Spotify fails at -8 LUFS, 0 dBTP', () => {
  const report = { integratedLufs: -8, truePeakDb: 0, samplePeakDb: 0 };
  const res = Compliance.evaluateTarget('spotify', report);
  if (res.pass) throw new Error('expected FAIL');
  if (res.checks.every((c) => c.pass)) throw new Error('no checks failed');
});

test('evaluateAll: returns result for every target', () => {
  const report = { integratedLufs: -14, truePeakDb: -1, samplePeakDb: -2, loudnessRange: 6 };
  const all = Compliance.evaluateAll(report);
  if (all.length !== Object.keys(Compliance.TARGETS).length) {
    throw new Error('count mismatch');
  }
});

test('renderHtml: returns well-formed HTML containing target labels', () => {
  const report = {
    integratedLufs: -14, truePeakDb: -1, samplePeakDb: -2,
    loudnessRange: 6, stereoCorrelation: 0.8, midSideRatio: 1.2,
    momentaryMaxLufs: -10, shortTermMaxLufs: -12, noiseFloorDb: -65
  };
  const evl = Compliance.evaluateAll(report);
  const html = Compliance.renderHtml('Test Report', report, evl, { filename: 'test.wav' });
  if (!/<!doctype html>/i.test(html)) throw new Error('missing doctype');
  if (!/Spotify/.test(html)) throw new Error('missing Spotify label');
  if (!/-14\.0 LUFS/.test(html)) throw new Error('missing measurement');
});

// ==========================================================================
// 5. ANOMALY
// ==========================================================================
console.log('\n== ANOMALY ==');

// Fake AudioBuffer shim for LSB tests (matches the Web Audio API surface that
// anomaly.js actually touches).
function makeBuffer(channels, sampleRate) {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0].length,
    getChannelData(i) { return channels[i]; }
  };
}

test('ultrasonicStats: detects a 22 kHz tone in a 48 kHz signal', () => {
  const sr = 48000;
  const sig = addSignals(
    makeSine(440, sr, 2, 0.2),
    makeSine(22000, sr, 2, 0.2)
  );
  const stft = buildMags(sig, sr, 4096, 1024);
  const u = Anomaly.ultrasonicStats(stft.frames, sr, 4096, 18000);
  if (!u.hasContent) throw new Error('ultrasonic content not detected');
  if (u.peakFreq < 20000 || u.peakFreq > 24000) {
    throw new Error('wrong peak freq: ' + u.peakFreq);
  }
  if (u.fraction < 0.01) throw new Error('fraction too small: ' + u.fraction);
});

test('ultrasonicStats: clean audible-only track has no ultrasonic flag', () => {
  const sr = 48000;
  const sig = makeSine(440, sr, 2, 0.3);
  const stft = buildMags(sig, sr, 4096, 1024);
  const u = Anomaly.ultrasonicStats(stft.frames, sr, 4096, 18000);
  if (u.significant) throw new Error('false positive on clean audible track');
});

test('detectTones: finds a 2 s pilot tone at 3 kHz', () => {
  const sr = 22050;
  const pilot = makeSine(3000, sr, 2, 0.4);
  const noise = makeNoise(sr * 2, 0.01);
  const sig = addSignals(pilot, noise);
  const stft = buildMags(sig, sr, 2048, 512);
  const tones = Anomaly.detectTones(stft.frames, sr, 2048, 512, { minDurationSec: 1.0 });
  const matches = tones.filter((t) => Math.abs(t.freq - 3000) < 40);
  if (!matches.length) throw new Error('no tone found near 3 kHz');
  if ((matches[0].endT - matches[0].startT) < 1.5) {
    throw new Error('tone duration too short: ' + (matches[0].endT - matches[0].startT));
  }
});

test('detectBursts: finds an impulsive click in otherwise clean audio', () => {
  const sr = 22050;
  const sig = makeSine(440, sr, 3, 0.15);
  // Inject a very short broadband burst at 1.5 s.
  const idx = Math.floor(1.5 * sr);
  for (let j = 0; j < 50; j++) sig[idx + j] = (j % 2 === 0 ? 0.9 : -0.9);
  const stft = buildMags(sig, sr, 1024, 256);
  const bursts = Anomaly.detectBursts(stft.frames, sr, 1024, 256, { sigmaK: 3 });
  if (!bursts.length) throw new Error('no bursts detected');
  const hit = bursts.find((b) => Math.abs(b.t - 1.5) < 0.2);
  if (!hit) throw new Error('burst not near 1.5 s: ' + JSON.stringify(bursts.map((b) => b.t)));
});

test('detectGeometry: returns sane edge density + entropy for a speckle grid', () => {
  const nF = 32, nB = 32;
  const grid = new Uint8Array(nF * nB);
  // Pure random speckle (natural-like).
  let s = 42;
  for (let i = 0; i < grid.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    grid[i] = (s >>> 24) & 0xff;
  }
  const g = Anomaly.detectGeometry(grid, nF, nB);
  if (!(g.orientationEntropy >= 2.5 && g.orientationEntropy <= 3.0)) {
    throw new Error('random grid entropy should be near-uniform, got ' + g.orientationEntropy);
  }
});

// A music-like signal: harmonic stack + envelope + small dither noise.
// Realistic dithered audio has LSBs that look nearly random to the chi-square
// test (z ≈ 0, not flagged). This is the "clean" baseline.
function makeMusicLike(sr, seconds, seed = 42) {
  const n = Math.floor(sr * seconds);
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    const env = 0.15 + 0.1 * Math.sin(2 * Math.PI * 0.7 * i / sr);
    const f1 = 0.55 * Math.sin(2 * Math.PI * 220 * i / sr);
    const f2 = 0.30 * Math.sin(2 * Math.PI * 440 * i / sr + 0.4);
    const f3 = 0.15 * Math.sin(2 * Math.PI * 880 * i / sr + 1.1);
    s = (s * 1664525 + 1013904223) >>> 0;
    const noise = (((s >>> 16) & 0xffff) / 65536 * 2 - 1) * 0.015;
    out[i] = env * (f1 + f2 + f3) + noise;
  }
  return out;
}

// Pathological stego signal: directly construct a buffer whose int16 value
// histogram has PoV pairs (2k, 2k+1) with counts forced to be exactly equal.
// This simulates the "ideal" Westfeld-Pfitzmann signature — the chi-square
// pair test can't tell the observed distribution apart from H0 (random LSBs),
// and in fact the observed chi is *much* lower than df, which is exactly
// what a stego embedder producing perfectly-balanced LSBs looks like.
// A realistic probabilistic LSB embedder (encrypted message) produces chi ≈
// df — too close to call — which is why the PoV test is inherently a
// probabilistic signal and not a hard flag. This test verifies the detector
// fires when the signature IS statistically clear.
function makeBalancedLsbBuffer(pairCount = 2500, samplesPerPair = 40) {
  const n = pairCount * samplesPerPair;
  const out = new Float32Array(n);
  let idx = 0;
  const half = Math.floor(pairCount / 2);
  for (let k = -half; k < pairCount - half; k++) {
    const even = 2 * k;
    const odd = 2 * k + 1;
    for (let j = 0; j < samplesPerPair / 2; j++) {
      out[idx++] = even / 32768;
      out[idx++] = odd / 32768;
    }
  }
  return out;
}

test('lsbSteganalysis: natural music-like audio is not flagged', () => {
  const sr = 44100;
  const sig = makeMusicLike(sr, 2);
  const rep = Anomaly.lsbSteganalysis(makeBuffer([sig], sr));
  if (!rep.available) throw new Error('LSB stats unavailable: ' + rep.reason);
  if (rep.suspicious) {
    throw new Error('natural audio falsely flagged: z=' + rep.zScore +
      ' ac=' + rep.lsbAutocorr);
  }
  if (!isFinite(rep.chiSquare) || !isFinite(rep.zScore)) {
    throw new Error('non-finite statistics');
  }
});

test('lsbSteganalysis: perfectly balanced PoV pairs trigger the suspicious flag', () => {
  const sr = 44100;
  const sig = makeBalancedLsbBuffer(2500, 40);
  const rep = Anomaly.lsbSteganalysis(makeBuffer([sig], sr));
  if (!rep.available) throw new Error('LSB stats unavailable: ' + rep.reason);
  if (!rep.suspicious) {
    throw new Error('balanced PoV pairs should flag as suspicious: z=' +
      rep.zScore + ' df=' + rep.df);
  }
});

test('scanTrack: end-to-end on balanced-LSB signal → LSB flag set', () => {
  const sr = 48000;
  const base = makeBalancedLsbBuffer(3000, 32);
  const stft = Analyzer.computeSpectrogram(base, sr, { fftSize: 4096, hop: 1024, windowName: 'hann', packed: false });
  const packed = Analyzer.computeSpectrogram(base, sr, { fftSize: 4096, hop: 1024, windowName: 'hann', packed: true });
  const rep = Anomaly.scanTrack({
    rawMags: stft.grid,
    buffer: makeBuffer([base], sr),
    packedGrid: packed.grid,
    nFrames: stft.nFrames,
    nBins: stft.nBins,
    sampleRate: sr,
    fftSize: 4096,
    hop: 1024
  });
  console.log('    → score=' + rep.summary.score.toFixed(2) +
    ' notes=[' + rep.summary.notes.join(' | ') + ']');
  if (!rep.lsb.suspicious) throw new Error('LSB stego flag missed');
  if (rep.summary.score < 0.3) {
    throw new Error('summary score should reflect LSB flag: ' + rep.summary.score);
  }
});

test('scanTrack: end-to-end on ultrasonic tone in 48 kHz → ultrasonic flag set', () => {
  const sr = 48000;
  const t = 2;
  const sig = addSignals(
    makeSine(440, sr, t, 0.3),
    makeSine(22000, sr, t, 0.2)
  );
  const stft = Analyzer.computeSpectrogram(sig, sr, { fftSize: 4096, hop: 1024, windowName: 'hann', packed: false });
  const packed = Analyzer.computeSpectrogram(sig, sr, { fftSize: 4096, hop: 1024, windowName: 'hann', packed: true });
  const rep = Anomaly.scanTrack({
    rawMags: stft.grid,
    buffer: makeBuffer([sig], sr),
    packedGrid: packed.grid,
    nFrames: stft.nFrames,
    nBins: stft.nBins,
    sampleRate: sr,
    fftSize: 4096,
    hop: 1024
  });
  if (!rep.ultrasonic.hasContent) throw new Error('ultrasonic missed');
  if (!rep.summary.suspicious && rep.summary.score < 0.4) {
    throw new Error('strong ultrasonic content should bump the score, got ' + rep.summary.score);
  }
});

test('scanTrack: clean natural sine is not flagged', () => {
  const sr = 44100;
  const sig = addSignals(
    makeSine(440, sr, 2, 0.3),
    makeSine(880, sr, 2, 0.15),
    makeSine(1320, sr, 2, 0.08)
  );
  const stft = Analyzer.computeSpectrogram(sig, sr, { fftSize: 4096, hop: 1024, windowName: 'hann', packed: false });
  const packed = Analyzer.computeSpectrogram(sig, sr, { fftSize: 4096, hop: 1024, windowName: 'hann', packed: true });
  const rep = Anomaly.scanTrack({
    rawMags: stft.grid,
    buffer: makeBuffer([sig], sr),
    packedGrid: packed.grid,
    nFrames: stft.nFrames,
    nBins: stft.nBins,
    sampleRate: sr,
    fftSize: 4096,
    hop: 1024
  });
  // Tones present (the three sines) but no ultrasonic and no LSB stego, so
  // the score should be modest — confirm it isn't in the "highly suspicious"
  // band.
  console.log('    → score=' + rep.summary.score.toFixed(2));
  if (rep.summary.score >= 0.6) {
    throw new Error('clean signal flagged as highly suspicious: score=' + rep.summary.score);
  }
});

// ==========================================================================
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed) process.exit(1);
