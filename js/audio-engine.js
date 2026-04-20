// Audio engine: decodes files, plays back using a BufferSource, and tracks
// precise playback time. Exposes real-time frequency data via AnalyserNode for
// the live spectrum bars. Spectrogram rendering uses the raw AudioBuffer so it
// stays perfectly in sync with the clock-derived play position.
(function (global) {
  'use strict';

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.buffer = null;
      this.source = null;
      this.gainNode = null;
      this.analyser = null;
      this.playing = false;
      this.startedAt = 0;       // AudioContext.currentTime when play started
      this.offset = 0;          // seconds into the buffer where we started
      this.rate = 1;
      this.onEnded = null;
      this.onPlayStateChange = null;
      this.duration = 0;
      this.sampleRate = 44100;
      this.loop = null;         // {start, end} in seconds or null
    }

    ensureCtx() {
      if (!this.ctx) {
        const Ctx = global.AudioContext || global.webkitAudioContext;
        this.ctx = new Ctx({ latencyHint: 'interactive' });
        this.gainNode = this.ctx.createGain();
        // Band-limit filters: two cascaded Butterworth biquads each side give
        // a 24 dB/oct Linkwitz-Riley-style rolloff. They make the min/max
        // frequency inputs actually audible — content outside the window is
        // removed from playback, not just from the visualisation.
        this.bandHp1 = this.ctx.createBiquadFilter();
        this.bandHp2 = this.ctx.createBiquadFilter();
        this.bandLp1 = this.ctx.createBiquadFilter();
        this.bandLp2 = this.ctx.createBiquadFilter();
        this.bandHp1.type = 'highpass';
        this.bandHp2.type = 'highpass';
        this.bandLp1.type = 'lowpass';
        this.bandLp2.type = 'lowpass';
        this.bandHp1.Q.value = 0.707;
        this.bandHp2.Q.value = 0.707;
        this.bandLp1.Q.value = 0.707;
        this.bandLp2.Q.value = 0.707;
        this.bandHp1.frequency.value = 1;             // effectively bypassed
        this.bandHp2.frequency.value = 1;
        this.bandLp1.frequency.value = this.ctx.sampleRate / 2 - 1;
        this.bandLp2.frequency.value = this.ctx.sampleRate / 2 - 1;
        this.eqInput = this.ctx.createGain();  // pre-EQ splitter
        this.eqOutput = this.ctx.createGain(); // post-EQ collector
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.6;
        // Default: no EQ nodes in between; eqInput -> eqOutput direct.
        this.eqNodes = [];
        // Chain:
        //   source → gain → HP → HP → LP → LP → eqInput → [EQ chain] → eqOutput → analyser → destination
        this.gainNode.connect(this.bandHp1);
        this.bandHp1.connect(this.bandHp2);
        this.bandHp2.connect(this.bandLp1);
        this.bandLp1.connect(this.bandLp2);
        this.bandLp2.connect(this.eqInput);
        this.eqInput.connect(this.eqOutput);
        this.eqOutput.connect(this.analyser);
        this.analyser.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    // Band-limit playback to [minHz, maxHz]. Frequencies outside the window
    // are physically removed from the output by a 4th-order HP + 4th-order
    // LP cascade (24 dB/oct each side). Called when the user edits the
    // min/max frequency inputs or a preset is applied.
    setBandLimits(minHz, maxHz) {
      if (!this.ctx || !this.bandHp1) return;
      const nyq = (this.ctx.sampleRate || this.sampleRate || 44100) / 2;
      const lo = Math.max(1, Math.min(nyq - 1, Number.isFinite(minHz) ? minHz : 1));
      const hi = Math.max(lo + 1, Math.min(nyq - 1, Number.isFinite(maxHz) ? maxHz : nyq - 1));
      const now = this.ctx.currentTime;
      this.bandHp1.frequency.setTargetAtTime(lo, now, 0.01);
      this.bandHp2.frequency.setTargetAtTime(lo, now, 0.01);
      this.bandLp1.frequency.setTargetAtTime(hi, now, 0.01);
      this.bandLp2.frequency.setTargetAtTime(hi, now, 0.01);
    }

    // Rebuild the BiquadFilterNode chain from a bands array.
    // bands: [{type, freq, gain, q, enabled}, ...]. bypass skips the chain.
    setEqBands(bands, bypass) {
      if (!this.ctx) return;
      // Disconnect old chain.
      try { this.eqInput.disconnect(); } catch (_) {}
      for (const n of this.eqNodes) { try { n.disconnect(); } catch (_) {} }
      this.eqNodes = [];
      if (bypass || !bands || !bands.length) {
        this.eqInput.connect(this.eqOutput);
        return;
      }
      let prev = this.eqInput;
      for (const b of bands) {
        if (!b.enabled) continue;
        const node = this.ctx.createBiquadFilter();
        node.type = b.type;
        node.frequency.value = b.freq;
        node.gain.value = b.gain;
        node.Q.value = b.q;
        prev.connect(node);
        this.eqNodes.push(node);
        prev = node;
      }
      prev.connect(this.eqOutput);
    }

    // Replace the current AudioBuffer (used after offline spectral render).
    // Preserves the current play position by default.
    replaceBuffer(newBuffer, keepPosition = true) {
      const wasPlaying = this.playing;
      const pos = keepPosition ? this.getCurrentTime() : 0;
      this.stop(true);
      this.buffer = newBuffer;
      this.duration = newBuffer.duration;
      this.sampleRate = newBuffer.sampleRate;
      this.offset = Math.min(pos, this.duration);
      if (wasPlaying) this.play(this.offset);
      else this._emitState();
    }

    // Build an AudioBuffer from either mono samples or an array of channel buffers.
    samplesToBuffer(samples, sampleRate) {
      const ctx = this.ensureCtx();
      const sr = sampleRate || this.sampleRate || ctx.sampleRate;
      const channels = Array.isArray(samples) ? samples : [samples];
      const length = channels.length ? channels[0].length : 0;
      const buf = ctx.createBuffer(Math.max(1, channels.length), length, sr);
      for (let c = 0; c < channels.length; c++) {
        buf.copyToChannel(channels[c], c, 0);
      }
      return buf;
    }

    async loadFile(file) {
      const ctx = this.ensureCtx();
      const ab = await file.arrayBuffer();
      const buf = await new Promise((resolve, reject) => {
        // Callback form for Safari compatibility.
        const p = ctx.decodeAudioData(ab, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
      this.stop();
      this.buffer = buf;
      this.duration = buf.duration;
      this.sampleRate = buf.sampleRate;
      this.offset = 0;
      return buf;
    }

    setVolume(v) {
      if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(1, v));
    }

    setRate(r) {
      this.rate = r;
      if (this.source) this.source.playbackRate.value = r;
    }

    setSmoothing(s) {
      if (this.analyser) this.analyser.smoothingTimeConstant = Math.max(0, Math.min(0.95, s));
    }

    setAnalyserFFTSize(n) {
      if (this.analyser) {
        const clamped = Math.min(32768, Math.max(32, n));
        // AnalyserNode requires a power of 2.
        let pow = 32;
        while (pow < clamped) pow <<= 1;
        this.analyser.fftSize = pow;
      }
    }

    _emitState() {
      if (this.onPlayStateChange) this.onPlayStateChange(this.playing);
    }

    play(fromOffset) {
      if (!this.buffer) return;
      const ctx = this.ensureCtx();
      this.stop(true); // silent stop without state emission
      const src = ctx.createBufferSource();
      src.buffer = this.buffer;
      src.playbackRate.value = this.rate;
      src.connect(this.gainNode);
      const start = typeof fromOffset === 'number' ? fromOffset : this.offset;
      this.offset = Math.max(0, Math.min(this.duration, start));
      this.startedAt = ctx.currentTime;
      src.onended = () => {
        if (!this.playing) return; // stopped manually
        this.playing = false;
        // At end, snap offset to duration.
        const pos = this.getCurrentTime();
        this.offset = Math.min(this.duration, pos);
        if (this.onEnded) this.onEnded();
        this._emitState();
      };
      src.start(0, this.offset);
      this.source = src;
      this.playing = true;
      this._emitState();
    }

    stop(silent) {
      if (this.source) {
        try { this.source.onended = null; this.source.stop(); } catch (_) {}
        try { this.source.disconnect(); } catch (_) {}
        this.source = null;
      }
      this.playing = false;
      if (!silent) this._emitState();
    }

    pause() {
      if (!this.playing) return;
      const pos = this.getCurrentTime();
      this.stop(true);
      this.offset = pos;
      this.playing = false;
      this._emitState();
    }

    seek(t) {
      const tgt = Math.max(0, Math.min(this.duration, t));
      const wasPlaying = this.playing;
      this.stop(true);
      this.offset = tgt;
      if (wasPlaying) this.play(tgt);
      else this._emitState();
    }

    getCurrentTime() {
      if (!this.buffer) return 0;
      if (!this.playing) return this.offset;
      const elapsed = (this.ctx.currentTime - this.startedAt) * this.rate;
      let t = this.offset + elapsed;
      if (this.loop) {
        if (t >= this.loop.end) {
          // Re-seek to loop start (caller handles loop).
          this.seek(this.loop.start);
          return this.loop.start;
        }
      }
      return Math.min(this.duration, t);
    }

    getFrequencyData(arr) {
      if (!this.analyser) return 0;
      this.analyser.getByteFrequencyData(arr);
      return this.analyser.fftSize;
    }

    getTimeDomainData(arr) {
      if (!this.analyser) return 0;
      this.analyser.getByteTimeDomainData(arr);
      return this.analyser.fftSize;
    }
  }

  global.AudioEngine = AudioEngine;
})(typeof window !== 'undefined' ? window : globalThis);
