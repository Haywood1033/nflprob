// lib/qb-starter.js — this week's starting QB for a team, from data:
//   1. nflverse's schedules file names the starter (away_qb_name / home_qb_name). It's filled in
//      ahead of the week and can be stale: it kept naming Kyler Murray for the Vikings the night
//      Carson Wentz started (Murray ruled out).
//   2. ESPN's roster (lib/roster.js) carries the injury report. If the named QB is Out, Doubtful,
//      on IR or not on the roster, he isn't the starter: the healthy roster QB with the most
//      starts this season takes over (most recent appearance breaks ties), e.g. a veteran backup
//      who started weeks 1-2 before the injury to the week-3 starter.
//   3. No name from nflverse: the same pick from the healthy roster QBs.
// Every caller (passing props, anytime TD, the team model's backup-QB check, DFS) uses this, so
// the whole app agrees on who's starting. Questionable stays the starter (most play).

const { fetchTeamRoster, getRosterEntry } = require('./roster.js');
const { toNflverseAbbr } = require('./player-stats.js');
const { normalizeQbName } = require('./qb-status.js');

const ESPN_ABBR = { LA: 'LAR', WAS: 'WSH' }; // nflverse → ESPN where they differ
const espnAbbr = a => ESPN_ABBR[toNflverseAbbr(a)] || toNflverseAbbr(a);
const MIN_ATTEMPTS_START = 10;

function unavailable(entry) {
  if (!entry) return true; // not on the active roster at all
  if (entry.definitelyOut) return true;
  return /doubtful/i.test(entry.injuryStatus || '');
}

// Starts and last appearance this season for a QB on this team (nflverse team abbreviation).
function startsFor(playerRows, name, team) {
  const rows = playerRows.filter(r => r.player_display_name === name && r.team === team && r.position === 'QB' && r.season_type === 'REG');
  return { starts: rows.filter(r => (parseFloat(r.attempts) || 0) >= MIN_ATTEMPTS_START).length, lastWeek: rows.length ? Math.max(...rows.map(r => Number(r.week))) : -1, attempts: rows.reduce((s, r) => s + (parseFloat(r.attempts) || 0), 0) };
}

// roster: an already-fetched ESPN roster (optional; fetched when missing). → { name, source, note? }
//   source: 'nflverse' (named and healthy) | 'injury' (named QB ruled out, replaced) |
//           'roster' (nflverse named nobody) | 'unverified' (no roster to check against)
async function resolveStarter({ teamAbbr, namedQb, playerRows, roster = undefined }) {
  const team = toNflverseAbbr(teamAbbr);
  const R = roster === undefined ? await fetchTeamRoster(espnAbbr(teamAbbr)).catch(() => null) : roster;
  if (!R || !Object.keys(R).length) return { name: namedQb || null, source: 'unverified' };
  const named = namedQb ? getRosterEntry(R, namedQb) : null;
  if (namedQb && !unavailable(named)) return { name: namedQb, source: 'nflverse' };
  const healthy = Object.values(R).filter(e => e.position === 'QB' && !unavailable(e))
    .map(e => ({ name: e.displayName, ...startsFor(playerRows || [], e.displayName, team) }))
    .sort((a, b) => b.starts - a.starts || b.lastWeek - a.lastWeek || b.attempts - a.attempts);
  const pick = healthy[0];
  if (!pick) return { name: namedQb || null, source: 'unverified' };
  if (!namedQb) return { name: pick.name, source: 'roster' };
  const why = named ? (named.injuryStatus || 'ruled out') : 'not on the active roster';
  return { name: pick.name, source: 'injury', replaced: namedQb, note: `${namedQb} is ${why.toLowerCase()} on ESPN's injury report, so ${pick.name} starts${pick.lastWeek > 0 ? ` (last played week ${pick.lastWeek})` : ''}` };
}

const same = (a, b) => normalizeQbName(a) === normalizeQbName(b);

module.exports = { resolveStarter, unavailable, startsFor, espnAbbr, same };
