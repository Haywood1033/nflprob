// lib/dfs-projections.js — converts an uploaded DK Showdown salary sheet into DK-scored
// fantasy point projections, built from the SAME per-player models the rest of the app uses
// (pass/rush/rec yards, anytime-TD rate) wherever a model exists, with simple recency-average
// fallbacks (same recentGames() windowing, just without the full regression/defense-adjustment
// treatment) for the pieces nothing in this app currently models: passing TDs, QB rushing,
// RB receiving (computeRecUsage hard-filters to WR/TE), DST, and kickers.
//
// This mirrors exactly what was hand-verified in a one-off analysis earlier (DET@CAR,
// 2026 week 4) — same math, now parameterized instead of hardcoded to that one matchup so it
// works for any Showdown slate a user uploads.

const { fetchPlayerWeekStats, toNflverseAbbr } = require('./player-stats.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('./nflverse.js');
const { buildGameModel } = require('./team-scoring.js');
const { computePassUsage, computePassDefenseAllowed, projectPassYards } = require('./pass-scoring.js');
const { computeRushUsage, computeRushDefenseAllowed, projectRushYards } = require('./rush-scoring.js');
const { computeRecUsage, computeRecDefenseAllowed, projectRecYards } = require('./rec-scoring.js');
const { computePlayerUsage, LG: TD_LG } = require('./td-scoring.js');
const { recencyWindow, recentGames } = require('./recency-window.js');

function regress(actual, lgAvg, sample, k) {
  if (!sample) return lgAvg;
  return (actual * sample + lgAvg * k) / (sample + k);
}

// Loose name match: DK's "Name" field and nflverse's player_display_name are usually
// identical, but suffixes/periods/apostrophes occasionally differ (same class of bug fixed
// for roster matching in lib/roster.js — reuse the same normalization approach here).
function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[.'’]/g, '').replace(/\s+/g, ' ').trim();
}

// Finds the most recent REG-season week a team has real data for for. Used to infer "which
// week is this upload FOR" directly from the data itself — the week right after the last one
// both teams in the matchup actually have box scores for.
function lastCompletedWeek(playerRows, teamAbbr) {
  const weeks = playerRows
    .filter(r => r.team === teamAbbr && r.season_type === 'REG')
    .map(r => Number(r.week));
  return weeks.length ? Math.max(...weeks) : 0;
}

function dkPassPoints(passYds, passTds, ints) {
  let p = passYds * 0.04 + passTds * 4 - ints * 1;
  if (passYds >= 300) p += 3;
  return p;
}
function dkRushPoints(rushYds, rushTds, fumblesLost) {
  let p = rushYds * 0.1 + rushTds * 6 - fumblesLost * 1;
  if (rushYds >= 100) p += 3;
  return p;
}
function dkRecPoints(receptions, recYds, recTds, fumblesLost) {
  let p = receptions * 1 + recYds * 0.1 + recTds * 6 - fumblesLost * 1;
  if (recYds >= 100) p += 3;
  return p;
}
function dkDstPoints(sacks, ints, fumRec, defTds, safeties, blocks, pointsAllowed) {
  let p = sacks * 1 + ints * 2 + fumRec * 2 + defTds * 6 + safeties * 2 + blocks * 2;
  if (pointsAllowed <= 0) p += 10;
  else if (pointsAllowed <= 6) p += 7;
  else if (pointsAllowed <= 13) p += 4;
  else if (pointsAllowed <= 20) p += 1;
  else if (pointsAllowed <= 27) p += 0;
  else if (pointsAllowed <= 34) p -= 1;
  else p -= 4;
  return p;
}
function dkKickerPoints(fg019, fg2029, fg3039, fg4049, fg50, patMade) {
  return fg019 * 3 + fg2029 * 3 + fg3039 * 3 + fg4049 * 4 + fg50 * 5 + patMade * 1;
}

// Builds projections for every uploaded FLEX-priced row. `uploadedPlayers` is the parsed
// salary-sheet rows for Roster Position === 'FLEX' only (one row per distinct player/DST/K —
// the CPT-priced duplicate rows are 1.5x salary for the same entity and aren't needed here,
// since CPT scoring/salary is always derivable as 1.5x of the FLEX projection).
async function buildDfsProjections({ uploadedPlayers, year, awayAbbr, homeAbbr }) {
  const [playerRowsAll, teamRows] = await Promise.all([
    fetchPlayerWeekStats(year),
    fetchTeamWeekStats(year),
  ]);
  if (!playerRowsAll?.length || !teamRows?.length) {
    throw new Error('Player or team stats unavailable from nflverse right now');
  }

  const away = toNflverseAbbr(awayAbbr), home = toNflverseAbbr(homeAbbr);
  const throughWeek = Math.min(lastCompletedWeek(playerRowsAll, away), lastCompletedWeek(playerRowsAll, home));
  const lastN = recencyWindow(throughWeek);

  const homeEff = computeTeamEfficiency(teamRows, home, throughWeek, lastN);
  const awayEff = computeTeamEfficiency(teamRows, away, throughWeek, lastN);
  const model = buildGameModel(homeEff, awayEff, {});
  const implied = { [home]: model.homeImplied, [away]: model.awayImplied };

  // Index nflverse rows by normalized name once, instead of re-scanning the full ~2k-row
  // array per uploaded player (this runs once per request, same cost shape as the rest of
  // the app's per-request indexing — see lib/indexing.js for the same pattern elsewhere).
  const byNormName = {};
  for (const r of playerRowsAll) {
    const key = normalizeName(r.player_display_name);
    if (!byNormName[key]) byNormName[key] = [];
    byNormName[key].push(r);
  }
  function playerRowsFor(name) { return byNormName[normalizeName(name)] || []; }

  function rowsFor(name, team, posFilter) {
    const cand = playerRowsFor(name).filter(r => r.team === team && r.season_type === 'REG' && (!posFilter || r.position === posFilter));
    return recentGames(cand, throughWeek, lastN);
  }
  function avg(rows, field) {
    if (!rows.length) return 0;
    return rows.reduce((s, r) => s + (parseFloat(r[field]) || 0), 0) / rows.length;
  }

  function projectQB(name, team, oppAbbr) {
    const usage = computePassUsage(playerRowsFor(name), name, team, throughWeek, lastN);
    const defAllowed = computePassDefenseAllowed(teamRows, oppAbbr, throughWeek, lastN, toNflverseAbbr);
    const proj = usage ? projectPassYards(usage, defAllowed, implied[team], {}) : null;
    const rows = rowsFor(name, team, 'QB');
    return {
      passYds: proj ? proj.projected : avg(rows, 'passing_yards'),
      passTds: avg(rows, 'passing_tds'),
      ints: avg(rows, 'passing_interceptions'),
      rushYds: avg(rows, 'rushing_yards'),
      games: rows.length,
      modelUsed: !!proj,
    };
  }
  function projectRusher(name, team, oppAbbr) {
    const usage = computeRushUsage(playerRowsFor(name), name, team, throughWeek, lastN);
    if (!usage) return null;
    const defAllowed = computeRushDefenseAllowed(teamRows, oppAbbr, throughWeek, lastN, toNflverseAbbr);
    const proj = projectRushYards(usage, defAllowed, implied[team]);
    const fumPerGame = avg(rowsFor(name, team, 'RB'), 'rushing_fumbles_lost');
    return { rushYds: proj.projected, fumbles: fumPerGame, games: usage.games };
  }
  function projectReceiver(name, team, oppAbbr) {
    const usage = computeRecUsage(playerRowsFor(name), name, team, throughWeek, lastN);
    if (!usage) return null;
    const defAllowed = computeRecDefenseAllowed(teamRows, oppAbbr, throughWeek, lastN, toNflverseAbbr);
    const proj = projectRecYards(usage, defAllowed, implied[team]);
    const fumPerGame = avg(rowsFor(name, team, usage.position), 'receiving_fumbles_lost');
    return { recYds: proj.projected, receptions: usage.receptions / usage.games, fumbles: fumPerGame, games: usage.games };
  }
  function projectTdLegs(name, position) {
    const usage = computePlayerUsage(playerRowsFor(name), name, throughWeek, lastN);
    const anchors = TD_LG[position];
    if (!usage || !anchors) return { rushTds: 0, recTds: 0 };
    let rushTds = 0, recTds = 0;
    if (position === 'RB' || position === 'QB') {
      const carriesPerGame = usage.carries / usage.games;
      const tdPerCarry = regress(usage.rushTds / Math.max(usage.carries, 1), anchors.tdPerCarry, usage.carries, anchors.k);
      rushTds = carriesPerGame * tdPerCarry;
    }
    if (position !== 'QB') {
      const targetsPerGame = usage.targets / usage.games;
      const kRec = anchors.kRec ?? anchors.k;
      const tdPerTarget = regress(usage.recTds / Math.max(usage.targets, 1), anchors.tdPerTarget, usage.targets, kRec);
      recTds = targetsPerGame * tdPerTarget;
    }
    return { rushTds, recTds };
  }
  function projectDst(teamAbbr, oppAbbr) {
    const rows = recentGames(teamRows.filter(r => r.team === teamAbbr && r.season_type === 'REG'), throughWeek, lastN);
    return {
      sacks: avg(rows, 'def_sacks'), ints: avg(rows, 'def_interceptions'),
      fumRec: avg(rows, 'fumble_recovery_opp'),
      defTds: avg(rows, 'def_tds') + avg(rows, 'fumble_recovery_tds'),
      safeties: avg(rows, 'def_safeties'),
      blocks: avg(rows, 'def_punt_blocks') + avg(rows, 'def_pat_blocks') + avg(rows, 'def_fg_blocks'),
      pointsAllowed: implied[oppAbbr],
    };
  }
  function projectKicker(teamAbbr) {
    const rows = recentGames(teamRows.filter(r => r.team === teamAbbr && r.season_type === 'REG'), throughWeek, lastN);
    return {
      fg019: avg(rows, 'fg_made_0_19'), fg2029: avg(rows, 'fg_made_20_29'),
      fg3039: avg(rows, 'fg_made_30_39'), fg4049: avg(rows, 'fg_made_40_49'),
      fg50: avg(rows, 'fg_made_50_59') + avg(rows, 'fg_made_60_'),
      patMade: avg(rows, 'pat_made'),
    };
  }

  const results = [];
  for (const row of uploadedPlayers) {
    const name = row.name, pos = row.position, team = toNflverseAbbr(row.teamAbbrev);
    const oppAbbr = team === home ? away : home;
    const salary = Number(row.salary);
    const status = (row.status || '').trim();
    const base = { id: row.id, name, pos, team: row.teamAbbrev, salary, avgPointsPerGame: Number(row.avgPointsPerGame) || 0 };

    if (status === 'OUT' || status === 'IR' || status === 'Doubtful' || status === 'Suspended') {
      results.push({ ...base, points: 0, note: status, modeled: false });
      continue;
    }

    let points = 0, note = '', modeled = true;
    if (pos === 'QB') {
      const qb = projectQB(name, team, oppAbbr);
      const td = projectTdLegs(name, 'QB');
      points = dkPassPoints(qb.passYds, qb.passTds, qb.ints) + dkRushPoints(qb.rushYds, td.rushTds, 0);
      note = `pass ${qb.passYds.toFixed(0)}yd/${qb.passTds.toFixed(1)}TD, rush ${qb.rushYds.toFixed(0)}yd/${td.rushTds.toFixed(2)}TD`;
      modeled = qb.modelUsed;
    } else if (pos === 'RB') {
      const ru = projectRusher(name, team, oppAbbr);
      if (!ru) { results.push({ ...base, points: base.avgPointsPerGame, note: 'no recent usage data — using provided average', modeled: false }); continue; }
      const td = projectTdLegs(name, 'RB');
      const rbRecRows = rowsFor(name, team, 'RB');
      const recYdsPerGame = avg(rbRecRows, 'receiving_yards');
      const receptionsPerGame = avg(rbRecRows, 'receptions');
      const recFumPerGame = avg(rbRecRows, 'receiving_fumbles_lost');
      points = dkRushPoints(ru.rushYds, td.rushTds, ru.fumbles) + dkRecPoints(receptionsPerGame, recYdsPerGame, td.recTds, recFumPerGame);
      note = `rush ${ru.rushYds.toFixed(0)}yd/${td.rushTds.toFixed(2)}TD, rec ${receptionsPerGame.toFixed(1)}rec/${recYdsPerGame.toFixed(0)}yd/${td.recTds.toFixed(2)}TD`;
    } else if (pos === 'WR' || pos === 'TE') {
      const rec = projectReceiver(name, team, oppAbbr);
      if (!rec) { results.push({ ...base, points: base.avgPointsPerGame, note: 'no recent usage data — using provided average', modeled: false }); continue; }
      const td = projectTdLegs(name, pos);
      points = dkRecPoints(rec.receptions, rec.recYds, td.recTds, rec.fumbles);
      note = `rec ${rec.receptions.toFixed(1)}rec/${rec.recYds.toFixed(0)}yd/${td.recTds.toFixed(2)}TD`;
    } else if (pos === 'DST') {
      const d = projectDst(team, oppAbbr);
      points = dkDstPoints(d.sacks, d.ints, d.fumRec, d.defTds, d.safeties, d.blocks, d.pointsAllowed);
      note = `${d.sacks.toFixed(1)}sk/${d.ints.toFixed(1)}int, ~${d.pointsAllowed.toFixed(1)}pts allowed (model)`;
      modeled = false; // no dedicated DST model — recency averages + our implied-points estimate
    } else if (pos === 'K') {
      const k = projectKicker(team);
      points = dkKickerPoints(k.fg019, k.fg2029, k.fg3039, k.fg4049, k.fg50, k.patMade);
      note = 'recent team FG/XP rate (no per-kicker split in the data)';
      modeled = false;
    } else {
      results.push({ ...base, points: base.avgPointsPerGame, note: 'unrecognized position — using provided average', modeled: false });
      continue;
    }
    results.push({ ...base, points: +points.toFixed(2), note, modeled });
  }

  return { week: throughWeek + 1, throughWeek, year, home, away, model, players: results };
}

module.exports = { buildDfsProjections, normalizeName };
