// lib/recency-window.js — shared logic for how far back to look for "recent form"
//
// THE PROBLEM THIS SOLVES: before any current-season games exist, every usage function
// falls back to last season's data (see fetchPlayerWeekStats/fetchTeamWeekStats). If that
// fallback then also uses the normal 5-game recency window, it can lock onto a noisy,
// unrepresentative slice of last season's tail end — e.g. a WR who had a temporary target
// spike because a teammate was injured in December has nothing to do with his real Week 1
// role in a new season. A full-season average is more stable for that "borrowed baseline"
// purpose. Once real current-season games exist, the normal 5-game window becomes
// legitimate recent form again and should be used.
//
// The heuristic: throughWeek < 1 means no current-season games have been played yet, which
// is exactly the condition under which fetchPlayerWeekStats/fetchTeamWeekStats fall back to
// last season. Once throughWeek >= 1, real current-season rows exist and recent-form logic
// should apply normally.

const FULL_SEASON_WINDOW = 18; // covers a full 17-game regular season with margin
const LIVE_RECENCY_WINDOW = 5; // normal "recent form" window once real current-season data exists

function recencyWindow(throughWeek) {
  return throughWeek < 1 ? FULL_SEASON_WINDOW : LIVE_RECENCY_WINDOW;
}

// recentGames() — picks a player/team's "recent form" games out of a candidate row set.
//
// BUG THIS FIXES: every usage/ranking function used to do
// `.sort(byWeekDesc).slice(0, lastN)` — take the candidate's own last N rows, whatever week
// they're from. That's "last N times this person appeared in the data," not "last N weeks."
// For someone who has been out for a while (hurt, benched, on IR) that silently pulls in
// stale games from well before the current week and presents them as current form — the
// exact mechanism behind a benched/injured QB still out-ranking, and still projecting as,
// the team's active starter. Real symptom: a long-since-replaced starter still shows up as
// the passing-prop leader because his last 5 recorded games (from a month ago) still count
// as "recent."
//
// FIX: once real current-season games exist (throughWeek >= 1), "recent" means the actual
// last `lastN` calendar weeks up through throughWeek — a player who hasn't appeared in that
// span contributes zero games, which correctly drops his volume to zero instead of reusing
// old ones. Before any current-season games exist (throughWeek < 1, still on the prior-season
// fallback), there's no real "current week" to measure gaps against, so it keeps the old
// behavior of just taking the most recent `lastN` rows available.
function recentGames(rows, throughWeek, lastN) {
  const inSeason = throughWeek < 1 ? rows : rows.filter(r => Number(r.week) <= throughWeek);
  const sorted = [...inSeason].sort((a, b) => Number(b.week) - Number(a.week));
  if (throughWeek < 1) return sorted.slice(0, lastN);
  return sorted.filter(r => Number(r.week) > throughWeek - lastN);
}

// Each game further back counts for 75% of the game ahead of it (so 2 games back ≈ 56% weight,
// 3 games back ≈ 42%) — noticeable but not so aggressive that one freak game swings a
// projection on its own.
const RECENCY_DECAY = 0.75;

// Recency-weighted sum over an ALREADY most-recent-first sorted row set (exactly what
// recentGames() returns — this trusts that ordering rather than re-sorting). Used for the rate
// stats that feed yardage/volume projections, so a real recent role change shows up faster
// than a flat window average would. Deliberately NOT used for the raw unweighted sums that
// feed confidence tiers and badge signal thresholds elsewhere (usage.targets, usage.carries,
// etc.) — those were calibrated against flat sums, and the projection math getting more
// responsive shouldn't silently redefine what counts as "high usage" or "sample confidence."
function weightedAgg(rows, fields, decay = RECENCY_DECAY) {
  let weightedGames = 0;
  const sums = {};
  fields.forEach(f => { sums[f] = 0; });
  rows.forEach((r, i) => {
    const w = Math.pow(decay, i);
    weightedGames += w;
    fields.forEach(f => { sums[f] += w * (parseFloat(r[f]) || 0); });
  });
  return { weightedGames, sums };
}

// A real role claimed that week (combined carries+targets, or targets alone for a pure
// receiver group) — not a token mop-up snap. Used only to detect a new face in the window,
// never to size a projection itself.
const ROLE_CHANGE_MIN_VOLUME = 6;

// REAL CASE THIS WAS BUILT FROM: Josh Jacobs missed GB's first 6 games, returned in week 7.
// MarShawn Lloyd's own recent-form window (weeks 3-7) was unaffected by recentGames()'s fix
// above — he has a real row every one of those weeks — but weightedAgg()'s plain exponential
// decay still let 4 games of "Jacobs was fully out" committee usage outweigh the 1 game that
// actually reflects the current depth chart, overstating his going-forward share (modeled 40%
// vs. his real post-return 35%). This detects the week a position group's personnel visibly
// changed — a player neither seen with real volume in any EARLIER week of the SAME window
// suddenly has it (a returning starter, a rookie promotion, a trade — any of them mean the
// group's actual current personnel just changed) — so that week's weight can be boosted below.
// Returns null for the normal case (nothing in the window looks new), including when the only
// "new" faces are everyone in the window's own first week (nothing earlier to compare against).
function detectRoleChangeWeek(groupRows, throughWeek, lastN, volumeOf) {
  const windowStart = throughWeek - lastN + 1;
  const byWeek = {};
  for (const r of groupRows) {
    if (r.season_type !== 'REG') continue;
    const wk = Number(r.week);
    if (wk > throughWeek || wk < windowStart) continue;
    if (!byWeek[wk]) byWeek[wk] = new Set();
    if (volumeOf(r) >= ROLE_CHANGE_MIN_VOLUME) byWeek[wk].add(r.player_display_name);
  }
  const weeksAsc = Object.keys(byWeek).map(Number).sort((a, b) => a - b);
  if (!weeksAsc.length) return null;

  let roleChangeWeek = null;
  const seenSoFar = new Set();
  for (const wk of weeksAsc) {
    const isNew = [...byWeek[wk]].some(p => !seenSoFar.has(p));
    if (isNew && wk !== weeksAsc[0]) roleChangeWeek = wk;
    byWeek[wk].forEach(p => seenSoFar.add(p));
  }
  return roleChangeWeek;
}

// Chosen to noticeably shift a share estimate toward the new reality within one game, without
// fully discarding the older games the way a hard cutoff to "just the games since" would (one
// game — 6 carries for Lloyd in week 7 — is a thin, noisy sample to size a projection on
// alone). Verified against the real case above: boosting week 7 by 3x pulled Lloyd's modeled
// share from 40% to ~38%, most of the way toward his real 35% post-return share, while still
// hedging against week 7 having been a one-off (e.g. Jacobs on a snap count).
const ROLE_CHANGE_BOOST = 3;

// Same contract as weightedAgg (rows must already be most-recent-first), but any row from
// `roleChangeWeek` onward has its normal decay weight multiplied by ROLE_CHANGE_BOOST first.
// roleChangeWeek == null (the normal case) is identical to plain weightedAgg.
function weightedAggWithRoleChange(rows, fields, roleChangeWeek, decay = RECENCY_DECAY) {
  if (roleChangeWeek == null) return weightedAgg(rows, fields, decay);
  let weightedGames = 0;
  const sums = {};
  fields.forEach(f => { sums[f] = 0; });
  rows.forEach((r, i) => {
    let w = Math.pow(decay, i);
    if (Number(r.week) >= roleChangeWeek) w *= ROLE_CHANGE_BOOST;
    weightedGames += w;
    fields.forEach(f => { sums[f] += w * (parseFloat(r[f]) || 0); });
  });
  return { weightedGames, sums };
}

module.exports = {
  recencyWindow, recentGames, weightedAgg, RECENCY_DECAY, FULL_SEASON_WINDOW, LIVE_RECENCY_WINDOW,
  detectRoleChangeWeek, weightedAggWithRoleChange, ROLE_CHANGE_MIN_VOLUME, ROLE_CHANGE_BOOST,
};
