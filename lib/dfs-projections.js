// lib/dfs-projections.js — converts an uploaded DK salary sheet into DK-scored fantasy point
// projections, built from the SAME per-player models the rest of the app uses (pass/rush/rec
// yards, anytime-TD rate) wherever a model exists, with simple recency-average fallbacks (same
// recentGames() windowing, just without the full regression/defense-adjustment treatment) for
// the pieces nothing in this app currently models: passing TDs, QB rushing, RB receiving
// (computeRecUsage hard-filters to WR/TE), DST, and kickers.
//
// Two entry points share everything below this point:
//   buildDfsProjections()    — DK Showdown: one game, every uploaded player plays in it.
//   buildClassicProjections() — DK Classic: a full multi-game slate, each player in THEIR OWN
//     game (grouped from the per-row away/home abbreviations the client already parses out of
//     the salary file's Game Info column, same way Showdown parses it from the header row).
// The per-position projector functions (projectQB/projectRusher/etc.) and the staleness checks
// (benchedQbNote/staleRoleNote) don't care how many games are in play — they're built once per
// GAME (createGameProjectors) and once per SLATE (buildStalenessChecks) respectively, and
// projectOneRow() ties a single uploaded row to whichever game context it belongs to.

const { fetchPlayerWeekStats, toNflverseAbbr } = require('./player-stats.js');
const { fetchTeamWeekStats, computeTeamEfficiency } = require('./nflverse.js');
const { buildGameModel } = require('./team-scoring.js');
const { computePassUsage, computePassDefenseAllowed, projectPassYards, getCI: getPassCI } = require('./pass-scoring.js');
const { computeRushUsage, computeRushDefenseAllowed, projectRushYards, getCI: getRushCI } = require('./rush-scoring.js');
const { computeRecUsage, computeRecDefenseAllowed, projectRecYards, getCI: getRecCI } = require('./rec-scoring.js');
const { computePlayerUsage, LG: TD_LG } = require('./td-scoring.js');
const { recencyWindow, recentGames } = require('./recency-window.js');
const { loadCalibration, applyDfsCalibration } = require('./calibration.js');
const { resolveStarter, same } = require('./qb-starter.js');
const { fetchGames } = require('./nflverse-games.js');
const { getMarketContext } = require('./vegas-lines.js');

function regress(actual, lgAvg, sample, k) {
  if (!sample) return lgAvg;
  return (actual * sample + lgAvg * k) / (sample + k);
}

// Loose name match: DK's "Name" field and nflverse's player_display_name are usually
// identical, but periods/apostrophes/spacing occasionally differ.
function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[.'’]/g, '').replace(/\s+/g, ' ').trim();
}

// Strips a trailing generational suffix (Jr./Sr./II/III/IV/V). Used only as a team-scoped
// fallback below, not folded into normalizeName() itself — lib/roster.js deliberately leaves
// suffixes in its own normalization because two real players can share a base name across
// DIFFERENT teams (the suffix is the only thing telling them apart there). Here the fallback
// is always scoped to the uploaded player's own team, so that risk doesn't apply — it only
// catches DK and nflverse disagreeing on whether ONE player's own suffix is present at all.
function stripSuffix(name) {
  return (name || '').replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i, '').trim();
}

// Finds the most recent REG-season week a team has real data for. Used to infer "which week is
// this upload FOR" directly from the data itself — the week right after the last one a team
// actually has box scores for.
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

// DK points a player actually scored in one nflverse week row (QB/RB/WR/TE), including the
// pieces the projection leaves out (2-point conversions, return TDs, sack fumbles), since the
// backtest grades against the real total.
function dkActualPoints(r) {
  const n = f => parseFloat(r[f]) || 0;
  return dkPassPoints(n('passing_yards'), n('passing_tds'), n('passing_interceptions'))
    + dkRushPoints(n('rushing_yards'), n('rushing_tds'), n('rushing_fumbles_lost') + n('sack_fumbles_lost'))
    + dkRecPoints(n('receptions'), n('receiving_yards'), n('receiving_tds'), n('receiving_fumbles_lost'))
    + 2 * (n('passing_2pt_conversions') + n('rushing_2pt_conversions') + n('receiving_2pt_conversions'))
    + 6 * n('special_teams_tds');
}

// His DK points per game so far this regular season for this team (null with no games yet) —
// the anchor the DFS calibration blends toward.
function seasonDkAverage(rows, team, throughWeek) {
  const rs = rows.filter(r => r.team === team && r.season_type === 'REG' && (throughWeek < 1 || Number(r.week) <= throughWeek));
  return rs.length ? rs.reduce((s, r) => s + dkActualPoints(r), 0) / rs.length : null;
}

// Indexes nflverse rows by normalized name once per request, instead of re-scanning the full
// ~2k-row array per uploaded player. Shared across every game in a Classic slate — this is a
// slate-wide cost, not a per-game one.
function buildNameIndex(playerRowsAll) {
  const byNormName = {};
  const byNormNameNoSuffix = {};
  for (const r of playerRowsAll) {
    const key = normalizeName(r.player_display_name);
    if (!byNormName[key]) byNormName[key] = [];
    byNormName[key].push(r);
    const noSuffixKey = normalizeName(stripSuffix(r.player_display_name));
    if (!byNormNameNoSuffix[noSuffixKey]) byNormNameNoSuffix[noSuffixKey] = [];
    byNormNameNoSuffix[noSuffixKey].push(r);
  }
  return { byNormName, byNormNameNoSuffix };
}

// Exact normalized match first (preserves a real generational suffix when both sides agree on
// it). Only when that finds NOTHING does this fall back to a suffix-insensitive match, and only
// within the same team — DK's feed and nflverse occasionally disagree on whether a player's
// Jr./Sr./II/III is present at all (e.g. nflverse's "James Cook" vs DK's "James Cook III"),
// which is a pure formatting difference for that one player, not two different people. Scoping
// to team keeps it that way: two real players sharing a base name on DIFFERENT teams still
// won't get conflated, since the exact match (or no match) is all that's tried outside the
// uploaded player's own team.
function makePlayerRowsFor(byNormName, byNormNameNoSuffix) {
  return function playerRowsFor(name, team) {
    const exact = byNormName[normalizeName(name)];
    if (exact && exact.length) return exact;
    const candidates = byNormNameNoSuffix[normalizeName(stripSuffix(name))] || [];
    return team ? candidates.filter(r => r.team === team) : [];
  };
}

// The compute*Usage() functions (lib/rush-scoring.js etc.) re-filter their input rows by an
// EXACT `r.player_display_name === playerName` match — correct and necessary when they're
// called from the main app's tabs, where the name always comes from nflverse data itself
// (self-consistent by construction). Here it isn't: `name` is whatever string DK's export
// used, which is only matched to nflverse rows via the lenient playerRowsFor() match above.
// Passing the DK name straight through re-triggers that same exact check inside
// compute*Usage() and silently discards a correctly-found player's rows the moment the two
// sources format a name even slightly differently (suffix, punctuation, spacing) — the player
// then falls back to a crude recency-average or provided-average estimate instead of the real
// model, with no error raised. Using the row's own nflverse name instead of the DK one keeps
// that inner exact-match check meaningful rather than silently self-defeating.
function realName(rows, fallback) { return rows.length ? rows[0].player_display_name : fallback; }

// Builds every per-position projector for ONE game (one implied-points pair). Everything here
// is specific to that single matchup — called once per game, whether there's one game
// (Showdown) or many (Classic).
function createGameProjectors({ playerRowsAll, teamRows, implied, home, away, throughWeek, lastN, playerRowsFor }) {
  function rowsFor(name, team, posFilter) {
    const cand = playerRowsFor(name, team).filter(r => r.team === team && r.season_type === 'REG' && (!posFilter || r.position === posFilter));
    return recentGames(cand, throughWeek, lastN);
  }
  function avg(rows, field) {
    if (!rows.length) return 0;
    return rows.reduce((s, r) => s + (parseFloat(r[field]) || 0), 0) / rows.length;
  }

  function projectQB(name, team, oppAbbr) {
    const rawRows = playerRowsFor(name, team);
    // A backup coming in may have no games in the recent window: his whole season instead (flagged).
    let usage = computePassUsage(rawRows, realName(rawRows, name), team, throughWeek, lastN), staleSample = false;
    if (!usage) { usage = computePassUsage(rawRows, realName(rawRows, name), team, throughWeek, 18); staleSample = !!usage; }
    const defAllowed = computePassDefenseAllowed(teamRows, oppAbbr, throughWeek, lastN, toNflverseAbbr);
    const proj = usage ? projectPassYards(usage, defAllowed, implied[team], {}) : null;
    let rows = rowsFor(name, team, 'QB');
    if (!rows.length) rows = recentGames(playerRowsFor(name, team).filter(r => r.team === team && r.season_type === 'REG' && r.position === 'QB'), throughWeek, 18);
    return {
      passYds: proj ? proj.projected : avg(rows, 'passing_yards'),
      passTds: avg(rows, 'passing_tds'),
      ints: avg(rows, 'passing_interceptions'),
      rushYds: avg(rows, 'rushing_yards'),
      games: rows.length,
      modelUsed: !!proj, staleSample,
      // QBs get no share-based buffering the way RB/WR/TE usage does (there's normally one
      // starter, so there's no "team total" to anchor against) — a mid-season QB change (the
      // new starter's own history is a handful of mop-up snaps behind the old starter, not a
      // real sample of starter-level volume) is exactly the case a thin-sample flag is for.
      ci: usage ? getPassCI(usage.attempts) : { tier: 'low' },
    };
  }
  function projectRusher(name, team, oppAbbr) {
    const rawRows = playerRowsFor(name, team);
    // Full dataset (not rawRows) so computeRushUsage can sum every RB teammate's carries per
    // week to compute this player's share — rawRows only resolves the real nflverse name.
    const usage = computeRushUsage(playerRowsAll, realName(rawRows, name), team, throughWeek, lastN);
    if (!usage) return null;
    const defAllowed = computeRushDefenseAllowed(teamRows, oppAbbr, throughWeek, lastN, toNflverseAbbr);
    const proj = projectRushYards(usage, defAllowed, implied[team]);
    const fumPerGame = avg(rowsFor(name, team, 'RB'), 'rushing_fumbles_lost');
    return { rushYds: proj.projected, fumbles: fumPerGame, games: usage.games, ci: getRushCI(usage.carries) };
  }
  function projectReceiver(name, team, oppAbbr) {
    const rawRows = playerRowsFor(name, team);
    // Full dataset (not rawRows) so computeRecUsage can sum every teammate's targets per week
    // to compute this player's share — rawRows only resolves the real nflverse name.
    const usage = computeRecUsage(playerRowsAll, realName(rawRows, name), team, throughWeek, lastN);
    if (!usage) return null;
    const defAllowed = computeRecDefenseAllowed(teamRows, oppAbbr, throughWeek, lastN, toNflverseAbbr);
    const proj = projectRecYards(usage, defAllowed, implied[team]);
    const fumPerGame = avg(rowsFor(name, team, usage.position), 'receiving_fumbles_lost');
    return { recYds: proj.projected, receptions: usage.receptions / usage.games, fumbles: fumPerGame, games: usage.games, ci: getRecCI(usage.targets) };
  }
  function projectTdLegs(name, position, team) {
    const rawRows = playerRowsFor(name, team);
    const usage = computePlayerUsage(rawRows, realName(rawRows, name), throughWeek, lastN);
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

  return { rowsFor, avg, projectQB, projectRusher, projectReceiver, projectTdLegs, projectDst, projectKicker };
}

// Builds the two staleness checks the main loop needs, SLATE-WIDE (every team in the upload,
// not just one game's two teams) — a team only ever appears in one game per week, so there's no
// risk of the same team's players being checked against two different "this week's active
// starter" baselines.
function buildStalenessChecks({ uploadedPlayers, playerRowsAll, throughWeek, playerRowsFor, starters = new Map() }) {
  // A team occasionally still carries a backup QB who played real snaps earlier this season
  // (injury relief, a since-resolved competition) on the uploaded slate alongside the actual
  // current starter. That backup's own historical rate stats still look like normal QB
  // production, with nothing to flag that the opportunity is gone — so without this check, the
  // model (and the optimizer built on it) would treat both as independently valuable and could
  // roster both into the same lineup, when in reality only one is actually going to play
  // meaningful snaps. Mirrors the lastWeekPlayed-over-raw-volume fix already applied to starter
  // selection elsewhere (lib/roster-pool.js etc.): whoever played the team's QB position most
  // recently is presumed the active starter; a teammate strictly behind that is presumed
  // benched, unless both played in the exact same most recent week (a real timeshare the data
  // can't resolve, so left alone rather than guessed at).
  //
  // The "most recent starter" bar is built ONLY from this week's uploaded, currently-active QBs
  // (status not OUT/IR/Doubtful/Suspended) — never from the full historical dataset blind to
  // this week's availability. Otherwise the exact case this is meant to handle backfires: if
  // the historically-most-recent QB is OUT this week, using his last game as the bar would
  // wrongly bench the guy replacing him too (he "loses" to a game played by someone who isn't
  // even playing), leaving the team with no viable QB in the pool at all instead of one.
  const activeQbLastWeekByTeam = {};
  for (const r of uploadedPlayers) {
    if (r.position !== 'QB') continue;
    const rStatus = (r.status || '').trim();
    if (rStatus === 'OUT' || rStatus === 'IR' || rStatus === 'Doubtful' || rStatus === 'Suspended') continue;
    const rTeam = toNflverseAbbr(r.teamAbbrev);
    const rRows = playerRowsFor(r.name, rTeam).filter(row => row.position === 'QB' && row.season_type === 'REG' && row.team === rTeam && Number(row.week) <= throughWeek);
    if (!rRows.length) continue;
    const lastWeek = Math.max(...rRows.map(row => Number(row.week)));
    if (!activeQbLastWeekByTeam[rTeam] || lastWeek > activeQbLastWeekByTeam[rTeam]) activeQbLastWeekByTeam[rTeam] = lastWeek;
  }
  function benchedQbNote(name, team) {
    // This week's starter from data (lib/qb-starter: nflverse's named QB unless ESPN's injury report
    // rules him out) decides first; the most-recent-starter rule below is the fallback.
    const st = starters.get(team);
    if (st?.name && st.source !== 'unverified') return same(st.name, name) ? null : `not this week's starter: ${st.note || `${st.name} starts`}. Lock them in if you know otherwise`;
    const teamMaxWeek = activeQbLastWeekByTeam[team];
    if (teamMaxWeek == null) return null;
    const rawRows = playerRowsFor(name, team).filter(r => r.position === 'QB' && r.season_type === 'REG' && r.team === team && Number(r.week) <= throughWeek);
    if (!rawRows.length) return null; // no data at all — the normal "no usage data" fallback below handles this
    const ownLastWeek = Math.max(...rawRows.map(r => Number(r.week)));
    return ownLastWeek < teamMaxWeek
      ? `not this team's most recent active starting QB (last played week ${ownLastWeek}, this week's presumed starter has played as recently as week ${teamMaxWeek}) — likely benched this week; lock them in if you know otherwise`
      : null;
  }

  // Same bug class as the QB check above, generalized to RB/WR/TE: a committee back or
  // receiver who started while the real lead was hurt still has rush/rec rate stats that look
  // like normal production, with nothing in computeRushUsage/computeRecUsage flagging that the
  // role is gone now that the starter is back. The signal here is the plainest available: did
  // this player record any stat line at all in the TEAM's own most recent completed game at
  // this position? A real rotational role shows up in that file even on a bad game (a token
  // carry/target); a scratch/demotion shows no row whatsoever.
  const mostRecentTeamWeekAtPos = {}; // "team|position" -> most recent week ANY teammate at that position recorded a stat
  for (const r of playerRowsAll) {
    if (r.season_type !== 'REG' || Number(r.week) > throughWeek) continue;
    if (r.position !== 'RB' && r.position !== 'WR' && r.position !== 'TE') continue;
    const key = r.team + '|' + r.position;
    const wk = Number(r.week);
    if (!mostRecentTeamWeekAtPos[key] || wk > mostRecentTeamWeekAtPos[key]) mostRecentTeamWeekAtPos[key] = wk;
  }
  function staleRoleNote(name, team, pos) {
    const teamMostRecent = mostRecentTeamWeekAtPos[team + '|' + pos];
    if (teamMostRecent == null) return null;
    const rawRows = playerRowsFor(name, team).filter(r => r.position === pos && r.season_type === 'REG' && r.team === team && Number(r.week) <= throughWeek);
    if (!rawRows.length) return null; // no data at all — the normal "no usage data" fallback below handles this
    const ownLastWeek = Math.max(...rawRows.map(r => Number(r.week)));
    return ownLastWeek < teamMostRecent
      ? `no recorded snap in the team's most recent game at this position (week ${teamMostRecent}) — last real stat line was week ${ownLastWeek}; likely inactive or buried on the depth chart now, not still in that old role. Treat this projection as stale; lock them in if you know otherwise`
      : null;
  }

  // Same real gap as the main app's prop tabs (lib/roster-pool.js's unmodeledRosterTeammates) —
  // a roster-active player with zero usage history anywhere this season (an IR activation, a
  // trade addition) doesn't get projected (nothing to build a number from), but nothing was
  // flagging that his TEAMMATES' projections — who DO get modeled normally — don't account for
  // him either. DFS doesn't fetch ESPN's live roster the way the prop tabs do, but it doesn't
  // need to: the uploaded salary file itself is the authoritative "who's playing this week" list
  // (DK removes IR/inactive players from a slate), so this scans `uploadedPlayers` instead,
  // same source the QB-benched check above already uses.
  const byTeamPos = {}; // "team|position" -> [{ name, hasHistory }]
  for (const r of uploadedPlayers) {
    if (!['QB', 'RB', 'WR', 'TE'].includes(r.position)) continue;
    const rStatus = (r.status || '').trim();
    if (rStatus === 'OUT' || rStatus === 'IR' || rStatus === 'Doubtful' || rStatus === 'Suspended') continue;
    const rTeam = toNflverseAbbr(r.teamAbbrev);
    const hasHistory = playerRowsFor(r.name, rTeam).some(row => row.team === rTeam && row.position === r.position && row.season_type === 'REG');
    const key = rTeam + '|' + r.position;
    if (!byTeamPos[key]) byTeamPos[key] = [];
    byTeamPos[key].push({ name: r.name, hasHistory });
  }
  const unmodeledByTeamPos = {};
  for (const [key, list] of Object.entries(byTeamPos)) {
    const unmodeled = list.filter(x => !x.hasHistory).map(x => x.name);
    if (unmodeled.length) unmodeledByTeamPos[key] = unmodeled;
  }
  function unmodeledTeammates(name, team, pos) {
    return (unmodeledByTeamPos[team + '|' + pos] || []).filter(n => n !== name);
  }

  return { benchedQbNote, staleRoleNote, unmodeledTeammates };
}

// Projects one uploaded row against the game it belongs to. `home`/`away` are THAT row's own
// matchup (not necessarily the only game in the slate).
function projectOneRow(row, { home, away, projectors, benchedQbNote, staleRoleNote, unmodeledTeammates, cal = null, playerRowsFor = null, throughWeek = 0 }) {
  const name = row.name, pos = row.position, team = toNflverseAbbr(row.teamAbbrev);
  const oppAbbr = team === home ? away : home;
  const salary = Number(row.salary);
  const status = (row.status || '').trim();
  const base = { id: row.id, name, pos, team: row.teamAbbrev, salary, avgPointsPerGame: Number(row.avgPointsPerGame) || 0 };

  if (status === 'OUT' || status === 'IR' || status === 'Doubtful' || status === 'Suspended') {
    return { ...base, points: 0, note: status, modeled: false };
  }
  let benchNote = null;
  if (pos === 'QB') benchNote = benchedQbNote(name, team);
  if (pos === 'RB' || pos === 'WR' || pos === 'TE') {
    const staleNote = staleRoleNote(name, team, pos);
    if (staleNote) return { ...base, points: 0, note: staleNote, modeled: false };
  }

  const { rowsFor, avg, projectQB, projectRusher, projectReceiver, projectTdLegs, projectDst, projectKicker } = projectors;
  let points = 0, note = '', modeled = true, lowSample = false;
  if (pos === 'QB') {
    const qb = projectQB(name, team, oppAbbr);
    const td = projectTdLegs(name, 'QB', team);
    points = dkPassPoints(qb.passYds, qb.passTds, qb.ints) + dkRushPoints(qb.rushYds, td.rushTds, 0);
    note = `pass ${qb.passYds.toFixed(0)}yd/${qb.passTds.toFixed(1)}TD, rush ${qb.rushYds.toFixed(0)}yd/${td.rushTds.toFixed(2)}TD`;
    modeled = qb.modelUsed;
    lowSample = modeled && (qb.ci.tier === 'low' || qb.staleSample);
    if (qb.staleSample) note = `last played week ${Math.max(...playerRowsFor(name, team).filter(r => r.position === 'QB' && Number(r.week) <= throughWeek).map(r => Number(r.week)))}; season rates used — ${note}`;
  } else if (pos === 'RB') {
    const ru = projectRusher(name, team, oppAbbr);
    if (!ru) return { ...base, points: base.avgPointsPerGame, note: 'no recent usage data — using provided average', modeled: false };
    const td = projectTdLegs(name, 'RB', team);
    const rbRecRows = rowsFor(name, team, 'RB');
    const recYdsPerGame = avg(rbRecRows, 'receiving_yards');
    const receptionsPerGame = avg(rbRecRows, 'receptions');
    const recFumPerGame = avg(rbRecRows, 'receiving_fumbles_lost');
    points = dkRushPoints(ru.rushYds, td.rushTds, ru.fumbles) + dkRecPoints(receptionsPerGame, recYdsPerGame, td.recTds, recFumPerGame);
    note = `rush ${ru.rushYds.toFixed(0)}yd/${td.rushTds.toFixed(2)}TD, rec ${receptionsPerGame.toFixed(1)}rec/${recYdsPerGame.toFixed(0)}yd/${td.recTds.toFixed(2)}TD`;
    lowSample = ru.ci.tier === 'low';
    // A receiving role is a real shared play with the QB (his catches are the QB's
    // completions) the same way a WR/TE's is — a committed between-the-tackles back isn't,
    // which is why Showdown correlation logic (buildCore(), lib/dfs-optimizer.js) otherwise
    // treats RBs as having no correlation partner. 2.5+ projected receptions/game is a
    // deliberately real bar (a true receiving-down back, not an occasional check-down) —
    // below it, forcing a QB pairing would fabricate a signal that isn't actually there.
    base.recRole = receptionsPerGame >= 2.5;
  } else if (pos === 'WR' || pos === 'TE') {
    const rec = projectReceiver(name, team, oppAbbr);
    if (!rec) return { ...base, points: base.avgPointsPerGame, note: 'no recent usage data — using provided average', modeled: false };
    const td = projectTdLegs(name, pos, team);
    points = dkRecPoints(rec.receptions, rec.recYds, td.recTds, rec.fumbles);
    note = `rec ${rec.receptions.toFixed(1)}rec/${rec.recYds.toFixed(0)}yd/${td.recTds.toFixed(2)}TD`;
    lowSample = rec.ci.tier === 'low';
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
    return { ...base, points: base.avgPointsPerGame, note: 'unrecognized position — using provided average', modeled: false };
  }
  // A thin sample isn't just a weaker number — it's a sign the model has barely any real
  // evidence of this player's CURRENT role (a new starter whose own history is a handful of
  // snaps behind the old one, a committee back who just saw his first real touches). Flagged
  // separately from modeled/EST so a confident-looking MODEL tag never hides "this is
  // basically a guess" the way it would have for a sudden starter change.
  if (lowSample) note = `⚠ limited sample behind this projection — ${note}`;
  // Backtest calibration (lib/backtest.js → nfl_calibration): a fitted line per position on the
  // model and his season DK average, only when it beat the raw model on held-out weeks.
  // Modeled QB/RB/WR/TE only (DST and K are plain recency averages with no model to correct).
  let rawPoints = null;
  if (cal && modeled && playerRowsFor && ['QB', 'RB', 'WR', 'TE'].includes(pos)) {
    const avgSoFar = seasonDkAverage(playerRowsFor(name, team).filter(r => r.position === pos), team, throughWeek);
    const adj = applyDfsCalibration(points, avgSoFar, pos, cal);
    if (adj !== points) { rawPoints = +points.toFixed(2); points = adj; }
  }
  const unmodeled = unmodeledTeammates(name, team, pos);
  if (unmodeled.length) note = `⚠ ${unmodeled.join(', ')} ${unmodeled.length > 1 ? 'are' : 'is'} active with no recorded usage this season, may take touches this doesn't account for — ${note}`;
  if (benchNote) return { ...base, points: +points.toFixed(2), note: `⚠ ${benchNote}`, modeled, lowSample, benched: true };
  return { ...base, points: +points.toFixed(2), ...(rawPoints != null ? { rawPoints } : {}), note, modeled, lowSample, unmodeledTeammates: unmodeled };
}

// Builds a single game's context (team efficiency -> implied points -> win prob) from already-
// fetched teamRows. Shared by both entry points below.
function buildGame(teamRows, awayAbbr, homeAbbr, throughWeek, lastN) {
  const away = toNflverseAbbr(awayAbbr), home = toNflverseAbbr(homeAbbr);
  const homeEff = computeTeamEfficiency(teamRows, home, throughWeek, lastN);
  const awayEff = computeTeamEfficiency(teamRows, away, throughWeek, lastN);
  const model = buildGameModel(homeEff, awayEff, {});
  return { away, home, model, implied: { [home]: model.homeImplied, [away]: model.awayImplied } };
}

// DK Showdown: one game, every uploaded FLEX-priced row plays in it. `uploadedPlayers` is the
// parsed salary-sheet rows for Roster Position === 'FLEX' only (one row per distinct player/
// DST/K — the CPT-priced duplicate rows are 1.5x salary for the same entity and aren't needed
// here, since CPT scoring/salary is always derivable as 1.5x of the FLEX projection).
async function buildDfsProjections({ uploadedPlayers, year, awayAbbr, homeAbbr }) {
  const [playerRowsAll, teamRows, cal] = await Promise.all([
    fetchPlayerWeekStats(year),
    fetchTeamWeekStats(year),
    loadCalibration(),
  ]);
  if (!playerRowsAll?.length || !teamRows?.length) {
    throw new Error('Player or team stats unavailable from nflverse right now');
  }

  const away = toNflverseAbbr(awayAbbr), home = toNflverseAbbr(homeAbbr);
  const throughWeek = Math.min(lastCompletedWeek(playerRowsAll, away), lastCompletedWeek(playerRowsAll, home));
  const lastN = recencyWindow(throughWeek);

  const { byNormName, byNormNameNoSuffix } = buildNameIndex(playerRowsAll);
  const playerRowsFor = makePlayerRowsFor(byNormName, byNormNameNoSuffix);
  const { model, implied } = buildGame(teamRows, awayAbbr, homeAbbr, throughWeek, lastN);
  const projectors = createGameProjectors({ playerRowsAll, teamRows, implied, home, away, throughWeek, lastN, playerRowsFor });
  const starters = await resolveStarters([[awayAbbr, homeAbbr]], year, throughWeek + 1, playerRowsAll);
  const { benchedQbNote, staleRoleNote, unmodeledTeammates } = buildStalenessChecks({ uploadedPlayers, playerRowsAll, throughWeek, playerRowsFor, starters });

  const results = uploadedPlayers.map(row => projectOneRow(row, { home, away, projectors, benchedQbNote, staleRoleNote, unmodeledTeammates, cal, playerRowsFor, throughWeek }));

  return { week: throughWeek + 1, throughWeek, year, home, away, model, players: results, calibrated: dfsCalibrated(cal) };
}

// DK Classic: a full multi-game slate. `uploadedPlayers` rows must each carry their OWN
// `awayAbbr`/`homeAbbr` (parsed client-side from that row's Game Info cell — different rows can
// be different games, unlike Showdown where every row shares the one uploaded matchup).
async function buildClassicProjections({ uploadedPlayers, year }) {
  const [playerRowsAll, teamRows, cal] = await Promise.all([
    fetchPlayerWeekStats(year),
    fetchTeamWeekStats(year),
    loadCalibration(),
  ]);
  if (!playerRowsAll?.length || !teamRows?.length) {
    throw new Error('Player or team stats unavailable from nflverse right now');
  }

  const byGame = {};
  for (const row of uploadedPlayers) {
    const key = row.awayAbbr + '@' + row.homeAbbr;
    if (!byGame[key]) byGame[key] = [];
    byGame[key].push(row);
  }

  // throughWeek is computed SLATE-WIDE (every team in the upload), not per game — every game in
  // a real Classic slate is from the same week, so this just needs one consistent answer, the
  // same reasoning buildDfsProjections already uses across its one game's two teams.
  const allAbbrs = [...new Set(uploadedPlayers.flatMap(r => [r.awayAbbr, r.homeAbbr]))].map(toNflverseAbbr);
  const throughWeek = allAbbrs.length ? Math.min(...allAbbrs.map(a => lastCompletedWeek(playerRowsAll, a))) : 0;
  const lastN = recencyWindow(throughWeek);

  const { byNormName, byNormNameNoSuffix } = buildNameIndex(playerRowsAll);
  const playerRowsFor = makePlayerRowsFor(byNormName, byNormNameNoSuffix);
  const starters = await resolveStarters(Object.keys(byGame).map(k => k.split('@')), year, throughWeek + 1, playerRowsAll);
  const { benchedQbNote, staleRoleNote, unmodeledTeammates } = buildStalenessChecks({ uploadedPlayers, playerRowsAll, throughWeek, playerRowsFor, starters });

  const results = [];
  const games = [];
  for (const [key, rowsForGame] of Object.entries(byGame)) {
    const [awayAbbr, homeAbbr] = key.split('@');
    const { away, home, model, implied } = buildGame(teamRows, awayAbbr, homeAbbr, throughWeek, lastN);
    games.push({ awayAbbr, homeAbbr, away, home, model });
    const projectors = createGameProjectors({ playerRowsAll, teamRows, implied, home, away, throughWeek, lastN, playerRowsFor });
    for (const row of rowsForGame) {
      results.push(projectOneRow(row, { home, away, projectors, benchedQbNote, staleRoleNote, unmodeledTeammates, cal, playerRowsFor, throughWeek }));
    }
  }

  return { week: throughWeek + 1, throughWeek, year, games, players: results, calibrated: dfsCalibrated(cal) };
}

// This week's starting QB per team (lib/qb-starter), for every game in the upload: nflverse's
// named starter unless ESPN's injury report rules him out. Network trouble → an empty map, and the
// most-recent-starter rule in buildStalenessChecks applies as before.
async function resolveStarters(pairs, year, week, playerRowsAll) {
  const out = new Map();
  try {
    const games = await fetchGames().catch(() => null);
    await Promise.all(pairs.map(async ([awayAbbr, homeAbbr]) => {
      const m = games ? getMarketContext(games, year, week, awayAbbr, homeAbbr) : {};
      await Promise.all([[awayAbbr, m.awayQbName], [homeAbbr, m.homeQbName]].map(async ([abbr, named]) => {
        const r = await resolveStarter({ teamAbbr: abbr, namedQb: named || null, playerRows: playerRowsAll }).catch(() => null);
        if (r) out.set(toNflverseAbbr(abbr), r);
      }));
    }));
  } catch { /* fall back to the recency rule */ }
  return out;
}

// Which positions' DFS points the saved calibration changes (for the UI note).
function dfsCalibrated(cal) {
  return ['QB', 'RB', 'WR', 'TE'].filter(p => !!cal?.['dfs_' + p.toLowerCase()]?.line);
}

module.exports = {
  buildDfsProjections, buildClassicProjections, normalizeName,
  // for lib/backtest.js, which replays past weeks through the same projectors
  createGameProjectors, projectOneRow, buildNameIndex, makePlayerRowsFor, dkActualPoints, seasonDkAverage,
  buildStalenessChecks, // tests
};
