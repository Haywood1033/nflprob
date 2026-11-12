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
const { normalizeName, baseName } = require('./roster.js');

// ESPN's roster name → the name nflverse's stats use for the same player. They don't always
// agree: ESPN lists "James Cook III", nflverse "James Cook", and an exact-match lookup silently
// dropped him from every prop pool. Exact name first; then ignoring periods/spacing; then
// ignoring a Jr./Sr./II/III suffix, accepted only when exactly one stats player matches (the
// same position preferred), so two different players are never merged. null = no stats at all.
const nameIndexes = new WeakMap();
function nameIndex(playerRows) {
  let idx = nameIndexes.get(playerRows);
  if (idx) return idx;
  idx = { exact: new Set(), norm: new Map(), base: new Map() };
  for (const r of playerRows) {
    const n = r.player_display_name;
    if (!n || idx.exact.has(n)) continue;
    idx.exact.add(n);
    for (const [map, key] of [[idx.norm, normalizeName(n)], [idx.base, baseName(n)]]) {
      if (!map.has(key)) map.set(key, new Map());
      map.get(key).set(n, r.position);
    }
  }
  nameIndexes.set(playerRows, idx);
  return idx;
}
function statsName(playerRows, name, position = null) {
  if (!name || !playerRows?.length) return null;
  const idx = nameIndex(playerRows);
  if (idx.exact.has(name)) return name;
  for (const [map, key] of [[idx.norm, normalizeName(name)], [idx.base, baseName(name)]]) {
    const hits = [...(map.get(key) || new Map())];
    const samePos = position ? hits.filter(([, p]) => p === position) : [];
    if (samePos.length === 1) return samePos[0][0];
    if (hits.length === 1) return hits[0][0];
  }
  return null;
}

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
    const name = statsName(playerRows, entry.displayName, entry.position);
    const histTeam = name && findHistoricalTeam(playerRows, name);
    if (!histTeam) return null; // no usage history at all (rookie) — skip, don't crash
    const candidateRows = playerRows.filter(r => r.player_display_name === name && r.team === histTeam && r.season_type === 'REG');
    const rows = recentGames(candidateRows, throughWeek, lastN);
    const volume = rows.reduce((s, r) => s + (parseFloat(r[volumeField]) || 0), 0);
    const lastWeekPlayed = rows.length ? Math.max(...rows.map(r => Number(r.week))) : -1;
    // name = the stats name (everything downstream looks rows up by it)
    return { name, displayName: entry.displayName, position: entry.position, histTeam, volume, lastWeekPlayed };
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

// Finds roster-ACTIVE players (not ruled out) at the given positions who have NO usage history
// anywhere this season — exactly the set poolFromRoster() (and api/props.js's own
// tdPoolFromRoster, which uses this same findHistoricalTeam check) silently drop, since
// findHistoricalTeam returns null for them and the candidate is filtered out with no trace.
//
// This can't tell a genuine contributor (an IR activation, a trade addition the stats pipeline
// hasn't caught up to yet) apart from a camp body who's simply never played — there's no
// depth-chart or snap-share data available to make that call. So rather than silently excluding
// them (the current behavior) or guessing a specific number for them (which there's no real
// data to base one on), this surfaces them as a caveat on teammates at the same position, who
// ARE being modeled — on the honest assumption that a real roster move is worth flagging even
// when it can't be quantified, the same way a "thin sample" warning doesn't try to hide
// uncertainty behind a confident-looking number.
//
// REAL CASE THIS WAS BUILT FROM: Zach Charbonnet (Seattle RB) opened the season on IR and has
// zero recorded carries anywhere this year. The moment he's active again, every other Seattle
// RB's projection is still being computed as if he doesn't exist — nothing in the pipeline
// before this function had any way to know he's even on the roster, let alone that he might
// take real carries away from them.
function unmodeledRosterTeammates(roster, playerRows, positions) {
  if (!roster) return [];
  return Object.values(roster)
    .filter(entry => positions.includes(entry.position) && !entry.definitelyOut && !statsName(playerRows, entry.displayName, entry.position))
    .map(entry => ({ name: entry.displayName, position: entry.position }));
}

// The anytime TD pool for one team, from candidates with { volume (touches in the recent window),
// lastWeekPlayed }. Most recent game first (who holds the job now), then volume, capped at count.
// On top of that, the team's highest-volume players in the window are always kept: a lead back
// who missed last week ranks behind every teammate who played, even ones with a touch or two, and
// used to fall off the end of the list while still showing on the rushing tab.
function rankTdPool(candidates, count = 9, keepTopVolume = 5) {
  const byRecency = [...candidates].sort((a, b) => b.lastWeekPlayed - a.lastWeekPlayed || b.volume - a.volume);
  const pool = byRecency.slice(0, count);
  const topVolume = [...candidates].filter(c => c.volume > 0).sort((a, b) => b.volume - a.volume).slice(0, keepTopVolume);
  for (const c of topVolume) if (!pool.includes(c)) pool.push(c);
  return pool;
}

module.exports = { findHistoricalTeam, poolFromRoster, unmodeledRosterTeammates, statsName, rankTdPool };
