// lib/nflverse.js — pulls team-level efficiency data from nflverse-data releases (GitHub, free, no auth)
//
// VERIFIED against the live file (curl'd and inspected headers directly):
// - Correct URL is under the release *download* path, NOT raw.githubusercontent.com —
//   this repo doesn't store data in its git tree, only as release assets.
// - Release tag is "stats_team" (not "stats_team_week" — that was my original guess, it was wrong).
// - The file is ONE ROW PER TEAM PER GAME, offense-only. There is no separate "defense EPA
//   allowed" column and no red-zone-TD-rate column. To get defense-allowed EPA for team X,
//   look up the OPPONENT's row for the same game_id — their offensive output against X
//   IS what X's defense allowed. Red zone rate isn't available in this file at all (would need
//   play-by-play with yardline_100); dropped from the model until we pull PBP separately.
// - Team abbreviations here are nflverse's own (LA, WAS) — NOT ESPN's (LAR, WSH). Must
//   normalize before matching against schedule.js output.

const CACHE_TTL = 60 * 60 * 1000; // 1 hour — data updates ~daily during season
let cache = { season: null, rows: null, timestamp: null };

const TEAM_WEEK_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;

// nflverse abbr differs from ESPN abbr for these two teams
const NFLVERSE_ABBR_FIX = { LAR: 'LA', WSH: 'WAS' };
function toNflverseAbbr(espnAbbr) {
  return NFLVERSE_ABBR_FIX[espnAbbr] || espnAbbr;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cells = line.split(','); // fine here — no embedded commas in this file's columns
    const row = {};
    headers.forEach((h, i) => row[h.trim()] = cells[i]);
    return row;
  });
}

async function fetchTeamWeekStats(season) {
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (cache.season === season && age < CACHE_TTL && cache.rows) return cache.rows;

  // Current season's file won't exist until games have actually been played;
  // fall back to prior season so the model has *something* pre-week-1.
  //
  // IMPORTANT: checking r.ok alone isn't enough. nflverse can publish the current
  // season's file early — sometimes with only preseason rows, sometimes as a near-empty
  // shell — before any REG-season games exist. If we accepted that file just because the
  // HTTP request succeeded, we'd lock onto zero usable rows and never fall back to last
  // season's real data. So this checks for at least one actual REG-season row before
  // committing to a season; otherwise it keeps trying older seasons.
  for (const trySeason of [season, season - 1]) {
    try {
      const r = await fetch(TEAM_WEEK_URL(trySeason), { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const text = await r.text();
      const rows = parseCSV(text);
      const hasRegRows = rows.some(row => row.season_type === 'REG');
      if (!hasRegRows) {
        console.warn(`nflverse team-week file for ${trySeason} exists but has no REG rows yet — trying older season`);
        continue;
      }
      cache = { season, rows, timestamp: Date.now(), sourceSeason: trySeason };
      return rows;
    } catch (e) {
      console.warn(`nflverse team-week fetch failed for ${trySeason}:`, e.message);
    }
  }
  return null;
}

// Build a game_id → { team → offensive row } index so defense-allowed can be looked up
function indexByGame(rows) {
  const byGame = {};
  for (const r of rows) {
    if (!byGame[r.game_id]) byGame[r.game_id] = {};
    byGame[r.game_id][r.team] = r;
  }
  return byGame;
}

function offEpaPerPlay(row) {
  const plays = (parseFloat(row.attempts) || 0) + (parseFloat(row.carries) || 0);
  if (!plays) return null;
  const epa = (parseFloat(row.passing_epa) || 0) + (parseFloat(row.rushing_epa) || 0);
  return { epaPlay: epa / plays, plays };
}

// Aggregate last-N-games EPA/play (offense + defense allowed) per team, weighted toward recent games
function computeTeamEfficiency(rows, espnAbbr, throughWeek, lastN = 5) {
  if (!rows?.length) return null;
  const team = toNflverseAbbr(espnAbbr);
  const byGame = indexByGame(rows);

  // Week 1 (throughWeek=0) with no current-season games yet: fall back to the tail end
  // of whatever season is in `rows` (typically last season, per fetchTeamWeekStats fallback)
  // instead of filtering to week<=0, which would match nothing.
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;

  const teamRows = rows
    .filter(r => r.team === team && r.season_type === 'REG' && weekFilter(r))
    .sort((a, b) => Number(b.week) - Number(a.week))
    .slice(0, lastN);

  if (!teamRows.length) return null;

  let sumEpaOff = 0, sumEpaDefAllowed = 0, sumPlays = 0, games = 0;
  for (const r of teamRows) {
    const off = offEpaPerPlay(r);
    if (!off) continue;
    const oppRow = byGame[r.game_id]?.[r.opponent_team];
    const oppOff = oppRow ? offEpaPerPlay(oppRow) : null;

    sumEpaOff += off.epaPlay;
    sumPlays += off.plays;
    if (oppOff) sumEpaDefAllowed += oppOff.epaPlay;
    games++;
  }
  if (!games) return null;

  return {
    games,
    epaPlayOff: sumEpaOff / games,
    epaPlayDef: sumEpaDefAllowed / games, // this team's defense: EPA/play they allowed
    playsPerGame: sumPlays / games,
    redZoneTdRate: null, // not available in this data source — needs play-by-play, follow-up task
  };
}

module.exports = { fetchTeamWeekStats, computeTeamEfficiency, TEAM_WEEK_URL, toNflverseAbbr };
