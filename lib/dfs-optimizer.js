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
// below to diversify a generated set of lineups via a max-exposure cap). `coreCandidates` is an
// extra, lower-priority forcing list — the Showdown correlation partners (see buildCore()
// below) we'd *like* in the lineup alongside this captain. They're tried as a block, then with
// the weakest one dropped, and so on down to none, so a correlation pick that simply doesn't
// fit the cap (or collides with a lock/exclude) degrades gracefully instead of making the whole
// build infeasible. The returned `coreUsedIds` says which of them actually made it in, so
// callers can report the real Core rather than the aspirational one.
function buildLineupForCaptain(usable, lockedSet, captain, flexExcluded = null, coreCandidates = []) {
  const captainSalary = Math.round(captain.salary * 1.5);
  if (captainSalary > CAP) return null;

  const eligibleCore = coreCandidates.filter(p =>
    p.id !== captain.id && !lockedSet.has(p.id) && !(flexExcluded && flexExcluded.has(p.id))
  );
  const lockedFlex = usable.filter(p => lockedSet.has(p.id) && p.id !== captain.id);

  for (let take = eligibleCore.length; take >= 0; take--) {
    const coreSubset = eligibleCore.slice(0, take);
    const coreIds = new Set(coreSubset.map(p => p.id));
    const forcedFlex = [...lockedFlex, ...coreSubset];
    const slotsLeft = 5 - forcedFlex.length;
    if (slotsLeft < 0) continue; // too many locked/core players to fit alongside this captain — try a smaller core
    const remainingPool = usable.filter(p =>
      p.id !== captain.id && !lockedSet.has(p.id) && !coreIds.has(p.id) && !(flexExcluded && flexExcluded.has(p.id))
    );
    const forcedSalary = forcedFlex.reduce((s, p) => s + p.salary, 0);
    const forcedPoints = forcedFlex.reduce((s, p) => s + p.points, 0);
    const budgetUnits = Math.floor((CAP - captainSalary - forcedSalary) / UNIT);
    if (budgetUnits < 0) continue;
    const rest = bestN(remainingPool, budgetUnits, slotsLeft);
    if (!rest) continue;
    const flex = [...forcedFlex, ...rest.players];
    return {
      captain, captainSalary,
      flex,
      totalPoints: +(captain.points * 1.5 + forcedPoints + rest.points).toFixed(2),
      totalSalary: captainSalary + forcedSalary + rest.salaryUsed,
      coreUsedIds: coreIds,
    };
  }
  return null;
}

// pool: projected players (points > 0 enforced by caller, or not — zero-point players just
// never get picked). lockedIds: must appear somewhere in the final 6. captainLockId: if set,
// that player MUST be Captain (captainLockId should also be in lockedIds, or is treated as
// implicitly locked). excludedIds: must not appear anywhere. Pure max-EV, no correlation
// forcing — used as a correctness baseline and anywhere a single untouched optimum is wanted.
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

// Showdown correlation model. A DK Showdown slate is a single game, so "stacking" here isn't
// about which game to pick — it's about which players' own outcomes move together within that
// one game. Two real correlations exist in this format: (1) a QB and his own team's
// pass-catcher share the same completions and passing TDs, and (2) a "bring-back" pass-catcher
// on the OPPOSING team benefits alongside the captain's team if the game turns into a shootout
// (both passing games get volume together). RB production is usage/game-script driven rather
// than tied to one teammate's stat line, and DST/K value depends on the OPPOSING offense
// underperforming — forcing a correlation partner for those would fabricate a signal that
// isn't actually there, so we say so instead of guessing. Returns the captain plus up to two
// correlation partners (in priority order) and a human-readable reason for each, including why
// a position gets none.
function buildCore(usable, captain, { model } = {}) {
  const PASS_CATCHER = new Set(['WR', 'TE']);
  const byPoints = (a, b) => b.points - a.points;
  const ownTeam = usable.filter(p => p.id !== captain.id && p.team === captain.team && p.points > 0);
  const oppTeam = usable.filter(p =>
    p.id !== captain.id && p.team !== captain.team && p.points > 0 && p.pos !== 'DST' && p.pos !== 'K'
  );

  const players = [captain];
  const reasons = [{ id: captain.id, reason: `Captain — 1.5x salary and points.` }];

  if (captain.pos === 'QB') {
    const ownCatcher = ownTeam.filter(p => PASS_CATCHER.has(p.pos)).sort(byPoints)[0];
    if (ownCatcher) {
      players.push(ownCatcher);
      reasons.push({ id: ownCatcher.id, reason: `Same-team pass-catcher — shares ${captain.name}'s completions and passing TDs.` });
    }
    const bringBack = oppTeam.filter(p => PASS_CATCHER.has(p.pos) || p.pos === 'QB').sort(byPoints)[0];
    if (bringBack) {
      players.push(bringBack);
      reasons.push({ id: bringBack.id, reason: `Bring-back from the opposing offense — benefits alongside ${captain.name} if this plays out as a shootout${model && model.total ? ` (model total: ${model.total})` : ''}.` });
    }
  } else if (PASS_CATCHER.has(captain.pos)) {
    const ownQb = ownTeam.find(p => p.pos === 'QB');
    if (ownQb) {
      players.push(ownQb);
      reasons.push({ id: ownQb.id, reason: `${captain.name}'s production runs through ${ownQb.name}'s passing volume.` });
    }
    const bringBack = oppTeam.filter(p => PASS_CATCHER.has(p.pos) || p.pos === 'QB').sort(byPoints)[0];
    if (bringBack) {
      players.push(bringBack);
      reasons.push({ id: bringBack.id, reason: `Bring-back from the opposing offense — shootout correlation with ${captain.name}.` });
    }
  } else if (captain.pos === 'RB') {
    reasons.push({ id: null, reason: `${captain.name}'s touches are driven by usage and game script, not a shared play with one teammate — no correlation partner is forced here.` });
  } else {
    reasons.push({ id: null, reason: `${captain.pos} value depends on the opposing offense underperforming, which runs counter to stacking that offense's skill players — no correlation partner is forced here.` });
  }

  return { players, reasons };
}

// Hamilton apportionment: give every entry in `weights` at least 1 of `count`, then hand out
// the remainder in proportion to weight (largest leftover fraction first). Used to split lineup
// entries across more than one "captain theory" without ever dropping a qualifying theory to
// zero just because its weight rounded down.
function allocateByWeight(count, weights) {
  const n = weights.length;
  const base = new Array(n).fill(1);
  let remaining = count - n;
  if (remaining <= 0) return base;
  const total = weights.reduce((s, w) => s + w, 0);
  const raw = weights.map(w => remaining * w / total);
  const extra = raw.map(Math.floor);
  let leftover = remaining - extra.reduce((s, e) => s + e, 0);
  const order = raw.map((r, i) => ({ i, frac: r - extra[i] })).sort((a, b) => b.frac - a.frac);
  for (let j = 0; j < leftover; j++) extra[order[j].i]++;
  return base.map((b, i) => b + extra[i]);
}

// Generates up to `count` distinct, high-quality lineups instead of a single point-optimal one
// — standard large-field DFS tournament practice. Two things keep the set from degenerating
// into "20 unrelated lineups, several of them bad": (1) a quality floor — only captains whose
// own best-possible lineup lands within `qualityFloor` (default 85%) of the single best
// lineup's value are ever built around, so the 20th lineup can't be built on a captain that
// was never actually a good play; and (2) correlation — each qualifying captain gets its
// Showdown Core (see buildCore()) forced into every lineup built around it, so the generated
// set is built from a handful of real correlated stacks rather than treating every player as
// independent. Entries are split across the qualifying captains by weighted apportionment
// (the top theory gets the largest share), and within each captain's share, the remaining FLEX
// slots still get the existing max-exposure-cap diversification so the same complementary
// pieces don't just get recycled into every build.
function optimizeLineups(pool, {
  count = 5, maxExposure = 0.35, lockedIds = [], captainLockId = null, excludedIds = [],
  qualityFloor = 0.85, model = {},
} = {}) {
  const excluded = new Set(excludedIds);
  const usable = pool.filter(p => !excluded.has(p.id));
  const lockedSet = new Set(lockedIds);
  if (captainLockId) lockedSet.add(captainLockId);

  const candidateCaptains = captainLockId
    ? usable.filter(p => p.id === captainLockId)
    : usable;
  const ranked = candidateCaptains
    .map(captain => ({ captain, preview: buildLineupForCaptain(usable, lockedSet, captain) }))
    .filter(c => c.preview)
    .sort((a, b) => b.preview.totalPoints - a.preview.totalPoints);
  if (!ranked.length) return [];

  const topValue = ranked[0].preview.totalPoints;
  const floorValue = topValue * qualityFloor;
  const contenders = ranked.filter(c => c.preview.totalPoints >= floorValue).slice(0, count);

  const weights = contenders.map((_, i) => contenders.length - i); // top theory weighted heaviest
  const allocation = allocateByWeight(count, weights);

  const lineups = [];
  const exposureCount = {}; // global FLEX exposure across the whole generated set

  for (let ci = 0; ci < contenders.length && lineups.length < count; ci++) {
    const { captain } = contenders[ci];
    const core = buildCore(usable, captain, { model });
    const coreCandidates = core.players.slice(1); // everything but the captain itself
    const wanted = allocation[ci];
    const maxAllowed = Math.max(1, Math.ceil(count * maxExposure));
    const seenFlexSignatures = new Set();
    let forcedExclusions = new Set();
    let generatedForThisCaptain = 0;

    while (generatedForThisCaptain < wanted && lineups.length < count) {
      // This captain's very first lineup stays pure max-EV, uncompromised by the Core — that
      // IS "the top projected lineup" for this theory, and forcing a correlation partner into
      // it would just be trading away value it didn't need to trade. Every lineup after that
      // for the same captain forces the Core in, since the whole point of generating more than
      // one is the correlated hedge, not a second independent max-EV search.
      const forceCore = generatedForThisCaptain > 0;
      const exposureExcluded = new Set(
        Object.keys(exposureCount).filter(id => exposureCount[id] >= maxAllowed && !lockedSet.has(id))
      );
      const flexExcluded = new Set([...exposureExcluded, ...forcedExclusions]);
      const result = buildLineupForCaptain(usable, lockedSet, captain, flexExcluded, forceCore ? coreCandidates : []);
      if (!result || result.totalPoints < floorValue) break; // exhausted this captain, or fell below the consistency floor

      const signature = result.flex.map(p => p.id).sort().join(',');
      if (seenFlexSignatures.has(signature)) {
        // Ban this attempt's single best non-locked, non-Core flex player and retry
        // immediately — forces a genuinely different combination without ever stripping out
        // the deliberately-forced correlation piece.
        const forceOut = [...result.flex]
          .filter(p => !lockedSet.has(p.id) && !result.coreUsedIds.has(p.id))
          .sort((a, b) => b.points - a.points)[0];
        if (!forceOut || forcedExclusions.has(forceOut.id)) break; // genuinely exhausted
        forcedExclusions.add(forceOut.id);
        continue;
      }

      seenFlexSignatures.add(signature);
      const flexIds = new Set(result.flex.map(p => p.id));
      lineups.push({
        ...result,
        core: {
          forced: forceCore,
          players: core.players.map(p => ({
            id: p.id, name: p.name, pos: p.pos, team: p.team,
            inLineup: p.id === captain.id || flexIds.has(p.id),
          })),
          reasons: core.reasons,
        },
      });
      result.flex.forEach(p => { exposureCount[p.id] = (exposureCount[p.id] || 0) + 1; });
      exposureCount[captain.id] = (exposureCount[captain.id] || 0) + 1;
      generatedForThisCaptain++;
      forcedExclusions = new Set();
    }
  }

  // Sort by actual achieved value, not generation order — forcing the Core costs a little
  // value on purpose for the consistency hedge, so a secondary theory's untouched top lineup
  // can land ahead of a primary theory's Core-forced one. "Lineup 1" should always mean the
  // best lineup actually generated.
  lineups.sort((a, b) => b.totalPoints - a.totalPoints);
  return lineups;
}

module.exports = { optimizeLineup, optimizeLineups, buildCore, bestN, CAP, UNIT };
