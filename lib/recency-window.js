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

module.exports = { recencyWindow, FULL_SEASON_WINDOW, LIVE_RECENCY_WINDOW };
