const { fetchWeekSchedule } = require('../lib/schedule.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { fetchPlayerWeekStats, toNflverseAbbr } = require('../lib/player-stats.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { computePlayerUsage, computeDefenseAllowedToPosition, anytimeTdProb, getTdSignals } = require('../lib/td-scoring.js');
const { recencyWindow, recentGames } = require('../lib/recency-window.js');
const { fetchTeamRoster, isHealthy, getRosterEntry } = require('../lib/roster.js');
const { poolFromRoster } = require('../lib/roster-pool.js');

let cache = { data: null, timestamp: null, week: null };
const CACHE_TTL = 30 * 60 * 1000;
const TD_POSITIONS = ['RB', 'WR', 'TE'];

// Recency-limited, same reasoning as poolFromRoster's fix (lib/roster-pool.js): rank by
// who's actually getting touches lately, not by whoever accumulated the most earlier in the
// season — otherwise a since-injured/benched player's early-season volume keeps him ranked
// above the player who has actually taken over the role.
function topUsagePlayersForTeamFallback(playerRows, teamEspnAbbr, throughWeek, perPosition = 4) {
  const team = toNflverseAbbr(teamEspnAbbr);
  const lastN = recencyWindow(throughWeek);
  const teamRows = playerRows.filter(r => r.team === team && r.season_type === 'REG' && TD_POSITIONS.includes(r.position));

  const byName = {};
  for (const r of teamRows) {
    if (!byName[r.player_display_name]) byName[r.player_display_name] = { position: r.position, rows: [] };
    byName[r.player_display_name].rows.push(r);
  }

  const byPos = { RB: [], WR: [], TE: [] };
  Object.entries(byName).forEach(([name, p]) => {
    if (!byPos[p.position]) return;
    const recent = recentGames(p.rows, throughWeek, lastN);
    const touches = recent.reduce((s, r) => s + (parseFloat(r.targets) || 0) + (parseFloat(r.carries) || 0), 0);
    byPos[p.position].push({ name, histTeam: team, volume: touches });
  });

  let pool = [];
  for (const pos of TD_POSITIONS) pool = pool.concat(byPos[pos].sort((a, b) => b.volume - a.volume).slice(0, perPosition));
  return pool;
}

// TD-specific pool builder: ranks by combined touches (targets + carries), since
// poolFromRoster only sums a single field and targets-alone would badly under-rank RBs.
function tdPoolFromRoster(roster, playerRows, count = 8, throughWeek = -1) {
  // Same fix as lib/roster-pool.js — an empty-but-truthy roster object must fall back too.
  if (!roster || Object.keys(roster).length === 0) return null;
  const candidates = Object.values(roster).filter(entry => TD_POSITIONS.includes(entry.position) && !entry.definitelyOut);

  const { findHistoricalTeam } = require('../lib/roster-pool.js');
  const lastN = recencyWindow(throughWeek);
  const withVolume = candidates.map(entry => {
    const histTeam = findHistoricalTeam(playerRows, entry.displayName);
    if (!histTeam) return null;
    const candidateRows = playerRows.filter(r => r.player_display_name === entry.displayName && r.team === histTeam && r.season_type === 'REG');
    const rows = recentGames(candidateRows, throughWeek, lastN);
    const touches = rows.reduce((s, r) => s + (parseFloat(r.targets) || 0) + (parseFloat(r.carries) || 0), 0);
    return { name: entry.displayName, position: entry.position, histTeam, volume: touches };
  }).filter(Boolean);

  return withVolume.sort((a, b) => b.volume - a.volume).slice(0, count);
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

  if (!playerRows?.length) {
    return res.status(200).json({ week, players: [], error: 'Player stats unavailable' });
  }

  const throughWeek = Number(week) - 1;
  const players = [];

  const distinctAbbrs = [...new Set(schedule.flatMap(g => [g.homeAbbr, g.awayAbbr]))];
  const rosterEntries = await Promise.all(distinctAbbrs.map(async abbr => [abbr, await fetchTeamRoster(abbr)]));
  const rosterCache = Object.fromEntries(rosterEntries);

  for (const g of schedule) {
    const homeEff = teamRows ? computeTeamEfficiency(teamRows, g.homeAbbr, throughWeek) : null;
    const awayEff = teamRows ? computeTeamEfficiency(teamRows, g.awayAbbr, throughWeek) : null;
    const model = buildGameModel(homeEff, awayEff, {});

    const teamsInGame = [
      { abbr: g.homeAbbr, name: g.homeTeam, oppAbbr: g.awayAbbr, implied: model.homeImplied },
      { abbr: g.awayAbbr, name: g.awayTeam, oppAbbr: g.homeAbbr, implied: model.awayImplied },
    ];

    for (const t of teamsInGame) {
      const roster = rosterCache[t.abbr];

      const pool = tdPoolFromRoster(roster, playerRows, 8, throughWeek)
        || topUsagePlayersForTeamFallback(playerRows, t.abbr, throughWeek);

      for (const candidate of pool) {
        const usage = computePlayerUsage(playerRows, candidate.name, throughWeek, recencyWindow(throughWeek));
        if (!usage) continue;
        const defAllowed = computeDefenseAllowedToPosition(playerRows, t.oppAbbr, usage.position, throughWeek, recencyWindow(throughWeek), toNflverseAbbr);
        const prob = anytimeTdProb(usage, defAllowed, t.implied);
        if (prob == null) continue;
        const sig = getTdSignals(usage, defAllowed, model);
        const rosterEntry = getRosterEntry(roster, candidate.name);

        players.push({
          name: candidate.name,
          position: usage.position,
          team: t.name,
          opponent: teamsInGame.find(x => x.abbr !== t.abbr).name,
          gameId: g.gameId,
          prob: +prob.toFixed(1),
          touches: usage.touches,
          signals: sig.signals,
          signalCount: sig.count,
          badge: sig.badge,
          ci: sig.ci,
          injured: !isHealthy(roster, candidate.name),
          injuryStatus: rosterEntry?.injuryStatus || null,
        });
      }
    }
  }

  players.sort((a, b) => b.prob - a.prob);

  const data = { week, year, players, timestamp: Date.now(), elapsed: Date.now() - start };
  cache = { data, timestamp: Date.now(), week };
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
  return res.status(200).json(data);
};
