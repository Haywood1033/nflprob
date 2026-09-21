const { fetchWeekSchedule } = require('../lib/schedule.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { fetchPlayerWeekStats, toNflverseAbbr } = require('../lib/player-stats.js');
const { fetchAllWeather } = require('../lib/weather.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { computePassUsage, computePassDefenseAllowed, projectPassYards, getPassSignals } = require('../lib/pass-scoring.js');
const { recencyWindow, recentGames } = require('../lib/recency-window.js');
const { fetchTeamRoster, isHealthy, getRosterEntry } = require('../lib/roster.js');
const { poolFromRoster } = require('../lib/roster-pool.js');

let cache = { data: null, timestamp: null, week: null };
const CACHE_TTL = 30 * 60 * 1000;

// Recency-limited, same reasoning as poolFromRoster's fix: rank by who's actually throwing
// the ball lately, not by whoever accumulated the most attempts earlier in the season.
function starterQbForTeamFallback(playerRows, teamEspnAbbr, throughWeek) {
  const team = toNflverseAbbr(teamEspnAbbr);
  const lastN = recencyWindow(throughWeek);
  const teamRows = playerRows.filter(r => r.team === team && r.position === 'QB' && r.season_type === 'REG');

  const byName = {};
  for (const r of teamRows) {
    if (!byName[r.player_display_name]) byName[r.player_display_name] = [];
    byName[r.player_display_name].push(r);
  }
  return Object.entries(byName)
    .map(([name, rows]) => {
      const recent = recentGames(rows, throughWeek, lastN);
      const attempts = recent.reduce((s, r) => s + (parseFloat(r.attempts) || 0), 0);
      return { name, histTeam: team, volume: attempts };
    })
    .sort((a, b) => b.volume - a.volume);
}

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
  if (!schedule?.length) return res.status(200).json({ week, players: [], error: 'No schedule found' });

  const [teamRows, playerRows] = await Promise.all([
    fetchTeamWeekStats(year),
    fetchPlayerWeekStats(year),
  ]);
  if (!playerRows?.length) return res.status(200).json({ week, players: [], error: 'Player stats unavailable' });

  const homeTeams = schedule.map(g => g.homeTeam);
  const distinctAbbrs = [...new Set(schedule.flatMap(g => [g.homeAbbr, g.awayAbbr]))];

  const [weather, rosterEntries] = await Promise.all([
    fetchAllWeather(new Date().toLocaleDateString('en-CA'), homeTeams, {}),
    Promise.all(distinctAbbrs.map(async abbr => [abbr, await fetchTeamRoster(abbr)])),
  ]);
  const rosterCache = Object.fromEntries(rosterEntries);

  const throughWeek = Number(week) - 1;
  const players = [];

  for (const g of schedule) {
    const homeEff = teamRows ? computeTeamEfficiency(teamRows, g.homeAbbr, throughWeek) : null;
    const awayEff = teamRows ? computeTeamEfficiency(teamRows, g.awayAbbr, throughWeek) : null;
    const model = buildGameModel(homeEff, awayEff, {});
    const gameWeather = weather[g.homeTeam] || {};

    const teamsInGame = [
      { abbr: g.homeAbbr, name: g.homeTeam, oppAbbr: g.awayAbbr, implied: model.homeImplied },
      { abbr: g.awayAbbr, name: g.awayTeam, oppAbbr: g.homeAbbr, implied: model.awayImplied },
    ];

    for (const t of teamsInGame) {
      const roster = rosterCache[t.abbr];

      const candidates = poolFromRoster(roster, playerRows, ['QB'], 'attempts', 3, throughWeek)
        || starterQbForTeamFallback(playerRows, t.abbr, throughWeek);
      if (!candidates?.length) continue;
      const starter = candidates[0];

      const usage = computePassUsage(playerRows, starter.name, starter.histTeam, throughWeek, recencyWindow(throughWeek));
      if (!usage) continue;
      const defAllowed = computePassDefenseAllowed(teamRows, t.oppAbbr, throughWeek, recencyWindow(throughWeek), toNflverseAbbr);
      const proj = projectPassYards(usage, defAllowed, t.implied, { weather: gameWeather });
      if (!proj) continue;
      const sig = getPassSignals(usage, defAllowed, proj);
      const rosterEntry = getRosterEntry(roster, starter.name);

      players.push({
        name: starter.name,
        team: t.name,
        opponent: teamsInGame.find(x => x.abbr !== t.abbr).name,
        gameId: g.gameId,
        projected: proj.projected,
        floor: proj.floor,
        ceiling: proj.ceiling,
        attempts: usage.attempts,
        signals: sig.signals,
        signalCount: sig.count,
        badge: sig.badge,
        ci: sig.ci,
        injured: !isHealthy(roster, starter.name),
        injuryStatus: rosterEntry?.injuryStatus || null,
      });
    }
  }

  players.sort((a, b) => b.projected - a.projected);

  const data = { week, year, players, timestamp: Date.now(), elapsed: Date.now() - start };
  cache = { data, timestamp: Date.now(), week };
  // No CDN/edge caching — see api/props.js for why (in-memory cache above already covers
  // this, and unlike an edge cache it always resets on a real deploy).
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(data);
};
