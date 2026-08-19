// lib/rush-scoring.js — Rushing yards projection model
const { byGameTeam } = require('./indexing.js');
const LG_YPC = 4.2;
const LG_CARRIES = 14.0;
const K_YPC = 80;

function regress(actual, lgAvg, sample, k) {
  if (!sample) return lgAvg;
  return (actual * sample + lgAvg * k) / (sample + k);
}

function computeRushUsage(rows, playerName, teamFilter, throughWeek, lastN = 5) {
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const playerRows = rows
    .filter(r => r.player_display_name === playerName && r.team === teamFilter && r.season_type === 'REG' && weekFilter(r) && r.position === 'RB')
    .sort((a, b) => Number(b.week) - Number(a.week))
    .slice(0, lastN);

  if (!playerRows.length) return null;

  const games = playerRows.length;
  const carries = playerRows.reduce((s, r) => s + (parseFloat(r.carries) || 0), 0);
  const rushYards = playerRows.reduce((s, r) => s + (parseFloat(r.rushing_yards) || 0), 0);
  const team = playerRows[0].team;

  const perGameYards = playerRows.map(r => parseFloat(r.rushing_yards) || 0);
  const mean = perGameYards.reduce((a, b) => a + b, 0) / games;
  const variance = perGameYards.reduce((s, y) => s + (y - mean) ** 2, 0) / games;
  const stdDev = Math.sqrt(variance);

  const last3 = playerRows.slice(0, 3);
  const hotGames = last3.filter(r => (parseFloat(r.rushing_yards) || 0) >= 60).length;

  return { games, team, carries, rushYards, stdDev, recentMean: mean, hotGames };
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

  const carriesPerGame = usage.carries / usage.games;
  let ypc = regress(usage.rushYards / Math.max(usage.carries, 1), LG_YPC, usage.carries, K_YPC);

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

  let badge = null;
  if (count >= 4)      badge = { label: '🏆 Elite Play',    color: 'var(--amber)' };
  else if (count >= 3) badge = { label: '⭐ All-Star Play', color: 'var(--blue)' };
  else if (count >= 2) badge = { label: '💡 Value Play',    color: 'var(--purple)' };

  return { signals, count, badge, ci: getCI(usage.carries) };
}

module.exports = { computeRushUsage, computeRushDefenseAllowed, projectRushYards, getRushSignals, getCI, LG_YPC, LG_CARRIES };
