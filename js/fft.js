// Iterative radix-2 FFT with precomputed twiddles and bit-reversed indices.
// In-place on separate real/imag Float32 arrays for performance.
(function (global) {
  'use strict';

  class FFT {
    constructor(n) {
      if (n & (n - 1)) throw new Error('FFT size must be a power of two: ' + n);
      this.n = n;
      this.levels = Math.log2(n) | 0;
      this.cosT = new Float32Array(n / 2);
      this.sinT = new Float32Array(n / 2);
      for (let i = 0; i < n / 2; i++) {
        this.cosT[i] = Math.cos(-2 * Math.PI * i / n);
        this.sinT[i] = Math.sin(-2 * Math.PI * i / n);
      }
      this.rev = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        let r = 0, v = i;
        for (let j = 0; j < this.levels; j++) { r = (r << 1) | (v & 1); v >>= 1; }
        this.rev[i] = r;
      }
    }

    // Forward FFT. Writes results into re, im in place.
    // re/im: Float32Array of length n.
    forward(re, im) {
      const n = this.n, rev = this.rev;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      let size = 2;
      while (size <= n) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          let k = 0;
          for (let j = i; j < i + half; j++) {
            const tpre = this.cosT[k] * re[j + half] - this.sinT[k] * im[j + half];
            const tpim = this.cosT[k] * im[j + half] + this.sinT[k] * re[j + half];
            re[j + half] = re[j] - tpre;
            im[j + half] = im[j] - tpim;
            re[j] += tpre;
            im[j] += tpim;
            k += step;
          }
        }
        size <<= 1;
      }
    }
  }

  // Window function generators.
  const Windows = {
    hann(n) {
      const w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
      return w;
    },
    hamming(n) {
      const w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1));
      return w;
    },
    blackman(n) {
      const w = new Float32Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
      return w;
    },
    bartlett(n) {
      const w = new Float32Array(n);
      const m = (n - 1) / 2;
      for (let i = 0; i < n; i++) w[i] = 1 - Math.abs((i - m) / m);
      return w;
    },
    rect(n) {
      const w = new Float32Array(n);
      w.fill(1);
      return w;
    },
    flattop(n) {
      const a = [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368];
      const w = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = 2 * Math.PI * i / (n - 1);
        w[i] = a[0] - a[1] * Math.cos(x) + a[2] * Math.cos(2 * x) - a[3] * Math.cos(3 * x) + a[4] * Math.cos(4 * x);
      }
      return w;
    }
  };

  function buildWindow(name, n) {
    return (Windows[name] || Windows.hann)(n);
  }

  global.FFT = FFT;
  global.Windows = { build: buildWindow, list: Object.keys(Windows) };
})(typeof window !== 'undefined' ? window : globalThis);
