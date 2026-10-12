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

// DK Showdown requires at least one player from EACH team in the final 6 — an all-one-team
// lineup isn't just suboptimal, it's an invalid DK entry, so this is a hard constraint, not a
// soft preference. The overwhelming majority of calls never need it: a captain's forced flex
// (locks/Core) or the plain unconstrained optimum almost always already spans both teams on its
// own, since the salary cap pushes toward spreading value across the cheaper side too. Only
// when EVERY forced slot and the free-flex optimum are the captain's own team does this fall
// back to forcing each possible other-team player in turn as a guaranteed anchor and re-solving
// the rest — this finds the exact constrained optimum, not an approximation: whichever
// other-team player the TRUE best valid lineup uses, forcing that same player as the anchor and
// re-solving the remaining slots can only match or beat that lineup's value, since the rest of
// that lineup is itself a feasible solution to the resulting sub-problem. Taking the best result
// across every possible anchor therefore finds a value >= the true optimum, and since every
// anchored result is itself a valid, feasible 2-team lineup, it can't exceed the true optimum
// either — so it's exactly equal to it.
function bestFlexWithBothTeams(captain, forcedFlex, remainingPool, budgetUnits, slotsLeft) {
  const hasOtherTeam = players => players.some(p => p.team !== captain.team);
  if (hasOtherTeam(forcedFlex)) return bestN(remainingPool, budgetUnits, slotsLeft);

  const unconstrained = bestN(remainingPool, budgetUnits, slotsLeft);
  if (slotsLeft === 0 || (unconstrained && hasOtherTeam(unconstrained.players))) return unconstrained;

  let best = null;
  for (const anchor of remainingPool) {
    if (anchor.team === captain.team) continue;
    const w = Math.round(anchor.salary / UNIT);
    if (w > budgetUnits) continue;
    const rest = bestN(remainingPool.filter(p => p.id !== anchor.id), budgetUnits - w, slotsLeft - 1);
    if (!rest) continue;
    const points = anchor.points + rest.points;
    if (!best || points > best.points) {
      best = { points, salaryUsed: anchor.salary + rest.salaryUsed, players: [anchor, ...rest.players] };
    }
  }
  return best;
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
    const rest = bestFlexWithBothTeams(captain, forcedFlex, remainingPool, budgetUnits, slotsLeft);
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
// one game. Two real correlations exist in this format: (1) a QB and a teammate who actually
// catches passes share the same completions and passing TDs, and (2) a "bring-back" pass-catcher
// on the OPPOSING team benefits alongside the captain's team if the game turns into a shootout
// (both passing games get volume together). A between-the-tackles RB's production is usage/
// game-script driven rather than tied to the passing game, but a real receiving back is a
// genuine exception — his catches ARE the QB's completions, the same shared play a WR/TE has —
// so RBs use the same `isPassCatcher` check as WR/TE, gated on `recRole` (set in
// buildDfsProjections() from actual projected receiving volume, not just position) rather than
// assumed from position alone. DST/K value depends on the OPPOSING offense underperforming —
// forcing a correlation partner for those would fabricate a signal that isn't actually there,
// so we say so instead of guessing. Returns the captain plus up to two correlation partners (in
// priority order) and a human-readable reason for each, including why a position gets none.
function buildCore(usable, captain, { model } = {}) {
  const isPassCatcher = p => p.pos === 'WR' || p.pos === 'TE' || (p.pos === 'RB' && p.recRole);
  const byPoints = (a, b) => b.points - a.points;
  const ownTeam = usable.filter(p => p.id !== captain.id && p.team === captain.team && p.points > 0);
  const oppTeam = usable.filter(p =>
    p.id !== captain.id && p.team !== captain.team && p.points > 0 && p.pos !== 'DST' && p.pos !== 'K'
  );

  const players = [captain];
  const reasons = [{ id: captain.id, reason: `Captain — 1.5x salary and points.` }];

  if (captain.pos === 'QB') {
    const ownCatcher = ownTeam.filter(isPassCatcher).sort(byPoints)[0];
    if (ownCatcher) {
      players.push(ownCatcher);
      const role = ownCatcher.pos === 'RB' ? ' as a receiving back' : '';
      reasons.push({ id: ownCatcher.id, reason: `Same-team pass-catcher${role} — shares ${captain.name}'s completions and passing TDs.` });
    }
    const bringBack = oppTeam.filter(p => isPassCatcher(p) || p.pos === 'QB').sort(byPoints)[0];
    if (bringBack) {
      players.push(bringBack);
      reasons.push({ id: bringBack.id, reason: `Bring-back from the opposing offense — benefits alongside ${captain.name} if this plays out as a shootout${model && model.total ? ` (model total: ${model.total})` : ''}.` });
    }
  } else if (isPassCatcher(captain)) {
    const ownQb = ownTeam.find(p => p.pos === 'QB');
    if (ownQb) {
      players.push(ownQb);
      reasons.push({ id: ownQb.id, reason: `${captain.name}'s production runs through ${ownQb.name}'s passing volume.` });
    }
    const bringBack = oppTeam.filter(p => isPassCatcher(p) || p.pos === 'QB').sort(byPoints)[0];
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

// Generates up to `count` distinct lineups instead of a single point-optimal one — standard
// large-field DFS tournament practice. Two tiers:
//
// Tier "primary" ("best shot" lineups) — only captains whose own best-possible lineup lands
// within `qualityFloor` (default 85%) of the single best lineup's value get built around, each
// with its Showdown Core (see buildCore()) forced into every lineup after its own first
// (pure max-EV) one, so this tier is a handful of real correlated stacks, not scattered
// independent picks. Entries are split across the qualifying captains by weighted apportionment
// (the top theory gets the largest share).
//
// Tier "fill" — if a `count`-entry tournament has more entries than the primary tier could
// responsibly fill, a below-floor lineup still has a shot at the prize pool and an unused entry
// has none, so this tier keeps going: it walks the rest of the full captain ranking (not just
// the ones that cleared the floor), still forcing each captain's Core for consistency, with the
// exposure cap progressively loosened so good complementary pieces can recur as needed. It has
// no value floor — the only thing that stops it is genuinely running out of distinct, salary-
// cap-legal lineups to build, which only happens on a very shallow pool. Every lineup carries a
// `tier` field so the caller can show which ones are the real conviction plays.
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

  const lineups = [];
  const globalSignatures = new Set(); // captainId|sorted-flex-ids, deduped across both tiers
  const exposureCount = {}; // global FLEX/captain exposure across the whole generated set

  // Generates up to `wanted` more distinct lineups for one captain, mutating the shared state
  // above. Stops when infeasible, when the reachable space is genuinely exhausted, or when
  // `minValue` is set and the next best achievable value falls below it.
  //
  // Re-solving after banning only the single best repeated flex player (one linear chain of
  // bans) under-explores the space: once that chain bans enough players to make the knapsack
  // infeasible, it gives up even though other combinations — reached by banning a DIFFERENT
  // player from an earlier attempt — are still perfectly valid and unexplored. This instead
  // runs a small branch-and-bound: a duplicate result branches into one child search per
  // excludable flex player in it (not just the best one), queued smallest-exclusion-set-first
  // so higher-value lineups are still found before lower-value ones. An iteration cap bounds
  // the cost on pools where this tree genuinely gets large.
  const MAX_SEARCH_ITERATIONS = 400;
  function fillFromCaptain(captain, core, { wanted, minValue, exposureCapRatio, tier }) {
    const coreCandidates = core.players.slice(1); // everything but the captain itself
    const maxAllowed = Math.max(1, Math.ceil(count * exposureCapRatio));
    let generatedForThisCaptain = 0;

    const frontier = [new Set()];
    let frontierHead = 0;
    const triedExclusionSigs = new Set(['']);
    let iterations = 0;

    while (generatedForThisCaptain < wanted && lineups.length < count
      && frontierHead < frontier.length && iterations < MAX_SEARCH_ITERATIONS) {
      iterations++;
      const extraExcluded = frontier[frontierHead++];

      // This captain's very first lineup (across either tier) stays pure max-EV, uncompromised
      // by the Core — forcing a correlation partner into it would just trade away value it
      // didn't need to trade. Every lineup after that for the same captain forces the Core in.
      const alreadyBuilt = lineups.some(l => l.captain.id === captain.id) || generatedForThisCaptain > 0;
      const exposureExcluded = new Set(
        Object.keys(exposureCount).filter(id => exposureCount[id] >= maxAllowed && !lockedSet.has(id))
      );
      const flexExcluded = new Set([...exposureExcluded, ...extraExcluded]);
      const result = buildLineupForCaptain(usable, lockedSet, captain, flexExcluded, alreadyBuilt ? coreCandidates : []);
      if (!result || (minValue != null && result.totalPoints < minValue)) continue; // dead branch, try the next frontier entry

      const signature = captain.id + '|' + result.flex.map(p => p.id).sort().join(',');
      if (globalSignatures.has(signature)) {
        const branchable = result.flex.filter(p => !lockedSet.has(p.id) && !result.coreUsedIds.has(p.id));
        for (const p of branchable) {
          const childExcluded = new Set([...extraExcluded, p.id]);
          const sig = [...childExcluded].sort().join(',');
          if (triedExclusionSigs.has(sig)) continue;
          triedExclusionSigs.add(sig);
          frontier.push(childExcluded);
        }
        continue;
      }

      globalSignatures.add(signature);
      const flexIds = new Set(result.flex.map(p => p.id));
      lineups.push({
        ...result, tier,
        core: {
          forced: alreadyBuilt,
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
    }
    return generatedForThisCaptain;
  }

  // ---- Tier "primary" ----
  const primaryContenders = ranked.filter(c => c.preview.totalPoints >= floorValue).slice(0, count);
  const weights = primaryContenders.map((_, i) => primaryContenders.length - i); // top theory weighted heaviest
  const allocation = allocateByWeight(count, weights);
  primaryContenders.forEach(({ captain }, i) => {
    const core = buildCore(usable, captain, { model });
    fillFromCaptain(captain, core, { wanted: allocation[i], minValue: floorValue, exposureCapRatio: maxExposure, tier: 'primary' });
  });

  // ---- Tier "fill" — only runs if the primary tier left entries on the table. Round-robins one
  // lineup per captain per pass (instead of exhausting the first captain in the ranking before
  // moving on) so entries stay spread across captains rather than piling onto whichever one
  // happens to be easiest to keep squeezing variations out of.
  //
  // Staged in order of how much is being relaxed, rather than jumping straight to "no floor,
  // any captain": extracting MORE flex variation out of the captains already used in the
  // primary tier (same quality floor, just a looser exposure cap) comes first, then the same
  // captains with a lower secondary floor, then expanding to the rest of the ranked list at
  // that secondary floor, and only as a true last resort — a shallow pool that can't otherwise
  // reach `count` — dropping the floor entirely. This is the same thing captain-locked mode
  // does by construction (there's only one captain, so "fill" necessarily means deepening its
  // own flex variety); the staging here gives free mode that same bias toward sticking with a
  // captain that's actually proven good before reaching for a structurally worse one.
  function roundRobinFill(captainList, minValue, exposureCapRatio) {
    let progress = true;
    while (lineups.length < count && progress) {
      progress = false;
      for (const { captain } of captainList) {
        if (lineups.length >= count) break;
        const core = buildCore(usable, captain, { model });
        const added = fillFromCaptain(captain, core, { wanted: 1, minValue, exposureCapRatio, tier: 'fill' });
        if (added > 0) progress = true;
      }
    }
  }

  const secondaryFloor = topValue * 0.65;
  const usedCaptainIds = new Set(lineups.map(l => l.captain.id));
  const provenCaptains = ranked.filter(r => usedCaptainIds.has(r.captain.id));
  const exposureSteps = [Math.max(maxExposure, 0.6), 1];
  const fillStages = [
    ...exposureSteps.map(exposureCapRatio => ({ captains: provenCaptains, minValue: floorValue, exposureCapRatio })),
    ...exposureSteps.map(exposureCapRatio => ({ captains: provenCaptains, minValue: secondaryFloor, exposureCapRatio })),
    ...exposureSteps.map(exposureCapRatio => ({ captains: ranked, minValue: secondaryFloor, exposureCapRatio })),
    { captains: ranked, minValue: null, exposureCapRatio: 1 },
  ];
  for (const stage of fillStages) {
    if (lineups.length >= count) break;
    roundRobinFill(stage.captains, stage.minValue, stage.exposureCapRatio);
  }

  // Sort by actual achieved value, not generation order — forcing the Core costs a little
  // value on purpose for the consistency hedge, so a secondary theory's untouched top lineup
  // can land ahead of a primary theory's Core-forced one. "Lineup 1" should always mean the
  // best lineup actually generated.
  lineups.sort((a, b) => b.totalPoints - a.totalPoints);
  return lineups;
}

module.exports = { optimizeLineup, optimizeLineups, buildCore, bestN, bestFlexWithBothTeams, CAP, UNIT };
