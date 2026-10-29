// api/team-model.js — Team-level win probability + implied points endpoint
// Step 1 of the build order. Output feeds every player prop as a context signal
// (a shootout game raises every player's ceiling; a defensive grind lowers it).
//
// Model logic lives in lib/team-scoring.js so api/props.js can reuse it directly.

const { fetchWeekSchedule } = require('../lib/schedule.js');
const { fetchAllWeather } = require('../lib/weather.js');
const { fetchTeamWeekStats, computeTeamEfficiency, toNflverseAbbr } = require('../lib/nflverse.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { recencyWindow } = require('../lib/recency-window.js');
const { fetchGames } = require('../lib/nflverse-games.js');
const { teamTrend } = require('../lib/team-trend.js');
const { getMarketContext } = require('../lib/vegas-lines.js');
const { fetchPlayerWeekStats } = require('../lib/player-stats.js');
const { qbStatus } = require('../lib/qb-status.js');
const { fetchPbp, computeRedZoneStats, teamRedZoneTdRate } = require('../lib/red-zone.js');

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
  // fetchGames() hits nflverse's schedules/games.csv once and is reused for both the Slate
  // trend charts (scheduleRows/teamTrend) and real market context (marketGames/getMarketContext)
  // below — same file, no need to fetch it twice.
  const [weather, marketGames, playerSeasonRows, pbpRows] = await Promise.all([
    fetchAllWeather(new Date().toLocaleDateString('en-CA'), homeTeams, {}),
    fetchGames().catch(() => null),
    fetchPlayerWeekStats(year),
    fetchPbp(year),
  ]);
  const scheduleRows = marketGames;
  // Real per-trip red-zone TD rate per team, from play-by-play — see lib/red-zone.js. null
  // (not fetched/unavailable) falls through computeTeamEfficiency to the honest "no data"
  // placeholder it already had.
  const rzStats = pbpRows ? computeRedZoneStats(pbpRows, Number(week) - 1) : null;

  const games = schedule.map(g => {
    const tw = Number(week) - 1;
    const homeRz = rzStats ? teamRedZoneTdRate(rzStats, toNflverseAbbr(g.homeAbbr)) : null;
    const awayRz = rzStats ? teamRedZoneTdRate(rzStats, toNflverseAbbr(g.awayAbbr)) : null;
    const homeEff = teamRows ? computeTeamEfficiency(teamRows, g.homeAbbr, tw, recencyWindow(tw), homeRz) : null;
    const awayEff = teamRows ? computeTeamEfficiency(teamRows, g.awayAbbr, tw, recencyWindow(tw), awayRz) : null;
    const gameWeather = weather[g.homeTeam] || {};

    // Market context (real spread/total line, rest days, key-number/blowout/teaser flags) —
    // blank for games far enough out that no book has posted a line yet; see lib/vegas-lines.js.
    const market = getMarketContext(marketGames, year, week, g.awayAbbr, g.homeAbbr);
    const homeQbStatus = playerSeasonRows ? qbStatus(market.homeQbName, playerSeasonRows, toNflverseAbbr(g.homeAbbr)) : 'unknown';
    const awayQbStatus = playerSeasonRows ? qbStatus(market.awayQbName, playerSeasonRows, toNflverseAbbr(g.awayAbbr)) : 'unknown';

    const model = buildGameModel(homeEff, awayEff, {
      weather: gameWeather,
      homeRestDays: market.homeRestDays, awayRestDays: market.awayRestDays,
      homeQbStatus, awayQbStatus,
    });

    // Model-vs-market edge: positive homeMarginEdge means the model favors the home team by
    // more than the market line does (and vice versa for away). Only meaningful once a real
    // line exists for this game.
    const marketEdge = market.available ? {
      homeMarginEdge: market.homeSpread != null ? +(model.diff - market.homeSpread).toFixed(1) : null,
      totalEdge: market.totalLine != null ? +(model.total - market.totalLine).toFixed(1) : null,
    } : null;

    const trend = { home: teamTrend(teamRows, scheduleRows, g.homeAbbr, year, tw), away: teamTrend(teamRows, scheduleRows, g.awayAbbr, year, tw) };

    return {
      ...g, model, weather: gameWeather, trend,
      market: { ...market, homeQbStatus, awayQbStatus, marketEdge, homeRedZoneTdRate: homeRz, awayRedZoneTdRate: awayRz },
    };
  });

  const data = { week, year, games, timestamp: Date.now(), elapsed: Date.now() - start };
  cache = { data, timestamp: Date.now(), week };
  // Short CDN cache — see api/props.js for the reasoning (60s balances "tabs feel slow with
  // zero edge caching" against "a deploy looks broken for 30+ minutes," which the old
  // no-store/long-s-maxage extremes each hit).
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
  return res.status(200).json(data);
};
