// lib/pass-scoring.js — Passing yards projection model
const { byGameTeam } = require('./indexing.js');
const LG_YPA = 7.02;
const K_YPA = 100;

function regress(actual, lgAvg, sample, k) {
  if (!sample) return lgAvg;
  return (actual * sample + lgAvg * k) / (sample + k);
}

function computePassUsage(rows, playerName, teamFilter, throughWeek, lastN = 5) {
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const playerRows = rows
    .filter(r => r.player_display_name === playerName && r.team === teamFilter
      && r.season_type === 'REG' && weekFilter(r) && r.position === 'QB')
    .sort((a, b) => Number(b.week) - Number(a.week))
    .slice(0, lastN);

  if (!playerRows.length) return null;

  const games = playerRows.length;
  const attempts = playerRows.reduce((s, r) => s + (parseFloat(r.attempts) || 0), 0);
  const passYards = playerRows.reduce((s, r) => s + (parseFloat(r.passing_yards) || 0), 0);
  const completions = playerRows.reduce((s, r) => s + (parseFloat(r.completions) || 0), 0);

  const perGameYards = playerRows.map(r => parseFloat(r.passing_yards) || 0);
  const mean = perGameYards.reduce((a, b) => a + b, 0) / games;
  const variance = perGameYards.reduce((s, y) => s + (y - mean) ** 2, 0) / games;
  const stdDev = Math.sqrt(variance);

  const last3 = playerRows.slice(0, 3);
  const hotGames = last3.filter(r => (parseFloat(r.passing_yards) || 0) >= 280).length;

  return { games, team: teamFilter, attempts, passYards, completions, stdDev, recentMean: mean, hotGames };
}

function computePassDefenseAllowed(teamRows, defTeamEspnAbbr, throughWeek, lastN = 5, toNflverseAbbr) {
  const defTeam = toNflverseAbbr(defTeamEspnAbbr);
  const byGame = byGameTeam(teamRows);

  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const defGames = teamRows
    .filter(r => r.team === defTeam && r.season_type === 'REG' && weekFilter(r))
    .sort((a, b) => Number(b.week) - Number(a.week))
    .slice(0, lastN);

  if (!defGames.length) return null;

  let totalAttAllowed = 0, totalYardsAllowed = 0;
  for (const r of defGames) {
    const oppRow = byGame[r.game_id]?.[r.opponent_team];
    if (!oppRow) continue;
    totalAttAllowed += parseFloat(oppRow.attempts) || 0;
    totalYardsAllowed += parseFloat(oppRow.passing_yards) || 0;
  }
  if (!totalAttAllowed) return null;

  return {
    games: defGames.length,
    ypaAllowed: totalYardsAllowed / totalAttAllowed,
    attAllowedPerGame: totalAttAllowed / defGames.length,
  };
}

function projectPassYards(usage, defAllowed, teamImplied, ctx = {}) {
  if (!usage) return null;

  const attemptsPerGame = usage.attempts / usage.games;
  let ypa = regress(usage.passYards / Math.max(usage.attempts, 1), LG_YPA, usage.attempts, K_YPA);

  if (defAllowed) {
    const ratio = defAllowed.ypaAllowed / LG_YPA;
    ypa *= Math.max(0.90, Math.min(1.12, ratio));
  }

  let attempts = attemptsPerGame;
  if (teamImplied != null) {
    const scriptMult = Math.max(0.92, Math.min(1.10, teamImplied / 22.0));
    attempts *= scriptMult;
  }

  if (ctx.weather && !ctx.weather.dome) {
    const w = ctx.weather.w || 0;
    if (w >= 20) ypa *= 0.88;
    else if (w >= 15) ypa *= 0.94;
  }

  const rawProjected = attempts * ypa;

  const SOFT_THRESHOLD = 290;
  const CEILING = 380;
  let projectedYards;
  if (rawProjected <= SOFT_THRESHOLD) {
    projectedYards = rawProjected;
  } else {
    const excess = rawProjected - SOFT_THRESHOLD;
    const maxExcess = CEILING - SOFT_THRESHOLD;
    projectedYards = SOFT_THRESHOLD + maxExcess * (1 - Math.exp(-excess / maxExcess));
  }

  const stdDev = usage.stdDev > 0 ? usage.stdDev : projectedYards * 0.35;
  const floor = Math.max(0, projectedYards - stdDev);
  const ceiling = projectedYards + stdDev;

  return {
    projected: +projectedYards.toFixed(1),
    floor: +floor.toFixed(1),
    ceiling: +ceiling.toFixed(1),
    projAttempts: +attempts.toFixed(1),
    ypa: +ypa.toFixed(2),
  };
}

function getCI(attempts) {
  if (!attempts || attempts < 1) return { tier: 'low', label: 'LOW', color: 'var(--red)' };
  if (attempts >= 120) return { tier: 'high', label: 'HIGH', color: 'var(--green)' };
  if (attempts >= 60) return { tier: 'mid', label: 'MID', color: 'var(--amber)' };
  return { tier: 'low', label: 'LOW', color: 'var(--red)' };
}

function getPassSignals(usage, defAllowed, projection) {
  const signals = [
    { key: 'usage',   active: (usage.attempts / usage.games) >= 32, label: 'High Volume' },
    { key: 'matchup', active: !!defAllowed && defAllowed.ypaAllowed > LG_YPA * 1.10, label: 'Favorable Matchup' },
    { key: 'hot',     active: usage.hotGames >= 2, label: 'Hot Streak' },
    { key: 'script',  active: projection.projAttempts >= 36, label: 'Pass-Heavy Script' },
    { key: 'conf',    active: getCI(usage.attempts).tier !== 'low', label: 'Sample Confidence' },
  ];
  const count = signals.filter(s => s.active).length;

  let badge = null;
  if (count >= 4)      badge = { label: '🏆 Elite Play',    color: 'var(--amber)' };
  else if (count >= 3) badge = { label: '⭐ All-Star Play', color: 'var(--blue)' };
  else if (count >= 2) badge = { label: '💡 Value Play',    color: 'var(--purple)' };

  return { signals, count, badge, ci: getCI(usage.attempts) };
}

module.exports = { computePassUsage, computePassDefenseAllowed, projectPassYards, getPassSignals, getCI, LG_YPA };
