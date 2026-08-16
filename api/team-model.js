// api/team-model.js — Team-level win probability + implied points endpoint
// Step 1 of the build order. Output feeds every player prop as a context signal
// (a shootout game raises every player's ceiling; a defensive grind lowers it).
//
// Model logic lives in lib/team-scoring.js so api/props.js can reuse it directly.

const { fetchWeekSchedule } = require('../lib/schedule.js');
const { fetchAllWeather } = require('../lib/weather.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { buildGameModel } = require('../lib/team-scoring.js');

let cache = { data: null, timestamp: null, week: null };
const CACHE_TTL = 30 * 60 * 1000; // 30 min — team efficiency data doesn't move fast

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const week = req.query.week;
  const year = req.query.year || new Date().getFullYear();
  if (!week) return res.status(400).json({ error: 'week query param required, e.g. ?week=1' });

  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (cache.week === week && age < CACHE_TTL && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  const start = Date.now();
  const schedule = await fetchWeekSchedule(year, week);
  if (!schedule?.length) return res.status(200).json({ week, games: [], error: 'No schedule found' });

  const teamRows = await fetchTeamWeekStats(year);
  const homeTeams = schedule.map(g => g.homeTeam);
  const weather = await fetchAllWeather(new Date().toLocaleDateString('en-CA'), homeTeams, {});

  const games = schedule.map(g => {
    const homeEff = teamRows ? computeTeamEfficiency(teamRows, g.homeAbbr, Number(week) - 1) : null;
    const awayEff = teamRows ? computeTeamEfficiency(teamRows, g.awayAbbr, Number(week) - 1) : null;
    const gameWeather = weather[g.homeTeam] || {};
    const model = buildGameModel(homeEff, awayEff, { weather: gameWeather });
    return { ...g, model, weather: gameWeather };
  });

  const data = { week, year, games, timestamp: Date.now(), elapsed: Date.now() - start };
  cache = { data, timestamp: Date.now(), week };
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
  return res.status(200).json(data);
};
