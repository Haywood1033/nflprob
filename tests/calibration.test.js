// Calibration math (lib/calibration.js): each fit recovers a known distortion, is shrunk toward
// "no change", is checked on held-out games, and applies cleanly to live outputs.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/calibration.js');

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('moneyline: an overconfident model is pulled in, and it helps on held-out games', () => {
  const r = rng(1), rows = [];
  for (let i = 0; i < 10000; i++) { const p = 0.2 + 0.6 * r(); rows.push({ p, y: r() < C.stretch(p, 0.7) ? 1 : 0, order: i }); }
  const c = C.calibrate(rows);
  assert.ok(Math.abs(c.kFit - 0.7) <= 0.1, `fitted ${c.kFit}`);
  assert.ok(c.kApplied >= c.kFit && c.kApplied < 1, 'shrunk toward 1');
  assert.ok(c.check.calibrated < c.check.raw);
  const m = C.applyGameCalibration({ homeWinProb: 75, awayWinProb: 25, homeImplied: 24, awayImplied: 18, total: 42, diff: 6 }, { ml: { k: 0.8 }, totals: { shift: 2 } });
  assert.ok(m.homeWinProb < 75 && m.homeWinProb > 50 && Math.abs(m.homeWinProb + m.awayWinProb - 100) < 0.11);
  assert.equal(m.total, 44); assert.equal(m.homeImplied - m.awayImplied, 6, 'the margin is unchanged');
});

test('anytime TD: a shifted, over-spread model is corrected (low up, high down)', () => {
  const r = rng(2), rows = [];
  // The shape the real NFL backtest showed: shifted down and too spread out.
  for (let i = 0; i < 8000; i++) { const p = 0.03 + 0.6 * r(); rows.push({ p, y: r() < C.tdApply(p, -0.4, 0.65) ? 1 : 0, order: i }); }
  const c = C.calibrateTd(rows);
  assert.ok(c.helped && c.applied.k < 1);
  assert.ok(C.applyTdCalibration(5, { td: c.applied }) > 5, 'a low chance goes up');
  assert.ok(C.applyTdCalibration(60, { td: c.applied }) < 60, 'a high chance comes down');
  assert.equal(C.applyTdCalibration(30, null), 30, 'no calibration = unchanged');
});

test('yardage: blends toward the season average when that predicts better, and the band grows to ~68%', () => {
  const r = rng(3), rows = [];
  for (let i = 0; i < 2000; i++) { const talent = 40 + 40 * r(), naive = talent + (r() - 0.5) * 10, proj = talent + (r() - 0.5) * 50, actual = Math.max(0, talent + (r() - 0.5) * 60); rows.push({ order: i, proj, naive, actual, floor: proj - 10, ceiling: proj + 10 }); }
  const c = C.calibrateYards(rows);
  assert.ok(c.helped && c.fit.w < 0.6, `model share ${c.fit.w}`);
  assert.ok(c.fit.f > 1 && Math.abs(c.check.coverageCalibrated - 0.68) < 0.06);
  const out = C.applyYardsCalibration({ projected: 80, floor: 60, ceiling: 100 }, 60, 'rush', { rush: { w: 0.5, f: 1.5 } });
  assert.equal(out.projected, 70); assert.equal(out.ceiling - out.projected, 30); assert.equal(out.rawProjected, 80);
  assert.equal(C.applyYardsCalibration({ projected: 80, floor: 60, ceiling: 100 }, null, 'rush', { rush: { w: 0.5, f: 1 } }).projected, 80, 'no season average yet = model only');
});

test('totals: a biased model is shifted, shrunk for sample size', () => {
  const r = rng(4), rows = [];
  for (let i = 0; i < 400; i++) { const t = 38 + 14 * r(); rows.push({ order: i, total: t, actualTotal: t + 3 + (r() - 0.5) * 20 }); }
  const c = C.calibrateTotals(rows);
  assert.ok(c.helped && c.applied.shift > 1 && c.applied.shift < c.fit.shift);
});
