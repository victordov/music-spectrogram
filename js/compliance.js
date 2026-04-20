// Compliance reports (Phase 1, Pro).
//
// Takes a pre-computed offline metering analysis (from Metering.analyzeBuffer)
// and checks it against well-known loudness targets. Produces structured JSON
// plus a printable HTML report.
(function (global) {
  'use strict';

  // -- Targets ---------------------------------------------------------------
  //
  // Each target is a dict of checks, where each check has:
  //   name: human label
  //   measure: key into the metering report
  //   range?: [lo, hi] expected
  //   max?: upper bound
  //   min?: lower bound
  //   tolerance?: additional tolerance (LU / dB) that counts as a pass-warn
  const TARGETS = {
    spotify: {
      label: 'Spotify',
      checks: [
        { name: 'Integrated LUFS', measure: 'integratedLufs', target: -14, tolerance: 1 },
        { name: 'True peak',        measure: 'truePeakDb',    max: -1 }
      ]
    },
    apple: {
      label: 'Apple Music',
      checks: [
        { name: 'Integrated LUFS', measure: 'integratedLufs', target: -16, tolerance: 1 },
        { name: 'True peak',        measure: 'truePeakDb',    max: -1 }
      ]
    },
    youtube: {
      label: 'YouTube',
      checks: [
        { name: 'Integrated LUFS', measure: 'integratedLufs', target: -14, tolerance: 1 },
        { name: 'True peak',        measure: 'truePeakDb',    max: -1 }
      ]
    },
    amazon: {
      label: 'Amazon Music',
      checks: [
        { name: 'Integrated LUFS', measure: 'integratedLufs', target: -14, tolerance: 2 },
        { name: 'True peak',        measure: 'truePeakDb',    max: -2 }
      ]
    },
    tidal: {
      label: 'Tidal',
      checks: [
        { name: 'Integrated LUFS', measure: 'integratedLufs', target: -14, tolerance: 1 },
        { name: 'True peak',        measure: 'truePeakDb',    max: -1 }
      ]
    },
    ebu_r128: {
      label: 'EBU R128 (Broadcast)',
      checks: [
        { name: 'Integrated LUFS',   measure: 'integratedLufs', target: -23, tolerance: 0.5 },
        { name: 'True peak',         measure: 'truePeakDb',     max: -1 },
        { name: 'Loudness Range',    measure: 'loudnessRange',  max: 18 }
      ]
    },
    atsc: {
      label: 'ATSC A/85 (US TV)',
      checks: [
        { name: 'Integrated LUFS', measure: 'integratedLufs', target: -24, tolerance: 2 },
        { name: 'True peak',        measure: 'truePeakDb',    max: -2 }
      ]
    },
    acx: {
      label: 'ACX Audiobook',
      checks: [
        { name: 'Integrated LUFS', measure: 'integratedLufs', range: [-23, -18] },
        { name: 'Sample peak',      measure: 'samplePeakDb',   max: -3 },
        { name: 'Noise floor',      measure: 'noiseFloorDb',   max: -60 }
      ]
    },
    podcast: {
      label: 'Podcast',
      checks: [
        { name: 'Integrated LUFS (stereo)', measure: 'integratedLufs', target: -16, tolerance: 1 },
        { name: 'True peak',                 measure: 'truePeakDb',    max: -1 }
      ]
    }
  };

  function listTargets() {
    return Object.keys(TARGETS).map((k) => ({ id: k, label: TARGETS[k].label }));
  }

  // -- Evaluation ------------------------------------------------------------

  function fmt(v, unit) {
    if (v === -Infinity) return `-∞ ${unit}`;
    if (v === Infinity) return `∞ ${unit}`;
    if (v == null || !isFinite(v)) return 'n/a';
    return `${v.toFixed(1)} ${unit}`;
  }

  function unitFor(measure) {
    if (measure === 'integratedLufs') return 'LUFS';
    if (measure === 'loudnessRange') return 'LU';
    return 'dB';
  }

  function evaluateCheck(check, report) {
    const v = report[check.measure];
    const unit = unitFor(check.measure);
    const result = { name: check.name, measured: v, unit, pass: false, reason: '' };
    if (v == null || !isFinite(v)) {
      result.reason = 'No measurement available';
      return result;
    }
    if (check.range) {
      const [lo, hi] = check.range;
      result.target = `${lo}…${hi} ${unit}`;
      if (v >= lo && v <= hi) { result.pass = true; result.reason = 'Within range'; }
      else if (v < lo) result.reason = `${(lo - v).toFixed(1)} ${unit} below target`;
      else result.reason = `${(v - hi).toFixed(1)} ${unit} above target`;
      return result;
    }
    if (check.max != null) {
      result.target = `≤ ${check.max} ${unit}`;
      if (v <= check.max) { result.pass = true; result.reason = 'OK'; }
      else result.reason = `${(v - check.max).toFixed(1)} ${unit} over`;
      return result;
    }
    if (check.min != null) {
      result.target = `≥ ${check.min} ${unit}`;
      if (v >= check.min) { result.pass = true; result.reason = 'OK'; }
      else result.reason = `${(check.min - v).toFixed(1)} ${unit} under`;
      return result;
    }
    if (check.target != null) {
      const tol = check.tolerance != null ? check.tolerance : 1;
      result.target = `${check.target} ± ${tol} ${unit}`;
      const diff = v - check.target;
      if (Math.abs(diff) <= tol) {
        result.pass = true;
        result.reason = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} ${unit}`;
      } else {
        result.reason = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} ${unit} (outside tolerance)`;
      }
      return result;
    }
    result.reason = 'Unknown check';
    return result;
  }

  function evaluateTarget(targetId, report) {
    const t = TARGETS[targetId];
    if (!t) return null;
    const checks = t.checks.map((c) => evaluateCheck(c, report));
    const passAll = checks.every((c) => c.pass);
    return {
      id: targetId,
      label: t.label,
      pass: passAll,
      checks
    };
  }

  function evaluateAll(report) {
    return Object.keys(TARGETS).map((id) => evaluateTarget(id, report));
  }

  // -- HTML rendering --------------------------------------------------------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function renderHtml(title, meteringReport, evaluation, extra = {}) {
    const css = `
      body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background:#0b1018; color:#e5eaf2; padding:24px; max-width:820px; margin:auto; }
      h1 { font-size:22px; margin:0 0 4px 0; }
      h2 { font-size:16px; margin:24px 0 8px 0; color:#9fb2c9; }
      .sub { color:#7e8ea6; font-size:13px; margin-bottom:16px; }
      table { width:100%; border-collapse:collapse; margin:4px 0; font-size:14px; }
      td, th { padding:6px 8px; border-bottom:1px solid #1b2636; text-align:left; }
      th { color:#9fb2c9; font-weight:600; }
      .badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:12px; font-weight:600; }
      .pass { background:#1a3a24; color:#6fe197; }
      .fail { background:#3a1a1a; color:#f08787; }
      .target-block { border:1px solid #1b2636; border-radius:10px; padding:12px 16px; margin:10px 0; }
      .measure { color:#e5eaf2; font-weight:600; }
      .reason { color:#7e8ea6; font-size:12px; }
      @media print { body { background:white; color:black; } th { color:#333; } .reason{ color:#666; } .target-block{ border-color:#ddd; } }
    `;

    const measuresRows = [
      ['Integrated LUFS',    fmt(meteringReport.integratedLufs, 'LUFS')],
      ['Momentary (max)',    fmt(meteringReport.momentaryMaxLufs, 'LUFS')],
      ['Short-term (max)',   fmt(meteringReport.shortTermMaxLufs, 'LUFS')],
      ['Loudness Range',     fmt(meteringReport.loudnessRange, 'LU')],
      ['True peak',          fmt(meteringReport.truePeakDb, 'dBTP')],
      ['Sample peak',        fmt(meteringReport.samplePeakDb, 'dBFS')],
      ['Stereo correlation', meteringReport.stereoCorrelation != null
        ? meteringReport.stereoCorrelation.toFixed(2) : 'n/a'],
      ['Mid/Side ratio',     meteringReport.midSideRatio != null
        ? meteringReport.midSideRatio.toFixed(2) : 'n/a'],
      ['Noise floor',        fmt(meteringReport.noiseFloorDb, 'dBFS')]
    ].map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');

    const targetsHtml = evaluation.map((t) => {
      const checks = t.checks.map((c) => {
        const badge = c.pass ? '<span class="badge pass">PASS</span>' : '<span class="badge fail">FAIL</span>';
        return `<tr>
          <td>${escapeHtml(c.name)}</td>
          <td class="measure">${escapeHtml(fmt(c.measured, c.unit))}</td>
          <td>${escapeHtml(c.target || '')}</td>
          <td>${badge}</td>
          <td class="reason">${escapeHtml(c.reason)}</td>
        </tr>`;
      }).join('');
      const tBadge = t.pass ? '<span class="badge pass">PASS</span>' : '<span class="badge fail">FAIL</span>';
      return `<div class="target-block">
        <h2 style="margin-top:0">${escapeHtml(t.label)} ${tBadge}</h2>
        <table>
          <thead><tr><th>Check</th><th>Measured</th><th>Target</th><th>Result</th><th>Note</th></tr></thead>
          <tbody>${checks}</tbody>
        </table>
      </div>`;
    }).join('');

    const subtitle = extra.filename
      ? `Source file: ${escapeHtml(extra.filename)} · ${new Date().toLocaleString()}`
      : new Date().toLocaleString();

    return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>${escapeHtml(title)}</title>
<style>${css}</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
<div class="sub">${subtitle}</div>
<h2>Measurements</h2>
<table><tbody>${measuresRows}</tbody></table>
<h2>Compliance</h2>
${targetsHtml}
</body></html>`;
  }

  global.Compliance = {
    TARGETS,
    listTargets,
    evaluateTarget,
    evaluateAll,
    renderHtml
  };
})(typeof window !== 'undefined' ? window : globalThis);
