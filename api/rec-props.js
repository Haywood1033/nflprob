// api/rec-props.js — Receiving yards player props endpoint (step 3b of the build order)
// Same structure as api/rush-props.js, including the team-scoping fix that closed the
// Tank Bigsby duplicate-player bug (usage aggregation filtered by team, not just name).
// Same known limitation: player pool is usage-based, not a confirmed active roster.

const { fetchWeekSchedule } = require('../lib/schedule.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { fetchPlayerWeekStats, toNflverseAbbr } = require('../lib/player-stats.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { computeRecUsage, computeRecDefenseAllowed, projectRecYards, getRecSignals } = require('../lib/rec-scoring.js');

let cache = { data: null, timestamp: null, week: null };
const CACHE_TTL = 30 * 60 * 1000;

function topReceiversForTeam(playerRows, teamEspnAbbr, throughWeek, count = 5) {
  const team = toNflverseAbbr(teamEspnAbbr);
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const teamRows = playerRows.filter(r => r.team === team && (r.position === 'WR' || r.position === 'TE')
    && r.season_type === 'REG' && weekFilter(r));

  const byName = {};
  for (const r of teamRows) {
    const targets = parseFloat(r.targets) || 0;
    if (!byName[r.player_display_name]) byName[r.player_display_name] = { name: r.player_display_name, targets: 0 };
    byName[r.player_display_name].targets += targets;
  }
  return Object.values(byName).sort((a, b) => b.targets - a.targets).slice(0, count);
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

  const throughWeek = Number(week) - 1;
  const players = [];

  for (const g of schedule) {
    const homeEff = teamRows ? computeTeamEfficiency(teamRows, g.homeAbbr, throughWeek) : null;
    const awayEff = teamRows ? computeTeamEfficiency(teamRows, g.awayAbbr, throughWeek) : null;
    const model = buildGameModel(homeEff, awayEff, {});

    const teamsInGame = [
      { abbr: g.homeAbbr, name: g.homeTeam, oppAbbr: g.awayAbbr, implied: model.homeImplied },
      { abbr: g.awayAbbr, name: g.awayTeam, oppAbbr: g.homeAbbr, implied: model.awayImplied },
    ];

    for (const t of teamsInGame) {
      const pool = topReceiversForTeam(playerRows, t.abbr, throughWeek);
      for (const candidate of pool) {
        const usage = computeRecUsage(playerRows, candidate.name, toNflverseAbbr(t.abbr), throughWeek);
        if (!usage) continue;
        const defAllowed = computeRecDefenseAllowed(teamRows, t.oppAbbr, throughWeek, 5, toNflverseAbbr);
        const proj = projectRecYards(usage, defAllowed, t.implied);
        if (!proj) continue;
        const sig = getRecSignals(usage, defAllowed, proj);

        players.push({
          name: candidate.name,
          position: usage.position,
          team: t.name,
          opponent: teamsInGame.find(x => x.abbr !== t.abbr).name,
          gameId: g.gameId,
          projected: proj.projected,
          floor: proj.floor,
          ceiling: proj.ceiling,
          targets: usage.targets,
          signalCount: sig.count,
          badge: sig.badge,
          ci: sig.ci,
        });
      }
    }
  }

  players.sort((a, b) => b.projected - a.projected);

  const data = { week, year, players, timestamp: Date.now(), elapsed: Date.now() - start };
  cache = { data, timestamp: Date.now(), week };
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
  return res.status(200).json(data);
};
