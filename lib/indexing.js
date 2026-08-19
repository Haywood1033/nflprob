// lib/indexing.js — shared, lazily-built lookup indexes for the large nflverse arrays.
//
// THE PROBLEM THIS SOLVES: several scoring functions (computeTeamEfficiency,
// computeRushDefenseAllowed, computeRecDefenseAllowed, computePassDefenseAllowed,
// computeDefenseAllowedToPosition) each rebuilt a full index or ran a full array.filter()
// over the ENTIRE dataset — every single call, even when called hundreds of times in a row
// with the exact same array. Season Projections is the worst case: it calls these functions
// once per candidate per remaining game (potentially 500-1000+ calls for a single category),
// each one rescanning up to ~19,000 player rows from scratch. That's very likely the real
// cause of "Season is extremely slow," not network latency.
//
// Fix: since fetchPlayerWeekStats()/fetchTeamWeekStats() return the SAME cached array
// reference across repeated calls (both within one request and across requests, thanks to
// their own module-level cache), a WeakMap keyed on that array object lets every consumer
// share one lazily-built index instead of each rebuilding its own copy.

const cache = new WeakMap();

function getIndex(rows, key, builder) {
  let entry = cache.get(rows);
  if (!entry) { entry = {}; cache.set(rows, entry); }
  if (!entry[key]) entry[key] = builder(rows);
  return entry[key];
}

// game_id -> { team -> row } — used to look up "what did the opponent do in this same game"
function byGameTeam(rows) {
  return getIndex(rows, 'byGameTeam', (rows) => {
    const idx = {};
    for (const r of rows) {
      if (!idx[r.game_id]) idx[r.game_id] = {};
      idx[r.game_id][r.team] = r;
    }
    return idx;
  });
}

// "opponentTeam|position" -> [rows] — used by computeDefenseAllowedToPosition, which
// previously did playerRows.filter(...) over all ~19,000 rows on every call.
function byOpponentPosition(rows) {
  return getIndex(rows, 'byOpponentPosition', (rows) => {
    const idx = {};
    for (const r of rows) {
      const key = r.opponent_team + '|' + r.position;
      if (!idx[key]) idx[key] = [];
      idx[key].push(r);
    }
    return idx;
  });
}

module.exports = { byGameTeam, byOpponentPosition };
