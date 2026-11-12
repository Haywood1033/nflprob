const { attachPropLines } = require('../lib/espn-props.js');
const { fetchWeekSchedule, seasonFromQuery } = require('../lib/schedule.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('../lib/nflverse.js');
const { fetchPlayerWeekStats, toNflverseAbbr } = require('../lib/player-stats.js');
const { buildGameModel } = require('../lib/team-scoring.js');
const { computeRecUsage, computeRecDefenseAllowed, projectRecYards, getRecSignals } = require('../lib/rec-scoring.js');
const { recencyWindow, recentGames } = require('../lib/recency-window.js');
const { fetchTeamRoster, isHealthy, getRosterEntry } = require('../lib/roster.js');
const { poolFromRoster } = require('../lib/roster-pool.js');

const { playerDetail } = require('../lib/player-detail.js');
const { loadCalibration, applyYardsCalibration, seasonAverage, blendVolume } = require('../lib/calibration.js');

let cache = { data: null, timestamp: null, key: null };
// Pass-catching backs join the receiving board at this many targets a game lately.
const RB_MIN_TARGETS = 2;
const REC_POSITIONS = { positions: ['WR', 'TE', 'RB'] };
const CACHE_TTL = 30 * 60 * 1000;

// Fallback ONLY used if the live roster fetch failed. Recency-limited, same reasoning as
// poolFromRoster's fix: rank by who's actually getting targets lately.
function topReceiversForTeamFallback(playerRows, teamEspnAbbr, throughWeek, count = 5) {
  const team = toNflverseAbbr(teamEspnAbbr);
  const lastN = recencyWindow(throughWeek);
  const teamRows = playerRows.filter(r => r.team === team && (r.position === 'WR' || r.position === 'TE')
    && r.season_type === 'REG');

  const byName = {};
  for (const r of teamRows) {
    if (!byName[r.player_display_name]) byName[r.player_display_name] = [];
    byName[r.player_display_name].push(r);
  }
  return Object.entries(byName)
    .map(([name, rows]) => {
      const recent = recentGames(rows, throughWeek, lastN);
      const targets = recent.reduce((s, r) => s + (parseFloat(r.targets) || 0), 0);
      const lastWeekPlayed = recent.length ? Math.max(...recent.map(r => Number(r.week))) : -1;
      return { name, histTeam: team, volume: targets, lastWeekPlayed };
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

  const [teamRows, playerRows] = await Promise.all([
    fetchTeamWeekStats(year),
    fetchPlayerWeekStats(year),
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

      const pool = poolFromRoster(roster, playerRows, ['WR', 'TE'], 'targets', 5, throughWeek)
        || topReceiversForTeamFallback(playerRows, t.abbr, throughWeek);
      // The team's top two backs by recent targets, kept only if they're real pass-catchers.
      for (const rb of (roster && Object.keys(roster).length ? poolFromRoster(roster, playerRows, ['RB'], 'targets', 2, throughWeek) : []) || []) pool.push(rb);

      for (const candidate of pool) {
        const usage = computeRecUsage(playerRows, candidate.name, candidate.histTeam, throughWeek, recencyWindow(throughWeek), REC_POSITIONS);
        if (!usage) continue;
        if (usage.position === 'RB' && usage.targets / usage.games < RB_MIN_TARGETS) continue;
        const defAllowed = computeRecDefenseAllowed(teamRows, t.oppAbbr, throughWeek, recencyWindow(throughWeek), toNflverseAbbr);
        const rawProj = projectRecYards(usage, defAllowed, t.implied);
        if (!rawProj) continue;
        const sig = getRecSignals(usage, defAllowed, rawProj); // signal thresholds were set on the raw projection
        const proj = applyYardsCalibration(rawProj, seasonAverage(playerRows, candidate.name, candidate.histTeam, throughWeek, 'receiving_yards'), 'rec', cal);
        const rosterEntry = getRosterEntry(roster, candidate.name);

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
          projReceptions: blendVolume(rawProj.projReceptions, usage.receptions / usage.games), // see lib/calibration.js
          signals: sig.signals,
          signalCount: sig.count,
          badge: sig.badge,
          ci: sig.ci,
          injured: !isHealthy(roster, candidate.name),
          injuryStatus: rosterEntry?.injuryStatus || null,
          detail: playerDetail(playerRows, { name: candidate.name, team: candidate.histTeam, position: usage.position, oppAbbr: toNflverseAbbr(t.oppAbbr), market: 'rec', throughWeek }),
        });
      }
      } catch (err) {
        console.error(`receiving-props: ${t.abbr} failed`, err);
        skipped.push({ team: t.name, error: err.message });
      }
    }
  }

  players.sort((a, b) => b.projected - a.projected);
  // The book's pre-game line for each player (ESPN), priced against the model.
  const lineInfo = await attachPropLines(players, schedule, rosterCache, 'rec_yds');

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
    console.error('receiving-props failed', err);
    return res.status(500).json({ week: req.query?.week, players: [], error: `Receiving props failed: ${err.message}` });
  }
};
