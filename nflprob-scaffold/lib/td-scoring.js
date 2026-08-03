// lib/td-scoring.js — Anytime TD probability model
// Mirrors hrProb()'s architecture from the HR engine: Bayesian regression toward
// position-average for small samples, additive/multiplicative signal stack, smart floor.
//
// Data available (verified against the live nflverse player-week file):
//   targets, receptions, receiving_tds, target_share, air_yards_share, wopr (pass catchers)
//   carries, rushing_tds (rushers)
// NOT available: snap share, red-zone-specific touches (would need play-by-play with
// yardline_100 — noted as a follow-up, same gap as the team model's red-zone signal).

// ── LEAGUE ANCHORS BY POSITION (2025 season averages — recalibrate after real 2026 results) ──
const LG = {
  WR: { tdPerTarget: 0.062, targetShare: 0.14, k: 40 },
  TE: { tdPerTarget: 0.068, targetShare: 0.11, k: 30 },
  RB: { tdPerCarry: 0.032, tdPerTarget: 0.045, carryShare: 0.35, k: 60, kRec: 40 },
};

function regress(actual, lgAvg, sample, k) {
  if (!sample) return lgAvg;
  return (actual * sample + lgAvg * k) / (sample + k);
}

// ── Aggregate a player's last-N-game usage from player-week rows ─────────────────────
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

  // Recent TD-scoring games (last 3) — used for the "hot streak" signal
  const last3 = playerRows.slice(0, 3);
  const recentTdGames = last3.filter(r => (parseFloat(r.receiving_tds) || 0) + (parseFloat(r.rushing_tds) || 0) > 0).length;

  return {
    games, position, team,
    targets, carries, recTds, rushTds,
    targetShare, wopr,
    touches: targets + carries,
    recentTdGames,
  };
}

// ── Aggregate TDs allowed to a position by a defense, via opponent-row lookup ────────
// (same technique as lib/nflverse.js's team defense-allowed derivation, just at player granularity)
function computeDefenseAllowedToPosition(playerRows, defTeamEspnAbbr, position, throughWeek, lastN = 5, toNflverseAbbr) {
  const defTeam = toNflverseAbbr(defTeamEspnAbbr);
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;

  // All opposing-position rows played AGAINST this defense
  const allowedRows = playerRows.filter(r =>
    r.opponent_team === defTeam && r.position === position && r.season_type === 'REG' && weekFilter(r)
  );

  // Group by game to get "TDs allowed to this position per game"
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

// League-average TDs allowed per position per game (rough anchors, recalibrate after real data)
const LG_TDS_ALLOWED = { WR: 0.9, TE: 0.35, RB: 0.55 };

// ── CORE MODEL ────────────────────────────────────────────────────────────────────
function anytimeTdProb(usage, defAllowed, teamImplied, ctx = {}) {
  if (!usage) return null;
  const pos = usage.position;
  const anchors = LG[pos];
  if (!anchors) return null; // QBs handled separately (rushing TD only, different model)

  let p;
  if (pos === 'RB') {
    const carriesPerGame = usage.carries / usage.games;
    const tdPerCarry = regress(usage.rushTds / Math.max(usage.carries, 1), anchors.tdPerCarry, usage.carries, anchors.k);
    const pRush = 1 - Math.pow(1 - tdPerCarry, carriesPerGame);

    // Receiving TD chance for pass-catching backs — combined via complementary probability,
    // NOT added on top (an earlier version added these directly and blew past the cap for
    // three-down backs like a workhorse RB with real receiving TD production).
    const targetsPerGame = usage.targets / usage.games;
    const tdPerTarget = regress(usage.recTds / Math.max(usage.targets, 1), anchors.tdPerTarget, usage.targets, anchors.kRec);
    const pRec = targetsPerGame > 0 ? 1 - Math.pow(1 - tdPerTarget, targetsPerGame) : 0;

    p = 1 - (1 - pRush) * (1 - pRec);
  } else {
    // WR / TE
    const targetsPerGame = usage.targets / usage.games;
    const tdPerTarget = regress(usage.recTds / Math.max(usage.targets, 1), anchors.tdPerTarget, usage.targets, anchors.k);
    p = 1 - Math.pow(1 - tdPerTarget, targetsPerGame);
    // NOTE: deliberately NOT also multiplying by wopr here — wopr (weighted opportunity
    // rating) is highly correlated with target volume, which already drives the base rate
    // above. Stacking both double-counted the same "opportunity" signal and pushed every
    // high-volume player toward the cap. Target share/volume alone is the opportunity signal;
    // tdPerTarget alone is the finishing-quality signal. Kept separate.
  }

  // ── MATCHUP: opponent TDs allowed to this position vs league avg ──────────────
  // Clip range is deliberately tighter than the team model's (which has bigger samples) —
  // a 5-game defensive sample for "TDs allowed to one position" is noisy, and letting it
  // swing a full ±40% was compounding with every other multiplier below to push volume
  // players straight to the cap.
  if (defAllowed) {
    const lgAllowed = LG_TDS_ALLOWED[pos] || 0.6;
    const allowedRatio = defAllowed.avgTdsAllowed / lgAllowed;
    p *= Math.max(0.80, Math.min(1.25, allowedRatio));
  }

  // ── GAME SCRIPT: team implied points from the team-level model ────────────────
  if (teamImplied != null) {
    const lgImplied = 22.0;
    p *= Math.max(0.80, Math.min(1.25, teamImplied / lgImplied));
  }

  // ── HOT STREAK: TD in 2+ of last 3 games ───────────────────────────────────────
  if (usage.recentTdGames >= 2) p *= 1.12;
  else if (usage.recentTdGames === 0 && usage.games >= 3) p *= 0.94;

  // Smart floor/cap
  return Math.max(1.5, Math.min(65, p * 100));
}

// ── Wilson-score-style confidence tier, anchored on touches instead of PA ──
function getCI(touches) {
  if (!touches || touches < 1) return { tier: 'low', label: 'LOW', color: 'var(--red)' };
  if (touches >= 60) return { tier: 'high', label: 'HIGH', color: 'var(--green)' };
  if (touches >= 25) return { tier: 'mid', label: 'MID', color: 'var(--amber)' };
  return { tier: 'low', label: 'LOW', color: 'var(--red)' };
}

// ── Signal stack → badge, mirroring the HR engine's Elite/All-Star/Value thresholds ──
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
