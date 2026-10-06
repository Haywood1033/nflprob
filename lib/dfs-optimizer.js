// lib/dfs-optimizer.js — exact Captain + 5 FLEX optimizer for a DK Showdown salary cap,
// with support for forcing specific players into the lineup ("locks") or into the Captain
// slot specifically, and excluding others outright. Uses a 0/1 knapsack DP (exactly-N-items,
// maximize points, weight = salary) rather than a greedy heuristic, so the result is the true
// mathematical optimum for the given point projections and constraints — not an approximation.

const CAP = 50000;
const UNIT = 100; // DK Showdown salaries are always whole-$100 increments

// dp[p][k][w] = max total points using exactly k of the first p players with total salary <=
// w (in $100 units). Standard 0/1 knapsack, kept as a full per-item-prefix table (not collapsed
// into just k/w) so reconstruction can walk backward by item index instead of following a
// pointer recorded at insertion time. A collapsed take[k][w] pointer looks right during the
// forward pass but can go stale: a later item can improve a *lower* cell (dp[k-1][w-weight])
// that an earlier cell's pointer already depends on, and reconstruction would then silently
// double-count that later item — the exact bug that produced duplicate players inside a single
// FLEX group. Keeping the full prefix table avoids that: dp[p-1][k][w] === dp[p][k][w] tells us
// unambiguously whether item p-1 was actually used in reaching the final optimum.
function bestN(players, budgetUnits, n) {
  if (n === 0) return { points: 0, salaryUsed: 0, players: [] };
  if (budgetUnits < 0) return null;
  const NEG = -Infinity;
  const P = players.length;
  const dp = Array.from({ length: P + 1 }, () =>
    Array.from({ length: n + 1 }, () => new Array(budgetUnits + 1).fill(NEG))
  );
  for (let wt = 0; wt <= budgetUnits; wt++) dp[0][0][wt] = 0;

  for (let p = 1; p <= P; p++) {
    const w = Math.round(players[p - 1].salary / UNIT);
    const v = players[p - 1].points;
    const prev = dp[p - 1], cur = dp[p];
    for (let k = 0; k <= n; k++) {
      const prevK = prev[k], prevK1 = k > 0 ? prev[k - 1] : null;
      const curK = cur[k];
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

  let best = NEG, bestW = -1;
  const finalRow = dp[P][n];
  for (let wt = 0; wt <= budgetUnits; wt++) if (finalRow[wt] > best) { best = finalRow[wt]; bestW = wt; }
  if (best === NEG) return null;

  // Reconstruct by walking backward through item prefixes: item p-1 was used exactly when
  // dp[p][k][wt] differs from dp[p-1][k][wt] (the "don't take" value at the same k/wt).
  const chosen = [];
  let p = P, k = n, wt = bestW;
  while (k > 0) {
    if (dp[p - 1][k][wt] === dp[p][k][wt]) {
      p -= 1;
      continue;
    }
    const player = players[p - 1];
    chosen.push(player);
    wt -= Math.round(player.salary / UNIT);
    k -= 1;
    p -= 1;
  }
  return { points: best, salaryUsed: chosen.reduce((s, pl) => s + pl.salary, 0), players: chosen };
}

// Builds the single best full lineup (captain + 5 flex) for one specific captain choice, given
// a usable pool, a set of player ids that MUST be in the final 6 (lockedSet), and an optional
// extra set of ids temporarily unavailable for the FLEX slots only (used by optimizeLineups()
// below to diversify a generated set of lineups via a max-exposure cap — captain choice is
// already the primary diversification axis there, so only FLEX gets exposure-capped, and a
// locked player is always exempt since the user explicitly wants them in every build).
function buildLineupForCaptain(usable, lockedSet, captain, flexExcluded = null) {
  const captainSalary = Math.round(captain.salary * 1.5);
  if (captainSalary > CAP) return null;
  const forcedFlex = usable.filter(p => lockedSet.has(p.id) && p.id !== captain.id);
  const remainingPool = usable.filter(p => p.id !== captain.id && !lockedSet.has(p.id) && !(flexExcluded && flexExcluded.has(p.id)));
  const slotsLeft = 5 - forcedFlex.length;
  if (slotsLeft < 0) return null; // too many locked players to fit alongside this captain
  const forcedSalary = forcedFlex.reduce((s, p) => s + p.salary, 0);
  const forcedPoints = forcedFlex.reduce((s, p) => s + p.points, 0);
  const budgetUnits = Math.floor((CAP - captainSalary - forcedSalary) / UNIT);
  if (budgetUnits < 0) return null;
  const rest = bestN(remainingPool, budgetUnits, slotsLeft);
  if (!rest) return null;
  const flex = [...forcedFlex, ...rest.players];
  return {
    captain, captainSalary,
    flex,
    totalPoints: +(captain.points * 1.5 + forcedPoints + rest.points).toFixed(2),
    totalSalary: captainSalary + forcedSalary + rest.salaryUsed,
  };
}

// pool: projected players (points > 0 enforced by caller, or not — zero-point players just
// never get picked). lockedIds: must appear somewhere in the final 6. captainLockId: if set,
// that player MUST be Captain (captainLockId should also be in lockedIds, or is treated as
// implicitly locked). excludedIds: must not appear anywhere.
function optimizeLineup(pool, { lockedIds = [], captainLockId = null, excludedIds = [] } = {}) {
  const excluded = new Set(excludedIds);
  const usable = pool.filter(p => !excluded.has(p.id));
  const lockedSet = new Set(lockedIds);
  if (captainLockId) lockedSet.add(captainLockId);

  if (captainLockId) {
    const captain = usable.find(p => p.id === captainLockId);
    if (!captain) return null;
    return buildLineupForCaptain(usable, lockedSet, captain);
  }

  let best = null;
  for (const captain of usable) {
    const result = buildLineupForCaptain(usable, lockedSet, captain);
    if (result && (!best || result.totalPoints > best.totalPoints)) best = result;
  }
  return best;
}

// Generates up to `count` distinct, high-quality lineups instead of a single point-optimal
// one — standard DFS tournament practice. A lineup that maximizes *expected* points has no
// hedge against any single projection being wrong (and this app's projections lean on plain
// recency averages for several legs — see lib/dfs-projections.js), so spreading entries across
// a small diversified set is the practical mitigation here, short of a full variance/ceiling
// model. Diversifies on two axes: (1) every lineup gets a DIFFERENT captain, generated in
// descending order of that captain's own best-possible lineup value, and (2) a max-exposure
// cap on FLEX players (default 35% of the generated set — in line with typical large-field GPP
// exposure practice, tighter than a cash-game/small-field cap would need) so the same few stud
// FLEX plays don't just get recycled into every build, which would undermine the hedge. Locked
// players are exempt from the exposure cap since the user explicitly wants them in every lineup.
function optimizeLineups(pool, { count = 5, maxExposure = 0.35, lockedIds = [], captainLockId = null, excludedIds = [] } = {}) {
  const excluded = new Set(excludedIds);
  const usable = pool.filter(p => !excluded.has(p.id));
  const lockedSet = new Set(lockedIds);
  if (captainLockId) lockedSet.add(captainLockId);

  // A locked Captain removes captain choice as a diversification axis, but the FLEX
  // construction around that captain is still real estate to vary — a common large-field
  // strategy is exactly "I have conviction on this Captain, now spread entries across
  // different complementary builds." With the captain fixed, the knapsack is solving the
  // EXACT SAME problem every time until something is actually excluded — unlike the
  // multi-captain path below, where every solve is structurally different from the start, here
  // the exposure cap alone does nothing on the first repeat (nobody's hit the cap yet), so a
  // second attempt would just return the identical best flex-5 again. Each repeat is instead
  // forced to change by banning that attempt's single best (non-locked) flex player and
  // re-solving immediately — a real exclusion, not a threshold waiting to be crossed — then the
  // usual cross-lineup exposure cap takes over once enough lineups exist for it to matter.
  if (captainLockId) {
    const captain = usable.find(p => p.id === captainLockId);
    if (!captain) return [];

    const lineups = [];
    const exposureCount = {};
    const maxAllowed = Math.max(1, Math.ceil(count * maxExposure));
    const seenFlexSignatures = new Set();
    let forcedExclusions = new Set();

    while (lineups.length < count) {
      const exposureExcluded = new Set(
        Object.keys(exposureCount).filter(id => exposureCount[id] >= maxAllowed && !lockedSet.has(id))
      );
      const flexExcluded = new Set([...exposureExcluded, ...forcedExclusions]);
      const result = buildLineupForCaptain(usable, lockedSet, captain, flexExcluded);
      if (!result) break; // no valid complementary flex-5 left even after forcing exclusions

      const signature = result.flex.map(p => p.id).sort().join(',');
      if (seenFlexSignatures.has(signature)) {
        // Ban this attempt's single best non-locked flex player and retry immediately — forces
        // a genuinely different combination instead of waiting on exposure counts that haven't
        // accumulated yet. Doesn't count as a generated lineup.
        const forceOut = [...result.flex].filter(p => !lockedSet.has(p.id)).sort((a, b) => b.points - a.points)[0];
        if (!forceOut || forcedExclusions.has(forceOut.id)) break; // genuinely exhausted — nothing left to force
        forcedExclusions.add(forceOut.id);
        continue;
      }

      seenFlexSignatures.add(signature);
      lineups.push(result);
      result.flex.forEach(p => { exposureCount[p.id] = (exposureCount[p.id] || 0) + 1; });
      forcedExclusions = new Set(); // fresh search for the next lineup
    }
    return lineups;
  }

  const ranked = usable
    .map(captain => ({ captain, preview: buildLineupForCaptain(usable, lockedSet, captain) }))
    .filter(c => c.preview)
    .sort((a, b) => b.preview.totalPoints - a.preview.totalPoints);

  const lineups = [];
  const exposureCount = {};
  const maxAllowed = Math.max(1, Math.ceil(count * maxExposure));

  for (const { captain } of ranked) {
    if (lineups.length >= count) break;
    const flexExcluded = new Set(
      Object.keys(exposureCount).filter(id => exposureCount[id] >= maxAllowed && !lockedSet.has(id))
    );
    const result = buildLineupForCaptain(usable, lockedSet, captain, flexExcluded);
    if (!result) continue; // this captain can't build a valid lineup once over-exposed players are capped — skip to the next-best captain
    lineups.push(result);
    exposureCount[captain.id] = (exposureCount[captain.id] || 0) + 1;
    result.flex.forEach(p => { exposureCount[p.id] = (exposureCount[p.id] || 0) + 1; });
  }
  return lineups;
}

module.exports = { optimizeLineup, optimizeLineups, bestN, CAP, UNIT };
