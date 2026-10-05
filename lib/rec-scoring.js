// lib/rec-scoring.js — Receiving yards projection model
const { byGameTeam } = require('./indexing.js');
const { recentGames, weightedAgg } = require('./recency-window.js');
const LG_YPT = { WR: 7.89, TE: 7.33 };
const K_YPT = 60;

function regress(actual, lgAvg, sample, k) {
  if (!sample) return lgAvg;
  return (actual * sample + lgAvg * k) / (sample + k);
}

function computeRecUsage(rows, playerName, teamFilter, throughWeek, lastN = 5) {
  const candidateRows = rows.filter(r => r.player_display_name === playerName && r.team === teamFilter
    && r.season_type === 'REG' && (r.position === 'WR' || r.position === 'TE'));
  const playerRows = recentGames(candidateRows, throughWeek, lastN);

  if (!playerRows.length) return null;

  const games = playerRows.length;
  const position = playerRows[0].position;
  const targets = playerRows.reduce((s, r) => s + (parseFloat(r.targets) || 0), 0);
  const recYards = playerRows.reduce((s, r) => s + (parseFloat(r.receiving_yards) || 0), 0);
  const receptions = playerRows.reduce((s, r) => s + (parseFloat(r.receptions) || 0), 0);

  const { weightedGames, sums } = weightedAgg(playerRows, ['targets', 'receiving_yards']);

  // Target SHARE of the team's own total, recency-weighted the same way — distinguishes "this
  // player's own role shrank" from "the team just threw less that particular week" (game
  // script, weather), which a raw per-game target count can't tell apart on its own.
  const teamTargetsByWeek = {};
  rows.filter(r => r.team === teamFilter && r.season_type === 'REG' && (r.position === 'WR' || r.position === 'TE' || r.position === 'RB'))
    .forEach(r => { teamTargetsByWeek[r.week] = (teamTargetsByWeek[r.week] || 0) + (parseFloat(r.targets) || 0); });
  const shareRows = playerRows
    .map(r => ({ week: r.week, share: teamTargetsByWeek[r.week] ? (parseFloat(r.targets) || 0) / teamTargetsByWeek[r.week] : null, teamTargets: teamTargetsByWeek[r.week] || 0 }))
    .filter(r => r.share != null);
  const shareAgg = weightedAgg(shareRows, ['share', 'teamTargets']);
  const recentShare = shareAgg.weightedGames ? shareAgg.sums.share / shareAgg.weightedGames : null;
  const teamWeightedTargetsPerGame = shareAgg.weightedGames ? shareAgg.sums.teamTargets / shareAgg.weightedGames : null;

  const perGameYards = playerRows.map(r => parseFloat(r.receiving_yards) || 0);
  const mean = perGameYards.reduce((a, b) => a + b, 0) / games;
  const variance = perGameYards.reduce((s, y) => s + (y - mean) ** 2, 0) / games;
  const stdDev = Math.sqrt(variance);

  const last3 = playerRows.slice(0, 3);
  const hotGames = last3.filter(r => (parseFloat(r.receiving_yards) || 0) >= 75).length;

  return {
    games, team: teamFilter, position, targets, recYards, receptions, stdDev, recentMean: mean, hotGames,
    weightedGames, weightedTargets: sums.targets, weightedRecYards: sums.receiving_yards,
    recentShare, teamWeightedTargetsPerGame,
  };
}

function computeRecDefenseAllowed(teamRows, defTeamEspnAbbr, throughWeek, lastN = 5, toNflverseAbbr) {
  const defTeam = toNflverseAbbr(defTeamEspnAbbr);
  const byGame = byGameTeam(teamRows);

  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const defGames = teamRows
    .filter(r => r.team === defTeam && r.season_type === 'REG' && weekFilter(r))
    .sort((a, b) => Number(b.week) - Number(a.week))
    .slice(0, lastN);

  if (!defGames.length) return null;

  let totalTargetsAllowed = 0, totalYardsAllowed = 0;
  for (const r of defGames) {
    const oppRow = byGame[r.game_id]?.[r.opponent_team];
    if (!oppRow) continue;
    totalTargetsAllowed += parseFloat(oppRow.targets) || 0;
    totalYardsAllowed += parseFloat(oppRow.receiving_yards) || 0;
  }
  if (!totalTargetsAllowed) return null;

  return {
    games: defGames.length,
    yptAllowed: totalYardsAllowed / totalTargetsAllowed,
    targetsAllowedPerGame: totalTargetsAllowed / defGames.length,
  };
}

function projectRecYards(usage, defAllowed, teamImplied) {
  if (!usage) return null;
  const lgYpt = LG_YPT[usage.position] || 7.6;

  const wTargets = usage.weightedTargets ?? usage.targets;
  const wGames = usage.weightedGames ?? usage.games;
  const wYards = usage.weightedRecYards ?? usage.recYards;

  // Share-based volume (recent share of team targets × the team's own recent targets/game) is
  // the primary estimate when available — see rush-scoring.js's projectRushYards for the same
  // reasoning. Falls back to the recency-weighted raw average otherwise.
  const targetsPerGame = (usage.recentShare != null && usage.teamWeightedTargetsPerGame != null)
    ? usage.recentShare * usage.teamWeightedTargetsPerGame
    : wTargets / wGames;
  let ypt = regress(wYards / Math.max(wTargets, 1), lgYpt, wTargets, K_YPT);

  if (defAllowed) {
    const ratio = defAllowed.yptAllowed / lgYpt;
    ypt *= Math.max(0.85, Math.min(1.20, ratio));
  }

  let targets = targetsPerGame;
  if (teamImplied != null) {
    const scriptMult = Math.max(0.90, Math.min(1.15, teamImplied / 22.0));
    targets *= scriptMult;
  }

  const projectedYards = targets * ypt;

  const stdDev = usage.stdDev > 0 ? usage.stdDev : projectedYards * 0.4;
  const floor = Math.max(0, projectedYards - stdDev);
  const ceiling = projectedYards + stdDev;

  return {
    projected: +projectedYards.toFixed(1),
    floor: +floor.toFixed(1),
    ceiling: +ceiling.toFixed(1),
    projTargets: +targets.toFixed(1),
    ypt: +ypt.toFixed(2),
  };
}

function getCI(targets) {
  if (!targets || targets < 1) return { tier: 'low', label: 'LOW', color: 'var(--red)' };
  if (targets >= 40) return { tier: 'high', label: 'HIGH', color: 'var(--green)' };
  if (targets >= 18) return { tier: 'mid', label: 'MID', color: 'var(--amber)' };
  return { tier: 'low', label: 'LOW', color: 'var(--red)' };
}

function getRecSignals(usage, defAllowed, projection) {
  const usageThreshold = usage.position === 'WR' ? 7 : 5;
  const signals = [
    { key: 'usage',   active: (usage.targets / usage.games) >= usageThreshold, label: 'High Usage' },
    { key: 'matchup', active: !!defAllowed && defAllowed.yptAllowed > (LG_YPT[usage.position] || 7.6) * 1.10, label: 'Favorable Matchup' },
    { key: 'hot',     active: usage.hotGames >= 2, label: 'Hot Streak' },
    { key: 'volume',  active: projection.projTargets >= 8, label: 'Featured Target' },
    { key: 'conf',    active: getCI(usage.targets).tier !== 'low', label: 'Sample Confidence' },
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

  return { signals, count, badge, ci: getCI(usage.targets) };
}

module.exports = { computeRecUsage, computeRecDefenseAllowed, projectRecYards, getRecSignals, getCI, LG_YPT };
