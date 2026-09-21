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

module.exports = { recencyWindow, recentGames, FULL_SEASON_WINDOW, LIVE_RECENCY_WINDOW };
