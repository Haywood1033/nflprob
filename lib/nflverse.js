// lib/nflverse.js — pulls team-level efficiency data from nflverse-data releases (GitHub, free, no auth)
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

async function fetchTeamWeekStats(season) {
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (cache.season === season && age < CACHE_TTL && cache.rows) return cache.rows;

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

const { byGameTeam } = require('./indexing.js');

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
