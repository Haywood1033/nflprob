// lib/nflverse-games.js — real final scores/results per game, from nflverse's schedules
// release. Used only for grading past predictions against what actually happened (team
// win/loss, actual total points) — the rest of the app never needs real outcomes, only this
// does. Same fetch/parse/cache shape as lib/nflverse.js and lib/player-stats.js.
const { splitCSVLine } = require('./player-stats.js');

const CACHE_TTL = 60 * 60 * 1000;
let cache = { rows: null, timestamp: null };

const GAMES_URL = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = splitCSVLine(line);
    const row = {};
    headers.forEach((h, i) => row[h.trim()] = cells[i]);
    return row;
  });
}

// The schedules file covers every season nflverse has ever published (a few MB, all seasons
// together — there's no per-season release the way player/team week stats have), so this is
// fetched once and cached whole; callers filter by season/week themselves.
async function fetchGames() {
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (age < CACHE_TTL && cache.rows) return cache.rows;
  try {
    const r = await fetch(GAMES_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const text = await r.text();
    const rows = parseCSV(text);
    cache = { rows, timestamp: Date.now() };
    return rows;
  } catch (e) {
    console.warn('nflverse games fetch failed:', e.message);
    return null;
  }
}

// Only real, final games — a game with no score yet (hasn't been played) has an empty
// away_score/home_score in this file, which is exactly what should be excluded from grading.
function completedGamesForWeek(games, season, week) {
  return games.filter(g =>
    Number(g.season) === Number(season) &&
    Number(g.week) === Number(week) &&
    g.game_type === 'REG' &&
    g.away_score !== '' && g.home_score !== ''
  );
}

module.exports = { fetchGames, completedGamesForWeek, GAMES_URL };
