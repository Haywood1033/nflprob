// api/team-model.js — Team-level win probability + implied points endpoint
// Step 1 of the build order. Output feeds every player prop as a context signal
// (a shootout game raises every player's ceiling; a defensive grind lowers it).
//
// Model logic lives in lib/team-scoring.js so api/props.js can reuse it directly.

const { fetchWeekSchedule, seasonFromQuery } = require('../lib/schedule.js');
const { fetchGameWeather } = require('../lib/weather.js');
const { fetchTeamWeekStats, computeTeamEfficiency, toNflverseAbbr } = require('../lib/nflverse.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { loadCalibration, applyGameCalibration } = require('../lib/calibration.js');
const { recencyWindow } = require('../lib/recency-window.js');
const { fetchGames } = require('../lib/nflverse-games.js');
const { teamTrend } = require('../lib/team-trend.js');
const { getMarketContext, marketEdge, withEspnLine } = require('../lib/vegas-lines.js');
const { fetchPlayerWeekStats } = require('../lib/player-stats.js');
const { qbStatus } = require('../lib/qb-status.js');
const { resolveStarter } = require('../lib/qb-starter.js');
const { fetchPbp, computeRedZoneStats, teamRedZoneTdRate } = require('../lib/red-zone.js');

let cache = { data: null, timestamp: null, key: null };
const CACHE_TTL = 30 * 60 * 1000; // 30 min — team efficiency data doesn't move fast

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const week = req.query.week;
  const year = seasonFromQuery(req.query);
  if (!week) return res.status(400).json({ error: 'week query param required, e.g. ?week=1' });
  const cacheKey = `${year}|${week}`;

  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (cache.key === cacheKey && age < CACHE_TTL && cache.data) {
    return res.status(200).json({ ...cache.data, cached: true });
  }

  const start = Date.now();
  const schedule = await fetchWeekSchedule(year, week);
  if (!schedule?.length) {
    // ESPN's schedule fetch failed or returned nothing for this exact week — if we already
    // served this week successfully at some point (even past the normal 30-min TTL above), that
    // stale response is almost always more useful than a blank "no games" page, especially
    // mid-slate when the user already saw real data minutes ago. A transient ESPN hiccup
    // shouldn't wipe out an otherwise-working session.
    if (cache.key === cacheKey && cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
    return res.status(200).json({ week, games: [], error: 'No schedule found' });
  }

  const teamRows = await fetchTeamWeekStats(year);
  // Backtest-fitted calibration (moneyline stretch, totals shift); none = the raw model.
  const cal = await loadCalibration();
  // fetchGames() hits nflverse's schedules/games.csv once and is reused for both the Slate
  // trend charts (scheduleRows/teamTrend) and real market context (marketGames/getMarketContext)
  // below — same file, no need to fetch it twice.
  const [marketGames, playerSeasonRows, pbpRows] = await Promise.all([
    fetchGames().catch(() => null),
    fetchPlayerWeekStats(year),
    fetchPbp(year),
  ]);
  // Each game's own kickoff-hour forecast; roof from nflverse, neutral sites from ESPN.
  const weather = await fetchGameWeather(schedule.map(g => ({
    key: g.gameId, homeTeam: g.homeTeam, date: g.date, indoor: g.indoor, neutralSite: g.neutralSite,
    roof: getMarketContext(marketGames, year, week, g.awayAbbr, g.homeAbbr).roof,
  })));
  const scheduleRows = marketGames;
  // Real per-trip red-zone TD rate per team, from play-by-play — see lib/red-zone.js. null
  // (not fetched/unavailable) falls through computeTeamEfficiency to the honest "no data"
  // placeholder it already had.
  const rzStats = pbpRows ? computeRedZoneStats(pbpRows, Number(week) - 1) : null;

  // This week's starting QBs (lib/qb-starter): nflverse's named QB unless ESPN's injury report rules
  // him out, so a backup starting tonight is judged as a backup by the model.
  const starterList = await Promise.all(schedule.flatMap(g => {
    const m = getMarketContext(marketGames, year, week, g.awayAbbr, g.homeAbbr);
    return [[`${g.id || g.gameId}|home`, g.homeAbbr, m.homeQbName], [`${g.id || g.gameId}|away`, g.awayAbbr, m.awayQbName]];
  }).map(async ([key, abbr, named]) => [key, await resolveStarter({ teamAbbr: abbr, namedQb: named, playerRows: playerSeasonRows || [] }).catch(() => ({ name: named, source: 'unverified' }))]));
  const starters = new Map(starterList);
  const games = schedule.map(g => {
    const tw = Number(week) - 1;
    const homeRz = rzStats ? teamRedZoneTdRate(rzStats, toNflverseAbbr(g.homeAbbr)) : null;
    const awayRz = rzStats ? teamRedZoneTdRate(rzStats, toNflverseAbbr(g.awayAbbr)) : null;
    const homeEff = teamRows ? computeTeamEfficiency(teamRows, g.homeAbbr, tw, recencyWindow(tw), homeRz) : null;
    const awayEff = teamRows ? computeTeamEfficiency(teamRows, g.awayAbbr, tw, recencyWindow(tw), awayRz) : null;
    const gameWeather = weather[g.gameId] || {};

    // Market context (real spread/total line, rest days, key-number/blowout/teaser flags) —
    // blank for games far enough out that no book has posted a line yet; see lib/vegas-lines.js.
    // ESPN's current line first (it moves through the week), nflverse's as the fallback.
    const market = withEspnLine(getMarketContext(marketGames, year, week, g.awayAbbr, g.homeAbbr), g.espnOdds, g.homeAbbr, g.awayAbbr);
    const homeQb = starters.get(`${g.id || g.gameId}|home`) || { name: market.homeQbName }, awayQb = starters.get(`${g.id || g.gameId}|away`) || { name: market.awayQbName };
    const homeQbStatus = playerSeasonRows ? qbStatus(homeQb.name, playerSeasonRows, toNflverseAbbr(g.homeAbbr)) : 'unknown';
    const awayQbStatus = playerSeasonRows ? qbStatus(awayQb.name, playerSeasonRows, toNflverseAbbr(g.awayAbbr)) : 'unknown';

    const model = applyGameCalibration(buildGameModel(homeEff, awayEff, {
      weather: gameWeather, neutralSite: g.neutralSite,
      homeRestDays: market.homeRestDays, awayRestDays: market.awayRestDays,
      homeQbStatus, awayQbStatus,
    }), cal);

    // Model-vs-market edge: positive homeMarginEdge means the model favors the home team by
    // more than the market line does (and vice versa for away). Only meaningful once a real
    // line exists for this game.
    const edge = marketEdge(model, market);

    const trend = { home: teamTrend(teamRows, scheduleRows, g.homeAbbr, year, tw), away: teamTrend(teamRows, scheduleRows, g.awayAbbr, year, tw) };

    return {
      ...g, model, weather: gameWeather, trend,
      market: { ...market, homeQbName: homeQb.name, awayQbName: awayQb.name, homeQbNote: homeQb.note || null, awayQbNote: awayQb.note || null, homeQbStatus, awayQbStatus, marketEdge: edge, homeRedZoneTdRate: homeRz, awayRedZoneTdRate: awayRz },
    };
  });

  const data = { week, year, games, calibration: cal ? { ml: cal.ml?.k ?? 1, totalsShift: cal.totals?.shift ?? 0, fittedAt: cal.ml?.fittedAt || null } : null, timestamp: Date.now(), elapsed: Date.now() - start };
  cache = { data, timestamp: Date.now(), key: cacheKey };
  // Short CDN cache — see api/props.js for the reasoning (60s balances "tabs feel slow with
  // zero edge caching" against "a deploy looks broken for 30+ minutes," which the old
  // no-store/long-s-maxage extremes each hit).
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
  return res.status(200).json(data);
};
