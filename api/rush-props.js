const { attachPropLines } = require('../lib/espn-props.js');
const { fetchWeekSchedule, seasonFromQuery } = require('../lib/schedule.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { fetchPlayerWeekStats, toNflverseAbbr } = require('../lib/player-stats.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { computeRushUsage, computeRushDefenseAllowed, projectRushYards, getRushSignals } = require('../lib/rush-scoring.js');
const { recencyWindow, recentGames } = require('../lib/recency-window.js');
const { fetchTeamRoster, isHealthy, getRosterEntry } = require('../lib/roster.js');
const { poolFromRoster, unmodeledRosterTeammates, findHistoricalTeam } = require('../lib/roster-pool.js');
const { fetchGames, getMarketContext } = require('../lib/vegas-lines.js');
const { resolveStarter } = require('../lib/qb-starter.js');

const { playerDetail } = require('../lib/player-detail.js');
const { loadCalibration, applyYardsCalibration, seasonAverage, blendVolume } = require('../lib/calibration.js');

let cache = { data: null, timestamp: null, key: null };
// A starting QB joins the rushing board when he averages this many carries a game lately
// (Josh Allen ~8, Jayden Daniels ~5); a pocket passer's 1-2 kneel-downs and sneaks don't.
const QB_MIN_CARRIES = 3;
const CACHE_TTL = 30 * 60 * 1000;

// Recency-limited, same reasoning as poolFromRoster's fix: rank by who's actually getting
// carries lately, not by whoever accumulated the most earlier in the season.
function topRushersForTeamFallback(playerRows, teamEspnAbbr, throughWeek, count = 4) {
  const team = toNflverseAbbr(teamEspnAbbr);
  const lastN = recencyWindow(throughWeek);
  const teamRows = playerRows.filter(r => r.team === team && r.position === 'RB' && r.season_type === 'REG');

  const byName = {};
  for (const r of teamRows) {
    if (!byName[r.player_display_name]) byName[r.player_display_name] = [];
    byName[r.player_display_name].push(r);
  }
  return Object.entries(byName)
    .map(([name, rows]) => {
      const recent = recentGames(rows, throughWeek, lastN);
      const carries = recent.reduce((s, r) => s + (parseFloat(r.carries) || 0), 0);
      const lastWeekPlayed = recent.length ? Math.max(...recent.map(r => Number(r.week))) : -1;
      return { name, histTeam: team, volume: carries, lastWeekPlayed };
    })
    // Who played most recently wins first — see lib/roster-pool.js's poolFromRoster for the
    // full reasoning.
    .sort((a, b) => b.lastWeekPlayed - a.lastWeekPlayed || b.volume - a.volume).slice(0, count);
}

async function handler(req, res) {
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
    // See api/team-model.js's identical fallback for the reasoning — a transient ESPN hiccup
    // shouldn't wipe out a session that already saw real data for this week.
    if (cache.key === cacheKey && cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
    return res.status(200).json({ week, players: [], error: 'No schedule found' });
  }

  const [teamRows, playerRows, marketGames] = await Promise.all([
    fetchTeamWeekStats(year),
    fetchPlayerWeekStats(year),
    fetchGames().catch(() => null),
  ]);
  if (!playerRows?.length) return res.status(200).json({ week, players: [], error: 'Player stats unavailable' });

  const throughWeek = Number(week) - 1;
  const cal = await loadCalibration(); // backtest-fitted yardage calibration; none = the raw model
  const players = [];
  const skipped = []; // teams whose build failed: reported, never fatal to the rest of the slate

  const distinctAbbrs = [...new Set(schedule.flatMap(g => [g.homeAbbr, g.awayAbbr]))];
  const rosterEntries = await Promise.all(distinctAbbrs.map(async abbr => [abbr, await fetchTeamRoster(abbr)]));
  const rosterCache = Object.fromEntries(rosterEntries);

  for (const g of schedule) {
    const homeEff = teamRows ? computeTeamEfficiency(teamRows, g.homeAbbr, throughWeek) : null;
    const awayEff = teamRows ? computeTeamEfficiency(teamRows, g.awayAbbr, throughWeek) : null;
    const model = buildGameModel(homeEff, awayEff, { neutralSite: g.neutralSite });

    const teamsInGame = [
      { abbr: g.homeAbbr, name: g.homeTeam, oppAbbr: g.awayAbbr, implied: model.homeImplied },
      { abbr: g.awayAbbr, name: g.awayTeam, oppAbbr: g.homeAbbr, implied: model.awayImplied },
    ];

    for (const t of teamsInGame) {
      try {
      const roster = rosterCache[t.abbr];

      const pool = poolFromRoster(roster, playerRows, ['RB'], 'carries', 4, throughWeek)
        || topRushersForTeamFallback(playerRows, t.abbr, throughWeek);
      // A roster-active RB with zero usage history this season (an IR activation, a trade
      // addition) who never made it into the pool above at all — see the function's own
      // comment in lib/roster-pool.js for why this is flagged rather than silently ignored.
      const unmodeled = unmodeledRosterTeammates(roster, playerRows, ['RB']);

      // This week's starting QB (lib/qb-starter — the same answer as the passing tab), if he runs.
      const market = marketGames ? getMarketContext(marketGames, year, week, g.awayAbbr, g.homeAbbr) : {};
      const qb = await resolveStarter({ teamAbbr: t.abbr, namedQb: t.abbr === g.homeAbbr ? market.homeQbName : market.awayQbName, playerRows, roster }).catch(() => null);
      const qbTeam = qb?.name && findHistoricalTeam(playerRows.filter(r => r.position === 'QB'), qb.name);
      if (qbTeam) {
        const u = computeRushUsage(playerRows, qb.name, qbTeam, throughWeek, recencyWindow(throughWeek), { position: 'QB' });
        if (u && u.carries / u.games >= QB_MIN_CARRIES) pool.push({ name: qb.name, histTeam: qbTeam, position: 'QB' });
      }

      for (const candidate of pool) {
        const position = candidate.position === 'QB' ? 'QB' : 'RB';
        const usage = computeRushUsage(playerRows, candidate.name, candidate.histTeam, throughWeek, recencyWindow(throughWeek), { position });
        if (!usage) continue;
        const defAllowed = computeRushDefenseAllowed(teamRows, t.oppAbbr, throughWeek, recencyWindow(throughWeek), toNflverseAbbr);
        const rawProj = projectRushYards(usage, defAllowed, t.implied);
        if (!rawProj) continue;
        const sig = getRushSignals(usage, defAllowed, rawProj); // signal thresholds were set on the raw projection
        const proj = applyYardsCalibration(rawProj, seasonAverage(playerRows, candidate.name, candidate.histTeam, throughWeek, 'rushing_yards'), 'rush', cal);
        const rosterEntry = getRosterEntry(roster, candidate.name);

        players.push({
          name: candidate.name,
          position,
          team: t.name,
          opponent: teamsInGame.find(x => x.abbr !== t.abbr).name,
          gameId: g.gameId,
          projected: proj.projected,
          floor: proj.floor,
          ceiling: proj.ceiling,
          carries: usage.carries,
          projCarries: blendVolume(rawProj.projCarries, usage.carries / usage.games), // see lib/calibration.js
          signals: sig.signals,
          signalCount: sig.count,
          badge: sig.badge,
          ci: sig.ci,
          injured: !isHealthy(roster, candidate.name),
          injuryStatus: rosterEntry?.injuryStatus || null,
          unmodeledTeammates: position === 'RB' ? unmodeled.filter(u => u.name !== candidate.name).map(u => u.name) : [],
          detail: playerDetail(playerRows, { name: candidate.name, team: candidate.histTeam, position, oppAbbr: toNflverseAbbr(t.oppAbbr), market: 'rush', throughWeek }),
        });
      }
      } catch (err) {
        console.error(`rushing-props: ${t.abbr} failed`, err);
        skipped.push({ team: t.name, error: err.message });
      }
    }
  }

  players.sort((a, b) => b.projected - a.projected);
  // The book's pre-game line for each player (ESPN), priced against the model.
  const lineInfo = await attachPropLines(players, schedule, rosterCache, 'rush_yds');

  const data = { week, year, players, lines: lineInfo, skipped, timestamp: Date.now(), elapsed: Date.now() - start };
  cache = { data, timestamp: Date.now(), key: cacheKey };
  // Short CDN cache — see api/props.js for the reasoning (60s balances "tabs feel slow with
  // zero edge caching" against "a deploy looks broken for 30+ minutes," which the old
  // no-store/long-s-maxage extremes each hit).
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
  return res.status(200).json(data);
};

// Any failure outside the per-team builds comes back as JSON with its message (the page shows
// it), not as a bare server error page.
module.exports = async function (req, res) {
  try { return await handler(req, res); }
  catch (err) {
    console.error('rushing-props failed', err);
    return res.status(500).json({ week: req.query?.week, players: [], error: `Rushing props failed: ${err.message}` });
  }
};
