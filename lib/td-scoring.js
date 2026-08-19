// lib/td-scoring.js — Anytime TD probability model
const LG = {
  WR: { tdPerTarget: 0.062, targetShare: 0.14, k: 40 },
  TE: { tdPerTarget: 0.068, targetShare: 0.11, k: 30 },
  RB: { tdPerCarry: 0.032, tdPerTarget: 0.045, carryShare: 0.35, k: 60, kRec: 40 },
};

function regress(actual, lgAvg, sample, k) {
  if (!sample) return lgAvg;
  return (actual * sample + lgAvg * k) / (sample + k);
}

function computePlayerUsage(rows, playerName, throughWeek, lastN = 5) {
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const playerRows = rows
    .filter(r => r.player_display_name === playerName && r.season_type === 'REG' && weekFilter(r))
    .sort((a, b) => Number(b.week) - Number(a.week))
    .slice(0, lastN);

  if (!playerRows.length) return null;

  const sum = (key) => playerRows.reduce((s, r) => s + (parseFloat(r[key]) || 0), 0);
  const games = playerRows.length;
  const position = playerRows[0].position;
  const team = playerRows[0].team;

  const targets = sum('targets'), carries = sum('carries');
  const recTds = sum('receiving_tds'), rushTds = sum('rushing_tds');
  const targetShare = sum('target_share') / games;
  const wopr = sum('wopr') / games;

  const last3 = playerRows.slice(0, 3);
  const recentTdGames = last3.filter(r => (parseFloat(r.receiving_tds) || 0) + (parseFloat(r.rushing_tds) || 0) > 0).length;

  return { games, position, team, targets, carries, recTds, rushTds, targetShare, wopr, touches: targets + carries, recentTdGames };
}

const { byOpponentPosition } = require('./indexing.js');

function computeDefenseAllowedToPosition(playerRows, defTeamEspnAbbr, position, throughWeek, lastN = 5, toNflverseAbbr) {
  const defTeam = toNflverseAbbr(defTeamEspnAbbr);
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;

  // Previously: playerRows.filter(...) over the FULL ~19,000-row array on every call.
  // This function gets called once per candidate per remaining game — hundreds to over a
  // thousand times in a single Season Projections request — so that full scan repeated
  // that many times was very likely the single biggest cost in the whole request. Now it's
  // a lookup into a pre-built index (built once, shared across every call via lib/indexing.js)
  // followed by a filter over just that position's rows against that one opponent — a much
  // smaller subset.
  const candidateRows = byOpponentPosition(playerRows)[defTeam + '|' + position] || [];
  const allowedRows = candidateRows.filter(r => r.season_type === 'REG' && weekFilter(r));

  const byGame = {};
  for (const r of allowedRows) {
    const key = r.game_id;
    const tds = (parseFloat(r.receiving_tds) || 0) + (parseFloat(r.rushing_tds) || 0);
    byGame[key] = (byGame[key] || 0) + tds;
  }
  const games = Object.keys(byGame).sort().slice(-lastN);
  if (!games.length) return null;

  const avgTdsAllowed = games.reduce((s, g) => s + byGame[g], 0) / games.length;
  return { games: games.length, avgTdsAllowed };
}

const LG_TDS_ALLOWED = { WR: 0.9, TE: 0.35, RB: 0.55 };

function anytimeTdProb(usage, defAllowed, teamImplied, ctx = {}) {
  if (!usage) return null;
  const pos = usage.position;
  const anchors = LG[pos];
  if (!anchors) return null;

  let p;
  if (pos === 'RB') {
    const carriesPerGame = usage.carries / usage.games;
    const tdPerCarry = regress(usage.rushTds / Math.max(usage.carries, 1), anchors.tdPerCarry, usage.carries, anchors.k);
    const pRush = 1 - Math.pow(1 - tdPerCarry, carriesPerGame);

    const targetsPerGame = usage.targets / usage.games;
    const tdPerTarget = regress(usage.recTds / Math.max(usage.targets, 1), anchors.tdPerTarget, usage.targets, anchors.kRec);
    const pRec = targetsPerGame > 0 ? 1 - Math.pow(1 - tdPerTarget, targetsPerGame) : 0;

    p = 1 - (1 - pRush) * (1 - pRec);
  } else {
    const targetsPerGame = usage.targets / usage.games;
    const tdPerTarget = regress(usage.recTds / Math.max(usage.targets, 1), anchors.tdPerTarget, usage.targets, anchors.k);
    p = 1 - Math.pow(1 - tdPerTarget, targetsPerGame);
  }

  if (defAllowed) {
    const lgAllowed = LG_TDS_ALLOWED[pos] || 0.6;
    const allowedRatio = defAllowed.avgTdsAllowed / lgAllowed;
    p *= Math.max(0.80, Math.min(1.25, allowedRatio));
  }

  if (teamImplied != null) {
    const lgImplied = 22.0;
    p *= Math.max(0.80, Math.min(1.25, teamImplied / lgImplied));
  }

  if (usage.recentTdGames >= 2) p *= 1.12;
  else if (usage.recentTdGames === 0 && usage.games >= 3) p *= 0.94;

  const raw = p * 100;
  const SOFT_THRESHOLD = 45;
  const CEILING = 65;
  let final;
  if (raw <= SOFT_THRESHOLD) {
    final = raw;
  } else {
    const excess = raw - SOFT_THRESHOLD;
    const maxExcess = CEILING - SOFT_THRESHOLD;
    final = SOFT_THRESHOLD + maxExcess * (1 - Math.exp(-excess / maxExcess));
  }
  return Math.max(1.5, final);
}

function getCI(touches) {
  if (!touches || touches < 1) return { tier: 'low', label: 'LOW', color: 'var(--red)' };
  if (touches >= 60) return { tier: 'high', label: 'HIGH', color: 'var(--green)' };
  if (touches >= 25) return { tier: 'mid', label: 'MID', color: 'var(--amber)' };
  return { tier: 'low', label: 'LOW', color: 'var(--red)' };
}

function getTdSignals(usage, defAllowed, teamModel) {
  const signals = [
    { key: 'usage',   active: usage.position === 'RB' ? (usage.carries / usage.games) >= 12 : (usage.targets / usage.games) >= 6, label: 'High Usage' },
    { key: 'matchup', active: !!defAllowed && defAllowed.avgTdsAllowed > (LG_TDS_ALLOWED[usage.position] || 0.6) * 1.15, label: 'Favorable Matchup' },
    { key: 'streak',  active: usage.recentTdGames >= 2, label: 'Hot Streak' },
    { key: 'script',  active: !!teamModel?.shootoutSignal, label: 'Shootout Game' },
    { key: 'role',    active: usage.position === 'RB' ? usage.rushTds > 0 : usage.wopr >= 0.5, label: 'Featured Role' },
    { key: 'conf',    active: getCI(usage.touches).tier !== 'low', label: 'Sample Confidence' },
  ];
  const count = signals.filter(s => s.active).length;

  let badge = null;
  if (count >= 5)      badge = { label: '🏆 Elite Play',    color: 'var(--amber)' };
  else if (count >= 4) badge = { label: '⭐ All-Star Play', color: 'var(--blue)' };
  else if (count >= 3) badge = { label: '💡 Value Play',    color: 'var(--purple)' };

  return { signals, count, badge, ci: getCI(usage.touches) };
}

module.exports = { computePlayerUsage, computeDefenseAllowedToPosition, anytimeTdProb, getTdSignals, getCI, LG, LG_TDS_ALLOWED };
