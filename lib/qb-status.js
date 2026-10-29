// lib/qb-status.js — detects a backup-QB start from real data only, with no roster/depth-chart
// source: nflverse's schedules file names each game's starting QB (away_qb_name/home_qb_name,
// populated once the book/injury report settles — see lib/vegas-lines.js for the same file).
// "Backup" is defined relative to the team's OWN season: whoever has thrown the most pass
// attempts for that team this season is treated as the real QB1, and a start by anyone else is
// a backup start. This needs no outside depth-chart data and degrades honestly (returns
// 'unknown') whenever the season sample is too thin to call a starter at all.
const MIN_SEASON_ATTEMPTS_TO_CALL_STARTER = 20;

function normalizeQbName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

// playerSeasonRows: all of this season's weekly player rows (same shape as
// lib/player-stats.js's fetchPlayerWeekStats output) for every team, not pre-filtered — this
// filters to the one team and sums attempts itself so callers only fetch the season file once.
function seasonQbAttemptLeader(playerSeasonRows, nflverseTeamAbbr) {
  const byName = {};
  for (const r of playerSeasonRows) {
    if (r.team !== nflverseTeamAbbr || r.position !== 'QB' || r.season_type !== 'REG') continue;
    const name = r.player_display_name;
    byName[name] = (byName[name] || 0) + (parseFloat(r.attempts) || 0);
  }
  const ranked = Object.entries(byName).sort((a, b) => b[1] - a[1]);
  return ranked[0] ? { name: ranked[0][0], attempts: ranked[0][1] } : null;
}

// Returns 'starter', 'backup', or 'unknown'. `startingQbName` is this week's named starter
// (e.g. market.homeQbName from lib/vegas-lines.js); `nflverseTeamAbbr` must already be in
// nflverse's own abbreviation scheme (toNflverseAbbr), matching the `team` column these rows use.
function qbStatus(startingQbName, playerSeasonRows, nflverseTeamAbbr) {
  if (!startingQbName || !playerSeasonRows?.length) return 'unknown';
  const leader = seasonQbAttemptLeader(playerSeasonRows, nflverseTeamAbbr);
  if (!leader || leader.attempts < MIN_SEASON_ATTEMPTS_TO_CALL_STARTER) return 'unknown';
  return normalizeQbName(leader.name) === normalizeQbName(startingQbName) ? 'starter' : 'backup';
}

module.exports = { qbStatus, seasonQbAttemptLeader, normalizeQbName };
