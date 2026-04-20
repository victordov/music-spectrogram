// Colormap LUTs. Each returns {r,g,b} 0-255 for t in [0,1].
// Approximations derived from standard matplotlib data.
(function (global) {
  'use strict';

  // Compact RGB stop tables; bilinear interp.
  const TABLES = {
    viridis: [
      [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142],
      [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89],
      [180, 222, 44], [253, 231, 37]
    ],
    magma: [
      [0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129],
      [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135],
      [252, 253, 191]
    ],
    inferno: [
      [0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106],
      [186, 54, 85], [227, 89, 51], [249, 140, 10], [249, 201, 50],
      [252, 255, 164]
    ],
    plasma: [
      [13, 8, 135], [75, 3, 161], [125, 3, 168], [168, 34, 150],
      [203, 70, 121], [229, 107, 93], [248, 148, 65], [253, 195, 40],
      [240, 249, 33]
    ],
    turbo: [
      [48, 18, 59], [64, 92, 224], [53, 181, 229], [97, 220, 144],
      [187, 237, 52], [252, 200, 56], [253, 132, 30], [216, 63, 6],
      [122, 4, 3]
    ],
    gray: [[0, 0, 0], [255, 255, 255]],
    heat: [
      [0, 0, 0], [70, 0, 0], [150, 0, 0], [220, 30, 0],
      [255, 120, 0], [255, 210, 0], [255, 255, 200]
    ],
    cool: [
      [0, 0, 40], [0, 60, 140], [30, 150, 200], [80, 220, 220],
      [200, 255, 240]
    ]
  };

  // Precompute 256-entry Uint8Array LUT for each map (RGB interleaved).
  const LUTS = {};
  for (const name in TABLES) {
    const stops = TABLES[name];
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const x = t * (stops.length - 1);
      const i0 = Math.floor(x);
      const i1 = Math.min(stops.length - 1, i0 + 1);
      const f = x - i0;
      const a = stops[i0], b = stops[i1];
      lut[i * 3 + 0] = Math.round(a[0] * (1 - f) + b[0] * f);
      lut[i * 3 + 1] = Math.round(a[1] * (1 - f) + b[1] * f);
      lut[i * 3 + 2] = Math.round(a[2] * (1 - f) + b[2] * f);
    }
    LUTS[name] = lut;
  }

  function sample(name, t) {
    const lut = LUTS[name] || LUTS.viridis;
    const i = Math.max(0, Math.min(255, Math.round(t * 255)));
    return [lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2]];
  }

  global.Colormaps = { LUTS, sample, names: Object.keys(LUTS) };
})(typeof window !== 'undefined' ? window : globalThis);
