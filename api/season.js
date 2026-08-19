// api/season.js — Season-long projections (team wins, TD/rush/rec/pass yardage totals)
//
// ROSTER FILTERING (new): same fix as the four weekly prop endpoints — candidate pools are
// built from usage history, which has no way to know about offseason releases/trades. Every
// distinct team's current roster is prefetched once (parallelized, same pattern proven in
// the weekly endpoints) and every candidate is cross-checked before being projected.
//
// DESIGN: rather than inventing new "strength of schedule" logic, this calls the SAME
// per-game models already built and tested (buildGameModel, anytimeTdProb, projectRushYards,
// projectRecYards, projectPassYards) once for every remaining game on each team's real
// schedule, using that specific opponent's actual defensive numbers each time.
//
// KNOWN LIMITATIONS:
// - This is a framework/plumbing pass, not a calibrated model.
// - This endpoint makes a LOT of calls (32 teams x up to 17 games x several candidates per
//   category) — worth watching real timing on this one even after the indexing and
//   parallelization fixes, since it's the heaviest single endpoint in the app.

const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { fetchPlayerWeekStats, toNflverseAbbr } = require('../lib/player-stats.js');
const { fetchTeamSeasonSchedule } = require('../lib/season-schedule.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { computePlayerUsage, computeDefenseAllowedToPosition, anytimeTdProb } = require('../lib/td-scoring.js');
const { computeRushUsage, computeRushDefenseAllowed, projectRushYards } = require('../lib/rush-scoring.js');
const { computeRecUsage, computeRecDefenseAllowed, projectRecYards } = require('../lib/rec-scoring.js');
const { computePassUsage, computePassDefenseAllowed, projectPassYards } = require('../lib/pass-scoring.js');
const { ESPN_TEAM_NAME } = require('../lib/schedule.js');
const { recencyWindow } = require('../lib/recency-window.js');
const { fetchTeamRoster, isOnRoster } = require('../lib/roster.js');

let cache = { data: {}, timestamp: {} };
const CACHE_TTL = 60 * 60 * 1000;

const ALL_TEAMS = Object.keys(ESPN_TEAM_NAME);

function topByVolume(playerRows, teamEspnAbbr, throughWeek, positions, volumeField, count) {
  const team = toNflverseAbbr(teamEspnAbbr);
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const rows = playerRows.filter(r => r.team === team && positions.includes(r.position) && r.season_type === 'REG' && weekFilter(r));

  const byName = {};
  for (const r of rows) {
    const vol = parseFloat(r[volumeField]) || 0;
    if (!byName[r.player_display_name]) byName[r.player_display_name] = { name: r.player_display_name, vol: 0 };
    byName[r.player_display_name].vol += vol;
  }
  return Object.values(byName).sort((a, b) => b.vol - a.vol).slice(0, count);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const category = req.query.category || 'wins';
  const year = req.query.year || new Date().getFullYear();

  const cacheKey = category;
  const age = cache.timestamp[cacheKey] ? Date.now() - cache.timestamp[cacheKey] : Infinity;
  if (age < CACHE_TTL && cache.data[cacheKey]) {
    return res.status(200).json({ ...cache.data[cacheKey], cached: true });
  }

  const start = Date.now();
  const [teamRows, playerRows] = await Promise.all([fetchTeamWeekStats(year), fetchPlayerWeekStats(year)]);
  if (!teamRows?.length || !playerRows?.length) {
    return res.status(200).json({ category, results: [], error: 'Team or player stats unavailable' });
  }

  const throughWeek = 0;
  const window = recencyWindow(throughWeek);

  const teamEffByAbbr = {};
  for (const abbr of ALL_TEAMS) teamEffByAbbr[abbr] = computeTeamEfficiency(teamRows, abbr, throughWeek, window);

  const schedules = {};
  const rosterCache = {};
  await Promise.all([
    Promise.all(ALL_TEAMS.map(async (abbr) => { schedules[abbr] = await fetchTeamSeasonSchedule(abbr, year); })),
    Promise.all(ALL_TEAMS.map(async (abbr) => { rosterCache[abbr] = await fetchTeamRoster(abbr); })),
  ]);

  const missingSchedules = ALL_TEAMS.filter(a => !schedules[a]?.length);
  if (missingSchedules.length === ALL_TEAMS.length) {
    return res.status(200).json({
      category, results: [],
      error: 'No season schedules returned from ESPN.',
    });
  }

  let results = [];

  if (category === 'wins') {
    for (const abbr of ALL_TEAMS) {
      const schedule = schedules[abbr];
      if (!schedule?.length) continue;
      const selfEff = teamEffByAbbr[abbr];

      let actualWins = 0, actualLosses = 0, projectedWins = 0;
      for (const g of schedule) {
        const oppEff = teamEffByAbbr[g.oppAbbr];
        if (g.completed) {
          if (g.teamScore > g.oppScore) actualWins++;
          else if (g.teamScore < g.oppScore) actualLosses++;
          continue;
        }
        const model = g.isHome
          ? buildGameModel(selfEff, oppEff, {})
          : buildGameModel(oppEff, selfEff, {});
        const winProb = (g.isHome ? model.homeWinProb : model.awayWinProb) / 100;
        projectedWins += winProb;
      }

      results.push({
        team: ESPN_TEAM_NAME[abbr] || abbr,
        actualWins, actualLosses,
        projectedTotalWins: +(actualWins + projectedWins).toFixed(1),
        gamesRemaining: schedule.filter(g => !g.completed).length,
      });
    }
    results.sort((a, b) => b.projectedTotalWins - a.projectedTotalWins);
  }

  else if (category === 'td') {
    for (const abbr of ALL_TEAMS) {
      const schedule = schedules[abbr];
      if (!schedule?.length) continue;
      const roster = rosterCache[abbr];

      const rbPool = topByVolume(playerRows, abbr, throughWeek, ['RB'], 'carries', 2);
      const wrTePool = topByVolume(playerRows, abbr, throughWeek, ['WR', 'TE'], 'targets', 3);
      const pool = [...rbPool, ...wrTePool].filter(c => isOnRoster(roster, c.name));

      for (const candidate of pool) {
        const usage = computePlayerUsage(playerRows, candidate.name, throughWeek, window);
        if (!usage) continue;

        let seasonProb = 0, gamesRemaining = 0;
        for (const g of schedule) {
          if (g.completed) continue;
          gamesRemaining++;
          const oppEff = teamEffByAbbr[g.oppAbbr];
          const model = g.isHome ? buildGameModel(teamEffByAbbr[abbr], oppEff, {}) : buildGameModel(oppEff, teamEffByAbbr[abbr], {});
          const teamImplied = g.isHome ? model.homeImplied : model.awayImplied;
          const defAllowed = computeDefenseAllowedToPosition(playerRows, g.oppAbbr, usage.position, throughWeek, window, toNflverseAbbr);
          const prob = anytimeTdProb(usage, defAllowed, teamImplied);
          if (prob != null) seasonProb += prob / 100;
        }

        results.push({
          name: candidate.name, position: usage.position, team: ESPN_TEAM_NAME[abbr] || abbr,
          projectedSeasonTds: +seasonProb.toFixed(1), gamesRemaining,
        });
      }
    }
    results.sort((a, b) => b.projectedSeasonTds - a.projectedSeasonTds);
  }

  else if (category === 'rush' || category === 'rec' || category === 'pass') {
    for (const abbr of ALL_TEAMS) {
      const schedule = schedules[abbr];
      if (!schedule?.length) continue;
      const roster = rosterCache[abbr];

      let pool;
      if (category === 'rush') pool = topByVolume(playerRows, abbr, throughWeek, ['RB'], 'carries', 2);
      else if (category === 'rec') pool = topByVolume(playerRows, abbr, throughWeek, ['WR', 'TE'], 'targets', 3);
      else pool = topByVolume(playerRows, abbr, throughWeek, ['QB'], 'attempts', 1);

      pool = pool.filter(c => isOnRoster(roster, c.name));

      for (const candidate of pool) {
        let usage, computeDefFn, projectFn;
        if (category === 'rush') {
          usage = computeRushUsage(playerRows, candidate.name, toNflverseAbbr(abbr), throughWeek, window);
          computeDefFn = computeRushDefenseAllowed; projectFn = projectRushYards;
        } else if (category === 'rec') {
          usage = computeRecUsage(playerRows, candidate.name, toNflverseAbbr(abbr), throughWeek, window);
          computeDefFn = computeRecDefenseAllowed; projectFn = projectRecYards;
        } else {
          usage = computePassUsage(playerRows, candidate.name, toNflverseAbbr(abbr), throughWeek, window);
          computeDefFn = computePassDefenseAllowed; projectFn = projectPassYards;
        }
        if (!usage) continue;

        let seasonYards = 0, gamesRemaining = 0;
        for (const g of schedule) {
          if (g.completed) continue;
          gamesRemaining++;
          const oppEff = teamEffByAbbr[g.oppAbbr];
          const model = g.isHome ? buildGameModel(teamEffByAbbr[abbr], oppEff, {}) : buildGameModel(oppEff, teamEffByAbbr[abbr], {});
          const teamImplied = g.isHome ? model.homeImplied : model.awayImplied;
          const defAllowed = computeDefFn(teamRows, g.oppAbbr, throughWeek, window, toNflverseAbbr);
          const proj = projectFn(usage, defAllowed, teamImplied);
          if (proj) seasonYards += proj.projected;
        }

        results.push({
          name: candidate.name, team: ESPN_TEAM_NAME[abbr] || abbr,
          projectedSeasonYards: Math.round(seasonYards), gamesRemaining,
        });
      }
    }
    results.sort((a, b) => b.projectedSeasonYards - a.projectedSeasonYards);
  }

  const data = { category, year, results, missingSchedules, timestamp: Date.now(), elapsed: Date.now() - start };
  cache.data[cacheKey] = data;
  cache.timestamp[cacheKey] = Date.now();
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(200).json(data);
};
