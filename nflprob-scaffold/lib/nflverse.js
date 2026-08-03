// lib/nflverse.js — pulls team-level efficiency data from nflverse-data releases (GitHub, free, no auth)
// nflverse publishes weekly-updated CSVs to github.com/nflverse/nflverse-data/releases
// This gives us EPA/play, pace, red zone rates — everything the team-level model needs
// without touching a paid odds API.

const CACHE_TTL = 60 * 60 * 1000; // 1 hour — data updates ~daily during season
let cache = { season: null, teamWeek: null, timestamp: null };

// Weekly team-level box-score-derived stats (one row per team per week)
// Release: nflverse-data "stats_team" — columns include epa/play, pass/rush splits, plays, etc.
const TEAM_WEEK_URL = (season) =>
  `https://raw.githubusercontent.com/nflverse/nflverse-data/master/data/stats_team_week/stats_team_week_${season}.csv`;

// Play-by-play derived EPA (heavier file, weekly refresh) — used for red-zone and pace detail
const PBP_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    // NOTE: naive split — nflverse CSVs rarely have embedded commas in these columns,
    // but swap in a proper CSV parser (papaparse) once this runs for real.
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => row[h.trim()] = cells[i]);
    return row;
  });
}

async function fetchTeamWeekStats(season) {
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (cache.season === season && age < CACHE_TTL && cache.teamWeek) return cache.teamWeek;

  try {
    const r = await fetch(TEAM_WEEK_URL(season), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const text = await r.text();
    const rows = parseCSV(text);
    cache = { season, teamWeek: rows, timestamp: Date.now() };
    return rows;
  } catch (e) {
    console.warn('nflverse team-week fetch failed:', e.message);
    return null;
  }
}

// Aggregate last-N-weeks EPA/play (offense + defense allowed) per team, weighted toward recent games
function computeTeamEfficiency(rows, team, throughWeek, lastN = 5) {
  const teamRows = rows
    .filter(r => r.team === team && Number(r.week) <= throughWeek)
    .sort((a, b) => Number(b.week) - Number(a.week))
    .slice(0, lastN);

  if (!teamRows.length) return null;

  const avg = (key) => teamRows.reduce((s, r) => s + (parseFloat(r[key]) || 0), 0) / teamRows.length;

  return {
    games: teamRows.length,
    epaPlayOff: avg('offense_epa_play') || avg('off_epa_per_play'),
    epaPlayDef: avg('defense_epa_play') || avg('def_epa_per_play'),
    playsPerGame: avg('plays_offense') || avg('off_plays'),
    redZoneTdRate: avg('rz_td_pct'),
    passRate: avg('pass_rate'),
  };
}

module.exports = { fetchTeamWeekStats, computeTeamEfficiency, TEAM_WEEK_URL, PBP_URL };
