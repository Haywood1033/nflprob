// lib/dfs-game-context.js — the game environment DFS projections are scaled by (each team's
// implied points, which drive pass/rush/target volume and the opposing DST's points allowed).
//
// DFS used to build implied points from team efficiency alone (buildGameModel with no context).
// This uses what the Slate tab uses: QB status (a backup QB lowers his team's points), rest days,
// weather, the backtest-fitted game calibration and a neutral site; then blends in the Vegas
// implied team totals (from the spread and total) when a line exists. The blend weight was chosen
// on the lineup-strategy backtest (see CLAUDE.md).

const { computeTeamEfficiency } = require('./nflverse.js');
const { buildGameModel } = require('./team-scoring.js');
const { applyGameCalibration } = require('./calibration.js');
const { getMarketContext } = require('./vegas-lines.js');
const { qbStatus } = require('./qb-status.js');

// Full weight on the Vegas implied totals when a line exists (the rest of the context only when
// there is none): on the 370-game replay it gave the most accurate player projections (average
// miss 4.575 → 4.562 DK points) and matched the current lineups, while the model context alone
// was slightly worse for lineups (−0.28 best of 20).
const MARKET_WEIGHT = 1;

// Game-day weather from nflverse's schedule row (roof, temp, wind), the same source the backtest
// uses. Live, the schedule row has the roof but not yet the temperature and wind; callers may pass a
// forecast instead.
function scheduleWeather(g) {
  if (!g) return null;
  const roof = String(g.roof || '').toLowerCase();
  if (roof === 'dome' || roof === 'closed') return { dome: true };
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const t = num(g.temp), w = num(g.wind);
  return t == null && w == null ? null : { dome: false, w: w ?? 0, t: t ?? 60 };
}

// home/away are nflverse abbreviations. playerRows: the season's player rows (for QB status),
// already limited to weeks before this one. Returns { model, implied: { [home], [away] }, market }.
function dfsGameContext({ teamRows, playerRows, games, season, week, home, away, lastN, cal = null, weather = undefined, marketWeight = MARKET_WEIGHT, useContext = true }) {
  const tw = week - 1;
  const homeEff = computeTeamEfficiency(teamRows, home, tw, lastN);
  const awayEff = computeTeamEfficiency(teamRows, away, tw, lastN);
  const market = games ? getMarketContext(games, season, week, away, home) : { available: false };
  const g = games ? games.find(x => Number(x.season) === Number(season) && Number(x.week) === Number(week) && x.home_team === home && x.away_team === away) : null;
  let model;
  if (!useContext) model = buildGameModel(homeEff, awayEff, {});
  else {
    model = applyGameCalibration(buildGameModel(homeEff, awayEff, {
      weather: weather === undefined ? scheduleWeather(g) : weather,
      neutralSite: g?.location === 'Neutral',
      homeRestDays: market.homeRestDays, awayRestDays: market.awayRestDays,
      homeQbStatus: playerRows ? qbStatus(market.homeQbName, playerRows, home) : 'unknown',
      awayQbStatus: playerRows ? qbStatus(market.awayQbName, playerRows, away) : 'unknown',
    }), cal);
  }
  let homeImp = model.homeImplied, awayImp = model.awayImplied;
  if (marketWeight > 0 && market.totalLine != null && market.spreadLine != null) {
    // nflverse spread_line is the home team's expected margin.
    const mHome = market.totalLine / 2 + market.spreadLine / 2, mAway = market.totalLine / 2 - market.spreadLine / 2;
    homeImp = marketWeight * mHome + (1 - marketWeight) * homeImp;
    awayImp = marketWeight * mAway + (1 - marketWeight) * awayImp;
  }
  homeImp = +homeImp.toFixed(1); awayImp = +awayImp.toFixed(1);
  return { model: { ...model, homeImplied: homeImp, awayImplied: awayImp, total: +(homeImp + awayImp).toFixed(1) }, implied: { [home]: homeImp, [away]: awayImp }, market };
}

// Live: the kickoff-hour forecast at the home stadium (lib/weather.js), for a game whose schedule
// row has no temperature or wind yet. Null when it can't be had (then no weather adjustment).
async function forecastWeather(g) {
  try {
    if (!g) return null;
    const sw = scheduleWeather(g);
    if (sw) return sw; // a dome, or game-day numbers already in the file
    const { fetchGameWeather, etDateHour } = require('./weather.js');
    const { ESPN_TEAM_NAME } = require('./schedule.js');
    const espn = { LA: 'LAR', WAS: 'WSH' }[g.home_team] || g.home_team;
    const [hh, mm] = String(g.gametime || '13:00').split(':');
    // Kickoff is listed on the ET clock; find the UTC offset that reads back as that ET hour.
    const iso = ['-05:00', '-04:00'].map(o => `${g.gameday}T${hh.padStart(2, '0')}:${(mm || '00').padStart(2, '0')}:00${o}`).find(x => etDateHour(x)?.hour === Number(hh));
    if (!iso) return null;
    const w = await fetchGameWeather([{ key: 'g', homeTeam: ESPN_TEAM_NAME[espn], date: iso, roof: g.roof, neutralSite: g.location === 'Neutral' }]);
    return w.g && Object.keys(w.g).length ? w.g : null;
  } catch { return null; }
}

module.exports = { dfsGameContext, scheduleWeather, forecastWeather, MARKET_WEIGHT };
