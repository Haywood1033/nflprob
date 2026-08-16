// api/season.js — Season-long projections (team wins, TD/rush/rec/pass yardage totals)
//
// DESIGN: rather than inventing new "strength of schedule" logic, this calls the SAME
// per-game models already built and tested (buildGameModel, anytimeTdProb, projectRushYards,
// projectRecYards, projectPassYards) once for every remaining game on each team's real
// schedule, using that specific opponent's actual defensive numbers each time — SOS and
// home/road context fall out of that naturally, since every game uses real opponent-specific
// inputs rather than a single averaged multiplier.
//
// Season total = sum of each game's per-game projection across the full season. For TD
// probability specifically, summing per-game probabilities approximates expected season TD
// count (assumes independence across games — a simplification, not an exact distribution).
//
// KNOWN LIMITATIONS (same as the weekly prop endpoints, worth repeating here):
// - Player pools are usage-based, not roster/injury-confirmed.
// - lib/season-schedule.js is unverified against a live ESPN response (sandbox can't reach
//   ESPN at all — see that file's header for details).
// - This is a framework/plumbing pass, not a calibrated model — same as every other tab,
//   per the explicit scoping decision to build structure first and dial in accuracy later.

const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { fetchPlayerWeekStats, toNflverseAbbr } = require('../lib/player-stats.js');
const { fetchTeamSeasonSchedule } = require('../lib/season-schedule.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { computePlayerUsage, computeDefenseAllowedToPosition, anytimeTdProb } = require('../lib/td-scoring.js');
const { computeRushUsage, computeRushDefenseAllowed, projectRushYards } = require('../lib/rush-scoring.js');
const { computeRecUsage, computeRecDefenseAllowed, projectRecYards } = require('../lib/rec-scoring.js');
const { computePassUsage, computePassDefenseAllowed, projectPassYards } = require('../lib/pass-scoring.js');
const { ESPN_TEAM_NAME } = require('../lib/schedule.js');

let cache = { data: {}, timestamp: {} };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour — season projections don't need to be as fresh as weekly props

const ALL_TEAMS = Object.keys(ESPN_TEAM_NAME); // 32 ESPN abbreviations

// Season projections should be anchored on a FULL season's per-game rate, not the weekly
// tabs' 5-game recency window — a short recent stretch (e.g. an unusually hot or cold 5
// games) is appropriate for "what's this player doing right now" but produces unrealistic
// season-long extrapolations when multiplied across 17 games. 18 covers a full regular
// season with margin; playoffs are already excluded everywhere via the season_type==='REG'
// filter baked into each usage function.
const SEASON_WINDOW = 18;

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

  const category = req.query.category || 'wins'; // wins | td | rush | rec | pass
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

  const throughWeek = 0; // preseason: every team's "recent form" is its most recent available sample, same base for every remaining game

  // Precompute each team's own efficiency ONCE — reused across every opponent's schedule
  const teamEffByAbbr = {};
  for (const abbr of ALL_TEAMS) teamEffByAbbr[abbr] = computeTeamEfficiency(teamRows, abbr, throughWeek, SEASON_WINDOW);

  // Fetch every team's full season schedule ONCE
  const schedules = {};
  await Promise.all(ALL_TEAMS.map(async (abbr) => {
    schedules[abbr] = await fetchTeamSeasonSchedule(abbr, year);
  }));

  const missingSchedules = ALL_TEAMS.filter(a => !schedules[a]?.length);
  if (missingSchedules.length === ALL_TEAMS.length) {
    return res.status(200).json({
      category, results: [],
      error: 'No season schedules returned from ESPN — lib/season-schedule.js is unverified against a live response, this may be a field-mapping issue. Check the file header for what to inspect first.',
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

      const rbPool = topByVolume(playerRows, abbr, throughWeek, ['RB'], 'carries', 2);
      const wrTePool = topByVolume(playerRows, abbr, throughWeek, ['WR', 'TE'], 'targets', 3);
      const pool = [...rbPool, ...wrTePool];

      for (const candidate of pool) {
        const usage = computePlayerUsage(playerRows, candidate.name, throughWeek, SEASON_WINDOW);
        if (!usage) continue;

        let seasonProb = 0, gamesRemaining = 0;
        for (const g of schedule) {
          if (g.completed) continue;
          gamesRemaining++;
          const oppEff = teamEffByAbbr[g.oppAbbr];
          const model = g.isHome ? buildGameModel(teamEffByAbbr[abbr], oppEff, {}) : buildGameModel(oppEff, teamEffByAbbr[abbr], {});
          const teamImplied = g.isHome ? model.homeImplied : model.awayImplied;
          const defAllowed = computeDefenseAllowedToPosition(playerRows, g.oppAbbr, usage.position, throughWeek, SEASON_WINDOW, toNflverseAbbr);
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

      let pool;
      if (category === 'rush') pool = topByVolume(playerRows, abbr, throughWeek, ['RB'], 'carries', 2);
      else if (category === 'rec') pool = topByVolume(playerRows, abbr, throughWeek, ['WR', 'TE'], 'targets', 3);
      else pool = topByVolume(playerRows, abbr, throughWeek, ['QB'], 'attempts', 1);

      for (const candidate of pool) {
        let usage, computeDefFn, projectFn;
        if (category === 'rush') {
          usage = computeRushUsage(playerRows, candidate.name, toNflverseAbbr(abbr), throughWeek, SEASON_WINDOW);
          computeDefFn = computeRushDefenseAllowed; projectFn = projectRushYards;
        } else if (category === 'rec') {
          usage = computeRecUsage(playerRows, candidate.name, toNflverseAbbr(abbr), throughWeek, SEASON_WINDOW);
          computeDefFn = computeRecDefenseAllowed; projectFn = projectRecYards;
        } else {
          usage = computePassUsage(playerRows, candidate.name, toNflverseAbbr(abbr), throughWeek, SEASON_WINDOW);
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
          const defAllowed = computeDefFn(teamRows, g.oppAbbr, throughWeek, SEASON_WINDOW, toNflverseAbbr);
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
