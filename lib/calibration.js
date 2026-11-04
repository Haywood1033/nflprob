// lib/calibration.js — moneyline calibration fitted by the backtest (same method as nhlprob).
// The game model's win chance is a logistic on the implied-points difference; if favorites win
// more (or less) often than it says, the backtest fits a stretch k on the log-odds:
// calibrated p = σ(k · logit p). k > 1 widens favorites, k < 1 pulls them in, k = 1 changes nothing.
//
// What's applied is shrunk toward 1 by sample size, k_applied = 1 + (k_fit − 1) · n / (n + 400),
// so a season or two of games moves it only part of the way. The fit is checked honestly: fit on
// the older half of the games, scored on the newer half.

const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logit = p => Math.log(clip(p) / (1 - clip(p)));
const stretch = (p, k) => 1 / (1 + Math.exp(-k * logit(p)));
const logLoss = (rows, k) => rows.reduce((s, r) => s - (r.y ? Math.log(clip(stretch(r.p, k))) : Math.log(1 - clip(stretch(r.p, k)))), 0) / rows.length;
const GRID = Array.from({ length: 33 }, (_, i) => +(0.6 + i * 0.05).toFixed(2)); // 0.60 … 2.20
const SHRINK = 400;

function fitStretch(rows) {
  if (rows.length < 30) return null;
  let best = { k: 1, ll: logLoss(rows, 1) };
  for (const k of GRID) { const ll = logLoss(rows, k); if (ll < best.ll) best = { k, ll }; }
  return best.k;
}

// rows: [{ p (home win chance 0-1), y (1 home won), order (sortable: season*100 + week) }]
function calibrate(rows) {
  if (rows.length < 60) return { n: rows.length, kFit: null, kApplied: 1, note: 'Too few games to fit a calibration.' };
  const kFit = fitStretch(rows), n = rows.length;
  const kApplied = +(1 + (kFit - 1) * n / (n + SHRINK)).toFixed(3);
  const sorted = [...rows].sort((a, b) => a.order - b.order);
  const older = sorted.slice(0, Math.floor(n / 2)), newer = sorted.slice(Math.floor(n / 2));
  const kHalf = fitStretch(older), kHalfApplied = 1 + (kHalf - 1) * older.length / (older.length + SHRINK);
  return {
    n, kFit, kApplied,
    check: { fitOn: older.length, testedOn: newer.length, kFit: kHalf, kApplied: +kHalfApplied.toFixed(3), raw: logLoss(newer, 1), calibrated: logLoss(newer, kHalfApplied) },
  };
}

// ── Anytime TD: a + k · logit p ─────────────────────────────────────────────────────────
// The TD model's chances are both shifted and too spread (low ones too low, high ones too high);
// two numbers fix both: a shifts every chance, k < 1 pulls the extremes toward the middle.
// Shrunk toward (0, 1) by n / (n + 1500).
const tdApply = (p, a, k) => 1 / (1 + Math.exp(-(a + k * logit(p))));
const tdLoss = (rows, a, k) => rows.reduce((s, r) => s - (r.y ? Math.log(clip(tdApply(r.p, a, k))) : Math.log(1 - clip(tdApply(r.p, a, k)))), 0) / rows.length;
function fitTd(rows) {
  let best = { a: 0, k: 1, ll: tdLoss(rows, 0, 1) };
  for (let a = -1; a <= 1.0001; a += 0.05) for (let k = 0.4; k <= 1.4001; k += 0.05) { const l = tdLoss(rows, a, k); if (l < best.ll) best = { a: +a.toFixed(2), k: +k.toFixed(2), ll: l }; }
  return best;
}
function calibrateTd(rows) {
  if (rows.length < 300) return { n: rows.length, fit: null, applied: { a: 0, k: 1 }, note: 'Too few player-games to fit.' };
  const shrink = m => m / (m + 1500), n = rows.length, f = fitTd(rows), w = shrink(n);
  const sorted = [...rows].sort((x, y) => x.order - y.order), older = sorted.slice(0, Math.floor(n / 2)), newer = sorted.slice(Math.floor(n / 2));
  const h = fitTd(older), hw = shrink(older.length), ha = h.a * hw, hk = 1 + (h.k - 1) * hw;
  const check = { fitOn: older.length, testedOn: newer.length, raw: tdLoss(newer, 0, 1), calibrated: tdLoss(newer, ha, hk) };
  const helped = check.calibrated < check.raw;
  return { n, fit: { a: f.a, k: f.k }, applied: helped ? { a: +(f.a * w).toFixed(3), k: +(1 + (f.k - 1) * w).toFixed(3) } : { a: 0, k: 1 }, helped, check };
}

// ── Yardage: blend toward the season average, then size the band to hold ~68% ────────────
// proj' = w · model + (1 − w) · season average so far (w fitted on average miss); the floor–
// ceiling half-width is scaled by f so ~68% of games land inside (a ±1 SD band's share).
function blendMae(rows, w) { return rows.reduce((s, r) => s + Math.abs(w * r.proj + (1 - w) * r.naive - r.actual), 0) / rows.length; }
function fitBlend(rows) { let best = { w: 1, mae: blendMae(rows, 1) }; for (let w = 0; w <= 1.0001; w += 0.05) { const m = blendMae(rows, w); if (m < best.mae) best = { w: +w.toFixed(2), mae: m }; } return best.w; }
function coverage(rows, w, f) { return rows.filter(r => { const c = w * r.proj + (1 - w) * r.naive, half = ((r.ceiling - r.floor) / 2 || c * 0.4) * f; return r.actual >= Math.max(0, c - half) && r.actual <= c + half; }).length / rows.length; }
function fitBand(rows, w) { let best = { f: 1, gap: Math.abs(coverage(rows, w, 1) - 0.68) }; for (let f = 0.8; f <= 3.0001; f += 0.05) { const g = Math.abs(coverage(rows, w, f) - 0.68); if (g < best.gap) best = { f: +f.toFixed(2), gap: g }; } return best.f; }
function calibrateYards(allRows) {
  const rows = allRows.filter(r => r.naive != null);
  if (rows.length < 200) return { n: rows.length, applied: { w: 1, f: 1 }, note: 'Too few player-games to fit.' };
  const sorted = [...rows].sort((x, y) => x.order - y.order), older = sorted.slice(0, Math.floor(rows.length / 2)), newer = sorted.slice(Math.floor(rows.length / 2));
  const hw = fitBlend(older), hf = fitBand(older, hw);
  const check = { fitOn: older.length, testedOn: newer.length, raw: blendMae(newer, 1), calibrated: blendMae(newer, hw), coverageRaw: coverage(newer, 1, 1), coverageCalibrated: coverage(newer, hw, hf) };
  const w = fitBlend(rows), f = fitBand(rows, w), helped = check.calibrated <= check.raw;
  return { n: rows.length, fit: { w, f }, applied: { w: helped ? w : 1, f: fitBand(rows, helped ? w : 1) }, helped, check };
}

// ── Game totals: a shift for the model's average miss ────────────────────────────────────
function calibrateTotals(rows) {
  if (rows.length < 60) return { n: rows.length, applied: { shift: 0 }, note: 'Too few games to fit.' };
  const n = rows.length, shrink = m => m / (m + 200);
  const meanMiss = rs => rs.reduce((s, r) => s + (r.actualTotal - r.total), 0) / rs.length;
  const mae = (rs, sh) => rs.reduce((s, r) => s + Math.abs(r.total + sh - r.actualTotal), 0) / rs.length;
  const sorted = [...rows].sort((x, y) => x.order - y.order), older = sorted.slice(0, Math.floor(n / 2)), newer = sorted.slice(Math.floor(n / 2));
  const hs = meanMiss(older) * shrink(older.length);
  const check = { fitOn: older.length, testedOn: newer.length, raw: mae(newer, 0), calibrated: mae(newer, hs) };
  const helped = check.calibrated < check.raw, shift = +(meanMiss(rows) * shrink(n)).toFixed(2);
  return { n, fit: { shift: +meanMiss(rows).toFixed(2) }, applied: { shift: helped ? shift : 0 }, helped, check };
}

// ── Saved calibration (database) ────────────────────────────────────────────────────────
// Kept in its own small table; without DATABASE_URL nothing is saved and k stays 1.
const hasDb = !!process.env.DATABASE_URL;
let memo = { at: 0, value: null };
const ENSURE = `CREATE TABLE IF NOT EXISTS nfl_calibration (name VARCHAR(32) PRIMARY KEY, value DOUBLE PRECISION, detail JSONB, fitted_at TIMESTAMP DEFAULT NOW())`;

// All saved calibrations: { ml: {k, …}, td: {a, k, …}, rush/rec/pass: {w, f, …}, totals: {shift, …} }.
async function loadCalibration() {
  if (!hasDb) return null;
  if (Date.now() - memo.at < 5 * 60 * 1000) return memo.value;
  try {
    const { query } = require('./db.js');
    await query(ENSURE);
    const r = await query(`SELECT name, value, detail, fitted_at FROM nfl_calibration`);
    const out = {};
    for (const row of r.rows) out[row.name] = { ...(row.detail || {}), fittedAt: row.fitted_at };
    memo = { at: Date.now(), value: r.rows.length ? out : null };
    return memo.value;
  } catch (e) { console.warn('calibration load failed:', e.message); return null; }
}

// Saves what a backtest fitted. Only what helped on held-out games is applied (identity otherwise).
async function saveCalibration(bt) {
  if (!hasDb) return false;
  const { query } = require('./db.js');
  await query(ENSURE);
  const put = (name, value, detail) => query(`INSERT INTO nfl_calibration (name, value, detail) VALUES ($1, $2, $3) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, detail = EXCLUDED.detail, fitted_at = NOW()`, [name, value, JSON.stringify(detail)]);
  const m = bt.moneyline.calibration, mlHelped = m.kFit !== null && m.check && m.check.calibrated < m.check.raw;
  if (m.kFit !== null) await put('ml', mlHelped ? m.kApplied : 1, { k: mlHelped ? m.kApplied : 1, kFit: m.kFit, n: m.n, helped: mlHelped, check: m.check });
  const t = bt.anytimeTd.calibration; if (t?.fit) await put('td', t.applied.k, { ...t.applied, fit: t.fit, n: t.n, helped: t.helped, check: t.check });
  for (const k of ['rush', 'rec', 'pass']) { const c = bt[`${k}Yds`].calibration; if (c?.fit) await put(k, c.applied.w, { ...c.applied, fit: c.fit, n: c.n, helped: c.helped, check: c.check }); }
  const tt = bt.totals.calibration; if (tt?.fit) await put('totals', tt.applied.shift, { ...tt.applied, fit: tt.fit, n: tt.n, helped: tt.helped, check: tt.check });
  memo = { at: 0, value: null };
  return true;
}

// ── Applying it live ─────────────────────────────────────────────────────────────────────
// Game model (percent win chances): moneyline stretch, then the totals shift split across both
// teams' implied points (the margin is unchanged).
function applyGameCalibration(model, cal) {
  if (!model || !cal) return model;
  const out = { ...model };
  const k = cal.ml?.k;
  if (k && Math.abs(k - 1) > 1e-6) { const c = stretch(model.homeWinProb / 100, k); out.homeWinProb = +(c * 100).toFixed(1); out.awayWinProb = +((1 - c) * 100).toFixed(1); out.rawHomeWinProb = model.homeWinProb; }
  const sh = cal.totals?.shift;
  if (sh) { out.homeImplied = +(model.homeImplied + sh / 2).toFixed(1); out.awayImplied = +(model.awayImplied + sh / 2).toFixed(1); out.total = +(model.total + sh).toFixed(1); out.rawTotal = model.total; out.shootoutSignal = out.total >= 48; out.lowScoringSignal = out.total <= 40; }
  return out;
}
// Anytime TD chance, in percent.
function applyTdCalibration(probPct, cal) {
  const c = cal?.td; if (probPct == null || !c || (c.a === 0 && c.k === 1)) return probPct;
  return +(tdApply(probPct / 100, c.a, c.k) * 100).toFixed(1);
}
// Yardage projection { projected, floor, ceiling }: blend toward the season average, scale the band.
function applyYardsCalibration(proj, seasonAvg, market, cal) {
  const c = cal?.[market]; if (!proj || !c) return proj;
  const w = seasonAvg != null ? c.w ?? 1 : 1, f = c.f ?? 1;
  const center = w * proj.projected + (1 - w) * (seasonAvg ?? proj.projected);
  const half = ((proj.ceiling - proj.floor) / 2 || center * 0.4) * f;
  return { ...proj, projected: +center.toFixed(1), floor: +Math.max(0, center - half).toFixed(1), ceiling: +(center + half).toFixed(1), rawProjected: proj.projected };
}
// A player's per-game average so far this regular season (through `throughWeek`) for a stat field.
function seasonAverage(playerRows, name, team, throughWeek, field) {
  const rows = (playerRows || []).filter(r => r.player_display_name === name && (!team || r.team === team) && r.season_type === 'REG' && (throughWeek < 1 || Number(r.week) <= throughWeek));
  return rows.length ? rows.reduce((s, r) => s + (parseFloat(r[field]) || 0), 0) / rows.length : null;
}

module.exports = { calibrate, calibrateTd, calibrateYards, calibrateTotals, fitStretch, stretch, tdApply, applyGameCalibration, applyTdCalibration, applyYardsCalibration, seasonAverage, loadCalibration, saveCalibration, SHRINK, hasDb };
