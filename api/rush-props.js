// api/rush-props.js — Rushing yards player props endpoint
//
// ROSTER FILTERING (new): candidate pools are built from usage history (who carried the
// ball for this team recently), which has no way to know about offseason releases/trades.
// Real example that surfaced this: Kenny Gainwell's 2025 game logs say Steelers, but he
// wasn't re-signed for 2026 — nothing in the usage history reflects that. Fixed by cross-
// checking each candidate against ESPN's CURRENT roster (lib/roster.js, verified against a
// real response) before computing a projection for them. If the roster fetch fails, this
// fails open (doesn't filter) rather than silently showing nobody.

const { fetchWeekSchedule } = require('../lib/schedule.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { fetchPlayerWeekStats, toNflverseAbbr } = require('../lib/player-stats.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { computeRushUsage, computeRushDefenseAllowed, projectRushYards, getRushSignals } = require('../lib/rush-scoring.js');
const { recencyWindow } = require('../lib/recency-window.js');
const { fetchTeamRoster, isOnRoster, isHealthy } = require('../lib/roster.js');

let cache = { data: null, timestamp: null, week: null };
const CACHE_TTL = 30 * 60 * 1000;

function topRushersForTeam(playerRows, teamEspnAbbr, throughWeek, count = 4) {
  const team = toNflverseAbbr(teamEspnAbbr);
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const teamRows = playerRows.filter(r => r.team === team && r.position === 'RB' && r.season_type === 'REG' && weekFilter(r));

  const byName = {};
  for (const r of teamRows) {
    const carries = parseFloat(r.carries) || 0;
    if (!byName[r.player_display_name]) byName[r.player_display_name] = { name: r.player_display_name, carries: 0 };
    byName[r.player_display_name].carries += carries;
  }
  return Object.values(byName).sort((a, b) => b.carries - a.carries).slice(0, count);
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

  // PERFORMANCE FIX: the old version did `await fetchTeamRoster(t.abbr)` inside a nested
  // per-game/per-team loop — sequential, one round-trip at a time. For a full 16-game slate
  // that's up to 32 sequential ESPN calls, and this endpoint is one of four the Slate tab
  // loads together. Prefetching every distinct team's roster in parallel up front turns 32
  // sequential round-trips into the latency of just the slowest single one.
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

      const pool = topRushersForTeam(playerRows, t.abbr, throughWeek);
      for (const candidate of pool) {
        // Skip anyone not on the team's CURRENT roster — this is what actually fixes the
        // Gainwell-style bug, not just a cosmetic filter.
        if (!isOnRoster(roster, candidate.name)) continue;

        const usage = computeRushUsage(playerRows, candidate.name, toNflverseAbbr(t.abbr), throughWeek, recencyWindow(throughWeek));
        if (!usage) continue;
        const defAllowed = computeRushDefenseAllowed(teamRows, t.oppAbbr, throughWeek, recencyWindow(throughWeek), toNflverseAbbr);
        const proj = projectRushYards(usage, defAllowed, t.implied);
        if (!proj) continue;
        const sig = getRushSignals(usage, defAllowed, proj);

        players.push({
          name: candidate.name,
          team: t.name,
          opponent: teamsInGame.find(x => x.abbr !== t.abbr).name,
          gameId: g.gameId,
          projected: proj.projected,
          floor: proj.floor,
          ceiling: proj.ceiling,
          carries: usage.carries,
          signalCount: sig.count,
          badge: sig.badge,
          ci: sig.ci,
          injured: !isHealthy(roster, candidate.name),
          injuryStatus: roster?.[candidate.name]?.injuryStatus || null,
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
