const { fetchWeekSchedule, seasonFromQuery } = require('../lib/schedule.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { fetchPlayerWeekStats, toNflverseAbbr } = require('../lib/player-stats.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { computePlayerUsage, computeDefenseAllowedToPosition, anytimeTdProb, getTdSignals } = require('../lib/td-scoring.js');
const { recencyWindow, recentGames } = require('../lib/recency-window.js');
const { fetchTeamRoster, isHealthy, getRosterEntry } = require('../lib/roster.js');
const { poolFromRoster, unmodeledRosterTeammates } = require('../lib/roster-pool.js');
const { fetchPbp, computeRedZoneStats, playerRedZoneShare, teamRedZoneTdRate } = require('../lib/red-zone.js');
const { fetchGames, getMarketContext } = require('../lib/vegas-lines.js');
const { normalizeQbName } = require('../lib/qb-status.js');
const { resolveStarter } = require('../lib/qb-starter.js');

const { playerDetail } = require('../lib/player-detail.js');
const { loadCalibration, applyTdCalibration } = require('../lib/calibration.js');

let cache = { data: null, timestamp: null, key: null };
const CACHE_TTL = 30 * 60 * 1000;
const TD_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

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

  const byPos = { QB: [], RB: [], WR: [], TE: [] };
  Object.entries(byName).forEach(([name, p]) => {
    if (!byPos[p.position]) return;
    const recent = recentGames(p.rows, throughWeek, lastN);
    const touches = recent.reduce((s, r) => s + (parseFloat(r.targets) || 0) + (parseFloat(r.carries) || 0), 0);
    const lastWeekPlayed = recent.length ? Math.max(...recent.map(r => Number(r.week))) : -1;
    byPos[p.position].push({ name, histTeam: team, volume: touches, lastWeekPlayed });
  });

  // Who played most recently wins first — see lib/roster-pool.js's poolFromRoster for the full
  // reasoning.
  const byRecency = (a, b) => b.lastWeekPlayed - a.lastWeekPlayed || b.volume - a.volume;
  let pool = [];
  for (const pos of TD_POSITIONS) pool = pool.concat(byPos[pos].sort(byRecency).slice(0, perPosition));
  return pool;
}

// TD-specific pool builder: ranks by combined touches (targets + carries), since
// poolFromRoster only sums a single field and targets-alone would badly under-rank RBs.
function tdPoolFromRoster(roster, playerRows, count = 8, throughWeek = -1) {
  // Same fix as lib/roster-pool.js — an empty-but-truthy roster object must fall back too.
  if (!roster || Object.keys(roster).length === 0) return null;
  const candidates = Object.values(roster).filter(entry => TD_POSITIONS.includes(entry.position) && !entry.definitelyOut);

  const { findHistoricalTeam, statsName } = require('../lib/roster-pool.js');
  const lastN = recencyWindow(throughWeek);
  const withVolume = candidates.map(entry => {
    const name = statsName(playerRows, entry.displayName, entry.position); // ESPN "James Cook III" = nflverse "James Cook"
    const histTeam = name && findHistoricalTeam(playerRows, name);
    if (!histTeam) return null;
    const candidateRows = playerRows.filter(r => r.player_display_name === name && r.team === histTeam && r.season_type === 'REG');
    const rows = recentGames(candidateRows, throughWeek, lastN);
    const touches = rows.reduce((s, r) => s + (parseFloat(r.targets) || 0) + (parseFloat(r.carries) || 0), 0);
    const lastWeekPlayed = rows.length ? Math.max(...rows.map(r => Number(r.week))) : -1;
    return { name, displayName: entry.displayName, position: entry.position, histTeam, volume: touches, lastWeekPlayed };
  }).filter(Boolean);

  // Who played most recently wins first — see lib/roster-pool.js's poolFromRoster for the full
  // reasoning (a role change mid-window otherwise lets the old starter's bigger multi-game
  // total keep outranking the new starter's single more-recent game).
  return withVolume.sort((a, b) => b.lastWeekPlayed - a.lastWeekPlayed || b.volume - a.volume).slice(0, count);
}

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
    // See api/team-model.js's identical fallback for the reasoning — a transient ESPN hiccup
    // shouldn't wipe out a session that already saw real data for this week.
    if (cache.key === cacheKey && cache.data) return res.status(200).json({ ...cache.data, cached: true, stale: true });
    return res.status(200).json({ week, players: [], error: 'No schedule found' });
  }

  const [teamRows, playerRows, pbpRows, marketGames] = await Promise.all([
    fetchTeamWeekStats(year),
    fetchPlayerWeekStats(year),
    fetchPbp(year),
    fetchGames().catch(() => null),
  ]);

  if (!playerRows?.length) {
    return res.status(200).json({ week, players: [], error: 'Player stats unavailable' });
  }

  const throughWeek = Number(week) - 1;
  const cal = await loadCalibration(); // backtest-fitted TD calibration; none = the raw model
  // Real red-zone touch share (lib/red-zone.js, from play-by-play) — null when the fetch
  // failed, which every lookup below already treats the same as "no red-zone sample yet."
  const rzStats = pbpRows ? computeRedZoneStats(pbpRows, throughWeek) : null;
  const players = [];

  const distinctAbbrs = [...new Set(schedule.flatMap(g => [g.homeAbbr, g.awayAbbr]))];
  const rosterEntries = await Promise.all(distinctAbbrs.map(async abbr => [abbr, await fetchTeamRoster(abbr)]));
  const rosterCache = Object.fromEntries(rosterEntries);

  for (const g of schedule) {
    const homeRz = rzStats ? teamRedZoneTdRate(rzStats, toNflverseAbbr(g.homeAbbr)) : null;
    const awayRz = rzStats ? teamRedZoneTdRate(rzStats, toNflverseAbbr(g.awayAbbr)) : null;
    const homeEff = teamRows ? computeTeamEfficiency(teamRows, g.homeAbbr, throughWeek, undefined, homeRz) : null;
    const awayEff = teamRows ? computeTeamEfficiency(teamRows, g.awayAbbr, throughWeek, undefined, awayRz) : null;
    const model = buildGameModel(homeEff, awayEff, { neutralSite: g.neutralSite });

    const teamsInGame = [
      { abbr: g.homeAbbr, name: g.homeTeam, oppAbbr: g.awayAbbr, implied: model.homeImplied },
      { abbr: g.awayAbbr, name: g.awayTeam, oppAbbr: g.homeAbbr, implied: model.awayImplied },
    ];

    for (const t of teamsInGame) {
      const roster = rosterCache[t.abbr];
      const nflverseTeam = toNflverseAbbr(t.abbr);

      let pool = tdPoolFromRoster(roster, playerRows, 9, throughWeek)
        || topUsagePlayersForTeamFallback(playerRows, t.abbr, throughWeek);

      // nflverse's own confirmed-starter field (the same one lib/qb-status.js uses) overrides
      // the pool builders' lastWeekPlayed-based QB pick — that signal is blind to a just-
      // returning starter's own upcoming game, since his last RECORDED game is still from
      // before the injury (see lib/qb-status.js's pickConfirmedStarter comment for the real
      // case — Lamar Jackson's return — this fixes). Drops any OTHER QB on this team from the
      // pool entirely (he's not actually playing, not just less likely to) and makes sure the
      // confirmed starter is modeled even if the pool builder ranked him too low to include.
      const market = getMarketContext(marketGames, year, week, g.awayAbbr, g.homeAbbr);
      // The starter: nflverse's named QB unless ESPN's injury report rules him out (lib/qb-starter).
      const confirmedQbName = (await resolveStarter({ teamAbbr: t.abbr, namedQb: t.abbr === g.homeAbbr ? market.homeQbName : market.awayQbName, playerRows, roster: rosterCache[t.abbr] })).name;
      if (confirmedQbName) {
        pool = pool.filter(c => {
          const isQb = playerRows.some(r => r.player_display_name === c.name && r.team === nflverseTeam && r.position === 'QB');
          return !isQb || normalizeQbName(c.name) === normalizeQbName(confirmedQbName);
        });
        const alreadyIncluded = pool.some(c => normalizeQbName(c.name) === normalizeQbName(confirmedQbName));
        const hasRealData = playerRows.some(r => r.player_display_name === confirmedQbName && r.team === nflverseTeam && r.position === 'QB');
        if (!alreadyIncluded && hasRealData) {
          pool.push({ name: confirmedQbName, position: 'QB', histTeam: nflverseTeam, volume: 0, lastWeekPlayed: -1 });
        }
      }
      // Non-QB roster-active players with zero usage history anywhere this season (an IR
      // activation, a trade addition) who never made it into the pool above at all — see the
      // function's own comment in lib/roster-pool.js for why this is flagged rather than
      // silently ignored. QB is excluded here since it's already handled precisely above.
      const unmodeled = unmodeledRosterTeammates(roster, playerRows, TD_POSITIONS.filter(p => p !== 'QB'));

      for (const candidate of pool) {
        let usage = computePlayerUsage(playerRows, candidate.name, throughWeek, recencyWindow(throughWeek));
        // The confirmed starter coming off the bench (no games in the window): his season instead.
        if (!usage && confirmedQbName && normalizeQbName(candidate.name) === normalizeQbName(confirmedQbName)) usage = computePlayerUsage(playerRows, candidate.name, throughWeek, 18);
        if (!usage) continue;
        const defAllowed = computeDefenseAllowedToPosition(playerRows, t.oppAbbr, usage.position, throughWeek, recencyWindow(throughWeek), toNflverseAbbr);
        const rzShare = rzStats ? playerRedZoneShare(rzStats, toNflverseAbbr(t.abbr), usage.playerId) : null;
        const prob = applyTdCalibration(anytimeTdProb(usage, defAllowed, t.implied, { rzShare }), cal);
        if (prob == null) continue;
        const sig = getTdSignals(usage, defAllowed, model, rzShare);
        const rosterEntry = getRosterEntry(roster, candidate.name);

        players.push({
          name: candidate.name,
          position: usage.position,
          team: t.name,
          opponent: teamsInGame.find(x => x.abbr !== t.abbr).name,
          gameId: g.gameId,
          prob: +prob.toFixed(1),
          touches: usage.touches,
          rzTouchShare: rzShare?.rzTouchShare ?? null,
          inside10Share: rzShare?.inside10Share ?? null,
          signals: sig.signals,
          signalCount: sig.count,
          badge: sig.badge,
          ci: sig.ci,
          unmodeledTeammates: unmodeled.filter(u => u.position === usage.position && u.name !== candidate.name).map(u => u.name),
          injured: !isHealthy(roster, candidate.name),
          injuryStatus: rosterEntry?.injuryStatus || null,
          detail: playerDetail(playerRows, { name: candidate.name, position: usage.position, oppAbbr: toNflverseAbbr(t.oppAbbr), market: 'td', throughWeek }),
        });
      }
    }
  }

  players.sort((a, b) => b.prob - a.prob);

  const data = { week, year, players, timestamp: Date.now(), elapsed: Date.now() - start };
  cache = { data, timestamp: Date.now(), key: cacheKey };
  // Short CDN cache (60s) — a full request here does several external fetches (ESPN roster
  // per team, nflverse CSVs) and was measurably slow on every single tab load with no edge
  // caching at all. 60s is short enough that a real deploy is only briefly stale (self-heals
  // on its own well within a minute, unlike the 30+ minute s-maxage this replaced, which was
  // long enough to look like the deploy hadn't taken effect at all) while still letting the
  // edge answer repeat/concurrent requests for the same week instantly instead of re-running
  // the whole fetch cycle. The in-memory cache above still backs this up for warm-instance
  // reuse beyond that window.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
  return res.status(200).json(data);
};
