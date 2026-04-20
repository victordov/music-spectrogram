// App controller: wires audio engine, renderers, visualizations, and UI state.
(function () {
  'use strict';

  // ---------- State ----------
  const state = {
    file: null,
    buffer: null,               // AudioBuffer
    monoSamples: null,          // Float32Array of active channel mix for spectrogram computation
    mode: 'spectrogram',
    specStyle: 'scroll',
    fftSize: 1024,
    overlap: 0.5,
    windowFn: 'hann',
    smoothing: 0.6,
    minFreq: 20,
    maxFreq: 20000,
    channelMode: 'mono',
    freqScale: 'log',
    colorMap: 'viridis',
    minDb: -90,
    maxDb: -10,
    gamma: 1,
    grid: true,
    harmonic: false,
    loop: null,                 // {start, end}
    loopAnchor: null,           // temp {a: time}
    // Precomputed data per (file, fftSize/overlap/window/channel).
    track: null,                // {grid, nFrames, nBins, fftSize, hop, sampleRate, minDb, maxDb, rawMags?}
    altGrids: {},               // cached {mel, chroma, cochleagram, reassigned, cepstrum, features}
    scalogram: null,
    worker: null,
    rtFrame: 0,
    // New: audio-editing state.
    originalBuffer: null,       // AudioBuffer snapshot for revert
    originalSamples: null,      // Float32Array mono mix of originalBuffer
    mask: null,                 // SpectralMask instance
    hpsGrids: null,             // {gridH, gridP, nFrames, nBins, minDb, maxDb}
    // Brush tool state
    brushActive: false,
    brushSize: 20,
    brushGain: 0.5,
    brushDown: false,
    brushMode: 'attenuate',
    brushHarmonicLock: false,
    brushAutoSelect: false,
    // EQ state
    eq: null,                   // ParametricEQ instance
    eqShowCurve: true,
    // Pro/Studio gating — permanently 'studio' in this OSS build, so every
    // Pro feature (broadcast metering, compliance export, restoration
    // presets, key/BPM detection, live meters) is unlocked.
    tier: 'studio',
  };

  // Defaults used by the reset button.
  const DEFAULTS = {
    mode: 'spectrogram',
    specStyle: 'scroll',
    fftSize: 1024,
    overlap: 0.5,
    windowFn: 'hann',
    smoothing: 0.6,
    minFreq: 20,
    maxFreq: 20000,
    channelMode: 'mono',
    freqScale: 'log',
    colorMap: 'viridis',
    minDb: -90,
    maxDb: -10,
    gamma: 1,
    grid: true,
    harmonic: false,
    volume: 0.8,
    rate: 1,
    tZoom: 1, fZoom: 1, tPan: 0, fPan: 0,
  };

  const audio = new window.AudioEngine();
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  function status(msg, cls = '') {
    statusEl.className = 'status small' + (cls ? ' ' + cls : '');
    statusEl.textContent = msg;
  }
  function showError(msg) {
    const el = $('errorToast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showError._t);
    showError._t = setTimeout(() => el.classList.add('hidden'), 4500);
  }

  // ---------- Canvases ----------
  const specCanvas = $('specCanvas');
  const overlayCanvas = $('overlayCanvas');
  const renderer = new window.SpectrogramRenderer(specCanvas, overlayCanvas);
  const waveform = new window.Waveform($('waveformCanvas'));
  const barsCanvas = $('barsCanvas');
  const barsCtx = barsCanvas.getContext('2d');

  const waterfall = new window.Visualizations.Waterfall();

  // Hover readout — time / frequency / dB / nearest note.
  const hoverEl = $('hoverReadout');
  const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  function hzToNote(hz) {
    if (!hz || hz < 10) return '';
    // MIDI semitone number relative to A4 = 69.
    const midi = 69 + 12 * Math.log2(hz / 440);
    const nearest = Math.round(midi);
    const name = NOTE_NAMES[((nearest % 12) + 12) % 12];
    const octave = Math.floor(nearest / 12) - 1;
    const cents = Math.round((midi - nearest) * 100);
    const sign = cents > 0 ? '+' : '';
    return `${name}${octave}${cents !== 0 ? ' ' + sign + cents + '¢' : ''}`;
  }
  function dbAt(tSec, hz) {
    if (!state.track || !state.track.rawMags || !state.buffer || tSec == null) return null;
    const raw = state.track.rawMags;
    const sr = state.buffer.sampleRate;
    const nFrames = raw.length;
    if (!nFrames) return null;
    const frameF = (tSec / state.buffer.duration) * (nFrames - 1);
    const f0 = Math.max(0, Math.min(nFrames - 1, Math.round(frameF)));
    const bins = raw[f0];
    if (!bins) return null;
    const binF = (hz / (sr / 2)) * (bins.length - 1);
    const b0 = Math.max(0, Math.min(bins.length - 1, Math.round(binF)));
    const mag = bins[b0];
    if (!mag || mag <= 0) return -120;
    return 20 * Math.log10(mag);
  }
  // Brush cursor ring so the user can see the tool is armed and where the
  // stroke will land before committing. Stored in canvas-internal pixels.
  state.brushCursor = { x: 0, y: 0, visible: false };

  overlayCanvas.addEventListener('mousemove', (e) => {
    const r = overlayCanvas.getBoundingClientRect();
    const xPx = (e.clientX - r.left) * (overlayCanvas.width / r.width);
    const yPx = (e.clientY - r.top) * (overlayCanvas.height / r.height);
    const w = overlayCanvas.width, h = overlayCanvas.height;
    let tSec = null;
    if (state.mode === 'features' || state.mode === 'scalogram' || state.specStyle === 'static' || state.mode !== 'spectrogram') {
      const t0 = renderer.tPan, t1 = Math.min(1, renderer.tPan + 1 / renderer.tZoom);
      if (state.buffer) tSec = (t0 + (xPx / w) * (t1 - t0)) * state.buffer.duration;
    } else {
      tSec = audio.getCurrentTime();
    }
    const hz = renderer.yToFreq(yPx, h);
    const hzStr = hz < 1000 ? hz.toFixed(0) + ' Hz' : (hz / 1000).toFixed(2) + ' kHz';
    const note = hzToNote(hz);
    const db = dbAt(tSec, hz);
    const dbStr = (db != null && isFinite(db)) ? `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB` : '';
    hoverEl.classList.add('visible');
    hoverEl.innerHTML = `
      <span class="hr-t">${tSec != null ? formatTime(tSec) : '--:--'}</span>
      <span class="hr-f">${hzStr}</span>
      ${note ? `<span class="hr-n">${note}</span>` : ''}
      ${dbStr ? `<span class="hr-db">${dbStr}</span>` : ''}
    `;
    // Position the readout near the cursor but clamped inside the panel.
    const pr = overlayCanvas.parentElement.getBoundingClientRect();
    const px = Math.max(8, Math.min(pr.width - 200, e.clientX - pr.left + 12));
    const py = Math.max(8, Math.min(pr.height - 60, e.clientY - pr.top + 12));
    hoverEl.style.left = px + 'px';
    hoverEl.style.top = py + 'px';
    // Update & redraw brush ring while brush is active.
    if (state.brushActive) {
      state.brushCursor.x = xPx;
      state.brushCursor.y = yPx;
      state.brushCursor.visible = true;
      drawBrushCursor();
    }
    if (state.brushActive && state.brushDown && (e.buttons & 1)) {
      paintBrushAt(xPx, yPx);
    }
  });
  overlayCanvas.addEventListener('mouseleave', () => {
    hoverEl.classList.remove('visible');
    state.brushDown = false;
    state.brushLastPaint = null; // next re-entry is a fresh stroke
    state.brushCursor.visible = false;
    // Repaint overlay without the brush ring.
    if (state.brushActive) drawBrushCursor();
  });

  // Draw the brush size ring on top of the existing renderer overlay.
  // The overlay canvas is redrawn by the renderer on each renderCurrentMode
  // call, so we keep the ring purely additive.
  function drawBrushCursor() {
    const ctx = overlayCanvas.getContext('2d');
    // First, let the renderer repaint its own overlay (gridlines / cursor)
    // so we start from a clean state.
    if (renderer && typeof renderer.renderOverlay === 'function') renderer.renderOverlay();
    if (!state.brushCursor.visible || !state.brushActive) return;
    const { x, y } = state.brushCursor;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // brushSize is in CSS pixels; overlay is in device pixels.
    const rPx = state.brushSize * dpr;
    ctx.save();
    ctx.lineWidth = 1.5 * dpr;
    // Outer ring: bright accent so it's visible on any color map.
    ctx.strokeStyle = 'rgba(79, 209, 197, 0.95)';
    ctx.beginPath(); ctx.arc(x, y, rPx, 0, Math.PI * 2); ctx.stroke();
    // Inner dot.
    ctx.fillStyle = 'rgba(79, 209, 197, 0.85)';
    ctx.beginPath(); ctx.arc(x, y, 2 * dpr, 0, Math.PI * 2); ctx.fill();
    // Crosshair lines inside the ring for easier aim.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(x - rPx, y); ctx.lineTo(x + rPx, y);
    ctx.moveTo(x, y - rPx); ctx.lineTo(x, y + rPx);
    ctx.stroke();
    ctx.restore();
  }

  // Click-to-seek in static mode / brush paint.
  overlayCanvas.addEventListener('mousedown', (e) => {
    const r = overlayCanvas.getBoundingClientRect();
    const xPx = (e.clientX - r.left) * (overlayCanvas.width / r.width);
    const yPx = (e.clientY - r.top) * (overlayCanvas.height / r.height);
    if (state.brushActive) {
      if (!state.mask) {
        // Mask hasn't been initialised yet — the STFT hasn't finished. Try
        // a best-effort: if we have a track, allocate a matching mask now
        // instead of silently dropping the click.
        if (state.track && state.track.nFrames && state.track.fftSize) {
          state.mask = new window.SpectralMask(
            state.track.nFrames,
            (state.track.fftSize / 2) + 1
          );
        } else {
          status('Brush: waiting for analysis to finish…', 'warn');
          return;
        }
      }
      state.brushDown = true;
      state.brushLastPaint = null; // start a fresh stroke
      paintBrushAt(xPx, yPx, true);
      if (state.mask && state.mask.dirty) {
        if (!state._firstPaintShown) {
          state._firstPaintShown = true;
          status(`Painting ${state.brushMode} @ gain ${state.brushGain}× — drag to extend, then Apply.`, 'ok');
        }
      } else {
        status('Brush click registered but paint produced no change — check Mode / Gain.', 'warn');
      }
      return;
    }
    if (state.specStyle !== 'static' && state.mode === 'spectrogram') return;
    if (!state.buffer) return;
    const t0 = renderer.tPan, t1 = Math.min(1, renderer.tPan + 1 / renderer.tZoom);
    const frac = t0 + (xPx / overlayCanvas.width) * (t1 - t0);
    audio.seek(frac * state.buffer.duration);
  });
  window.addEventListener('mouseup', () => {
    state.brushDown = false;
    state.brushLastPaint = null; // end current stroke
  });

  // Double-click on spectrogram to flood-fill auto-select a region (when
  // the Auto-select brush option is on and brush is active).
  overlayCanvas.addEventListener('dblclick', (e) => {
    if (!state.brushActive || !state.brushAutoSelect) return;
    const r = overlayCanvas.getBoundingClientRect();
    const xPx = (e.clientX - r.left) * (overlayCanvas.width / r.width);
    const yPx = (e.clientY - r.top) * (overlayCanvas.height / r.height);
    autoSelectAt(xPx, yPx);
  });

  // Paint ONLY the mask at pixel coords — no canvas render.
  // Expensive render work is deferred to queueBrushRender() so we can coalesce
  // many mousemove events into a single animation frame.
  function _paintBrushMaskAt(xPx, yPx) {
    if (!state.mask || !state.buffer) return;
    const W = overlayCanvas.width, H = overlayCanvas.height;
    const t0 = renderer.tPan, t1 = Math.min(1, renderer.tPan + 1 / renderer.tZoom);
    const tFrac = t0 + (xPx / W) * (t1 - t0);
    const frame = tFrac * (state.mask.nFrames - 1);
    // Convert pixel y → frequency → mask bin (one-sided, nBins = fftSize/2+1).
    // Don't use renderer.yToBin here: it is scaled to the GRID bin count
    // (fftSize/2), but the mask has one extra Nyquist bin.
    const sr = state.buffer.sampleRate;
    const freqToMaskBin = (hz) => (hz / (sr / 2)) * (state.mask.nBins - 1);
    const binFloat = freqToMaskBin(renderer.yToFreq(yPx, H));
    // Convert pixel brush size to frame/bin units.
    const pxToFrame = ((t1 - t0) * (state.mask.nFrames - 1)) / W;
    const radiusFrames = Math.max(0.5, state.brushSize * pxToFrame);
    const binTop = freqToMaskBin(renderer.yToFreq(yPx - state.brushSize, H));
    const binBot = freqToMaskBin(renderer.yToFreq(yPx + state.brushSize, H));
    const radiusBins = Math.max(0.5, Math.abs(binTop - binBot) / 2);

    // For harmonic-preserve mode we need the magnitude spectrum at this frame
    // so we can detect peaks to protect.
    const opts = {};
    if (state.brushMode === 'harmonic-preserve' && state.track && state.track.rawMags) {
      const fIdx = Math.max(0, Math.min(state.track.rawMags.length - 1, Math.round(frame)));
      opts.peakMags = state.track.rawMags[fIdx];
      opts.preserveHalfBins = 3;
      opts.peakRelThresh = 0.15;
    }

    if (state.brushHarmonicLock) {
      state.mask.paintHarmonicLock(frame, binFloat, radiusFrames, radiusBins,
        state.brushGain, state.brushMode, 6, opts);
    } else {
      state.mask.paint(frame, binFloat, radiusFrames, radiusBins,
        state.brushGain, state.brushMode, opts);
    }
  }

  // Continuous stroke: interpolate from last painted position to (x, y) so
  // fast drags don't leave gaps between dabs, then schedule a render.
  //   resetLast=true drops the previous stroke point (for mousedown / first dab).
  function paintBrushAt(xPx, yPx, resetLast) {
    if (!state.mask || !state.buffer) return;
    const last = state.brushLastPaint;
    // Step between dabs in CSS-equivalent pixels. Smaller = denser = smoother
    // but slower. brushSize*0.4 matches what most raster editors use.
    const step = Math.max(1, state.brushSize * 0.4);
    if (!resetLast && last) {
      const dx = xPx - last.x, dy = yPx - last.y;
      const dist = Math.hypot(dx, dy);
      if (dist > step) {
        const n = Math.min(32, Math.ceil(dist / step));
        for (let i = 1; i <= n; i++) {
          const ix = last.x + (dx * i) / n;
          const iy = last.y + (dy * i) / n;
          _paintBrushMaskAt(ix, iy);
        }
      } else {
        _paintBrushMaskAt(xPx, yPx);
      }
    } else {
      _paintBrushMaskAt(xPx, yPx);
    }
    state.brushLastPaint = { x: xPx, y: yPx };
    queueBrushRender();
  }

  // Coalesce multiple paintBrushAt calls per frame into a single render.
  // Without this, a fast drag fires mousemove 60–120 times/sec and each call
  // would re-run the expensive _renderStatic + drawMaskOverlay pipeline.
  state.brushRenderPending = false;
  function queueBrushRender() {
    if (state.brushRenderPending) return;
    state.brushRenderPending = true;
    requestAnimationFrame(() => {
      state.brushRenderPending = false;
      renderCurrentMode();
      if (state.brushActive && state.brushCursor && state.brushCursor.visible) {
        drawBrushCursor();
      }
    });
  }

  // Double-click flood-fill auto-select: grab a connected region of similar
  // energy and paint it in one shot using the current brush gain + mode.
  function autoSelectAt(xPx, yPx) {
    if (!state.mask || !state.buffer || !state.track || !state.track.grid) return;
    const W = overlayCanvas.width, H = overlayCanvas.height;
    const t0 = renderer.tPan, t1 = Math.min(1, renderer.tPan + 1 / renderer.tZoom);
    const tFrac = t0 + (xPx / W) * (t1 - t0);
    const seedF = Math.round(tFrac * (state.mask.nFrames - 1));
    // Seed uses mask coords; see paintBrushAt for the same freq→mask-bin math.
    const sr = state.buffer.sampleRate;
    const seedB = Math.round((renderer.yToFreq(yPx, H) / (sr / 2)) * (state.mask.nBins - 1));
    const tr = state.track;
    const painted = state.mask.autoSelect(
      tr.grid, tr.nFrames, tr.nBins,
      seedF, seedB,
      tr.minDb, tr.maxDb,
      12, // dB threshold
      state.brushGain, state.brushMode
    );
    status(`Auto-selected ${painted} cells.`, 'ok');
    renderCurrentMode();
  }

  // ---------- Resize handling ----------
  function resizeAll() {
    renderer.resize();
    waveform.resize();
    const r = barsCanvas.getBoundingClientRect();
    barsCanvas.width = Math.max(1, r.width * (window.devicePixelRatio || 1));
    barsCanvas.height = Math.max(1, r.height * (window.devicePixelRatio || 1));
    renderCurrentMode();
    waveform.render();
    drawLegend();
  }
  window.addEventListener('resize', resizeAll);

  // ---------- File loading ----------
  async function handleFile(file) {
    if (!file) return;
    const name = (file.name || '').toLowerCase();
    if (!(name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.m4a') || name.endsWith('.ogg') || name.endsWith('.flac'))) {
      showError('Unsupported file type. Please provide .mp3 or .wav.');
      return;
    }
    try {
      status('Decoding audio…');
      const buf = await audio.loadFile(file);
      state.file = file;
      await onBufferLoaded(buf, file.name);
    } catch (err) {
      console.error(err);
      showError('Decode failed: ' + (err.message || err));
      status('Error decoding file.', 'error');
    }
  }

  // Shared post-decode wiring — used by file loads and by the demo generator.
  async function onBufferLoaded(buf, displayName) {
    state.buffer = buf;
    state.originalBuffer = buf;
    $('filename').textContent = displayName || '(in-memory audio)';
    $('waveInfo').textContent = `${buf.numberOfChannels}ch • ${buf.sampleRate} Hz • ${buf.duration.toFixed(2)}s`;
    applyChannelMode();
    state.originalSamples = new Float32Array(state.monoSamples);
    state.mask = null;
    state.hpsGrids = null;
    state.anomaly = { report: null };
    waveform.computePeaks(state.monoSamples, 2000);
    waveform.setTime(0, buf.duration);
    renderer.duration = buf.duration;
    renderer.sampleRate = buf.sampleRate;
    const nyq = buf.sampleRate / 2;
    const maxInput = $('maxFreq');
    maxInput.max = String(Math.floor(nyq));
    if (state.maxFreq > nyq) {
      state.maxFreq = Math.floor(nyq);
      maxInput.value = String(state.maxFreq);
    }
    applyDisplayParams();
    audio.setBandLimits(state.minFreq, state.maxFreq);
    hideEmptyState();
    await computeTrack();
    status('Ready. Press Space to play.', 'ok');
    $('seekBar').value = 0;
    updateTimeLabel();
  }

  // ---------- Demo track synthesis ----------
  // Builds a ~12-second track that showcases every feature at once:
  //   • A Cmaj7 arpeggio (key detector → C major)
  //   • A subtle 120 BPM kick (BPM detector → 120 BPM, burst detector trigger)
  //   • A sustained 15 kHz pilot tone for ~3s (tone detector trigger)
  //   • An ultrasonic 21 kHz signature throughout (ultrasonic flag)
  //   • A rhythmic broadband crackle (edge-density / geometry hint)
  // All synthesized offline via OfflineAudioContext-free direct Float32
  // generation so it works even before the user has touched the app.
  async function buildDemoBuffer(sr = 48000, seconds = 12) {
    const n = Math.floor(sr * seconds);
    const samples = new Float32Array(n);
    const notes = [261.63, 329.63, 392.0, 493.88]; // C4 E4 G4 B4 (Cmaj7)
    const bpm = 120;
    const beatSamples = Math.floor(sr * 60 / bpm);
    let s = 0xC0DECAFE >>> 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      // Arpeggio — change note every beat.
      const beatIdx = Math.floor(i / beatSamples);
      const note = notes[beatIdx % notes.length];
      const env = 0.3 * Math.exp(-(i % beatSamples) / (sr * 0.6));
      const arp = env * (
        0.6 * Math.sin(2 * Math.PI * note * t) +
        0.3 * Math.sin(2 * Math.PI * note * 2 * t) +
        0.15 * Math.sin(2 * Math.PI * note * 3 * t)
      );
      // Kick on each beat — short low-frequency burst.
      let kick = 0;
      const kickPhase = i % beatSamples;
      if (kickPhase < sr * 0.08) {
        const f = 55 * Math.exp(-kickPhase / (sr * 0.03));
        kick = 0.35 * Math.exp(-kickPhase / (sr * 0.04)) * Math.sin(2 * Math.PI * f * (kickPhase / sr));
      }
      // Sustained 15 kHz pilot between t ∈ [4, 7].
      let pilot = 0;
      if (t >= 4 && t <= 7) {
        const fadeT = Math.min(1, (t - 4) * 4, (7 - t) * 4);
        pilot = 0.08 * fadeT * Math.sin(2 * Math.PI * 15000 * t);
      }
      // Persistent ultrasonic 21 kHz signature.
      const ultra = 0.06 * Math.sin(2 * Math.PI * 21000 * t);
      // Rhythmic broadband crackle every 2nd beat.
      let crack = 0;
      if (kickPhase < 40 && beatIdx % 4 === 2) {
        s = (s * 1664525 + 1013904223) >>> 0;
        crack = 0.25 * (((s >>> 16) & 0xffff) / 32768 - 1);
      }
      samples[i] = arp + kick + pilot + ultra + crack;
    }
    // Soft normalisation.
    let peak = 0;
    for (let i = 0; i < n; i++) if (Math.abs(samples[i]) > peak) peak = Math.abs(samples[i]);
    if (peak > 0.95) {
      const g = 0.9 / peak;
      for (let i = 0; i < n; i++) samples[i] *= g;
    }
    return audio.samplesToBuffer(samples, sr);
  }

  async function loadDemoTrack() {
    try {
      status('Synthesising demo track…');
      const buf = await buildDemoBuffer(48000, 12);
      state.file = null;
      await onBufferLoaded(buf, 'Spectrogram Lab — demo track');
    } catch (err) {
      console.error(err);
      showError('Demo generation failed: ' + (err.message || err));
    }
  }

  function applyChannelMode() {
    if (!state.buffer) return;
    const chans = [];
    for (let c = 0; c < state.buffer.numberOfChannels; c++) chans.push(state.buffer.getChannelData(c));
    state.monoSamples = window.Analyzer.mixdown(chans, state.channelMode);
  }

  // Offload STFT to worker.
  function computeTrack() {
    return new Promise((resolve) => {
      if (!state.buffer || !state.monoSamples) return resolve();
      status('Analyzing full track (worker)…');
      if (state.worker) state.worker.terminate();
      const w = new Worker('js/workers/analysis-worker.js');
      state.worker = w;
      const hop = Math.max(1, Math.round(state.fftSize * (1 - state.overlap)));
      const keepRaw = true;
      // Copy typed array to transfer to worker.
      const copy = new Float32Array(state.monoSamples);
      w.postMessage({
        cmd: 'stft',
        samples: copy,
        sampleRate: state.buffer.sampleRate,
        fftSize: state.fftSize,
        hop,
        windowName: state.windowFn,
        minDb: -120,
        maxDb: 0,
        keepRaw
      }, [copy.buffer]);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') {
          status(`Analyzing (${m.stage})… ${(m.p * 100).toFixed(0)}%`);
        } else if (m.type === 'stft-done') {
          state.track = m;
          state.altGrids = {}; // invalidate alt caches
          // (Re)allocate spectral mask to match current analysis grid.
          state.mask = new window.SpectralMask(m.nFrames, (m.fftSize / 2) + 1);
          renderer.setTrack(m, state.buffer.duration);
          status('Analysis complete.', 'ok');
          renderCurrentMode();
          resolve();
        } else if (m.type === 'error') {
          status('Analysis error: ' + m.message, 'error');
          resolve();
        }
      };
    });
  }

  function applyDisplayParams() {
    renderer.setParams({
      mode: state.mode === 'spectrogram' ? (state.specStyle === 'scroll' ? 'scroll' : 'static') : 'static',
      freqScale: state.freqScale,
      colorMap: state.colorMap,
      minDb: state.minDb, maxDb: state.maxDb,
      gamma: state.gamma, grid: state.grid, harmonic: state.harmonic,
      minFreq: state.minFreq, maxFreq: state.maxFreq,
      sampleRate: state.buffer ? state.buffer.sampleRate : 44100,
      tZoom: +$('tZoom').value,
      fZoom: +$('fZoom').value,
      tPan: +$('tPan').value,
      fPan: +$('fPan').value,
      fftSize: state.fftSize,
      loop: state.loop,
    });
    drawLegend();
  }

  // ---------- Rendering dispatch ----------
  function renderCurrentMode() {
    const result = _renderCurrentModeInner();
    // Overlay mask tint on top (only when mask is dirty) so brush edits are visible.
    if (state.mask && state.mask.dirty) drawMaskOverlay();
    // EQ curve on the overlay canvas.
    if (state.eq && state.eqShowCurve && !state.eq.bypass) drawEqCurveOverlay();
    return result;
  }

  // Renderer calls this hook at the end of every renderOverlay() — including
  // the per-frame cursor updates during playback — so the EQ curve (drawn on
  // the overlay canvas) is not wiped every animation frame.
  renderer.onOverlayDraw = function (ctx, W, H) {
    if (!state.eq || !state.eqShowCurve || state.eq.bypass) return;
    // Reuse the same axis mapping as drawEqCurveOverlay below.
    const fmin = Math.max(1, renderer.minFreq);
    const fmax = Math.max(fmin + 1, Math.min(renderer.sampleRate / 2, renderer.maxFreq));
    const freqToX = (hz) => {
      let frac;
      if (renderer.freqScale === 'log') frac = Math.log(Math.max(fmin, Math.min(fmax, hz)) / fmin) / Math.log(fmax / fmin);
      else frac = (hz - fmin) / (fmax - fmin);
      return frac * W;
    };
    const xToFreq = (x) => {
      const frac = x / W;
      if (renderer.freqScale === 'log') return fmin * Math.pow(fmax / fmin, frac);
      return fmin + (fmax - fmin) * frac;
    };
    window.drawEqCurve(ctx, W, H, state.eq, { freqToX, xToFreq, minDb: -24, maxDb: 24 });
  };

  function _renderCurrentModeInner() {
    if (!state.buffer || !state.track) {
      renderer.render();
      return;
    }
    const w = specCanvas.width, h = specCanvas.height;
    const ctx = specCanvas.getContext('2d');
    const mode = state.mode;
    if (mode === 'spectrogram') {
      if (state.specStyle === 'scroll') {
        // Scrolling is drawn live; if track exists and nothing has been drawn yet,
        // seed an initial empty background.
        renderer.render();
      } else {
        renderer._renderStatic();
        renderer.renderOverlay();
      }
      return;
    }

    // Alt visualizations need raw magnitudes (keepRaw).
    const raw = state.track.rawMags;
    if (!raw) { renderer.render(); return; }

    if (mode === 'mel') {
      if (!state.altGrids.mel) state.altGrids.mel = window.Visualizations.buildMelGrid(raw, state.track.sampleRate, 128, state.minFreq, state.maxFreq);
      const g = state.altGrids.mel;
      window.Visualizations.drawHeatGrid(ctx, w, h, g.grid, g.nFrames, g.nRows, state.colorMap, {
        gamma: state.gamma, tPan: +$('tPan').value, tZoom: +$('tZoom').value,
        fPan: +$('fPan').value, fZoom: +$('fZoom').value
      });
      renderer.renderOverlay();
    } else if (mode === 'chroma') {
      if (!state.altGrids.chroma) state.altGrids.chroma = window.Visualizations.buildChromaGrid(raw, state.track.sampleRate);
      const g = state.altGrids.chroma;
      window.Visualizations.drawHeatGrid(ctx, w, h, g.grid, g.nFrames, g.nRows, state.colorMap, {
        gamma: state.gamma, tPan: +$('tPan').value, tZoom: +$('tZoom').value,
        fPan: 0, fZoom: 1
      });
      // Draw pitch-class labels
      ctx.fillStyle = 'rgba(230,233,239,0.9)';
      ctx.font = `${11 * Math.min(window.devicePixelRatio || 1, 2)}px ui-monospace, monospace`;
      const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
      const rowH = h / 12;
      for (let i = 0; i < 12; i++) {
        ctx.fillText(names[11 - i], 4, i * rowH + rowH / 2 + 4);
      }
      renderer.renderOverlay();
    } else if (mode === 'cochleagram') {
      if (!state.altGrids.cochlea) state.altGrids.cochlea = window.Visualizations.buildCochleagramGrid(raw, state.track.sampleRate, 96);
      const g = state.altGrids.cochlea;
      window.Visualizations.drawHeatGrid(ctx, w, h, g.grid, g.nFrames, g.nRows, state.colorMap, {
        gamma: state.gamma, tPan: +$('tPan').value, tZoom: +$('tZoom').value,
        fPan: 0, fZoom: 1
      });
      renderer.renderOverlay();
    } else if (mode === 'reassigned') {
      if (!state.altGrids.reassigned) state.altGrids.reassigned = window.Visualizations.buildReassignedGrid(raw);
      const g = state.altGrids.reassigned;
      window.Visualizations.drawHeatGrid(ctx, w, h, g.grid, g.nFrames, g.nRows, state.colorMap, {
        gamma: state.gamma, tPan: +$('tPan').value, tZoom: +$('tZoom').value,
        fPan: +$('fPan').value, fZoom: +$('fZoom').value
      });
      renderer.renderOverlay();
    } else if (mode === 'cepstrum') {
      if (!state.altGrids.cepstrum) state.altGrids.cepstrum = window.Visualizations.buildCepstrumGrid(raw, state.track.fftSize);
      const g = state.altGrids.cepstrum;
      window.Visualizations.drawHeatGrid(ctx, w, h, g.grid, g.nFrames, g.nRows, state.colorMap, {
        gamma: state.gamma, tPan: +$('tPan').value, tZoom: +$('tZoom').value,
        fPan: 0, fZoom: 1
      });
      renderer.renderOverlay();
    } else if (mode === 'features') {
      if (!state.altGrids.features) state.altGrids.features = window.Visualizations.buildFeatures(raw, state.monoSamples, state.track.sampleRate, state.track.hop);
      const f = state.altGrids.features;
      window.Visualizations.drawFeatures(ctx, w, h, f, { tPan: +$('tPan').value, tZoom: +$('tZoom').value });
      renderer.renderOverlay();
    } else if (mode === 'scalogram') {
      if (!state.scalogram) computeScalogram();
      else drawScalogram();
    } else if (mode === 'waterfall') {
      waterfall.draw(ctx, w, h, {
        colorMap: state.colorMap, minDb: state.minDb, maxDb: state.maxDb, gamma: state.gamma,
        fPan: +$('fPan').value, fZoom: +$('fZoom').value,
        sampleRate: state.track.sampleRate, minFreq: state.minFreq, maxFreq: state.maxFreq,
        freqScale: state.freqScale
      });
      renderer.renderOverlay();
    } else if (mode === 'harmonic' || mode === 'percussive') {
      if (!state.hpsGrids) {
        // Auto-kick an analysis if user selects a tab before running it.
        status('Run "Analyze HPS" to populate this view.', 'warn');
        renderer.render();
        return;
      }
      const g = mode === 'harmonic' ? state.hpsGrids.gridH : state.hpsGrids.gridP;
      drawPackedStftGrid(ctx, w, h, g, state.hpsGrids.nFrames, state.hpsGrids.nBins,
        state.hpsGrids.minDb, state.hpsGrids.maxDb);
      renderer.renderOverlay();
    }
  }

  // Redraw mask tint on top of current spec canvas (for brush visualization).
  function drawMaskOverlay() {
    if (!state.mask || !state.mask.dirty) return;
    const ctx = specCanvas.getContext('2d');
    const W = specCanvas.width, H = specCanvas.height;
    const sr = state.buffer ? state.buffer.sampleRate : 44100;
    const nB = state.mask.nBins;
    // Map pixel y → freq → mask bin (one-sided, nBins = fftSize/2+1).
    const yToMaskBin = (y, h) => (renderer.yToFreq(y, h) / (sr / 2)) * (nB - 1);
    state.mask.renderOverlay(ctx, W, H, {
      tPan: renderer.tPan, tZoom: renderer.tZoom,
      fPan: renderer.fPan, fZoom: renderer.fZoom,
      yToBin: yToMaskBin
    });
  }

  // Draw a packed STFT-style grid (nFrames * nBins, Uint8 encoded to a fixed dB range)
  // into the current canvas with the renderer's freq axis mapping and color map applied.
  function drawPackedStftGrid(ctx, w, h, grid, nFrames, nBins, gridMinDb, gridMaxDb) {
    const lut = window.Colormaps.LUTS[state.colorMap] || window.Colormaps.LUTS.viridis;
    const img = ctx.createImageData(w, h);
    const data = img.data;
    const gridRange = Math.max(1e-6, gridMaxDb - gridMinDb);
    const range = Math.max(1e-6, state.maxDb - state.minDb);
    const t0 = renderer.tPan, t1 = Math.min(1, renderer.tPan + 1 / renderer.tZoom);
    const binLo = new Int32Array(h);
    const binHi = new Int32Array(h);
    for (let py = 0; py < h; py++) {
      const hz0 = renderer.yToFreq(py + 1, h);
      const hz1 = renderer.yToFreq(py, h);
      const lo = Math.max(0, Math.min(nBins - 1, Math.floor((hz0 / (renderer.sampleRate / 2)) * nBins)));
      const hi = Math.max(0, Math.min(nBins - 1, Math.ceil((hz1 / (renderer.sampleRate / 2)) * nBins)));
      binLo[py] = Math.min(lo, hi);
      binHi[py] = Math.max(lo, hi);
    }
    for (let px = 0; px < w; px++) {
      const tf = t0 + (px / (w - 1)) * (t1 - t0);
      const fIdx = Math.max(0, Math.min(nFrames - 1, Math.floor(tf * (nFrames - 1))));
      const off = fIdx * nBins;
      for (let py = 0; py < h; py++) {
        let v = 0;
        const lo = binLo[py], hi = binHi[py];
        for (let k = lo; k <= hi; k++) {
          const g = grid[off + k];
          if (g > v) v = g;
        }
        const origT = v / 255;
        const db = gridMinDb + origT * gridRange;
        let t = (db - state.minDb) / range;
        t = Math.max(0, Math.min(1, t));
        if (state.gamma !== 1) t = Math.pow(t, state.gamma);
        const ci = Math.min(255, Math.max(0, (t * 255) | 0)) * 3;
        const di = (py * w + px) * 4;
        data[di] = lut[ci]; data[di + 1] = lut[ci + 1]; data[di + 2] = lut[ci + 2]; data[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function computeScalogram() {
    if (!state.monoSamples) return;
    status('Computing wavelet scalogram (worker)…');
    const w = new Worker('js/workers/analysis-worker.js');
    const copy = new Float32Array(state.monoSamples);
    w.postMessage({
      cmd: 'scalogram',
      samples: copy,
      sampleRate: state.buffer.sampleRate,
      nScales: 96, fMin: 50, fMax: Math.min(8000, state.buffer.sampleRate / 2),
      hop: Math.max(128, Math.round(state.buffer.sampleRate / 200)),
      minDb: -60, maxDb: 0
    }, [copy.buffer]);
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') status(`Scalogram… ${(m.p * 100).toFixed(0)}%`);
      else if (m.type === 'scalogram-done') {
        state.scalogram = m;
        status('Scalogram ready.', 'ok');
        drawScalogram();
      } else if (m.type === 'error') {
        status('Scalogram error: ' + m.message, 'error');
      }
      w.terminate();
    };
  }

  function drawScalogram() {
    if (!state.scalogram) return;
    const ctx = specCanvas.getContext('2d');
    const w = specCanvas.width, h = specCanvas.height;
    const g = state.scalogram;
    window.Visualizations.drawHeatGrid(ctx, w, h, g.grid, g.nFrames, g.nScales, state.colorMap, {
      gamma: state.gamma, tPan: +$('tPan').value, tZoom: +$('tZoom').value,
      fPan: 0, fZoom: 1
    });
    renderer.renderOverlay();
  }

  // ---------- Live spectrum bars ----------
  let freqByteArr = new Uint8Array(1024);
  function drawBars() {
    const w = barsCanvas.width, h = barsCanvas.height;
    barsCtx.fillStyle = '#05070a';
    barsCtx.fillRect(0, 0, w, h);
    if (!state.buffer || !audio.analyser) return;
    if (freqByteArr.length !== audio.analyser.frequencyBinCount) {
      freqByteArr = new Uint8Array(audio.analyser.frequencyBinCount);
    }
    audio.getFrequencyData(freqByteArr);
    const n = freqByteArr.length;
    const nyq = audio.ctx.sampleRate / 2;
    const bars = 96;
    const lut = window.Colormaps.LUTS[state.colorMap] || window.Colormaps.LUTS.viridis;
    let peakHz = 0, peakV = 0;
    for (let i = 0; i < bars; i++) {
      const frac0 = i / bars, frac1 = (i + 1) / bars;
      const f0 = state.freqScale === 'log'
        ? Math.max(1, state.minFreq) * Math.pow(state.maxFreq / Math.max(1, state.minFreq), frac0)
        : state.minFreq + (state.maxFreq - state.minFreq) * frac0;
      const f1 = state.freqScale === 'log'
        ? Math.max(1, state.minFreq) * Math.pow(state.maxFreq / Math.max(1, state.minFreq), frac1)
        : state.minFreq + (state.maxFreq - state.minFreq) * frac1;
      const b0 = Math.max(0, Math.min(n - 1, Math.floor((f0 / nyq) * n)));
      const b1 = Math.max(0, Math.min(n - 1, Math.ceil((f1 / nyq) * n)));
      let max = 0;
      for (let k = b0; k <= b1; k++) if (freqByteArr[k] > max) max = freqByteArr[k];
      const v = max / 255;
      if (max > peakV) { peakV = max; peakHz = (f0 + f1) / 2; }
      const ci = Math.min(255, Math.floor(v * 255)) * 3;
      barsCtx.fillStyle = `rgb(${lut[ci]},${lut[ci + 1]},${lut[ci + 2]})`;
      const bw = w / bars;
      const bh = v * h * 0.95;
      barsCtx.fillRect(i * bw, h - bh, bw - 1, bh);
    }
    $('peakInfo').textContent = peakV > 10 ? `peak ≈ ${peakHz < 1000 ? peakHz.toFixed(0) + ' Hz' : (peakHz / 1000).toFixed(2) + ' kHz'}` : '—';
  }

  // ---------- Real-time STFT frame for scrolling spectrogram + waterfall ----------
  let rtFft = null, rtWin = null, rtRe = null, rtIm = null;
  function ensureRtFft() {
    if (!rtFft || rtFft.n !== state.fftSize) {
      rtFft = new window.FFT(state.fftSize);
      rtRe = new Float32Array(state.fftSize);
      rtIm = new Float32Array(state.fftSize);
    }
    rtWin = window.Windows.build(state.windowFn, state.fftSize);
  }

  let lastRtTime = -1;
  function maybePushRtFrame() {
    if (!state.buffer || !state.monoSamples) return;
    // Compute a frame centered on the current playback position.
    const t = audio.getCurrentTime();
    const sr = state.buffer.sampleRate;
    const hop = Math.max(1, Math.round(state.fftSize * (1 - state.overlap)));
    const hopSec = hop / sr;
    // Throttle to one frame per hop to keep sync smooth.
    if (lastRtTime < 0 || Math.abs(t - lastRtTime) >= hopSec) {
      ensureRtFft();
      const center = Math.max(0, Math.floor(t * sr) - state.fftSize / 2);
      const buf = state.monoSamples;
      for (let i = 0; i < state.fftSize; i++) {
        const s = center + i;
        rtRe[i] = (s >= 0 && s < buf.length ? buf[s] : 0) * rtWin[i];
        rtIm[i] = 0;
      }
      rtFft.forward(rtRe, rtIm);
      const half = state.fftSize / 2;
      const mag = new Float32Array(half);
      let winSum = 0; for (let i = 0; i < state.fftSize; i++) winSum += rtWin[i];
      const norm = 1 / (winSum || 1);
      for (let k = 0; k < half; k++) mag[k] = Math.sqrt(rtRe[k] * rtRe[k] + rtIm[k] * rtIm[k]) * norm;
      if (state.mode === 'spectrogram' && state.specStyle === 'scroll' && audio.playing) {
        renderer.pushColumn(mag);
      }
      if (state.mode === 'waterfall' && audio.playing) {
        waterfall.push(mag);
      }
      // Harmonic tracking
      if (state.harmonic) {
        const h = window.Analyzer.trackHarmonics(mag, sr);
        renderer.setHarmonicPoints([{ t, freq: h.f0 }]);
      }
      lastRtTime = t;
    }
  }

  // ---------- Main animation loop ----------
  function tick() {
    requestAnimationFrame(tick);
    const t = audio.getCurrentTime();
    // Update seek + time labels.
    if (state.buffer) {
      const pct = t / state.buffer.duration;
      if (!seekDragging) $('seekBar').value = String(pct);
      updateTimeLabel();
      waveform.setTime(t, state.buffer.duration);
      renderer.setCursor(t);
    }
    // Live spectrum bars.
    drawBars();
    // Real-time spectrogram frame.
    maybePushRtFrame();
    // Redraw alternate realtime-only views.
    if (audio.playing && (state.mode === 'waterfall')) {
      const ctx = specCanvas.getContext('2d');
      waterfall.draw(ctx, specCanvas.width, specCanvas.height, {
        colorMap: state.colorMap, minDb: state.minDb, maxDb: state.maxDb, gamma: state.gamma,
        fPan: +$('fPan').value, fZoom: +$('fZoom').value,
        sampleRate: state.buffer ? state.buffer.sampleRate : 44100,
        minFreq: state.minFreq, maxFreq: state.maxFreq, freqScale: state.freqScale
      });
      renderer.renderOverlay();
    }
    // Loop handling.
    if (audio.playing && state.loop && state.buffer) {
      if (t >= state.loop.end) audio.seek(state.loop.start);
    }
  }
  requestAnimationFrame(tick);

  // ---------- UI wiring ----------
  let seekDragging = false;
  $('seekBar').addEventListener('input', () => {
    seekDragging = true;
    if (!state.buffer) return;
    const t = +$('seekBar').value * state.buffer.duration;
    audio.seek(t);
  });
  $('seekBar').addEventListener('change', () => { seekDragging = false; });
  $('volume').addEventListener('input', (e) => audio.setVolume(+e.target.value));
  $('rate').addEventListener('input', (e) => {
    audio.setRate(+e.target.value);
    $('rateLabel').textContent = (+e.target.value).toFixed(2) + '×';
  });
  $('playBtn').addEventListener('click', togglePlay);
  $('stopBtn').addEventListener('click', () => { audio.stop(); updatePlayUi(); });
  $('seekBackBtn').addEventListener('click', () => audio.seek(audio.getCurrentTime() - 5));
  $('seekFwdBtn').addEventListener('click', () => audio.seek(audio.getCurrentTime() + 5));

  audio.onPlayStateChange = updatePlayUi;

  function togglePlay() {
    if (!state.buffer) return;
    if (audio.playing) audio.pause();
    else audio.play();
  }
  function updatePlayUi() {
    $('playBtn').textContent = audio.playing ? '❙❙' : '▶';
  }
  function updateTimeLabel() {
    if (!state.buffer) { $('timeLabel').textContent = '00:00 / 00:00'; return; }
    $('timeLabel').textContent = `${formatTime(audio.getCurrentTime())} / ${formatTime(state.buffer.duration)}`;
  }

  // File open / drag and drop.
  $('openBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  // Demo-track button (top bar + empty-state CTA).
  $('demoBtn').addEventListener('click', loadDemoTrack);
  const emptyDemo = $('emptyDemoBtn');
  if (emptyDemo) emptyDemo.addEventListener('click', loadDemoTrack);
  const emptyOpen = $('emptyOpenBtn');
  if (emptyOpen) emptyOpen.addEventListener('click', () => $('fileInput').click());

  // Empty-state helpers.
  function hideEmptyState() {
    const el = $('emptyState');
    if (el) el.classList.add('hidden');
  }
  function showEmptyState() {
    const el = $('emptyState');
    if (el) el.classList.remove('hidden');
  }
  // Expose to reset path.
  state._hideEmptyState = hideEmptyState;
  state._showEmptyState = showEmptyState;

  const dropArea = document.body;
  ['dragenter','dragover'].forEach(ev => dropArea.addEventListener(ev, (e) => {
    e.preventDefault(); $('fileDrop').classList.add('dragging');
  }));
  ['dragleave','drop'].forEach(ev => dropArea.addEventListener(ev, (e) => {
    e.preventDefault(); $('fileDrop').classList.remove('dragging');
  }));
  dropArea.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  // Analysis controls.
  $('fftSize').addEventListener('change', (e) => {
    state.fftSize = +e.target.value;
    audio.setAnalyserFFTSize(state.fftSize);
    ensureRtFft();
    if (state.buffer) computeTrack();
  });
  $('overlap').addEventListener('change', (e) => {
    state.overlap = +e.target.value;
    if (state.buffer) computeTrack();
  });
  $('windowFn').addEventListener('change', (e) => {
    state.windowFn = e.target.value;
    if (state.buffer) computeTrack();
  });
  $('smoothing').addEventListener('input', (e) => {
    state.smoothing = +e.target.value;
    audio.setSmoothing(state.smoothing);
  });
  $('minFreq').addEventListener('change', (e) => {
    state.minFreq = Math.max(0, +e.target.value);
    audio.setBandLimits(state.minFreq, state.maxFreq);
    applyDisplayParams(); renderCurrentMode();
  });
  $('maxFreq').addEventListener('change', (e) => {
    state.maxFreq = Math.max(state.minFreq + 1, +e.target.value);
    audio.setBandLimits(state.minFreq, state.maxFreq);
    applyDisplayParams(); renderCurrentMode();
  });
  $('channelMode').addEventListener('change', (e) => {
    state.channelMode = e.target.value;
    if (state.buffer) {
      applyChannelMode();
      waveform.computePeaks(state.monoSamples, 2000);
      waveform.render();
      state.altGrids = {}; state.scalogram = null;
      computeTrack();
    }
  });

  // Display controls.
  $('freqScale').addEventListener('change', (e) => { state.freqScale = e.target.value; applyDisplayParams(); renderCurrentMode(); });
  $('colorMap').addEventListener('change', (e) => { state.colorMap = e.target.value; applyDisplayParams(); renderCurrentMode(); });
  $('specStyle').addEventListener('change', (e) => { state.specStyle = e.target.value; applyDisplayParams(); renderCurrentMode(); });
  $('minDb').addEventListener('input', (e) => { state.minDb = +e.target.value; $('minDbLbl').textContent = state.minDb; applyDisplayParams(); renderCurrentMode(); });
  $('maxDb').addEventListener('input', (e) => { state.maxDb = +e.target.value; $('maxDbLbl').textContent = state.maxDb; applyDisplayParams(); renderCurrentMode(); });
  $('gamma').addEventListener('input', (e) => { state.gamma = +e.target.value; $('gammaLbl').textContent = state.gamma.toFixed(2); applyDisplayParams(); renderCurrentMode(); });
  $('gridChk').addEventListener('change', (e) => { state.grid = e.target.checked; applyDisplayParams(); });
  $('harmonicChk').addEventListener('change', (e) => { state.harmonic = e.target.checked; renderer.renderOverlay(); });

  ['tZoom','fZoom','tPan','fPan'].forEach(id => {
    $(id).addEventListener('input', () => { applyDisplayParams(); renderCurrentMode(); });
  });

  // Mode tabs.
  document.querySelectorAll('#modeTabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#modeTabs .tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mode = btn.dataset.mode;
      applyDisplayParams();
      renderCurrentMode();
    });
  });

  // Presets.
  const presets = {
    music: { fftSize: 2048, overlap: 0.75, windowFn: 'hann', minFreq: 30, maxFreq: 16000, minDb: -90, maxDb: -10, colorMap: 'magma', freqScale: 'log' },
    speech: { fftSize: 1024, overlap: 0.5, windowFn: 'hamming', minFreq: 50, maxFreq: 8000, minDb: -80, maxDb: -10, colorMap: 'viridis', freqScale: 'log' },
    hifi: { fftSize: 4096, overlap: 0.875, windowFn: 'blackman', minFreq: 20, maxFreq: 22000, minDb: -100, maxDb: -10, colorMap: 'turbo', freqScale: 'log' },
    transient: { fftSize: 512, overlap: 0.75, windowFn: 'hann', minFreq: 20, maxFreq: 20000, minDb: -70, maxDb: 0, colorMap: 'inferno', freqScale: 'linear' }
  };
  document.querySelectorAll('[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(presets[btn.dataset.preset]));
  });
  function applyPreset(p) {
    for (const k in p) state[k] = p[k];
    $('fftSize').value = p.fftSize;
    $('overlap').value = p.overlap;
    $('windowFn').value = p.windowFn;
    $('minFreq').value = p.minFreq;
    $('maxFreq').value = p.maxFreq;
    $('minDb').value = p.minDb; $('minDbLbl').textContent = p.minDb;
    $('maxDb').value = p.maxDb; $('maxDbLbl').textContent = p.maxDb;
    $('colorMap').value = p.colorMap;
    $('freqScale').value = p.freqScale;
    applyDisplayParams();
    audio.setBandLimits(state.minFreq, state.maxFreq);
    if (state.buffer) computeTrack();
  }

  // Waveform seek hook.
  waveform.onSeek = (pct) => {
    if (!state.buffer) return;
    audio.seek(pct * state.buffer.duration);
  };

  // Keyboard shortcuts.
  window.addEventListener('keydown', (e) => {
    if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); audio.seek(audio.getCurrentTime() - (e.shiftKey ? 1 : 5)); break;
      case 'ArrowRight': e.preventDefault(); audio.seek(audio.getCurrentTime() + (e.shiftKey ? 1 : 5)); break;
      case 'ArrowUp': e.preventDefault(); {
        const v = Math.min(1, +$('volume').value + 0.05);
        $('volume').value = v; audio.setVolume(v);
      } break;
      case 'ArrowDown': e.preventDefault(); {
        const v = Math.max(0, +$('volume').value - 0.05);
        $('volume').value = v; audio.setVolume(v);
      } break;
      case '+': case '=': $('fZoom').value = Math.min(8, +$('fZoom').value + 0.2); $('fZoom').dispatchEvent(new Event('input')); break;
      case '-': case '_': $('fZoom').value = Math.max(1, +$('fZoom').value - 0.2); $('fZoom').dispatchEvent(new Event('input')); break;
      case ']': $('tZoom').value = Math.min(20, +$('tZoom').value + 0.5); $('tZoom').dispatchEvent(new Event('input')); break;
      case '[': $('tZoom').value = Math.max(1, +$('tZoom').value - 0.5); $('tZoom').dispatchEvent(new Event('input')); break;
      case 'l': case 'L': {
        state.freqScale = state.freqScale === 'log' ? 'linear' : 'log';
        $('freqScale').value = state.freqScale;
        applyDisplayParams(); renderCurrentMode();
      } break;
      case 'm': case 'M': {
        const list = window.Colormaps.names;
        const idx = list.indexOf(state.colorMap);
        state.colorMap = list[(idx + 1) % list.length];
        $('colorMap').value = state.colorMap;
        applyDisplayParams(); renderCurrentMode();
      } break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 's': case 'S': if (!e.shiftKey) { audio.stop(); updatePlayUi(); } break;
      case 'a': case 'A': if (state.buffer) {
        state.loopAnchor = { a: audio.getCurrentTime() };
        status(`Loop A set at ${formatTime(state.loopAnchor.a)}`);
      } break;
      case 'b': case 'B': if (state.buffer && state.loopAnchor) {
        const b = audio.getCurrentTime();
        if (b > state.loopAnchor.a) {
          state.loop = { start: state.loopAnchor.a, end: b };
          $('loopChk').checked = true;
          waveform.setLoop(state.loop);
          renderer.setLoop(state.loop);
          status(`Loop ${formatTime(state.loop.start)} → ${formatTime(state.loop.end)}`, 'ok');
        }
      } break;
      case 'Escape': state.loop = null; state.loopAnchor = null; waveform.setLoop(null); renderer.setLoop(null); $('loopChk').checked = false; status('Loop cleared.'); break;
    }
  });

  $('loopChk').addEventListener('change', (e) => {
    if (!e.target.checked) { state.loop = null; waveform.setLoop(null); renderer.setLoop(null); }
  });

  // Fullscreen.
  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  }
  $('fullscreenBtn').addEventListener('click', toggleFullscreen);

  // Export PNG.
  $('exportBtn').addEventListener('click', () => {
    const url = specCanvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = (state.file ? state.file.name.replace(/\.[^.]+$/, '') : 'spectrogram') + '_' + state.mode + '.png';
    a.click();
  });

  // Help dialog.
  $('helpBtn').addEventListener('click', () => $('helpDialog').showModal());

  // dB legend.
  function drawLegend() {
    const host = $('dbLegend');
    host.innerHTML = '';
    const c = document.createElement('canvas');
    c.width = 180; c.height = 14;
    const cx = c.getContext('2d');
    const lut = window.Colormaps.LUTS[state.colorMap] || window.Colormaps.LUTS.viridis;
    const img = cx.createImageData(180, 14);
    for (let x = 0; x < 180; x++) {
      const t = x / 179;
      const ci = Math.min(255, Math.max(0, Math.floor((state.gamma !== 1 ? Math.pow(t, state.gamma) : t) * 255))) * 3;
      for (let y = 0; y < 14; y++) {
        const di = (y * 180 + x) * 4;
        img.data[di] = lut[ci]; img.data[di + 1] = lut[ci + 1]; img.data[di + 2] = lut[ci + 2]; img.data[di + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    const left = document.createElement('span'); left.textContent = state.minDb + ' dB';
    const right = document.createElement('span'); right.textContent = state.maxDb + ' dB';
    host.appendChild(left); host.appendChild(c); host.appendChild(right);
  }

  function formatTime(s) { return window.formatTime ? window.formatTime(s) : ''; }

  // ---------- Parametric EQ wiring ----------
  state.eq = new window.ParametricEQ(audio.ctx ? audio.ctx.sampleRate : 44100);

  function buildEqUi() {
    const host = $('eqControls');
    host.innerHTML = '';
    state.eq.bands.forEach((band, idx) => {
      const row = document.createElement('div');
      row.className = 'eq-band';
      row.innerHTML = `
        <input type="checkbox" ${band.enabled ? 'checked' : ''} data-k="enabled" title="Enable band"/>
        <div class="knob-group">
          <div class="knob">
            <span>Type</span>
            <select data-k="type">
              <option value="highpass">HP</option>
              <option value="lowpass">LP</option>
              <option value="bandpass">BP</option>
              <option value="notch">Notch</option>
              <option value="peaking">Peak</option>
              <option value="lowshelf">LoSh</option>
              <option value="highshelf">HiSh</option>
            </select>
          </div>
          <div class="knob">
            <span>Freq</span>
            <input type="number" min="10" max="22000" step="1" data-k="freq" value="${band.freq}"/>
          </div>
          <div class="knob">
            <span>Q</span>
            <input type="number" min="0.1" max="20" step="0.1" data-k="q" value="${band.q}"/>
          </div>
        </div>
        <div class="knob">
          <span>Gain (dB)</span>
          <input type="range" min="-24" max="24" step="0.1" data-k="gain" value="${band.gain}"/>
          <span class="gain-val">${band.gain.toFixed(1)}</span>
        </div>
      `;
      row.querySelector('select[data-k="type"]').value = band.type;
      row.addEventListener('input', () => {
        const cb = row.querySelector('input[type="checkbox"]');
        const typeEl = row.querySelector('select[data-k="type"]');
        const freqEl = row.querySelector('input[data-k="freq"]');
        const qEl = row.querySelector('input[data-k="q"]');
        const gainEl = row.querySelector('input[data-k="gain"]');
        band.enabled = cb.checked;
        band.type = typeEl.value;
        band.freq = Math.max(1, +freqEl.value || band.freq);
        band.q = Math.max(0.0001, +qEl.value || band.q);
        band.gain = +gainEl.value;
        row.querySelector('.gain-val').textContent = band.gain.toFixed(1);
        applyEq();
      });
      row.addEventListener('change', applyEq);
      host.appendChild(row);
    });
  }
  function applyEq() {
    audio.setEqBands(state.eq.bands, state.eq.bypass);
    drawEqCurveOverlay();
  }
  function drawEqCurveOverlay() {
    // The EQ curve is now drawn inside renderer.onOverlayDraw(), so any call
    // to renderer.renderOverlay() paints it automatically. We just trigger a
    // refresh so the curve appears immediately on knob changes.
    renderer.renderOverlay();
  }

  $('eqBypass').addEventListener('change', (e) => {
    state.eq.bypass = e.target.checked;
    applyEq();
  });
  $('eqReset').addEventListener('click', () => {
    state.eq.reset();
    buildEqUi();
    applyEq();
  });
  $('eqShowCurve').addEventListener('change', (e) => {
    state.eqShowCurve = e.target.checked;
    if (!state.eqShowCurve) renderer.renderOverlay();
    else drawEqCurveOverlay();
  });

  // ---------- Spectral brush wiring ----------
  $('brushToggle').addEventListener('click', () => {
    state.brushActive = !state.brushActive;
    $('brushToggle').classList.toggle('active-tool', state.brushActive);
    overlayCanvas.style.cursor = state.brushActive ? 'crosshair' : '';
    if (state.brushActive) {
      // Brush paints into STFT coordinates, so force the user back to the
      // STFT-spectrogram tab and the static full-track view. Scroll mode
      // overwrites every frame so paint strokes would flicker and disappear;
      // mel/chroma/scalogram/etc. use their own grids and can't render the
      // mask overlay. Switching keeps the mental model simple: "you paint
      // on what you see, you hear the edit".
      let switched = false;
      if (state.mode !== 'spectrogram') {
        state.mode = 'spectrogram';
        document.querySelectorAll('.mode-tabs .tab').forEach(t => {
          t.classList.toggle('active', t.dataset.mode === 'spectrogram');
        });
        switched = true;
      }
      if (state.specStyle !== 'static') {
        state.specStyle = 'static';
        $('specStyle').value = 'static';
        switched = true;
      }
      if (switched) { applyDisplayParams(); renderCurrentMode(); }
      const hint = state.mask
        ? 'Brush ON — drag on the spectrogram to paint, then Apply.'
        : 'Brush ON — load or play a file first, then paint.';
      status(hint, 'ok');
    } else {
      status('Brush OFF.');
    }
  });
  $('brushSize').addEventListener('input', (e) => { state.brushSize = +e.target.value; });
  $('brushGain').addEventListener('change', (e) => { state.brushGain = +e.target.value; });
  $('brushMode').addEventListener('change', (e) => {
    state.brushMode = e.target.value;
    // Auto-suggest a sensible gain for each mode.
    if (state.brushMode === 'amplify' && state.brushGain < 1) {
      state.brushGain = 2; $('brushGain').value = '2';
    } else if (state.brushMode === 'attenuate' && state.brushGain > 1) {
      state.brushGain = 0.5; $('brushGain').value = '0.5';
    }
    status(`Brush mode: ${state.brushMode}`);
  });
  $('brushHarmonicLock').addEventListener('change', (e) => {
    state.brushHarmonicLock = e.target.checked;
  });
  $('brushAutoSelect').addEventListener('change', (e) => {
    state.brushAutoSelect = e.target.checked;
    if (state.brushAutoSelect) status('Auto-select ON — double-click inside a bright region.');
  });
  $('brushClear').addEventListener('click', () => {
    if (state.mask) { state.mask.clear(); renderCurrentMode(); status('Brush mask cleared.'); }
  });
  $('brushApply').addEventListener('click', async () => {
    if (!state.buffer || !state.monoSamples) {
      status('Load an audio file first.', 'warn');
      return;
    }
    if (!state.mask || !state.mask.dirty) {
      const off = !state.brushActive ? ' Click "🖌 Brush" to enable the tool,' : '';
      status(`Nothing to apply yet.${off} then click-drag on the spectrogram to paint — you\u2019ll see a red tint where you paint. Then press Apply.`, 'warn');
      return;
    }
    await applyMaskAndReload();
  });
  $('audioRevert').addEventListener('click', () => {
    if (!state.originalBuffer) return;
    audio.replaceBuffer(state.originalBuffer, true);
    state.buffer = state.originalBuffer;
    applyChannelMode();
    state.monoSamples = new Float32Array(state.originalSamples);
    waveform.computePeaks(state.monoSamples, 2000);
    waveform.render();
    state.mask = null;
    state.hpsGrids = null;
    state.altGrids = {};
    state.scalogram = null;
    computeTrack();
    status('Reverted to original audio.', 'ok');
  });

  function applyMaskAndReload() {
    return new Promise((resolve) => {
      status('Resynthesizing edited audio (worker)…');
      const w = new Worker('js/workers/analysis-worker.js');
      const hop = state.track.hop;
      const samples = new Float32Array(state.monoSamples);
      const mask = new Float32Array(state.mask.data);
      const smoothMask = new Float32Array(state.mask.smooth);
      w.postMessage({
        cmd: 'render-masked',
        samples,
        sampleRate: state.buffer.sampleRate,
        fftSize: state.fftSize,
        hop,
        windowName: state.windowFn,
        mask,
        smoothMask,
      }, [samples.buffer, mask.buffer, smoothMask.buffer]);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') status(`Rendering (${m.stage})… ${(m.p * 100).toFixed(0)}%`);
        else if (m.type === 'render-done') {
          const newBuf = audio.samplesToBuffer(m.rendered, m.sampleRate);
          audio.replaceBuffer(newBuf, true);
          state.buffer = newBuf;
          applyChannelMode();
          waveform.computePeaks(state.monoSamples, 2000);
          waveform.render();
          state.altGrids = {};
          state.scalogram = null;
          computeTrack().then(() => { status('Edit applied.', 'ok'); resolve(); });
          w.terminate();
        } else if (m.type === 'error') {
          status('Render error: ' + m.message, 'error');
          w.terminate(); resolve();
        }
      };
    });
  }

  // ---------- Harmonic-Percussive Separation wiring ----------
  function runHps(renderKind) {
    if (!state.buffer || !state.monoSamples) { status('Load audio first.', 'warn'); return; }
    status('Analyzing HPS (worker)…');
    const w = new Worker('js/workers/analysis-worker.js');
    const hop = state.track ? state.track.hop : Math.max(1, Math.round(state.fftSize * (1 - state.overlap)));
    const samples = new Float32Array(state.monoSamples);
    const kernel = +$('hpsKernel').value;
    w.postMessage({
      cmd: 'hps',
      samples, sampleRate: state.buffer.sampleRate,
      fftSize: state.fftSize, hop, windowName: state.windowFn,
      kernelH: kernel, kernelP: kernel,
      render: renderKind || null
    }, [samples.buffer]);
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') status(`HPS (${m.stage})… ${(m.p * 100).toFixed(0)}%`);
      else if (m.type === 'hps-done') {
        state.hpsGrids = {
          gridH: m.gridH, gridP: m.gridP,
          nFrames: m.nFrames, nBins: m.nBins,
          minDb: m.minDb, maxDb: m.maxDb
        };
        if (m.rendered) {
          const newBuf = audio.samplesToBuffer(m.rendered, m.renderedSampleRate);
          audio.replaceBuffer(newBuf, true);
          state.buffer = newBuf;
          applyChannelMode();
          waveform.computePeaks(state.monoSamples, 2000);
          waveform.render();
          state.altGrids = {};
          state.scalogram = null;
          status(`HPS complete — playing ${renderKind} component. Use "Revert audio" to restore.`, 'ok');
          computeTrack();
        } else {
          status('HPS complete. Switch to Harmonic/Percussive mode to view.', 'ok');
          renderCurrentMode();
        }
        w.terminate();
      } else if (m.type === 'error') {
        status('HPS error: ' + m.message, 'error');
        w.terminate();
      }
    };
  }
  $('hpsAnalyze').addEventListener('click', () => runHps(null));
  $('hpsHarmonic').addEventListener('click', () => runHps('harmonic'));
  $('hpsPercussive').addEventListener('click', () => runHps('percussive'));

  // ---------- Reset button ----------
  // Full reset: restore every control, analysis setting, EQ, brush, HPS state,
  // loop, zoom/pan, and audio buffer — while keeping playback going if it was
  // already playing (at roughly the same position).
  function resetConfigToDefaults() {
    const d = DEFAULTS;
    const wasPlaying = audio.playing;
    const posSec = audio.getCurrentTime();

    // Wipe all mutation state: brush mask, HPS, alt grids, scalogram, loop points.
    if (state.mask) state.mask.clear();
    state.hpsGrids = null;
    state.altGrids = {};
    state.scalogram = null;
    state.loop = null;
    state.loopAnchor = null;
    waveform.setLoop(null);
    renderer.setLoop(null);
    $('loopChk').checked = false;

    // Revert audio buffer if it was edited (HPS isolate / spectral apply).
    if (state.originalBuffer && state.buffer !== state.originalBuffer) {
      audio.replaceBuffer(state.originalBuffer, true);
      state.buffer = state.originalBuffer;
      applyChannelMode();
      state.monoSamples = new Float32Array(state.originalSamples);
      waveform.computePeaks(state.monoSamples, 2000);
    }

    // Apply defaults to state.
    Object.assign(state, {
      mode: d.mode, specStyle: d.specStyle,
      fftSize: d.fftSize, overlap: d.overlap, windowFn: d.windowFn,
      smoothing: d.smoothing, minFreq: d.minFreq, maxFreq: d.maxFreq,
      channelMode: d.channelMode, freqScale: d.freqScale, colorMap: d.colorMap,
      minDb: d.minDb, maxDb: d.maxDb, gamma: d.gamma, grid: d.grid, harmonic: d.harmonic,
      brushSize: 20, brushGain: 0.5, eqShowCurve: true,
    });

    // Sync every DOM control.
    $('fftSize').value = String(d.fftSize);
    $('overlap').value = String(d.overlap);
    $('windowFn').value = d.windowFn;
    $('smoothing').value = String(d.smoothing);
    $('minFreq').value = String(d.minFreq);
    $('maxFreq').value = String(d.maxFreq);
    $('channelMode').value = d.channelMode;
    $('freqScale').value = d.freqScale;
    $('colorMap').value = d.colorMap;
    $('specStyle').value = d.specStyle;
    $('minDb').value = String(d.minDb); $('minDbLbl').textContent = String(d.minDb);
    $('maxDb').value = String(d.maxDb); $('maxDbLbl').textContent = String(d.maxDb);
    $('gamma').value = String(d.gamma); $('gammaLbl').textContent = d.gamma.toFixed(2);
    $('gridChk').checked = d.grid;
    $('harmonicChk').checked = d.harmonic;
    $('tZoom').value = String(d.tZoom);
    $('fZoom').value = String(d.fZoom);
    $('tPan').value = String(d.tPan);
    $('fPan').value = String(d.fPan);
    $('volume').value = String(d.volume); audio.setVolume(d.volume);
    $('rate').value = String(d.rate); audio.setRate(d.rate);
    $('rateLabel').textContent = d.rate.toFixed(2) + '×';
    $('brushSize').value = '20';
    $('brushGain').value = '0.5';
    audio.setSmoothing(d.smoothing);
    audio.setAnalyserFFTSize(d.fftSize);
    audio.setBandLimits(d.minFreq, d.maxFreq);

    // Reset mode tabs.
    document.querySelectorAll('#modeTabs .tab').forEach(b => b.classList.toggle('active', b.dataset.mode === d.mode));

    // Reset EQ.
    if (state.eq) { state.eq.reset(); buildEqUi(); applyEq(); }
    $('eqBypass').checked = false;
    $('eqShowCurve').checked = true;

    // Turn brush off.
    if (state.brushActive) {
      state.brushActive = false;
      $('brushToggle').classList.remove('active-tool');
      overlayCanvas.style.cursor = '';
    }

    // Reset HPS kernel dropdown.
    $('hpsKernel').value = '17';

    applyDisplayParams();

    // Kick off re-analysis (non-blocking). Audio keeps playing the whole time:
    // either it continued naturally (original buffer) or replaceBuffer already
    // resumed playback at posSec (edited buffer).
    if (state.buffer) {
      computeTrack();
    } else {
      renderCurrentMode();
    }
    // Suppress "unused var" lint — wasPlaying/posSec are used via replaceBuffer above.
    void wasPlaying; void posSec;
    status('Settings reset to defaults.', 'ok');
  }
  $('resetBtn').addEventListener('click', resetConfigToDefaults);

  // ---------- Pro features wiring ----------
  //
  // Loudness / peak / key+BPM analysis runs on demand ("Analyze track" button),
  // not on every file load — it's expensive for long files and not always
  // needed. Live LUFS meter uses AnalyserNode's time-domain data and degrades
  // gracefully (approximate, since we can't guarantee non-overlap between ticks).
  state.pro = {
    report: null,          // Full metering report (Metering.analyzeBuffer).
    keyTempo: null,        // { chroma, key, tempo }
    lastReportFile: null,
    running: null,         // RunningLufs for live meters
    tickCounter: 0,
    timeDomain: null
  };

  function formatLufs(v) {
    if (v == null || !isFinite(v)) return '—';
    return v.toFixed(1) + ' LUFS';
  }
  function formatDb(v, unit) {
    if (v == null || !isFinite(v)) return '—';
    return v.toFixed(1) + ' ' + (unit || 'dB');
  }
  function formatLu(v) {
    if (v == null || !isFinite(v)) return '—';
    return v.toFixed(1) + ' LU';
  }

  function updateProReadouts() {
    const r = state.pro.report;
    const kt = state.pro.keyTempo;
    if (r) {
      $('mLufsI').textContent = formatLufs(r.integratedLufs);
      $('mLufsM').textContent = formatLufs(r.momentaryMaxLufs);
      $('mLufsS').textContent = formatLufs(r.shortTermMaxLufs);
      $('mLra').textContent = formatLu(r.loudnessRange);
      $('mTP').textContent = formatDb(r.truePeakDb, 'dBTP');
      $('mSP').textContent = formatDb(r.samplePeakDb, 'dBFS');
      $('mCorr').textContent = r.stereoCorrelation != null
        ? r.stereoCorrelation.toFixed(2)
        : 'mono';
      $('mWidth').textContent = r.midSide
        ? r.midSide.widthPct.toFixed(0) + '%'
        : '—';
      $('mNoise').textContent = formatDb(r.noiseFloorDb, 'dBFS');
    }
    if (kt) {
      $('mKey').textContent = kt.key.label;
      $('mBpm').textContent = kt.tempo.label;
    }
    // Update compliance if we have a report.
    if (r) refreshCompliance();
  }

  function refreshCompliance() {
    const targetEl = $('complianceTarget');
    const target = targetEl ? targetEl.value : 'spotify';
    const host = $('complianceChecks');
    if (!host) return;
    if (!state.pro.report) {
      host.innerHTML = '<span class="small">Run &ldquo;Analyze track&rdquo; to check compliance.</span>';
      return;
    }
    const res = window.Compliance.evaluateTarget(target, state.pro.report);
    if (!res) { host.textContent = 'Unknown target.'; return; }
    const rows = res.checks.map((c) => {
      const val = (c.measured != null && isFinite(c.measured))
        ? c.measured.toFixed(1) + ' ' + c.unit
        : 'n/a';
      const badge = c.pass
        ? '<span class="compliance-badge pass">PASS</span>'
        : '<span class="compliance-badge fail">FAIL</span>';
      return `<div class="compliance-row">
        <span class="check-name" title="${c.reason || ''}">${c.name}</span>
        <span class="check-val">${val}</span>
        ${badge}
      </div>`;
    }).join('');
    host.innerHTML = rows;
  }

  async function runProAnalysis() {
    if (!state.buffer) { showError('Load an audio file first.'); return; }
    if (!state.track || !state.track.rawMags) {
      status('Waiting for track STFT to finish…');
      // Best-effort: recompute if missing.
      await computeTrack();
      if (!state.track || !state.track.rawMags) {
        status('Analysis unavailable (STFT missing).', 'error');
        return;
      }
    }
    status('Running Pro analysis…');
    // Yield so the status paints.
    await new Promise((r) => setTimeout(r, 16));
    try {
      const t0 = performance.now();
      // Extract channel data from buffer.
      const chans = [];
      const nC = state.buffer.numberOfChannels;
      for (let c = 0; c < nC; c++) chans.push(state.buffer.getChannelData(c));
      const report = window.Metering.analyzeBuffer(chans, state.buffer.sampleRate);
      const keyTempo = window.KeyTempo.analyzeTrack(
        state.track.rawMags,
        state.buffer.sampleRate,
        state.track.hop
      );
      state.pro.report = report;
      state.pro.keyTempo = keyTempo;
      state.pro.lastReportFile = state.file ? state.file.name : null;
      updateProReadouts();
      const dt = performance.now() - t0;
      status(`Pro analysis complete (${dt.toFixed(0)} ms).`, 'ok');
    } catch (err) {
      console.error(err);
      status('Pro analysis error: ' + (err.message || err), 'error');
    }
  }
  $('proRun').addEventListener('click', runProAnalysis);
  $('complianceTarget').addEventListener('change', refreshCompliance);

  // Download compliance HTML report.
  $('complianceExport').addEventListener('click', () => {
    if (!state.pro.report) { showError('Run "Analyze track" first.'); return; }
    const target = $('complianceTarget').value;
    const res = window.Compliance.evaluateTarget(target, state.pro.report);
    const all = window.Compliance.evaluateAll(state.pro.report);
    const title = `Compliance Report — ${res ? res.label : 'All targets'}`;
    const html = window.Compliance.renderHtml(title, state.pro.report, all, {
      filename: state.pro.lastReportFile || (state.file && state.file.name)
    });
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compliance_${(state.file && state.file.name || 'track').replace(/\.[^.]+$/, '')}.html`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  // ---------- Restoration presets ----------
  //
  // Each button builds a mask for the selected preset and merges it into the
  // current state.mask. The user can then press "Apply" in the Brush toolbar
  // to hear the ISTFT-rendered result (same code path as the brush edits).
  function applyRestorationPreset(kind) {
    if (!state.track || !state.track.rawMags) {
      showError('Track not analyzed yet — please wait for STFT to finish.');
      return;
    }
    if (!state.mask) {
      state.mask = new window.SpectralMask(
        state.track.nFrames,
        (state.track.fftSize / 2) + 1
      );
    }
    const sr = state.buffer.sampleRate;
    const mags = state.track.rawMags;
    let built = null;
    try {
      switch (kind) {
        case 'hum': {
          const mains = parseInt($('restHumMains').value, 10) || 0;
          built = window.Restoration.buildHumMask(mags, sr, {
            mainsHz: mains > 0 ? mains : 0,
            harmonics: 10
          });
          break;
        }
        case 'rumble': {
          const hz = parseInt($('restRumbleHz').value, 10) || 80;
          built = window.Restoration.buildRumbleMask(mags, sr, {
            cutoffHz: hz, widthHz: 20
          });
          break;
        }
        case 'hiss':
          built = window.Restoration.buildHissMask(mags, sr, { minHz: 3000 });
          break;
        case 'deess':
          built = window.Restoration.buildDeessMask(mags, sr);
          break;
        case 'declick':
          built = window.Restoration.buildDeclickMask(mags, sr);
          break;
      }
    } catch (err) {
      console.error(err);
      showError('Preset failed: ' + (err.message || err));
      return;
    }
    if (!built) return;
    // Merge into state.mask.data.
    const mask = state.mask;
    if (built.data.length !== mask.data.length) {
      showError('Mask shape mismatch — try resetting FFT size.');
      return;
    }
    for (let i = 0; i < mask.data.length; i++) mask.data[i] *= built.data[i];
    if (built.smooth) {
      for (let i = 0; i < mask.smooth.length; i++) {
        mask.smooth[i] = Math.max(mask.smooth[i], built.smooth[i]);
      }
    }
    mask.dirty = true;
    $('restStatus').textContent = built.description + ' · press Apply to render';
    renderCurrentMode();
  }
  document.querySelectorAll('[data-rest]').forEach((btn) => {
    btn.addEventListener('click', () => applyRestorationPreset(btn.dataset.rest));
  });

  // ---------- Live LUFS meters ----------
  //
  // We read the analyser's time-domain buffer once per tick and push it into a
  // RunningLufs instance. Because AnalyserNode gives us the most recent
  // fftSize samples each time (not just the fresh ones), there is some overlap
  // — the meter is an approximation, not an EBU-accurate reference. Good
  // enough for monitoring.
  function ensureRunningLufs() {
    if (!state.buffer) return;
    const sr = state.buffer.sampleRate;
    if (!state.pro.running || state.pro.running.sampleRate !== sr) {
      state.pro.running = new window.Metering.RunningLufs(sr);
    }
  }
  function updateLiveMeters() {
    if (!audio.analyser || !audio.playing) return;
    ensureRunningLufs();
    const n = audio.analyser.fftSize;
    if (!state.pro.timeDomain || state.pro.timeDomain.length !== n) {
      state.pro.timeDomain = new Float32Array(n);
    }
    audio.analyser.getFloatTimeDomainData(state.pro.timeDomain);
    // Push into RunningLufs (treat as single channel — the analyser is
    // post-mix on the master bus).
    state.pro.running.push(state.pro.timeDomain, null);
    // Update UI once every 6 ticks (~100 ms) to keep cost low.
    state.pro.tickCounter = (state.pro.tickCounter + 1) % 6;
    if (state.pro.tickCounter !== 0) return;
    const m = state.pro.running.momentary();
    const s = state.pro.running.shortTerm();
    const p = state.pro.running.peakDb();
    $('mLiveM').textContent = formatLufs(m);
    $('mLiveS').textContent = formatLufs(s);
    $('mLivePk').textContent = formatDb(p, 'dBFS');
  }
  // Hook into the existing tick loop by extending it — call on every RAF.
  (function attachLiveMeters() {
    const origTick = tick;
    // We can't override `tick`; instead piggy-back via our own RAF loop that
    // cooperates with the renderer's clock. Throttled update:
    let last = 0;
    function liveLoop(ts) {
      if (ts - last > 40) {
        try { updateLiveMeters(); } catch (_) {}
        last = ts;
      }
      requestAnimationFrame(liveLoop);
    }
    requestAnimationFrame(liveLoop);
    void origTick;
  })();

  // When the user clicks stop/pause, reset the live meter display.
  audio.onPlayStateChange = ((prev) => (playing) => {
    if (typeof prev === 'function') prev(playing);
    if (!playing) {
      $('mLiveM').textContent = '—';
      $('mLiveS').textContent = '—';
      $('mLivePk').textContent = '—';
      if (state.pro.running) state.pro.running.reset();
    }
  })(audio.onPlayStateChange);

  // ---------- Anomaly scan ----------
  state.anomaly = { report: null };

  function formatTime(t) {
    const m = Math.floor(t / 60);
    const s = (t - m * 60).toFixed(1);
    return m + ':' + (parseFloat(s) < 10 ? '0' : '') + s;
  }
  function formatHz(hz) {
    if (hz >= 1000) return (hz / 1000).toFixed(2) + ' kHz';
    return hz.toFixed(1) + ' Hz';
  }

  function runAnomalyScan() {
    if (!state.track || !state.track.rawMags) {
      status('Load a file first.', 'error');
      return;
    }
    status('Scanning for anomalies…');
    // Defer to next tick so the status message paints first.
    setTimeout(() => {
      try {
        const rep = window.Anomaly.scanTrack({
          rawMags: state.track.rawMags,
          buffer: state.buffer,
          packedGrid: state.track.grid,
          nFrames: state.track.nFrames,
          nBins: state.track.nBins,
          sampleRate: state.track.sampleRate,
          fftSize: state.track.fftSize,
          hop: state.track.hop
        });
        state.anomaly.report = rep;
        renderAnomalyReport(rep);
        status('Anomaly scan complete.', 'ok');
      } catch (err) {
        console.error(err);
        status('Anomaly scan failed: ' + (err.message || err), 'error');
      }
    }, 30);
  }

  function renderAnomalyReport(rep) {
    $('anomalyCards').style.display = '';
    // --- Ultrasonic card
    const u = rep.ultrasonic || {};
    if (u.available) {
      $('aUltraFlag').textContent = u.significant ? 'YES (significant)' : (u.hasContent ? 'Yes (minor)' : 'No');
      $('aUltraFlag').className = u.significant ? 'anomaly-verdict suspect' : (u.hasContent ? 'anomaly-verdict minor' : 'anomaly-verdict clean');
      $('aUltraFrac').textContent = (u.fraction * 100).toFixed(2) + '%';
      $('aUltraPeak').textContent = u.peakDb > -120 ? u.peakDb.toFixed(1) + ' dB' : '—';
      $('aUltraFreq').textContent = u.peakFreq > 0 ? formatHz(u.peakFreq) : '—';
    } else {
      $('aUltraFlag').textContent = 'n/a';
      $('aUltraFrac').textContent = '—';
      $('aUltraPeak').textContent = '—';
      $('aUltraFreq').textContent = '—';
    }
    // --- Sustained tones
    const tones = rep.tones || [];
    $('aTonesCount').textContent = String(tones.length);
    const tonesList = $('aTonesList');
    tonesList.innerHTML = '';
    tones.slice(0, 12).forEach((t) => {
      const dur = t.endT - t.startT;
      const row = document.createElement('div');
      row.className = 'anomaly-row';
      row.innerHTML =
        '<span>' + formatHz(t.freq) + ' · ' + dur.toFixed(1) + 's · ' + t.meanDb.toFixed(0) + ' dB</span>' +
        '<button class="seek" data-seek="' + t.startT.toFixed(2) + '">▶ ' + formatTime(t.startT) + '</button>';
      tonesList.appendChild(row);
    });
    // --- Bursts
    const bursts = rep.bursts || [];
    $('aBurstsCount').textContent = String(bursts.length);
    const burstsList = $('aBurstsList');
    burstsList.innerHTML = '';
    bursts.slice(0, 12).forEach((b) => {
      const row = document.createElement('div');
      row.className = 'anomaly-row';
      row.innerHTML =
        '<span>' + formatTime(b.t) + ' · ' + (b.durationMs).toFixed(0) + ' ms · z=' + b.zScore.toFixed(1) + '</span>' +
        '<button class="seek" data-seek="' + b.t.toFixed(2) + '">▶</button>';
      burstsList.appendChild(row);
    });
    // --- LSB
    const lsb = rep.lsb || {};
    if (lsb.available) {
      $('aLsbZ').textContent = lsb.zScore.toFixed(2);
      $('aLsbAc').textContent = lsb.lsbAutocorr.toFixed(3);
      $('aLsbVerdict').textContent = lsb.verdict;
      $('aLsbVerdict').className = lsb.suspicious ? 'anomaly-verdict suspect' : 'anomaly-verdict clean';
    } else {
      $('aLsbZ').textContent = 'n/a';
      $('aLsbAc').textContent = 'n/a';
      $('aLsbVerdict').textContent = lsb.reason || 'not run';
    }
    // --- Geometry
    const g = rep.geometry || {};
    $('aGeoEdge').textContent = g.edgeDensity != null ? (g.edgeDensity * 100).toFixed(1) + '%' : '—';
    $('aGeoEnt').textContent = g.orientationEntropy != null ? g.orientationEntropy.toFixed(2) : '—';
    $('aGeoHot').textContent = g.hotSpots ? String(g.hotSpots.length) : '—';
    // --- Summary
    const s = rep.summary || {};
    $('aScore').textContent = (s.score * 100).toFixed(0) + '%';
    const verdict =
      s.score >= 0.6 ? { text: 'Highly suspicious', cls: 'suspect' } :
      s.score >= 0.35 ? { text: 'Suspicious', cls: 'suspect' } :
      s.score >= 0.1 ? { text: 'Minor anomalies', cls: 'minor' } :
      { text: 'Natural-looking', cls: 'clean' };
    $('aVerdict').textContent = verdict.text;
    $('aVerdict').className = 'anomaly-verdict ' + verdict.cls;
    $('aNotes').innerHTML = (s.notes || []).map((n) =>
      '<div style="padding:1px 0;">• ' + n.replace(/</g, '&lt;') + '</div>').join('');

    // Summary strip at the top of the panel.
    const sumEl = $('anomalySummary');
    sumEl.innerHTML = '';
    const scoreBadge = document.createElement('span');
    scoreBadge.className = 'compliance-badge ' + (s.suspicious ? 'fail' : 'pass');
    scoreBadge.textContent = s.suspicious ? 'FLAGGED' : 'CLEAN';
    sumEl.appendChild(scoreBadge);
    const scoreText = document.createElement('span');
    scoreText.className = 'small';
    scoreText.style.marginLeft = '8px';
    scoreText.textContent = verdict.text + ' · score ' + (s.score * 100).toFixed(0) + '%';
    sumEl.appendChild(scoreText);
  }

  $('anomalyRun').addEventListener('click', runAnomalyScan);

  // Clicking a "seek" button jumps playback to that time.
  $('anomalyCards').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-seek]');
    if (!btn || !state.buffer) return;
    const t = parseFloat(btn.dataset.seek);
    if (!Number.isFinite(t)) return;
    audio.seek(t);
  });

  // Quick-range buttons.
  $('anomalyUltra').addEventListener('click', () => {
    if (!state.buffer) return;
    const nyq = state.buffer.sampleRate / 2;
    if (nyq <= 20000) {
      status('Ultrasonic view requires a file with sample rate > 40 kHz.', 'error');
      return;
    }
    state.minFreq = 18000;
    state.maxFreq = Math.floor(nyq);
    $('minFreq').value = String(state.minFreq);
    $('maxFreq').value = String(state.maxFreq);
    audio.setBandLimits(state.minFreq, state.maxFreq);
    applyDisplayParams();
    renderCurrentMode();
  });
  $('anomalyFull').addEventListener('click', () => {
    state.minFreq = 20;
    state.maxFreq = 20000;
    $('minFreq').value = '20';
    $('maxFreq').value = '20000';
    audio.setBandLimits(state.minFreq, state.maxFreq);
    applyDisplayParams();
    renderCurrentMode();
  });

  // ---------- Hunt mode: cinematic sweep through anomaly hotspots ----------
  // After a scan, build a sorted list of {t, label, freq?} entries and
  // auto-seek / loop through each for a configurable dwell time. Lets
  // researchers + short-attention-span users eyeball everything the scanner
  // found without manually clicking through the lists.
  state.hunt = { active: false, tick: null, list: [], idx: 0, startedAt: 0 };
  const huntBtn = $('anomalyHunt');
  function buildHuntList(rep) {
    const list = [];
    (rep.tones || []).forEach(t => list.push({
      t: t.startT, label: 'Tone ' + formatHz(t.freq),
      freq: t.freq, dwell: Math.min(3, t.endT - t.startT + 0.5)
    }));
    (rep.bursts || []).forEach(b => list.push({
      t: b.t, label: 'Burst ' + (b.durationMs | 0) + 'ms', freq: b.peakFreq, dwell: 1.4
    }));
    if (rep.ultrasonic && rep.ultrasonic.hasContent && state.buffer && state.buffer.duration > 0.5) {
      list.push({
        t: Math.min(state.buffer.duration - 0.5, 0.5),
        label: 'Ultrasonic ' + formatHz(rep.ultrasonic.peakFreq || 18000),
        freq: rep.ultrasonic.peakFreq, dwell: 2.5, ultra: true
      });
    }
    (rep.geometry && rep.geometry.hotSpots || []).slice(0, 4).forEach(h => {
      if (h && h.time != null) list.push({
        t: h.time, label: 'Geometry hotspot @ ' + formatHz(h.freq),
        freq: h.freq, dwell: 1.6
      });
    });
    list.sort((a, b) => a.t - b.t);
    return list;
  }
  function stopHunt() {
    state.hunt.active = false;
    if (state.hunt.tick) { clearTimeout(state.hunt.tick); state.hunt.tick = null; }
    if (huntBtn) huntBtn.textContent = '🎯 Play hunt';
    status('Hunt stopped.', 'ok');
  }
  function stepHunt() {
    const h = state.hunt;
    if (!h.active) return;
    if (h.idx >= h.list.length) { stopHunt(); status('Hunt complete.', 'ok'); return; }
    const item = h.list[h.idx++];
    // Isolate frequency band around this anomaly.
    const sr = state.buffer ? state.buffer.sampleRate : 48000;
    if (item.freq && isFinite(item.freq)) {
      const f = item.freq;
      const halfOct = f > 4000 ? 0.33 : 0.5;
      const low = Math.max(20, Math.round(f / Math.pow(2, halfOct)));
      const high = Math.min(Math.floor(sr / 2), Math.round(f * Math.pow(2, halfOct)));
      state.minFreq = low;
      state.maxFreq = high;
      $('minFreq').value = String(low);
      $('maxFreq').value = String(high);
      audio.setBandLimits(low, high);
      applyDisplayParams();
    }
    audio.seek(item.t);
    audio.play();
    status(`Hunt ${h.idx}/${h.list.length}: ${item.label} @ ${formatTime(item.t)}`, 'ok');
    h.tick = setTimeout(stepHunt, Math.max(600, item.dwell * 1000));
  }
  function startHunt() {
    const rep = state.anomaly && state.anomaly.report;
    if (!rep) { status('Run an anomaly scan first.', 'error'); return; }
    const list = buildHuntList(rep);
    if (!list.length) { status('Nothing to hunt — no hotspots in this track.', 'ok'); return; }
    state.hunt = { active: true, tick: null, list, idx: 0, startedAt: performance.now() };
    if (huntBtn) huntBtn.textContent = '⏹ Stop hunt';
    stepHunt();
  }
  if (huntBtn) huntBtn.addEventListener('click', () => {
    if (state.hunt.active) stopHunt(); else startHunt();
  });

  // Enable/disable the hunt button once a report exists.
  const _origRenderAnomaly = renderAnomalyReport;
  renderAnomalyReport = function(rep) {
    _origRenderAnomaly(rep);
    if (huntBtn) {
      const nHot = (rep.tones || []).length + (rep.bursts || []).length +
        ((rep.ultrasonic && rep.ultrasonic.hasContent) ? 1 : 0) +
        Math.min(4, (rep.geometry && rep.geometry.hotSpots || []).length);
      huntBtn.disabled = nHot === 0;
      huntBtn.textContent = nHot ? `🎯 Play hunt (${nHot})` : '🎯 Play hunt';
    }
  };

  // ---------- Clip recorder: capture canvas + audio as .webm ----------
  // Uses MediaRecorder + canvas.captureStream. Audio is tapped from the
  // engine's destination via a MediaStreamAudioDestinationNode the first time
  // recording is requested.
  state.recorder = { mr: null, chunks: [], timer: null, startedAt: 0 };
  const recBtn = $('recordBtn');
  const recInd = $('recIndicator');
  const recLbl = $('recLabel');

  function ensureRecAudioTap() {
    if (!audio.ctx) audio.ensureCtx();
    if (!audio._recDest) {
      audio._recDest = audio.ctx.createMediaStreamDestination();
      // Tap the chain just before the speakers so effects + EQ are included.
      // The engine's AnalyserNode connects to ctx.destination; additionally
      // connect it to the recorder destination.
      if (audio.analyser) {
        try { audio.analyser.connect(audio._recDest); } catch (e) { /* already connected */ }
      }
    }
    return audio._recDest;
  }

  function updateRecLabel() {
    if (!state.recorder.mr || state.recorder.mr.state !== 'recording') return;
    const sec = Math.floor((performance.now() - state.recorder.startedAt) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    if (recLbl) recLbl.textContent = `REC ${mm}:${ss}`;
  }

  async function startRecording() {
    if (!state.buffer) { status('Load audio first, then record.', 'error'); return; }
    if (state.recorder.mr && state.recorder.mr.state === 'recording') return;
    try {
      const stream = specCanvas.captureStream(30);
      const audDest = ensureRecAudioTap();
      audDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
      const mimeCandidates = [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
      ];
      const mime = mimeCandidates.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
      if (!mime) throw new Error('MediaRecorder not supported in this browser');
      const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
      state.recorder.mr = mr;
      state.recorder.chunks = [];
      state.recorder.startedAt = performance.now();
      mr.ondataavailable = (e) => { if (e.data && e.data.size) state.recorder.chunks.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(state.recorder.chunks, { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const basename = (state.file && state.file.name || 'spectrogram').replace(/\.[^.]+$/, '');
        a.href = url;
        a.download = basename + '_clip.webm';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        if (recBtn) { recBtn.textContent = '● Rec clip'; recBtn.classList.remove('recording'); }
        if (recInd) recInd.classList.remove('visible');
        if (state.recorder.timer) { clearInterval(state.recorder.timer); state.recorder.timer = null; }
        status('Clip downloaded.', 'ok');
      };
      mr.start(250);
      state.recorder.timer = setInterval(updateRecLabel, 500);
      if (recBtn) { recBtn.textContent = '⏹ Stop rec'; recBtn.classList.add('recording'); }
      if (recInd) recInd.classList.add('visible');
      if (!audio.playing) audio.play();
      status('Recording clip — press "⏹ Stop rec" when done.', 'ok');
    } catch (err) {
      console.error(err);
      status('Recording failed: ' + (err.message || err), 'error');
    }
  }
  function stopRecording() {
    if (state.recorder.mr && state.recorder.mr.state === 'recording') {
      state.recorder.mr.stop();
    }
  }
  if (recBtn) recBtn.addEventListener('click', () => {
    if (state.recorder.mr && state.recorder.mr.state === 'recording') stopRecording();
    else startRecording();
  });

  // Initial setup.
  audio.ensureCtx();
  state.eq.setSampleRate(audio.ctx.sampleRate);
  buildEqUi();
  applyEq();
  resizeAll();
  drawLegend();
  status('Load an audio file to begin.');
})();
