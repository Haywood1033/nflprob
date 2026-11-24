// lib/dfs-sim.js — Showdown lineups chosen by simulation instead of average points.
//
// 1. Each player's outcome: his projection plus his game-to-game spread (`sd`) times a correlated
//    normal draw. Correlations between players come from CORRELATION, measured on past games (DK
//    points minus projection, divided by spread, for every pair of players in the same game,
//    grouped by position pair and same team / opponent).
// 2. Candidate lineups: the best lineup for each of `candidateSims` simulated games (a lineup that
//    wins in some version of the game), plus the plain optimizer's lineups.
// 3. Selection: on a separate set of `evalSims` simulated games, pick lineups one at a time, each
//    time the one that is near the top (within `winMargin` of the best candidate) in the most
//    simulated games not yet covered. That's the "at least one lineup ends up near the top" goal of
//    a large tournament, with the exposure cap still applied.
// Seeded, so the same upload gives the same lineups.

const { optimizeLineup, optimizeLineups } = require('./dfs-optimizer.js');

// Measured correlation of (actual − projection) / spread between two players in the same game, on
// 370 replayed 2025-26 games (2025 wk 3-18, 2026 wk 3-11), every pair of players in each game.
// Keys: "<posA>-<posB>|same" or "|opp", positions sorted alphabetically; pairs under ±0.02 left
// out (treated as uncorrelated). Stable between seasons, e.g. QB-WR same team +0.26 / +0.22,
// DST vs opposing QB −0.37 / −0.38.
const CORRELATION = {
  'DST-QB|opp': -0.373,
  'QB-WR|same': 0.246,
  'QB-QB|opp': 0.219,
  'QB-TE|same': 0.215,
  'DST-K|same': 0.213,
  'DST-K|opp': -0.198,
  'DST-DST|opp': -0.18,
  'DST-QB|same': -0.179,
  'DST-RB|opp': -0.125,
  'DST-WR|opp': -0.096,
  'K-K|opp': -0.087,
  'DST-TE|same': -0.071,
  'QB-WR|opp': 0.067,
  'DST-WR|same': -0.067,
  'QB-RB|opp': 0.066,
  'QB-TE|opp': 0.065,
  'DST-TE|opp': -0.059,
  'K-WR|same': 0.051,
  'QB-RB|same': 0.047,
  'K-RB|opp': -0.043,
  'K-RB|same': 0.04,
  'K-TE|same': -0.036,
  'K-QB|same': 0.028,
  'RB-RB|same': -0.027,
  'RB-TE|same': -0.025,
  'WR-WR|opp': 0.025,
  'K-TE|opp': 0.022,
  'RB-RB|opp': -0.022,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normal(rng) { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }

const pairKey = (a, b) => { const [x, y] = [a.pos, b.pos].sort(); return `${x}-${y}|${a.team === b.team ? 'same' : 'opp'}`; };

// Cholesky of the pool's correlation matrix; off-diagonals shrunk until it factors (keeps it valid).
function choleskyFor(pool, table) {
  const n = pool.length;
  for (let shrink = 1; shrink >= 0; shrink -= 0.1) {
    const C = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : shrink * (table[pairKey(pool[i], pool[j])] || 0))));
    const L = Array.from({ length: n }, () => new Array(n).fill(0));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = C[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 1e-9) { ok = false; break; } L[i][i] = Math.sqrt(s); }
        else L[i][j] = s / L[j][j];
      }
    }
    if (ok) return L;
  }
  return pool.map((_, i) => pool.map((__, j) => (i === j ? 1 : 0)));
}

function simulate(pool, L, count, rng) {
  const n = pool.length, out = [];
  for (let s = 0; s < count; s++) {
    const e = Array.from({ length: n }, () => normal(rng));
    out.push(pool.map((p, i) => {
      let z = 0; for (let k = 0; k <= i; k++) z += L[i][k] * e[k];
      const v = p.points + (p.sd ?? 6) * z;
      return p.pos === 'DST' ? Math.max(v, -4) : Math.max(v, 0);
    }));
  }
  return out;
}

const sig = l => l.captain.id + '|' + l.flex.map(p => p.id).sort().join(',');

// pool: projected players (id, pos, team, salary, points, sd). Options mirror optimizeLineups.
function simLineups(pool, {
  count = 20, maxExposure = 0.35, lockedIds = [], captainLockId = null, excludedIds = [],
  noCaptainPositions = [], captainTopN = null, table = CORRELATION,
  candidateSims = 150, evalSims = 1500, winMargin = 0.95, seed = 7, model = {},
} = {}) {
  const usable = pool.filter(p => !excludedIds.includes(p.id) && p.points > 0);
  if (usable.length < 6) return [];
  const rng = mulberry32(seed);
  const L = choleskyFor(usable, table);
  const index = new Map(usable.map((p, i) => [p.id, i]));

  // Candidates: the best lineup in each of candidateSims simulated games, plus the plain optimizer's.
  const cands = new Map();
  const noCpt = new Set(noCaptainPositions);
  const topIds = captainTopN ? new Set([...usable].filter(p => !noCpt.has(p.pos)).sort((a, b) => b.points - a.points).slice(0, captainTopN).map(p => p.id)) : null;
  const captainOk = c => captainLockId ? c.id === captainLockId : (!noCpt.has(c.pos) && (!topIds || topIds.has(c.id)));
  for (const l of optimizeLineups(usable, { count, maxExposure, lockedIds, captainLockId, excludedIds, noCaptainPositions, captainTopN, model })) cands.set(sig(l), l);
  for (const draw of simulate(usable, L, candidateSims, rng)) {
    const world = usable.map((p, i) => ({ ...p, points: Math.max(draw[i], 0.01) }));
    // Best lineup in this world among allowed captains.
    const allowedCaptains = world.filter(captainOk);
    let best = null;
    for (const c of allowedCaptains) {
      const l = optimizeLineup(world, { lockedIds, captainLockId: c.id, excludedIds });
      if (l && (!best || l.totalPoints > best.totalPoints)) best = l;
    }
    if (best) {
      const orig = { captain: usable[index.get(best.captain.id)], flex: best.flex.map(p => usable[index.get(p.id)]) };
      orig.totalPoints = +(orig.captain.points * 1.5 + orig.flex.reduce((x, p) => x + p.points, 0)).toFixed(2);
      orig.totalSalary = Math.round(orig.captain.salary * 1.5) + orig.flex.reduce((x, p) => x + p.salary, 0);
      cands.set(sig(orig), orig);
    }
  }
  const list = [...cands.values()];

  // Score every candidate in fresh simulated games.
  const evalDraws = simulate(usable, L, evalSims, rng);
  const scores = list.map(l => evalDraws.map(d => d[index.get(l.captain.id)] * 1.5 + l.flex.reduce((x, p) => x + d[index.get(p.id)], 0)));
  const bestPerSim = evalDraws.map((_, s) => Math.max(...scores.map(sc => sc[s])));
  const nearTop = scores.map(sc => sc.map((v, s) => v >= winMargin * bestPerSim[s]));

  // Greedy cover under the exposure cap.
  const maxAllowed = Math.max(1, Math.ceil(count * maxExposure));
  const exposure = {}, chosen = [], covered = new Array(evalSims).fill(false);
  const picks = new Set(), locked = new Set([...lockedIds, ...(captainLockId ? [captainLockId] : [])]);
  for (let cap = maxAllowed; chosen.length < count && cap <= count; cap = Math.min(count, cap + Math.ceil(count * 0.15))) {
    while (chosen.length < count) {
      let bestI = -1, bestGain = -1, bestMean = -Infinity;
      for (let i = 0; i < list.length; i++) {
        if (picks.has(i)) continue;
        const ids = [list[i].captain.id, ...list[i].flex.map(p => p.id)];
        if (ids.some(id => !locked.has(id) && (exposure[id] || 0) >= cap)) continue;
        let gain = 0; for (let s = 0; s < evalSims; s++) if (nearTop[i][s] && !covered[s]) gain++;
        const mean = list[i].totalPoints;
        if (gain > bestGain || (gain === bestGain && mean > bestMean)) { bestI = i; bestGain = gain; bestMean = mean; }
      }
      if (bestI < 0) break;
      picks.add(bestI); chosen.push(list[bestI]);
      for (let s = 0; s < evalSims; s++) if (nearTop[bestI][s]) covered[s] = true;
      for (const id of [list[bestI].captain.id, ...list[bestI].flex.map(p => p.id)]) exposure[id] = (exposure[id] || 0) + 1;
    }
    if (cap >= count) break;
  }
  const coverage = covered.filter(Boolean).length / evalSims;
  return chosen.map(l => ({ ...l, simCoverage: +coverage.toFixed(3) }));
}

module.exports = { simLineups, simulate, choleskyFor, CORRELATION, pairKey, mulberry32 };
