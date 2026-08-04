// lib/rec-scoring.js — Receiving yards projection model (step 3b of the build order)
// Same shape as lib/rush-scoring.js: continuous-yardage projection (mean + floor/ceiling),
// not a probability, since there's no sportsbook line to grade against (free-data-only
// decision from scoping).
//
// Real league anchors computed directly from the nflverse player-week file, not guessed:
//   WR: 7.89 yds/target, 62.4% catch rate, 12.65 yds/reception
//   TE: 7.33 yds/target, 72.3% catch rate, 10.14 yds/reception
// (RB receiving is handled separately if/when we build a receiving-back view — this
// model is WR/TE only, matching how receiving-yard props are typically offered.)
//
// Two lessons carried over from the rushing model, applied from the start this time:
//   1. Usage volume (targets/game) is NOT regressed toward league average — it's a
//      directly observed role, not a noisy sample of a hidden "true" rate (see the
//      Will Shipley bug in rush-scoring.js for why this matters).
//   2. Usage aggregation is filtered by TEAM, not just player name — a player traded
//      mid-season must not get his cross-team aggregate applied to both teams' candidate
//      pools (see the Tank Bigsby bug in rush-props.js for why this matters).

const LG_YPT = { WR: 7.89, TE: 7.33 };
const K_YPT = 60; // targets needed to fully trust a receiver's own YPT over league avg

function regress(actual, lgAvg, sample, k) {
  if (!sample) return lgAvg;
  return (actual * sample + lgAvg * k) / (sample + k);
}

// ── Aggregate a player's last-N-game receiving usage, scoped to one team ─────────
function computeRecUsage(rows, playerName, teamFilter, throughWeek, lastN = 5) {
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const playerRows = rows
    .filter(r => r.player_display_name === playerName && r.team === teamFilter
      && r.season_type === 'REG' && weekFilter(r) && (r.position === 'WR' || r.position === 'TE'))
    .sort((a, b) => Number(b.week) - Number(a.week))
    .slice(0, lastN);

  if (!playerRows.length) return null;

  const games = playerRows.length;
  const position = playerRows[0].position;
  const targets = playerRows.reduce((s, r) => s + (parseFloat(r.targets) || 0), 0);
  const recYards = playerRows.reduce((s, r) => s + (parseFloat(r.receiving_yards) || 0), 0);
  const receptions = playerRows.reduce((s, r) => s + (parseFloat(r.receptions) || 0), 0);

  const perGameYards = playerRows.map(r => parseFloat(r.receiving_yards) || 0);
  const mean = perGameYards.reduce((a, b) => a + b, 0) / games;
  const variance = perGameYards.reduce((s, y) => s + (y - mean) ** 2, 0) / games;
  const stdDev = Math.sqrt(variance);

  const last3 = playerRows.slice(0, 3);
  const hotGames = last3.filter(r => (parseFloat(r.receiving_yards) || 0) >= 75).length;

  return { games, team: teamFilter, position, targets, recYards, receptions, stdDev, recentMean: mean, hotGames };
}

// ── Opponent receiving yards allowed per target, via game_id/opponent lookup ─────
function computeRecDefenseAllowed(teamRows, defTeamEspnAbbr, throughWeek, lastN = 5, toNflverseAbbr) {
  const defTeam = toNflverseAbbr(defTeamEspnAbbr);
  const byGame = {};
  for (const r of teamRows) {
    if (!byGame[r.game_id]) byGame[r.game_id] = {};
    byGame[r.game_id][r.team] = r;
  }

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

// ── CORE MODEL: projected receiving yards (mean + floor/ceiling) ─────────────────
function projectRecYards(usage, defAllowed, teamImplied) {
  if (!usage) return null;
  const lgYpt = LG_YPT[usage.position] || 7.6;

  // Volume NOT regressed — same reasoning as carries in the rushing model.
  const targetsPerGame = usage.targets / usage.games;

  // Efficiency (yards/target) IS regressed — a handful of targets doesn't reveal true skill.
  let ypt = regress(usage.recYards / Math.max(usage.targets, 1), lgYpt, usage.targets, K_YPT);

  // ── MATCHUP: opponent YPT allowed vs league avg ──────────────────────────────
  if (defAllowed) {
    const ratio = defAllowed.yptAllowed / lgYpt;
    ypt *= Math.max(0.85, Math.min(1.20, ratio));
  }

  // ── GAME SCRIPT: team implied points as a mild volume proxy ──────────────────
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

// ── Confidence tier, anchored on targets ──────────────────────────────────────────
function getCI(targets) {
  if (!targets || targets < 1) return { tier: 'low', label: 'LOW', color: 'var(--red)' };
  if (targets >= 40) return { tier: 'high', label: 'HIGH', color: 'var(--green)' };
  if (targets >= 18) return { tier: 'mid', label: 'MID', color: 'var(--amber)' };
  return { tier: 'low', label: 'LOW', color: 'var(--red)' };
}

// ── Signal stack → badge, same thresholds pattern as the rushing/TD models ───────
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

  let badge = null;
  if (count >= 4)      badge = { label: '🏆 Elite Play',    color: 'var(--amber)' };
  else if (count >= 3) badge = { label: '⭐ All-Star Play', color: 'var(--blue)' };
  else if (count >= 2) badge = { label: '💡 Value Play',    color: 'var(--purple)' };

  return { signals, count, badge, ci: getCI(usage.targets) };
}

module.exports = { computeRecUsage, computeRecDefenseAllowed, projectRecYards, getRecSignals, getCI, LG_YPT };
