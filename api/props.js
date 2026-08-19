// api/props.js — Anytime TD player props endpoint
// ROSTER FILTERING: same fix as api/rush-props.js — candidates are cross-checked against
// ESPN's current roster before being scored, so a player released/traded in the offseason
// (real example: Kenny Gainwell, no longer on Pittsburgh's roster) doesn't get surfaced
// just because his name shows up in last season's usage history.

const { fetchWeekSchedule } = require('../lib/schedule.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { fetchPlayerWeekStats, toNflverseAbbr } = require('../lib/player-stats.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { computePlayerUsage, computeDefenseAllowedToPosition, anytimeTdProb, getTdSignals } = require('../lib/td-scoring.js');
const { recencyWindow } = require('../lib/recency-window.js');
const { fetchTeamRoster, isOnRoster, isHealthy } = require('../lib/roster.js');

let cache = { data: null, timestamp: null, week: null };
const CACHE_TTL = 30 * 60 * 1000;

const TD_POSITIONS = ['RB', 'WR', 'TE'];

function topUsagePlayersForTeam(playerRows, teamEspnAbbr, throughWeek, perPosition = 4) {
  const team = toNflverseAbbr(teamEspnAbbr);
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const teamRows = playerRows.filter(r => r.team === team && r.season_type === 'REG' && weekFilter(r) && TD_POSITIONS.includes(r.position));

  const byName = {};
  for (const r of teamRows) {
    const touches = (parseFloat(r.targets) || 0) + (parseFloat(r.carries) || 0);
    if (!byName[r.player_display_name]) byName[r.player_display_name] = { name: r.player_display_name, position: r.position, touches: 0 };
    byName[r.player_display_name].touches += touches;
  }

  const byPos = { RB: [], WR: [], TE: [] };
  Object.values(byName).forEach(p => { if (byPos[p.position]) byPos[p.position].push(p); });

  let pool = [];
  for (const pos of TD_POSITIONS) {
    pool = pool.concat(byPos[pos].sort((a, b) => b.touches - a.touches).slice(0, perPosition));
  }
  return pool;
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
  const rosterCache = {};

  for (const g of schedule) {
    const homeEff = teamRows ? computeTeamEfficiency(teamRows, g.homeAbbr, throughWeek) : null;
    const awayEff = teamRows ? computeTeamEfficiency(teamRows, g.awayAbbr, throughWeek) : null;
    const model = buildGameModel(homeEff, awayEff, {});

    const teamsInGame = [
      { abbr: g.homeAbbr, name: g.homeTeam, oppAbbr: g.awayAbbr, implied: model.homeImplied },
      { abbr: g.awayAbbr, name: g.awayTeam, oppAbbr: g.homeAbbr, implied: model.awayImplied },
    ];

    for (const t of teamsInGame) {
      if (!(t.abbr in rosterCache)) {
        rosterCache[t.abbr] = await fetchTeamRoster(t.abbr);
      }
      const roster = rosterCache[t.abbr];

      const pool = topUsagePlayersForTeam(playerRows, t.abbr, throughWeek);
      for (const candidate of pool) {
        if (!isOnRoster(roster, candidate.name)) continue;

        const usage = computePlayerUsage(playerRows, candidate.name, throughWeek, recencyWindow(throughWeek));
        if (!usage) continue;
        const defAllowed = computeDefenseAllowedToPosition(playerRows, t.oppAbbr, usage.position, throughWeek, recencyWindow(throughWeek), toNflverseAbbr);
        const prob = anytimeTdProb(usage, defAllowed, t.implied);
        if (prob == null) continue;
        const sig = getTdSignals(usage, defAllowed, model);

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
          injuryStatus: roster?.[candidate.name]?.injuryStatus || null,
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
