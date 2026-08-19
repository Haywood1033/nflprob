// api/pass-props.js — Passing yards props endpoint
// ROSTER FILTERING: same fix as the other three prop endpoints. Especially relevant here —
// a starter can be released/traded, and this endpoint has no ranked backup fallback, so a
// stale starter would previously just show up as-is with no signal anything was wrong.

const { fetchWeekSchedule } = require('../lib/schedule.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { fetchPlayerWeekStats, toNflverseAbbr } = require('../lib/player-stats.js');
const { fetchAllWeather } = require('../lib/weather.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { computePassUsage, computePassDefenseAllowed, projectPassYards, getPassSignals } = require('../lib/pass-scoring.js');
const { recencyWindow } = require('../lib/recency-window.js');
const { fetchTeamRoster, isOnRoster, isHealthy } = require('../lib/roster.js');

let cache = { data: null, timestamp: null, week: null };
const CACHE_TTL = 30 * 60 * 1000;

function starterQbForTeam(playerRows, teamEspnAbbr, throughWeek) {
  const team = toNflverseAbbr(teamEspnAbbr);
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const teamRows = playerRows.filter(r => r.team === team && r.position === 'QB' && r.season_type === 'REG' && weekFilter(r));

  const byName = {};
  for (const r of teamRows) {
    const attempts = parseFloat(r.attempts) || 0;
    if (!byName[r.player_display_name]) byName[r.player_display_name] = { name: r.player_display_name, attempts: 0 };
    byName[r.player_display_name].attempts += attempts;
  }
  return Object.values(byName).sort((a, b) => b.attempts - a.attempts);
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
  const weather = await fetchAllWeather(new Date().toLocaleDateString('en-CA'), homeTeams, {});

  const throughWeek = Number(week) - 1;
  const players = [];
  const rosterCache = {};

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
      if (!(t.abbr in rosterCache)) {
        rosterCache[t.abbr] = await fetchTeamRoster(t.abbr);
      }
      const roster = rosterCache[t.abbr];

      // Try each candidate QB by usage rank until we find one who's actually still on the
      // roster — not just take the single top-attempts name and hope. This is what actually
      // fixes the "starter got released/traded" case for a position with no depth-chart
      // fallback in the raw usage data alone.
      const candidates = starterQbForTeam(playerRows, t.abbr, throughWeek);
      const starter = candidates.find(c => isOnRoster(roster, c.name));
      if (!starter) continue;

      const usage = computePassUsage(playerRows, starter.name, toNflverseAbbr(t.abbr), throughWeek, recencyWindow(throughWeek));
      if (!usage) continue;
      const defAllowed = computePassDefenseAllowed(teamRows, t.oppAbbr, throughWeek, recencyWindow(throughWeek), toNflverseAbbr);
      const proj = projectPassYards(usage, defAllowed, t.implied, { weather: gameWeather });
      if (!proj) continue;
      const sig = getPassSignals(usage, defAllowed, proj);

      players.push({
        name: starter.name,
        team: t.name,
        opponent: teamsInGame.find(x => x.abbr !== t.abbr).name,
        gameId: g.gameId,
        projected: proj.projected,
        floor: proj.floor,
        ceiling: proj.ceiling,
        attempts: usage.attempts,
        signalCount: sig.count,
        badge: sig.badge,
        ci: sig.ci,
        injured: !isHealthy(roster, starter.name),
        injuryStatus: roster?.[starter.name]?.injuryStatus || null,
      });
    }
  }

  players.sort((a, b) => b.projected - a.projected);

  const data = { week, year, players, timestamp: Date.now(), elapsed: Date.now() - start };
  cache = { data, timestamp: Date.now(), week };
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
  return res.status(200).json(data);
};
