// lib/classic-optimizer.js — exact optimizer for a DK Classic salary cap: QB(1) + RB(2) +
// WR(3) + TE(1) + FLEX(1, RB/WR/TE) + DST(1) = 9 players, $50,000 cap. No Captain multiplier
// (see lib/dfs-optimizer.js for that — Showdown only).
//
// APPROACH: DK's roster shape reduces to exactly 3 valid position distributions once FLEX is
// resolved (RB in [2,3], WR in [3,4], TE in [1,2], RB+WR+TE always totaling 7):
//   (RB3,WR3,TE1) — flex is an RB, (RB2,WR4,TE1) — flex is a WR, (RB2,WR3,TE2) — flex is a TE.
// Rather than one 6-dimensional knapsack (which would need a prohibitively large per-item-
// prefix table to reconstruct safely — see lib/dfs-optimizer.js's bestN() comment on why a
// collapsed pointer silently double-counts), this solves each position bucket (QB/RB/WR/TE/
// DST) as its OWN "pick exactly k, maximize points, for EVERY possible salary split" table,
// then combines the (up to) 5 independent bucket tables pairwise under the shared cap for each
// of the 3 distributions, keeping the best. Each piece stays small and is reconstructed the
// same safe backward-walk way bestN() already is.

const CAP = 50000;
const UNIT = 100; // DK salaries are always whole-$100 increments
const CAP_UNITS = CAP / UNIT;
const NEG = -Infinity;

const FLEX_SCENARIOS = [
  { QB: 1, RB: 3, WR: 3, TE: 1, DST: 1 },
  { QB: 1, RB: 2, WR: 4, TE: 1, DST: 1 },
  { QB: 1, RB: 2, WR: 3, TE: 2, DST: 1 },
];
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'DST'];

// Builds, for one position bucket, "pick exactly k players, maximize points, within budget w"
// for EVERY k from 0..maxK and EVERY w from 0..budgetUnits — a full dp[p][k][w] table in the
// same shape as lib/dfs-optimizer.js's bestN(), just exposing every (k, w) pair instead of
// collapsing to the single global best, since which k and which w this bucket will actually
// need isn't known until it's combined with the other buckets below.
function buildBucketTable(players, maxK, budgetUnits) {
  const P = players.length;
  const full = Array.from({ length: P + 1 }, () =>
    Array.from({ length: maxK + 1 }, () => new Array(budgetUnits + 1).fill(NEG))
  );
  for (let wt = 0; wt <= budgetUnits; wt++) full[0][0][wt] = 0;

  for (let p = 1; p <= P; p++) {
    const w = Math.round(players[p - 1].salary / UNIT);
    const v = players[p - 1].points;
    const prev = full[p - 1], cur = full[p];
    for (let kk = 0; kk <= maxK; kk++) {
      const prevK = prev[kk], prevK1 = kk > 0 ? prev[kk - 1] : null;
      const curK = cur[kk];
      for (let wt = 0; wt <= budgetUnits; wt++) {
        let best = prevK[wt]; // don't take item p-1
        if (prevK1 && wt >= w && prevK1[wt - w] !== NEG) {
          const cand = prevK1[wt - w] + v;
          if (cand > best) best = cand;
        }
        curK[wt] = best;
      }
    }
  }

  function rowFor(k) { return full[P][k]; }
  function reconstruct(k, wt) {
    if (k < 0 || full[P][k][wt] === NEG) return null;
    const chosen = [];
    let p = P, kk = k, w = wt;
    while (kk > 0) {
      if (full[p - 1][kk][w] === full[p][kk][w]) { p -= 1; continue; }
      const player = players[p - 1];
      chosen.push(player);
      w -= Math.round(player.salary / UNIT);
      kk -= 1;
      p -= 1;
    }
    return chosen;
  }
  return { rowFor, reconstruct };
}

// Combines two independent "points achievable at budget w" rows into one, for every total
// budget 0..budgetUnits — i.e. for each total w, finds the split (wa, w-wa) across A and B that
// maximizes their combined points. splitA[w] records which wa achieved it, so the caller can
// backtrack into each side's own reconstruct() afterward.
function combine(rowA, rowB, budgetUnits) {
  const points = new Array(budgetUnits + 1).fill(NEG);
  const splitA = new Array(budgetUnits + 1).fill(-1);
  for (let w = 0; w <= budgetUnits; w++) {
    let best = NEG, bestWa = -1;
    for (let wa = 0; wa <= w; wa++) {
      const a = rowA[wa];
      if (a === NEG) continue;
      const b = rowB[w - wa];
      if (b === NEG) continue;
      const val = a + b;
      if (val > best) { best = val; bestWa = wa; }
    }
    points[w] = best;
    splitA[w] = bestWa;
  }
  return { points, splitA };
}

// optimizeClassicLineup: pool is projected players (points > 0 enforced by caller or not — a
// zero/negative-point player just never gets picked). lockedIds: must appear somewhere in the
// final 9. excludedIds: must not appear anywhere. No Captain concept — every slot scores at
// face value.
function optimizeClassicLineup(pool, { lockedIds = [], excludedIds = [] } = {}) {
  const excluded = new Set(excludedIds);
  const lockedSet = new Set(lockedIds);
  const usable = pool.filter(p => !excluded.has(p.id));

  const lockedPlayers = usable.filter(p => lockedSet.has(p.id));
  const lockedByPos = { QB: [], RB: [], WR: [], TE: [], DST: [] };
  for (const p of lockedPlayers) {
    if (!lockedByPos[p.pos]) return null; // a locked player at an unsupported position (e.g. K) can't fill any Classic slot
    lockedByPos[p.pos].push(p);
  }

  const lockedSalaryUnits = lockedPlayers.reduce((s, p) => s + Math.round(p.salary / UNIT), 0);
  const remainingBudgetUnits = CAP_UNITS - lockedSalaryUnits;
  if (remainingBudgetUnits < 0) return null;

  const freeByPos = { QB: [], RB: [], WR: [], TE: [], DST: [] };
  for (const p of usable) {
    if (lockedSet.has(p.id) || !(p.points > 0) || !freeByPos[p.pos]) continue;
    freeByPos[p.pos].push(p);
  }

  let best = null;
  for (const sc of FLEX_SCENARIOS) {
    const need = {
      QB: sc.QB - lockedByPos.QB.length,
      RB: sc.RB - lockedByPos.RB.length,
      WR: sc.WR - lockedByPos.WR.length,
      TE: sc.TE - lockedByPos.TE.length,
      DST: sc.DST - lockedByPos.DST.length,
    };
    if (POSITIONS.some(pos => need[pos] < 0)) continue; // too many locks at one position for this scenario's flex assignment

    const result = solveScenario(freeByPos, need, remainingBudgetUnits);
    if (!result) continue;
    const totalPoints = result.points + lockedPlayers.reduce((s, p) => s + p.points, 0);
    if (!best || totalPoints > best.points) {
      best = { points: totalPoints, scenario: sc, players: [...lockedPlayers, ...result.players] };
    }
  }
  if (!best) return null;

  const totalSalary = best.players.reduce((s, p) => s + p.salary, 0);
  return { points: +best.points.toFixed(2), totalSalary, players: best.players, scenario: best.scenario };
}

// Solves and FULLY reconstructs one scenario's exact-need combination — the straightforward
// version of solveExactNeed above, written as a plain sequential walk (QB -> DST -> RB -> WR ->
// TE) so the backtracking is explicit and easy to follow rather than generic-and-clever.
function solveScenario(freeByPos, need, budgetUnits) {
  const qb = buildBucketTable(freeByPos.QB, Math.max(need.QB, 0), budgetUnits);
  const dst = buildBucketTable(freeByPos.DST, Math.max(need.DST, 0), budgetUnits);
  const rb = buildBucketTable(freeByPos.RB, Math.max(need.RB, 0), budgetUnits);
  const wr = buildBucketTable(freeByPos.WR, Math.max(need.WR, 0), budgetUnits);
  const te = buildBucketTable(freeByPos.TE, Math.max(need.TE, 0), budgetUnits);

  const qbRow = qb.rowFor(Math.max(need.QB, 0));
  const dstRow = dst.rowFor(Math.max(need.DST, 0));
  const rbRow = rb.rowFor(Math.max(need.RB, 0));
  const wrRow = wr.rowFor(Math.max(need.WR, 0));
  const teRow = te.rowFor(Math.max(need.TE, 0));

  const c1 = combine(qbRow, dstRow, budgetUnits);     // QB + DST
  const c2 = combine(c1.points, rbRow, budgetUnits);  // + RB
  const c3 = combine(c2.points, wrRow, budgetUnits);  // + WR
  const c4 = combine(c3.points, teRow, budgetUnits);  // + TE

  let bw = -1, bv = NEG;
  for (let w = 0; w <= budgetUnits; w++) if (c4.points[w] > bv) { bv = c4.points[w]; bw = w; }
  if (bv === NEG) return null;

  const w3 = c4.splitA[bw], wTe = bw - w3;
  const w2 = c3.splitA[w3], wWr = w3 - w2;
  const w1 = c2.splitA[w2], wRb = w2 - w1;
  const wQb = c1.splitA[w1], wDst = w1 - wQb;

  const teChosen = te.reconstruct(Math.max(need.TE, 0), wTe) || [];
  const wrChosen = wr.reconstruct(Math.max(need.WR, 0), wWr) || [];
  const rbChosen = rb.reconstruct(Math.max(need.RB, 0), wRb) || [];
  const dstChosen = dst.reconstruct(Math.max(need.DST, 0), wDst) || [];
  const qbChosen = qb.reconstruct(Math.max(need.QB, 0), wQb) || [];

  return { points: bv, players: [...qbChosen, ...rbChosen, ...wrChosen, ...teChosen, ...dstChosen] };
}

// Generates up to `count` distinct lineups via exposure-capped repeated re-solving — simpler
// than lib/dfs-optimizer.js's Showdown generator (no correlation/"Core" stacking yet; a Classic
// slate's QB-WR stacks can span multiple games, a meaningfully bigger correlation model than
// Showdown's single-game one, and isn't built here — see the module comment). Each repeat
// re-solves fresh under a growing exclusion set: once a player hits `maxExposure` of the target
// count, they're excluded from further builds; an exact-duplicate result instead bans its own
// cheapest non-locked player for the next attempt only, then releases that ban once a genuinely
// new lineup is found.
function optimizeClassicLineups(pool, { count = 1, maxExposure = 0.3, lockedIds = [], excludedIds = [] } = {}) {
  const baseExcluded = new Set(excludedIds);
  const lockedSet = new Set(lockedIds);
  const lineups = [];
  const signatures = new Set();
  const exposureCount = {};
  const maxAllowed = Math.max(1, Math.ceil(count * maxExposure));
  const MAX_ATTEMPTS = count * 40; // generous ceiling so a shallow pool can't loop forever

  let extraExcluded = new Set();
  let attempts = 0;
  while (lineups.length < count && attempts < MAX_ATTEMPTS) {
    attempts++;
    const exposureExcluded = Object.keys(exposureCount).filter(id => exposureCount[id] >= maxAllowed && !lockedSet.has(id));
    const result = optimizeClassicLineup(pool, {
      lockedIds,
      excludedIds: [...baseExcluded, ...exposureExcluded, ...extraExcluded],
    });
    if (!result) {
      // Nothing fits under the current exclusions — try again with just the duplicate-avoidance
      // bans cleared (keep the real exposure caps) in case THOSE were what made it infeasible,
      // rather than giving up on a pool that genuinely has more to offer.
      if (extraExcluded.size) { extraExcluded = new Set(); continue; }
      break;
    }
    const signature = result.players.map(p => p.id).sort().join(',');
    if (signatures.has(signature)) {
      const candidates = result.players.filter(p => !lockedSet.has(p.id)).sort((a, b) => a.salary - b.salary);
      if (!candidates.length) break; // every player is locked — this is the only lineup possible
      extraExcluded.add(candidates[0].id);
      continue;
    }
    signatures.add(signature);
    lineups.push(result);
    result.players.forEach(p => { exposureCount[p.id] = (exposureCount[p.id] || 0) + 1; });
    extraExcluded = new Set();
  }
  return lineups;
}

module.exports = { optimizeClassicLineup, optimizeClassicLineups, CAP, UNIT, FLEX_SCENARIOS };
