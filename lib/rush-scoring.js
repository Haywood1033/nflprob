// lib/rush-scoring.js — Rushing yards projection model
const { byGameTeam } = require('./indexing.js');
const { recentGames, weightedAgg } = require('./recency-window.js');
const LG_YPC = 4.2;
const LG_CARRIES = 14.0;
const K_YPC = 80;

function regress(actual, lgAvg, sample, k) {
  if (!sample) return lgAvg;
  return (actual * sample + lgAvg * k) / (sample + k);
}

function computeRushUsage(rows, playerName, teamFilter, throughWeek, lastN = 5) {
  const candidateRows = rows.filter(r => r.player_display_name === playerName && r.team === teamFilter && r.season_type === 'REG' && r.position === 'RB');
  const playerRows = recentGames(candidateRows, throughWeek, lastN);

  if (!playerRows.length) return null;

  const games = playerRows.length;
  const carries = playerRows.reduce((s, r) => s + (parseFloat(r.carries) || 0), 0);
  const rushYards = playerRows.reduce((s, r) => s + (parseFloat(r.rushing_yards) || 0), 0);
  const team = playerRows[0].team;

  const { weightedGames, sums } = weightedAgg(playerRows, ['carries', 'rushing_yards']);

  // Carries SHARE of the team's own total, recency-weighted the same way — distinguishes "this
  // player's own role shrank" from "the team just ran less that particular week" (e.g. trailing
  // big), which a raw per-game carry count can't tell apart. A back ascending in a committee
  // shows up here as a rising share even in a week the team ran less overall.
  const teamRowsByWeek = {};
  rows.filter(r => r.team === teamFilter && r.season_type === 'REG' && r.position === 'RB')
    .forEach(r => { teamRowsByWeek[r.week] = (teamRowsByWeek[r.week] || 0) + (parseFloat(r.carries) || 0); });
  const shareRows = playerRows
    .map(r => ({ week: r.week, share: teamRowsByWeek[r.week] ? (parseFloat(r.carries) || 0) / teamRowsByWeek[r.week] : null, teamCarries: teamRowsByWeek[r.week] || 0 }))
    .filter(r => r.share != null);
  const shareAgg = weightedAgg(shareRows, ['share', 'teamCarries']);
  const recentShare = shareAgg.weightedGames ? shareAgg.sums.share / shareAgg.weightedGames : null;
  const teamWeightedCarriesPerGame = shareAgg.weightedGames ? shareAgg.sums.teamCarries / shareAgg.weightedGames : null;

  const perGameYards = playerRows.map(r => parseFloat(r.rushing_yards) || 0);
  const mean = perGameYards.reduce((a, b) => a + b, 0) / games;
  const variance = perGameYards.reduce((s, y) => s + (y - mean) ** 2, 0) / games;
  const stdDev = Math.sqrt(variance);

  const last3 = playerRows.slice(0, 3);
  const hotGames = last3.filter(r => (parseFloat(r.rushing_yards) || 0) >= 60).length;

  return {
    games, team, carries, rushYards, stdDev, recentMean: mean, hotGames,
    weightedGames, weightedCarries: sums.carries, weightedRushYards: sums.rushing_yards,
    recentShare, teamWeightedCarriesPerGame,
  };
}

function computeRushDefenseAllowed(teamRows, defTeamEspnAbbr, throughWeek, lastN = 5, toNflverseAbbr) {
  const defTeam = toNflverseAbbr(defTeamEspnAbbr);
  const byGame = byGameTeam(teamRows);

  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const defGames = teamRows
    .filter(r => r.team === defTeam && r.season_type === 'REG' && weekFilter(r))
    .sort((a, b) => Number(b.week) - Number(a.week))
    .slice(0, lastN);

  if (!defGames.length) return null;

  let totalCarriesAllowed = 0, totalYardsAllowed = 0;
  for (const r of defGames) {
    const oppRow = byGame[r.game_id]?.[r.opponent_team];
    if (!oppRow) continue;
    totalCarriesAllowed += parseFloat(oppRow.carries) || 0;
    totalYardsAllowed += parseFloat(oppRow.rushing_yards) || 0;
  }
  if (!totalCarriesAllowed) return null;

  return {
    games: defGames.length,
    ypcAllowed: totalYardsAllowed / totalCarriesAllowed,
    carriesAllowedPerGame: totalCarriesAllowed / defGames.length,
  };
}

function projectRushYards(usage, defAllowed, teamImplied) {
  if (!usage) return null;

  const wCarries = usage.weightedCarries ?? usage.carries;
  const wGames = usage.weightedGames ?? usage.games;
  const wYards = usage.weightedRushYards ?? usage.rushYards;

  // Share-based volume (recent share of team carries × the team's own recent carries/game) is
  // the primary estimate when available — it isolates the player's own role from week-to-week
  // swings in how much the team ran overall. Falls back to the recency-weighted raw average
  // when share data isn't available (e.g. a synthetic usage object in a test).
  const carriesPerGame = (usage.recentShare != null && usage.teamWeightedCarriesPerGame != null)
    ? usage.recentShare * usage.teamWeightedCarriesPerGame
    : wCarries / wGames;
  let ypc = regress(wYards / Math.max(wCarries, 1), LG_YPC, wCarries, K_YPC);

  if (defAllowed) {
    const ratio = defAllowed.ypcAllowed / LG_YPC;
    ypc *= Math.max(0.85, Math.min(1.20, ratio));
  }

  let carries = carriesPerGame;
  if (teamImplied != null) {
    const scriptMult = Math.max(0.90, Math.min(1.15, teamImplied / 22.0));
    carries *= scriptMult;
  }

  const projectedYards = carries * ypc;

  const stdDev = usage.stdDev > 0 ? usage.stdDev : projectedYards * 0.4;
  const floor = Math.max(0, projectedYards - stdDev);
  const ceiling = projectedYards + stdDev;

  return {
    projected: +projectedYards.toFixed(1),
    floor: +floor.toFixed(1),
    ceiling: +ceiling.toFixed(1),
    projCarries: +carries.toFixed(1),
    ypc: +ypc.toFixed(2),
  };
}

function getCI(carries) {
  if (!carries || carries < 1) return { tier: 'low', label: 'LOW', color: 'var(--red)' };
  if (carries >= 60) return { tier: 'high', label: 'HIGH', color: 'var(--green)' };
  if (carries >= 25) return { tier: 'mid', label: 'MID', color: 'var(--amber)' };
  return { tier: 'low', label: 'LOW', color: 'var(--red)' };
}

function getRushSignals(usage, defAllowed, projection) {
  const signals = [
    { key: 'usage',   active: (usage.carries / usage.games) >= 14, label: 'High Usage' },
    { key: 'matchup', active: !!defAllowed && defAllowed.ypcAllowed > LG_YPC * 1.10, label: 'Favorable Matchup' },
    { key: 'hot',     active: usage.hotGames >= 2, label: 'Hot Streak' },
    { key: 'volume',  active: projection.projCarries >= 16, label: 'Bellcow Volume' },
    { key: 'conf',    active: getCI(usage.carries).tier !== 'low', label: 'Sample Confidence' },
  ];
  const count = signals.filter(s => s.active).length;
  const hasConfidence = signals.find(s => s.key === 'conf').active;

  // A badge is a claim worth betting on, so it requires a real sample behind it (hasConfidence)
  // on top of clearing a higher bar of the signal count — thresholds raised from 2/3/4-of-5 to
  // 3/4/5-of-5 after "badge overload" feedback made Best Plays too noisy to use.
  let badge = null;
  if (hasConfidence) {
    if (count >= 5)      badge = { label: '🏆 Elite Play',    color: 'var(--amber)' };
    else if (count >= 4) badge = { label: '⭐ All-Star Play', color: 'var(--blue)' };
    else if (count >= 3) badge = { label: '💡 Value Play',    color: 'var(--purple)' };
  }

  return { signals, count, badge, ci: getCI(usage.carries) };
}

module.exports = { computeRushUsage, computeRushDefenseAllowed, projectRushYards, getRushSignals, getCI, LG_YPC, LG_CARRIES };
