// lib/dfs-optimizer.js — exact Captain + 5 FLEX optimizer for a DK Showdown salary cap,
// with support for forcing specific players into the lineup ("locks") or into the Captain
// slot specifically, and excluding others outright. Uses a 0/1 knapsack DP (exactly-N-items,
// maximize points, weight = salary) rather than a greedy heuristic, so the result is the true
// mathematical optimum for the given point projections and constraints — not an approximation.

const CAP = 50000;
const UNIT = 100; // DK Showdown salaries are always whole-$100 increments

// dp[k][w] = max total points using exactly k players with total salary <= w (in $100 units).
// Standard 0/1 knapsack, iterated item-by-item with k and w walked DOWNWARD so each player is
// only ever used once.
function bestN(players, budgetUnits, n) {
  if (n === 0) return { points: 0, salaryUsed: 0, players: [] };
  if (budgetUnits < 0) return null;
  const NEG = -Infinity;
  const dp = Array.from({ length: n + 1 }, () => new Array(budgetUnits + 1).fill(NEG));
  dp[0][0] = 0;
  const take = Array.from({ length: n + 1 }, () => Array.from({ length: budgetUnits + 1 }, () => null));
  for (let i = 0; i < players.length; i++) {
    const w = Math.round(players[i].salary / UNIT);
    const v = players[i].points;
    for (let k = Math.min(n, i + 1); k >= 1; k--) {
      for (let wt = budgetUnits; wt >= w; wt--) {
        if (dp[k - 1][wt - w] === NEG) continue;
        const cand = dp[k - 1][wt - w] + v;
        if (cand > dp[k][wt]) {
          dp[k][wt] = cand;
          take[k][wt] = i;
        }
      }
    }
  }
  let best = NEG, bestW = -1;
  for (let wt = 0; wt <= budgetUnits; wt++) if (dp[n][wt] > best) { best = dp[n][wt]; bestW = wt; }
  if (best === NEG) return null;

  // Reconstruct by walking the take[] pointers back from (n, bestW).
  const chosen = [];
  let k = n, wt = bestW;
  while (k > 0) {
    const i = take[k][wt];
    chosen.push(players[i]);
    wt -= Math.round(players[i].salary / UNIT);
    k -= 1;
  }
  return { points: best, salaryUsed: chosen.reduce((s, p) => s + p.salary, 0), players: chosen };
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
// cap on FLEX players (default 60% of the generated set) so the same few stud FLEX plays don't
// just get recycled into every build, which would undermine the hedge. Locked players are
// exempt from the exposure cap since the user explicitly wants them in every lineup.
function optimizeLineups(pool, { count = 5, maxExposure = 0.6, lockedIds = [], captainLockId = null, excludedIds = [] } = {}) {
  const excluded = new Set(excludedIds);
  const usable = pool.filter(p => !excluded.has(p.id));
  const lockedSet = new Set(lockedIds);
  if (captainLockId) lockedSet.add(captainLockId);

  // A locked Captain removes the only diversification axis this function has — there is
  // exactly one valid "best" lineup in that case, same as optimizeLineup().
  if (captainLockId) {
    const captain = usable.find(p => p.id === captainLockId);
    const lineup = captain ? buildLineupForCaptain(usable, lockedSet, captain) : null;
    return lineup ? [lineup] : [];
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
