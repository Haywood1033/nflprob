// lib/pass-scoring.js — Passing yards projection model (step 3c of the build order)
// QB-specific: unlike rushing/receiving, this is (usually) a ONE-PLAYER-PER-TEAM pool,
// not a multi-candidate one — so the endpoint logic differs (grab the clear starter,
// don't rank a depth chart of backups against him).
//
// Real league anchors, verified directly against the nflverse files (not guessed):
//   Player-level: 7.02 YPA, 64.4% completion rate
//   Team-level:   7.019 YPA (matches closely — good cross-file consistency check)
//
// Same two lessons carried over from rushing/receiving, applied from the start:
//   1. Attempt volume is NOT regressed toward league average — it's an observed role
//      (starter vs backup), not noisy evidence of a hidden true rate.
//   2. Usage aggregation is filtered by TEAM, not just player name — protects against
//      a QB traded/signed elsewhere mid-season getting a cross-team aggregate applied
//      to both teams (same bug class as Tank Bigsby in the rushing model).

const LG_YPA = 7.02;
const K_YPA = 100; // attempts needed to fully trust a QB's own YPA over league avg — passing efficiency is noisier game-to-game than rushing YPC, so this needs a bigger anchor sample

function regress(actual, lgAvg, sample, k) {
  if (!sample) return lgAvg;
  return (actual * sample + lgAvg * k) / (sample + k);
}

// ── Aggregate a QB's last-N-game passing usage, scoped to one team ───────────────
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

// ── Opponent passing yards allowed per attempt, via game_id/opponent lookup ──────
function computePassDefenseAllowed(teamRows, defTeamEspnAbbr, throughWeek, lastN = 5, toNflverseAbbr) {
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

// ── CORE MODEL: projected passing yards (mean + floor/ceiling) ───────────────────
function projectPassYards(usage, defAllowed, teamImplied, ctx = {}) {
  if (!usage) return null;

  // Volume NOT regressed — same reasoning as carries/targets in the other two models.
  const attemptsPerGame = usage.attempts / usage.games;

  // Efficiency (YPA) IS regressed — game-to-game passing efficiency is noisy.
  let ypa = regress(usage.passYards / Math.max(usage.attempts, 1), LG_YPA, usage.attempts, K_YPA);

  // ── MATCHUP: opponent YPA allowed vs league avg ──────────────────────────────
  // Tightened from an earlier [0.85, 1.20] range: that combined with the game-script
  // multiplier below (also tightened) was compounding to a 1.38x stack whenever both
  // happened to be favorable at once — which turned out to be common, not rare, across
  // a real slate. Five different QBs in five different real matchups all landed in a
  // "300+, Elite" tier simultaneously before this fix, which is the same red flag as
  // the anytime TD model's compounding bug: individually reasonable multipliers can
  // still produce systemically unrealistic output when stacked without a check.
  if (defAllowed) {
    const ratio = defAllowed.ypaAllowed / LG_YPA;
    ypa *= Math.max(0.90, Math.min(1.12, ratio));
  }

  // ── GAME SCRIPT: team implied points as a mild volume proxy ──────────────────
  let attempts = attemptsPerGame;
  if (teamImplied != null) {
    const scriptMult = Math.max(0.92, Math.min(1.10, teamImplied / 22.0));
    attempts *= scriptMult;
  }

  // ── WEATHER: wind suppresses passing efficiency more directly than rushing ───
  if (ctx.weather && !ctx.weather.dome) {
    const w = ctx.weather.w || 0;
    if (w >= 20) ypa *= 0.88;
    else if (w >= 15) ypa *= 0.94;
  }

  const rawProjected = attempts * ypa;

  // ── SOFT CEILING ──────────────────────────────────────────────────────────────
  // Real NFL passing days over ~320 yards happen, but they're the exception, not
  // something half a real slate should show simultaneously. Below 290, values pass
  // through unchanged; above it, they're squashed asymptotically toward 380 instead
  // of scaling linearly — so a genuinely exceptional matchup can still stand out,
  // without every plus-matchup game looking identically "elite."
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

// ── Confidence tier, anchored on attempts ─────────────────────────────────────────
function getCI(attempts) {
  if (!attempts || attempts < 1) return { tier: 'low', label: 'LOW', color: 'var(--red)' };
  if (attempts >= 120) return { tier: 'high', label: 'HIGH', color: 'var(--green)' };
  if (attempts >= 60) return { tier: 'mid', label: 'MID', color: 'var(--amber)' };
  return { tier: 'low', label: 'LOW', color: 'var(--red)' };
}

// ── Signal stack → badge, same thresholds pattern as the other two yardage models ─
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
