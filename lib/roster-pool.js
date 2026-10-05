// lib/roster-pool.js — builds candidate pools starting from the CURRENT roster, not from
// historical usage data grouped by team.
//
// THE PROBLEM THIS SOLVES: the roster filter (lib/roster.js) only removes players who
// SHOULDN'T be in a team's pool anymore (e.g. Kenny Gainwell, released from Pittsburgh). It
// cannot ADD a player who changed teams, because candidate pools were built by filtering
// historical nflverse rows where row.team === currentTeam — and a traded player's entire
// history is tagged with their OLD team. Real example: A.J. Brown was traded from
// Philadelphia to New England in June 2026. Every one of his cached 2025 rows says
// team: 'PHI'. Building New England's WR pool by filtering rows where team === 'NE' means
// he never enters the pool at all — invisible before the roster check even runs.
//
// THE FIX: flip the order. Start from the live roster (source of truth for "who is on this
// team right now"), then for each rostered player at a relevant position, look up their
// historical performance by NAME ALONE — using whatever team their own historical rows
// actually show, not the team we're building a pool for. The player's projection still uses
// their real recent performance; only the "which team are they awarded to" question is
// answered by the roster, not by old box scores.

const { recencyWindow, recentGames } = require('./recency-window.js');

// Finds the team a player's own historical rows are tagged with (their most recent game).
// Needed because we can no longer assume "the team we're building a pool for" matches
// "the team their historical rows say" — that assumption is exactly what breaks for anyone
// traded or newly signed.
function findHistoricalTeam(playerRows, name) {
  const rows = playerRows.filter(r => r.player_display_name === name && r.season_type === 'REG');
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => Number(b.week) - Number(a.week));
  return sorted[0].team;
}

// Builds a ranked candidate pool for a team, driven by its LIVE roster rather than by
// historical team-tagged rows. Returns null if no roster is available (caller should fall
// back to the old team-filtered approach in that case — better a possibly-stale pool than
// no pool at all if ESPN's roster fetch failed).
//
// RECENCY FIX: ranking used to sum a player's ENTIRE season of volume, which is stale once a
// role changes mid-season — a QB benched or hurt in week 4 keeps outranking the player who's
// actually started since, because his week 1-3 volume alone can still exceed the new
// starter's smaller sample. Real symptom: backups/former starters kept showing up as the
// team's passing-prop "leader" over the actual current starter. Ranking on the same recent
// window the usage/projection math already uses (recencyWindow) means volume reflects who's
// playing NOW, not who played most earlier in the season.
function poolFromRoster(roster, playerRows, positions, volumeField, count, throughWeek = -1) {
  // Treat an empty-but-truthy roster ({}) the same as a missing one. A 200 response from
  // ESPN with an empty/malformed body (plausible under load — this function fires up to 32
  // concurrent roster requests per request) would previously slip past `if (!roster)` since
  // {} is truthy, silently returning zero candidates instead of falling back. That's very
  // likely why only a couple of teams were getting real data — not every roster fetch
  // failed outright, some just came back empty, and this line let that go unnoticed.
  if (!roster || Object.keys(roster).length === 0) return null;

  const candidates = Object.values(roster).filter(entry =>
    positions.includes(entry.position) && !entry.definitelyOut
  );

  const lastN = recencyWindow(throughWeek);

  const withVolume = candidates.map(entry => {
    const histTeam = findHistoricalTeam(playerRows, entry.displayName);
    if (!histTeam) return null; // no usage history at all (rookie, or name mismatch we haven't caught) — skip, don't crash
    const candidateRows = playerRows.filter(r => r.player_display_name === entry.displayName && r.team === histTeam && r.season_type === 'REG');
    const rows = recentGames(candidateRows, throughWeek, lastN);
    const volume = rows.reduce((s, r) => s + (parseFloat(r[volumeField]) || 0), 0);
    const lastWeekPlayed = rows.length ? Math.max(...rows.map(r => Number(r.week))) : -1;
    return { name: entry.displayName, position: entry.position, histTeam, volume, lastWeekPlayed };
  }).filter(Boolean);

  // STARTER-CHANGE FIX: ranking purely by summed volume across the recency window still gets
  // this wrong when a role change happens mid-window — a QB who started weeks 1-2 then got
  // benched keeps outranking the new starter's single week-3 game just because 2 games' worth
  // of attempts adds up to more than 1 game's worth, even though the new guy is who's actually
  // playing now. Real symptom: a Thursday-night prop list shows last week's backup as the
  // passing leader over the QB who started the very next game. Fix: rank by WHO PLAYED MOST
  // RECENTLY first — that's the real signal of who currently holds the job — and use volume
  // only as a tiebreaker among players who last played in that same most-recent week.
  return withVolume.sort((a, b) => b.lastWeekPlayed - a.lastWeekPlayed || b.volume - a.volume).slice(0, count);
}

module.exports = { findHistoricalTeam, poolFromRoster };
