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

// pool: projected players (points > 0 enforced by caller, or not — zero-point players just
// never get picked). lockedIds: must appear somewhere in the final 6. captainLockId: if set,
// that player MUST be Captain (captainLockId should also be in lockedIds, or is treated as
// implicitly locked). excludedIds: must not appear anywhere.
function optimizeLineup(pool, { lockedIds = [], captainLockId = null, excludedIds = [] } = {}) {
  const excluded = new Set(excludedIds);
  const usable = pool.filter(p => !excluded.has(p.id));
  const lockedSet = new Set(lockedIds);
  if (captainLockId) lockedSet.add(captainLockId);

  function tryCaptain(captain) {
    const captainSalary = Math.round(captain.salary * 1.5);
    if (captainSalary > CAP) return null;
    const forcedFlex = usable.filter(p => lockedSet.has(p.id) && p.id !== captain.id);
    const remainingPool = usable.filter(p => p.id !== captain.id && !lockedSet.has(p.id));
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

  if (captainLockId) {
    const captain = usable.find(p => p.id === captainLockId);
    if (!captain) return null;
    return tryCaptain(captain);
  }

  let best = null;
  for (const captain of usable) {
    const result = tryCaptain(captain);
    if (result && (!best || result.totalPoints > best.totalPoints)) best = result;
  }
  return best;
}

module.exports = { optimizeLineup, bestN, CAP, UNIT };
