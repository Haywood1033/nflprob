// lib/backtest.js — leak-free backtest: every completed regular-season week (from week 2, so
// there's at least one game of the season behind it) is re-predicted the way the live app
// predicts it, using only games before that week, then scored against what happened.
//
//   game model   moneyline log loss vs the home-team rate AND vs the Vegas moneyline (no-vig);
//                spread and total error vs the Vegas lines; record when the model disagrees with
//                the line by 3+ points; lean tiers; the moneyline calibration fit (lib/calibration)
//   anytime TD   log loss and calibration vs each player's own TD rate so far this season;
//                hit rate by badge (Elite / All-Star / Value) against the model's own number
//   yards        rush / receiving / passing: average miss and bias vs his season average so far,
//                and how often the floor–ceiling band held
//   DFS          DraftKings points per QB / RB / WR / TE through lib/dfs-projections.js's own
//                projectors (as the optimizers build them), vs his season DK average so far
//
// Inputs mirror the live endpoints: team efficiency through the prior week (api/team-model.js),
// red-zone rates from play-by-play through the prior week, rest days and the starting QB from
// nflverse's schedule file, game-day weather from that file (the live app uses a forecast).
// Player pools are the endpoints' own no-roster fallbacks (who played most recently, then
// volume), since a past week's ESPN roster isn't available; QB status counts starts only
// through the prior week. Players with no stat line that week are left out (books void them).

const { fetchTeamWeekStats, computeTeamEfficiency, toNflverseAbbr } = require('./nflverse.js');
const { fetchPlayerWeekStats } = require('./player-stats.js');
const { fetchGames, completedGamesForWeek } = require('./nflverse-games.js');
const { buildGameModel } = require('./team-scoring.js');
const { recencyWindow, recentGames } = require('./recency-window.js');
const { getMarketContext } = require('./vegas-lines.js');
const { qbStatus, normalizeQbName } = require('./qb-status.js');
const { fetchPbp, computeRedZoneStats, teamRedZoneTdRate, playerRedZoneShare } = require('./red-zone.js');
const { computePlayerUsage, computeDefenseAllowedToPosition, anytimeTdProb, getTdSignals } = require('./td-scoring.js');
const { computeRushUsage, computeRushDefenseAllowed, projectRushYards } = require('./rush-scoring.js');
const { computeRecUsage, computeRecDefenseAllowed, projectRecYards } = require('./rec-scoring.js');
const { computePassUsage, computePassDefenseAllowed, projectPassYards } = require('./pass-scoring.js');
const { normalizeName, createGameProjectors, projectOneRow, buildNameIndex, makePlayerRowsFor, dkActualPoints, seasonDkAverage } = require('./dfs-projections.js');
const { tierOf, mlLeanTier } = require('./grading.js');
const { calibrate, calibrateTd, calibrateYards, calibrateTotals, calibrateDfs } = require('./calibration.js');

const clip = p => Math.min(1 - 1e-4, Math.max(1e-4, p));
const ll = (p, y) => -(y ? Math.log(clip(p)) : Math.log(1 - clip(p)));
const mean = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : null);
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const americanToProb = a => (a == null ? null : a < 0 ? -a / (-a + 100) : 100 / (a + 100));
const TD_BINS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0001];

// The endpoints' no-roster pools: players at these positions who appeared in the recent window,
// most recent first, then by volume.
function pool(byTeam, team, positions, volumeOf, throughWeek, count) {
  const byName = new Map();
  for (const r of byTeam.get(team) || []) {
    if (r.season_type !== 'REG' || !positions.includes(r.position)) continue;
    const a = byName.get(r.player_display_name) || [];
    a.push(r); byName.set(r.player_display_name, a);
  }
  const lastN = recencyWindow(throughWeek);
  return [...byName.entries()].map(([name, rows]) => {
    const recent = recentGames(rows, throughWeek, lastN);
    return { name, position: rows[0].position, histTeam: team, volume: recent.reduce((s, r) => s + volumeOf(r), 0), lastWeekPlayed: recent.length ? Math.max(...recent.map(r => Number(r.week))) : -1 };
  }).filter(p => p.lastWeekPlayed > 0).sort((a, b) => b.lastWeekPlayed - a.lastWeekPlayed || b.volume - a.volume).slice(0, count);
}

function weatherOf(g) {
  const roof = String(g.roof || '').toLowerCase();
  if (roof === 'dome' || roof === 'closed') return { dome: true };
  return { dome: false, w: num(g.wind) ?? 0, t: num(g.temp) ?? 60 };
}

// The player's own season so far (weeks before this one), for the naive baselines.
function seasonSoFar(byPlayer, name, team, throughWeek) {
  const rows = (byPlayer.get(name + '|' + team) || []).filter(r => r.season_type === 'REG' && Number(r.week) <= throughWeek);
  const sum = f => rows.reduce((s, r) => s + (parseFloat(r[f]) || 0), 0);
  return { games: rows.length, tds: sum('rushing_tds') + sum('receiving_tds'), rush: sum('rushing_yards'), rec: sum('receiving_yards'), pass: sum('passing_yards') };
}

async function runBacktest({ seasons = null, props = true, maxWeeksPerSeason = 18, currentOnly = false } = {}) {
  const games = await fetchGames();
  if (!games) throw new Error('nflverse schedule unavailable');
  const done = games.filter(g => g.game_type === 'REG' && g.home_score !== '' && g.away_score !== '');
  const latest = Math.max(...done.map(g => Number(g.season)));
  const targetSeasons = seasons || (currentOnly ? [latest] : [latest - 1, latest]);

  const gameRows = [], td = [], yards = { rush: [], rec: [], pass: [] }, dfs = [];
  const perWeek = [];
  for (const season of targetSeasons) {
    const [teamRowsAll, playerRowsAll, pbp] = await Promise.all([fetchTeamWeekStats(season), fetchPlayerWeekStats(season), fetchPbp(season).catch(() => null)]);
    // Keep only this season's rows (the loaders blend in last season for teams with no games yet).
    const teamRows = (teamRowsAll || []).filter(r => Number(r.season) === season);
    const playerRows = (playerRowsAll || []).filter(r => Number(r.season) === season);
    if (!teamRows.length) continue;
    // Indexes, built once per season (the pools and baselines read them every week).
    const byTeam = new Map(), byPlayer = new Map(), byName = new Map();
    for (const r of playerRows) { (byTeam.get(r.team) || byTeam.set(r.team, []).get(r.team)).push(r); const k = r.player_display_name + '|' + r.team; (byPlayer.get(k) || byPlayer.set(k, []).get(k)).push(r); (byName.get(r.player_display_name) || byName.set(r.player_display_name, []).get(r.player_display_name)).push(r); }
    // The scoring functions filter rows by player name themselves, so handing each one only that
    // player's rows gives the same answer much faster; defense numbers repeat per opponent-week.
    const own = name => byName.get(name) || [];
    const memo = new Map(), once = (key, f) => (memo.has(key) ? memo.get(key) : (memo.set(key, f()), memo.get(key)));
    const weeks = [...new Set(done.filter(g => Number(g.season) === season).map(g => Number(g.week)))].filter(w => w >= 2).sort((a, b) => a - b).slice(0, maxWeeksPerSeason);
    for (const week of weeks) {
      const tw = week - 1, win = recencyWindow(tw);
      const rz = pbp ? computeRedZoneStats(pbp.filter(r => Number(r.season ?? season) === season), tw) : null;
      const before = playerRows.filter(r => Number(r.week) <= tw);
      // League TD rate per game by position so far (the prior for the naive baseline).
      const posRate = {};
      for (const pos of ['QB', 'RB', 'WR', 'TE']) { const rs = before.filter(r => r.position === pos && r.season_type === 'REG' && ((parseFloat(r.targets) || 0) + (parseFloat(r.carries) || 0)) > 0); posRate[pos] = rs.length ? rs.reduce((s, r) => s + (parseFloat(r.rushing_tds) || 0) + (parseFloat(r.receiving_tds) || 0), 0) / rs.length : 0.2; }
      const weekRows = new Map();
      for (const r of playerRows) if (Number(r.week) === week && r.season_type === 'REG') weekRows.set(normalizeName(r.player_display_name) + '|' + r.team, r);
      let n = 0, right = 0;
      for (const g of completedGamesForWeek(games, season, week)) {
        const home = g.home_team, away = g.away_team;
        const homeRz = rz ? teamRedZoneTdRate(rz, home) : null, awayRz = rz ? teamRedZoneTdRate(rz, away) : null;
        const homeEff = computeTeamEfficiency(teamRows, home, tw, win, homeRz), awayEff = computeTeamEfficiency(teamRows, away, tw, win, awayRz);
        if (!homeEff || !awayEff) continue;
        const market = getMarketContext(games, season, week, away, home);
        const model = buildGameModel(homeEff, awayEff, {
          weather: weatherOf(g), neutralSite: g.location === 'Neutral', homeRestDays: market.homeRestDays, awayRestDays: market.awayRestDays,
          homeQbStatus: qbStatus(market.homeQbName, before, home), awayQbStatus: qbStatus(market.awayQbName, before, away),
        });
        const hs = Number(g.home_score), as = Number(g.away_score);
        if (hs === as) continue; // ties don't grade a moneyline
        const ih = americanToProb(market.homeMoneyline), ia = americanToProb(market.awayMoneyline);
        const p = model.homeWinProb / 100, y = hs > as ? 1 : 0;
        gameRows.push({ season, week, order: season * 100 + week, home, away, p, y, diff: model.diff, total: model.total, margin: hs - as, actualTotal: hs + as,
          vegasSpread: num(g.spread_line), vegasTotal: num(g.total_line), vegasP: ih != null && ia != null ? ih / (ih + ia) : null, tier: mlLeanTier(model.homeWinProb) });
        n++; if ((p >= 0.5) === (y === 1)) right++;
        if (!props) continue;

        // ── DFS points, the way api/lineup-optimizer.js / api/classic-optimizer.js build them:
        // their own game model (no red-zone or context inputs), every player at QB/RB/WR/TE who
        // played this week (the starting QB only), staleness checks off (he did play). ──
        {
          const dHome = computeTeamEfficiency(teamRows, home, tw, win), dAway = computeTeamEfficiency(teamRows, away, tw, win);
          const dm = buildGameModel(dHome, dAway, {});
          const gameRowsPlayers = [...(byTeam.get(home) || []), ...(byTeam.get(away) || [])];
          const priorRows = gameRowsPlayers.filter(r => Number(r.week) <= tw);
          const { byNormName, byNormNameNoSuffix } = buildNameIndex(priorRows);
          const playerRowsFor = makePlayerRowsFor(byNormName, byNormNameNoSuffix);
          const projectors = createGameProjectors({ playerRowsAll: priorRows, teamRows, implied: { [home]: dm.homeImplied, [away]: dm.awayImplied }, home, away, throughWeek: tw, lastN: win, playerRowsFor });
          const ctx = { home, away, projectors, benchedQbNote: () => null, staleRoleNote: () => null, unmodeledTeammates: () => [] };
          for (const r of gameRowsPlayers) {
            if (Number(r.week) !== week || r.season_type !== 'REG' || !['QB', 'RB', 'WR', 'TE'].includes(r.position)) continue;
            const qbName = r.team === home ? market.homeQbName : market.awayQbName;
            if (r.position === 'QB' && (qbName ? normalizeQbName(r.player_display_name) !== normalizeQbName(qbName) : (parseFloat(r.attempts) || 0) < 15)) continue;
            const pr = projectOneRow({ id: r.player_id, name: r.player_display_name, position: r.position, teamAbbrev: r.team, salary: 0, status: '' }, ctx);
            if (!pr.modeled) continue; // live calibration only touches modeled projections
            dfs.push({ order: season * 100 + week, pos: r.position, proj: pr.points, actual: dkActualPoints(r), naive: seasonDkAverage(playerRowsFor(r.player_display_name, r.team).filter(x => x.position === r.position), r.team, tw) });
          }
        }

        // ── Props, the way api/props.js and the yardage endpoints build them ──
        const ctxFree = buildGameModel(homeEff, awayEff, { neutralSite: g.location === 'Neutral' });
        for (const [team, opp, implied, qbName] of [[home, away, ctxFree.homeImplied, market.homeQbName], [away, home, ctxFree.awayImplied, market.awayQbName]]) {
          const actualOf = name => weekRows.get(normalizeName(name) + '|' + team);
          // Anytime TD: the TD pool, the confirmed QB only.
          let tdPool = pool(byTeam, team, ['QB', 'RB', 'WR', 'TE'], r => (parseFloat(r.targets) || 0) + (parseFloat(r.carries) || 0), tw, 9);
          if (qbName) tdPool = tdPool.filter(c => c.position !== 'QB' || normalizeQbName(c.name) === normalizeQbName(qbName));
          for (const c of tdPool) {
            const actual = actualOf(c.name);
            if (!actual) continue;
            const usage = computePlayerUsage(own(c.name), c.name, tw, win);
            if (!usage) continue;
            const def = once(`td|${opp}|${usage.position}|${tw}`, () => computeDefenseAllowedToPosition(playerRows, opp, usage.position, tw, win, toNflverseAbbr));
            const rzShare = rz ? playerRedZoneShare(rz, team, usage.playerId) : null;
            const prob = anytimeTdProb(usage, def, implied, { rzShare });
            if (prob == null) continue;
            const sig = getTdSignals(usage, def, ctxFree, rzShare);
            const so = seasonSoFar(byPlayer, c.name, team, tw);
            const scored = ((parseFloat(actual.rushing_tds) || 0) + (parseFloat(actual.receiving_tds) || 0)) > 0 ? 1 : 0;
            // Naive baseline: his TDs per game so far, shrunk toward his position's league rate over 4 games.
            const prior = posRate[usage.position] ?? 0.2, rate = (so.tds + 4 * prior) / (so.games + 4);
            td.push({ order: season * 100 + week, p: prob / 100, y: scored, naive: 1 - Math.exp(-rate), tier: tierOf(sig.badge?.label), count: sig.count });
          }
          // Rushing yards: RBs by carries.
          for (const c of pool(byTeam, team, ['RB'], r => parseFloat(r.carries) || 0, tw, 4)) {
            const actual = actualOf(c.name); if (!actual) continue;
            const usage = computeRushUsage(byTeam.get(team) || [], c.name, team, tw, win); if (!usage) continue;
            const proj = projectRushYards(usage, once(`rush|${opp}|${tw}`, () => computeRushDefenseAllowed(teamRows, opp, tw, win, toNflverseAbbr)), implied); if (!proj) continue;
            const so = seasonSoFar(byPlayer, c.name, team, tw), a = parseFloat(actual.rushing_yards) || 0;
            yards.rush.push({ order: season * 100 + week, proj: proj.projected, floor: proj.floor, ceiling: proj.ceiling, actual: a, naive: so.games ? so.rush / so.games : null });
          }
          // Receiving yards: WR / TE by targets.
          for (const c of pool(byTeam, team, ['WR', 'TE'], r => parseFloat(r.targets) || 0, tw, 5)) {
            const actual = actualOf(c.name); if (!actual) continue;
            const usage = computeRecUsage(byTeam.get(team) || [], c.name, team, tw, win); if (!usage) continue;
            const proj = projectRecYards(usage, once(`rec|${opp}|${tw}`, () => computeRecDefenseAllowed(teamRows, opp, tw, win, toNflverseAbbr)), implied); if (!proj) continue;
            const so = seasonSoFar(byPlayer, c.name, team, tw), a = parseFloat(actual.receiving_yards) || 0;
            yards.rec.push({ order: season * 100 + week, proj: proj.projected, floor: proj.floor, ceiling: proj.ceiling, actual: a, naive: so.games ? so.rec / so.games : null });
          }
          // Passing yards: the confirmed starter, else the most recent passer.
          const qb = qbName ? { name: qbName } : pool(byTeam, team, ['QB'], r => parseFloat(r.attempts) || 0, tw, 1)[0];
          if (qb) {
            const actual = actualOf(qb.name);
            const usage = actual ? computePassUsage(byTeam.get(team) || [], qb.name, team, tw, win) : null;
            const proj = usage ? projectPassYards(usage, once(`pass|${opp}|${tw}`, () => computePassDefenseAllowed(teamRows, opp, tw, win, toNflverseAbbr)), implied, { weather: weatherOf(g) }) : null;
            if (proj) { const so = seasonSoFar(byPlayer, qb.name, team, tw), a = parseFloat(actual.passing_yards) || 0; yards.pass.push({ order: season * 100 + week, proj: proj.projected, floor: proj.floor, ceiling: proj.ceiling, actual: a, naive: so.games ? so.pass / so.games : null }); }
          }
        }
      }
      if (n) perWeek.push({ season, week, games: n, favoritesWon: right });
    }
  }

  // ── Scores ──
  const withVegas = gameRows.filter(r => r.vegasP != null);
  const withSpread = gameRows.filter(r => r.vegasSpread != null), withTotal = gameRows.filter(r => r.vegasTotal != null);
  // Against the number: games where the model's margin / total differs from the line by 3+.
  const ats = withSpread.filter(r => Math.abs(r.diff - r.vegasSpread) >= 3 && r.margin !== r.vegasSpread).map(r => ((r.diff > r.vegasSpread) === (r.margin > r.vegasSpread) ? 1 : 0));
  const ou = withTotal.filter(r => Math.abs(r.total - r.vegasTotal) >= 3 && r.actualTotal !== r.vegasTotal).map(r => ((r.total > r.vegasTotal) === (r.actualTotal > r.vegasTotal) ? 1 : 0));
  const homeRate = mean(gameRows, r => r.y);
  const yardSummary = rows => {
    const nv = rows.filter(r => r.naive != null);
    return { n: rows.length, mae: { model: mean(rows, r => Math.abs(r.proj - r.actual)), naive: mean(nv, r => Math.abs(r.naive - r.actual)), modelSameRows: mean(nv, r => Math.abs(r.proj - r.actual)) }, bias: mean(rows, r => r.proj - r.actual), inBand: mean(rows, r => (r.actual >= r.floor && r.actual <= r.ceiling ? 1 : 0)), calibration: calibrateYards(rows) };
  };
  const tdNaive = td.filter(r => r.naive != null);
  return {
    generatedAt: new Date().toISOString(), seasons: targetSeasons, weeks: perWeek.length, games: gameRows.length,
    moneyline: {
      accuracy: mean(gameRows, r => ((r.p >= 0.5) === (r.y === 1) ? 1 : 0)),
      logLoss: { model: mean(gameRows, r => ll(r.p, r.y)), home: mean(gameRows, r => ll(homeRate, r.y)), vegas: mean(withVegas, r => ll(r.vegasP, r.y)), modelSameGames: mean(withVegas, r => ll(r.p, r.y)), vegasGames: withVegas.length },
      vegasAccuracy: mean(withVegas, r => ((r.vegasP >= 0.5) === (r.y === 1) ? 1 : 0)),
      byTier: ['strong', 'lean', 'tossup'].map(t => { const r = gameRows.filter(x => x.tier === t); return { tier: t, n: r.length, predicted: mean(r, x => Math.max(x.p, 1 - x.p)), won: mean(r, x => ((x.p >= 0.5) === (x.y === 1) ? 1 : 0)) }; }),
      calibration: calibrate(gameRows),
    },
    spread: { n: withSpread.length, mae: { model: mean(withSpread, r => Math.abs(r.diff - r.margin)), vegas: mean(withSpread, r => Math.abs(r.vegasSpread - r.margin)) }, disagree3: { n: ats.length, hitRate: mean(ats, x => x) } },
    totals: { n: withTotal.length, mae: { model: mean(withTotal, r => Math.abs(r.total - r.actualTotal)), vegas: mean(withTotal, r => Math.abs(r.vegasTotal - r.actualTotal)) }, bias: mean(gameRows, r => r.total - r.actualTotal), disagree3: { n: ou.length, hitRate: mean(ou, x => x) }, calibration: calibrateTotals(gameRows) },
    anytimeTd: {
      n: td.length, rate: mean(td, r => r.y),
      logLoss: { model: mean(td, r => ll(r.p, r.y)), naive: mean(tdNaive, r => ll(r.naive, r.y)), modelSameRows: mean(tdNaive, r => ll(r.p, r.y)) },
      bins: TD_BINS.slice(0, -1).map((lo, i) => { const b = td.filter(r => r.p >= lo && r.p < TD_BINS[i + 1]); return { lo, hi: Math.min(1, TD_BINS[i + 1]), n: b.length, predicted: mean(b, r => r.p), actual: mean(b, r => r.y) }; }),
      calibration: calibrateTd(td),
      byBadge: ['Elite', 'All-Star', 'Value', 'none'].map(t => { const r = td.filter(x => x.tier === t); return { badge: t === 'none' ? 'No badge' : t, n: r.length, predicted: mean(r, x => x.p), actual: mean(r, x => x.y) }; }),
    },
    rushYds: yardSummary(yards.rush), recYds: yardSummary(yards.rec), passYds: yardSummary(yards.pass),
    dfs: {
      n: dfs.length,
      byPosition: Object.fromEntries(['QB', 'RB', 'WR', 'TE'].map(pos => {
        const rows = dfs.filter(r => r.pos === pos), nv = rows.filter(r => r.naive != null);
        return [pos, { n: rows.length, mae: { model: mean(rows, r => Math.abs(r.proj - r.actual)), naive: mean(nv, r => Math.abs(r.naive - r.actual)), modelSameRows: mean(nv, r => Math.abs(r.proj - r.actual)) }, bias: mean(rows, r => r.proj - r.actual), avgActual: mean(rows, r => r.actual), calibration: calibrateDfs(rows) }];
      })),
    },
    perWeek: perWeek.reverse(),
  };
}

module.exports = { runBacktest };
