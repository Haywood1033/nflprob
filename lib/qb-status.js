// lib/qb-status.js — detects a backup-QB start from real data only, with no roster/depth-chart
// source: nflverse's schedules file names each game's starting QB (away_qb_name/home_qb_name,
// populated once the book/injury report settles — see lib/vegas-lines.js for the same file).
// "Backup" is defined relative to the team's OWN season: whoever has started the most games is
// treated as the real QB1, ties broken by whoever started EARLIEST. This needs no outside
// depth-chart data and degrades honestly (returns 'unknown') whenever the season sample is too
// thin to call a starter at all.
//
// REAL BUG THIS FIXES: an earlier version ranked by CUMULATIVE SEASON PASS ATTEMPTS, not start
// count — verified broken against real 2026 Ravens data: Lamar Jackson started weeks 1-4 (96
// attempts) before an injury, Tyler Huntley started weeks 4-7 filling in (106 attempts). The
// moment Huntley's fill-in stretch outlasted Lamar's pre-injury attempts, the attempts-leader
// logic flipped to calling HUNTLEY the real starter — so Lamar's actual return start got
// flagged 'backup' and Huntley's got flagged 'starter', exactly inverted. Start COUNT doesn't
// have this failure mode (a long injury absence can make the fill-in's cumulative YARDAGE
// bigger, but not his start count, until he's genuinely out-started the player he replaced),
// and the earliest-week tiebreak correctly favors whoever established the role first when
// counts are tied (as they are here: 4 starts each, Lamar's first in week 1 vs. Huntley's in
// week 4).
//
// KNOWN REMAINING LIMITATION: a true PERMANENT in-season QB change (the week-1 starter is
// benched for good) will keep flagging the new full-time starter as 'backup' until he's
// started more games than his predecessor did — there's no real data signal available here to
// tell "permanent benching" apart from "temporary injury fill-in" any earlier than that.
const MIN_STARTS_TO_CALL_A_STARTER = 2;
const MIN_ATTEMPTS_TO_COUNT_AS_A_START = 10; // filters out a token mop-up series, not a real start

function normalizeQbName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

// playerSeasonRows: all of this season's weekly player rows (same shape as
// lib/player-stats.js's fetchPlayerWeekStats output) for every team, not pre-filtered — this
// filters to the one team and counts starts itself so callers only fetch the season file once.
function seasonQbStartsLeader(playerSeasonRows, nflverseTeamAbbr) {
  const byName = {};
  for (const r of playerSeasonRows) {
    if (r.team !== nflverseTeamAbbr || r.position !== 'QB' || r.season_type !== 'REG') continue;
    const attempts = parseFloat(r.attempts) || 0;
    if (attempts < MIN_ATTEMPTS_TO_COUNT_AS_A_START) continue;
    const name = r.player_display_name;
    const week = Number(r.week);
    if (!byName[name]) byName[name] = { starts: 0, firstWeek: week, attempts: 0 };
    byName[name].starts++;
    byName[name].attempts += attempts;
    if (week < byName[name].firstWeek) byName[name].firstWeek = week;
  }
  const ranked = Object.entries(byName).sort((a, b) =>
    b[1].starts - a[1].starts || a[1].firstWeek - b[1].firstWeek
  );
  return ranked[0] ? { name: ranked[0][0], ...ranked[0][1] } : null;
}

// Returns 'starter', 'backup', or 'unknown'. `startingQbName` is this week's named starter
// (e.g. market.homeQbName from lib/vegas-lines.js); `nflverseTeamAbbr` must already be in
// nflverse's own abbreviation scheme (toNflverseAbbr), matching the `team` column these rows use.
function qbStatus(startingQbName, playerSeasonRows, nflverseTeamAbbr) {
  if (!startingQbName || !playerSeasonRows?.length) return 'unknown';
  const leader = seasonQbStartsLeader(playerSeasonRows, nflverseTeamAbbr);
  if (!leader || leader.starts < MIN_STARTS_TO_CALL_A_STARTER) return 'unknown';
  return normalizeQbName(leader.name) === normalizeQbName(startingQbName) ? 'starter' : 'backup';
}

module.exports = { qbStatus, seasonQbStartsLeader, normalizeQbName };
