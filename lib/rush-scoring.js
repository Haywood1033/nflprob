// lib/rush-scoring.js — Rushing yards projection model (step 3a of the build order)
// Unlike anytime TD (a binary event → probability), this is a continuous-yardage
// projection: mean expected yards + a floor/ceiling range, since we have no sportsbook
// line to compute "probability of clearing X" against (free-data-only decision from scoping).
//
// Data verified directly on both nflverse files (no guessing this time):
//   Player file: carries, rushing_yards (direct columns, no derivation needed)
//   Team file:   carries, rushing_yards (offense's own) — opponent's yards ALLOWED per
//                carry is derived via the same game_id/opponent_team lookup technique
//                proven in lib/nflverse.js and lib/td-scoring.js.

const LG_YPC = 4.2;        // league-average yards per carry
const LG_CARRIES = 14.0;   // league-average carries/game, used only as a "High Usage" signal threshold
const K_YPC = 80;          // YPC needs a bigger sample to trust than carry volume

function regress(actual, lgAvg, sample, k) {
  if (!sample) return lgAvg;
  return (actual * sample + lgAvg * k) / (sample + k);
}

// ── Aggregate a player's last-N-game rushing usage ────────────────────────────────
function computeRushUsage(rows, playerName, throughWeek, lastN = 5) {
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const playerRows = rows
    .filter(r => r.player_display_name === playerName && r.season_type === 'REG' && weekFilter(r) && r.position === 'RB')
    .sort((a, b) => Number(b.week) - Number(a.week))
    .slice(0, lastN);

  if (!playerRows.length) return null;

  const games = playerRows.length;
  const carries = playerRows.reduce((s, r) => s + (parseFloat(r.carries) || 0), 0);
  const rushYards = playerRows.reduce((s, r) => s + (parseFloat(r.rushing_yards) || 0), 0);
  const team = playerRows[0].team;

  // Per-game yardage log (for a simple std-dev-based range, not a full distribution fit)
  const perGameYards = playerRows.map(r => parseFloat(r.rushing_yards) || 0);
  const mean = perGameYards.reduce((a, b) => a + b, 0) / games;
  const variance = perGameYards.reduce((s, y) => s + (y - mean) ** 2, 0) / games;
  const stdDev = Math.sqrt(variance);

  const last3 = playerRows.slice(0, 3);
  const hotGames = last3.filter(r => (parseFloat(r.rushing_yards) || 0) >= 60).length;

  return { games, team, carries, rushYards, stdDev, recentMean: mean, hotGames };
}

// ── Opponent rushing yards allowed per carry, via same game_id/opponent lookup ────
function computeRushDefenseAllowed(teamRows, defTeamEspnAbbr, throughWeek, lastN = 5, toNflverseAbbr) {
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

// ── CORE MODEL: projected rushing yards (mean + floor/ceiling) ───────────────────
function projectRushYards(usage, defAllowed, teamImplied) {
  if (!usage) return null;

  // NOTE: carry volume is NOT regressed toward league average. An earlier version
  // treated "3 carries in 5 games" as a small, uncertain sample of a hidden true rate
  // and pulled it toward a starter's workload (~14 carries/game) — but usage/role is
  // directly observed, not noisy evidence of a higher truth. A buried backup's low
  // workload IS his workload; regressing it upward produced nonsense projections
  // (e.g. ~70 projected yards for a player with 3 total carries across 5 games).
  // Only per-touch EFFICIENCY (YPC) gets regressed — a handful of carries genuinely
  // isn't enough to trust someone's true yards-per-carry skill.
  const carriesPerGame = usage.carries / usage.games;
  let ypc = regress(usage.rushYards / Math.max(usage.carries, 1), LG_YPC, usage.carries, K_YPC);

  // ── MATCHUP: opponent YPC allowed vs league avg ──────────────────────────────
  // Tighter clip than the team model's — same reasoning as the TD model: a 5-game
  // defensive sample for yards-per-carry-allowed is noisy.
  if (defAllowed) {
    const ratio = defAllowed.ypcAllowed / LG_YPC;
    ypc *= Math.max(0.85, Math.min(1.20, ratio));
  }

  // ── GAME SCRIPT: team implied points as a mild volume proxy ──────────────────
  // More implied points ≈ more offensive possessions overall, not a strong signal on
  // its own (a team could lean pass-heavy even implied high), so kept modest.
  let carries = carriesPerGame;
  if (teamImplied != null) {
    const scriptMult = Math.max(0.90, Math.min(1.15, teamImplied / 22.0));
    carries *= scriptMult;
  }

  const projectedYards = carries * ypc;

  // Floor/ceiling: use the player's own recent-game std dev if we have one, otherwise
  // a rough default spread. This is NOT a fitted distribution — it's a simple range
  // for display, same "smart floor" spirit as the other models, not a statistical claim.
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

// ── Confidence tier, anchored on carries (same pattern as TD model's touches) ────
function getCI(carries) {
  if (!carries || carries < 1) return { tier: 'low', label: 'LOW', color: 'var(--red)' };
  if (carries >= 60) return { tier: 'high', label: 'HIGH', color: 'var(--green)' };
  if (carries >= 25) return { tier: 'mid', label: 'MID', color: 'var(--amber)' };
  return { tier: 'low', label: 'LOW', color: 'var(--red)' };
}

// ── Signal stack → badge, same thresholds pattern as the TD model ────────────────
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
