const { byGameTeam } = require('./indexing.js');

const CACHE_TTL = 60 * 60 * 1000;
let cache = { season: null, rows: null, timestamp: null };

const TEAM_WEEK_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;

const NFLVERSE_ABBR_FIX = { LAR: 'LA', WSH: 'WAS' };
function toNflverseAbbr(espnAbbr) {
  return NFLVERSE_ABBR_FIX[espnAbbr] || espnAbbr;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => row[h.trim()] = cells[i]);
    return row;
  });
}

async function fetchSeasonFile(season) {
  try {
    const r = await fetch(TEAM_WEEK_URL(season), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const text = await r.text();
    return parseCSV(text);
  } catch (e) {
    console.warn(`nflverse team-week fetch failed for ${season}:`, e.message);
    return null;
  }
}

// Same blended-fallback fix as lib/player-stats.js — real current-season rows for teams
// who've played, prior-season rows spliced in per-team for anyone who hasn't yet, instead of
// one all-or-nothing season switch that leaves not-yet-played teams with zero data.
async function fetchTeamWeekStats(season) {
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (cache.season === season && age < CACHE_TTL && cache.rows) return cache.rows;

  const currentRows = await fetchSeasonFile(season);
  const hasAnyCurrentReg = currentRows && currentRows.some(r => r.season_type === 'REG');

  if (!hasAnyCurrentReg) {
    const priorRows = await fetchSeasonFile(season - 1);
    if (priorRows) {
      cache = { season, rows: priorRows, timestamp: Date.now(), sourceSeason: season - 1 };
      return priorRows;
    }
    return null;
  }

  const priorRows = await fetchSeasonFile(season - 1);
  const teamsWithCurrentData = new Set(
    currentRows.filter(r => r.season_type === 'REG').map(r => r.team)
  );
  const supplementalRows = (priorRows || []).filter(r => !teamsWithCurrentData.has(r.team));
  const blended = [...currentRows, ...supplementalRows];

  cache = { season, rows: blended, timestamp: Date.now(), sourceSeason: `${season} (blended with ${season - 1} for teams without current data)` };
  return blended;
}

function offEpaPerPlay(row) {
  const plays = (parseFloat(row.attempts) || 0) + (parseFloat(row.carries) || 0);
  if (!plays) return null;
  const epa = (parseFloat(row.passing_epa) || 0) + (parseFloat(row.rushing_epa) || 0);
  return { epaPlay: epa / plays, plays };
}

function computeTeamEfficiency(rows, espnAbbr, throughWeek, lastN = 5) {
  if (!rows?.length) return null;
  const team = toNflverseAbbr(espnAbbr);
  const byGame = byGameTeam(rows);

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
    epaPlayDef: sumEpaDefAllowed / games,
    playsPerGame: sumPlays / games,
    redZoneTdRate: null,
  };
}

module.exports = { fetchTeamWeekStats, computeTeamEfficiency, TEAM_WEEK_URL, toNflverseAbbr };
