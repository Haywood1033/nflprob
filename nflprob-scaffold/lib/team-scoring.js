// lib/team-scoring.js — pure functions for the team-level model
// Split out from api/team-model.js so api/props.js can reuse impliedPoints/buildGameModel
// as an input signal for player props (e.g. shootout game = higher prop ceiling).

// ── LEAGUE ANCHORS (2026 season averages — recalibrate after week 1) ──────
const LG_EPA_OFF = 0.00;   // EPA/play, offense, league avg is ~0 by construction
const LG_EPA_DEF = 0.00;   // EPA/play allowed, defense
const LG_PLAYS   = 63.5;   // plays per team per game
const LG_PPG     = 22.0;   // points per game, league avg
const K_EPA      = 5;      // games played to fully trust a team's EPA sample
const K_PACE     = 3;

function regress(actual, lgAvg, games, k) {
  if (games == null || games <= 0) return lgAvg;
  return (actual * games + lgAvg * k) / (games + k);
}

// off/def = computeTeamEfficiency() output for offense's own team / opponent's defense
function impliedPoints(off, oppDef, ctx = {}) {
  const gOff = off?.games || 0;
  const gDef = oppDef?.games || 0;

  const epaOff = regress(off?.epaPlayOff ?? LG_EPA_OFF, LG_EPA_OFF, gOff, K_EPA);
  const epaDefAllowed = regress(oppDef?.epaPlayDef ?? LG_EPA_DEF, LG_EPA_DEF, gDef, K_EPA);
  const pace = regress(off?.playsPerGame ?? LG_PLAYS, LG_PLAYS, gOff, K_PACE);

  const netEpa = epaOff + epaDefAllowed;
  let points = LG_PPG + (netEpa * pace * 0.35);
  points += (pace - LG_PLAYS) * 0.12;

  if (off?.redZoneTdRate != null) {
    points += (off.redZoneTdRate - 0.55) * 8;
  }

  if (ctx.isHome) points += 1.0;

  if (ctx.qbStatus === 'backup') points *= 0.85;
  else if (ctx.qbStatus === 'questionable') points *= 0.95;

  if (ctx.restDays != null) {
    if (ctx.restDays <= 4) points *= 0.96;
    else if (ctx.restDays >= 10) points *= 1.02;
  }

  if (ctx.weather && !ctx.weather.dome) {
    const w = ctx.weather.w || 0;
    if (w >= 20) points *= 0.90;
    else if (w >= 15) points *= 0.95;
    if ((ctx.weather.t ?? 60) <= 25) points *= 0.96;
  }

  return Math.max(10, Math.min(34, points));
}

function winProbFromDiff(diff) {
  const k = 0.15;
  return 1 / (1 + Math.exp(-k * diff));
}

function buildGameModel(homeEff, awayEff, ctx = {}) {
  const homePts = impliedPoints(homeEff, awayEff, { ...ctx, isHome: true,  qbStatus: ctx.homeQbStatus, restDays: ctx.homeRestDays });
  const awayPts = impliedPoints(awayEff, homeEff, { ...ctx, isHome: false, qbStatus: ctx.awayQbStatus, restDays: ctx.awayRestDays });

  const total = +(homePts + awayPts).toFixed(1);
  const diff  = +(homePts - awayPts).toFixed(1);
  const homeWinProb = +(winProbFromDiff(diff) * 100).toFixed(1);

  const shootoutSignal = total >= 48;
  const lowScoringSignal = total <= 40;

  return {
    homeImplied: +homePts.toFixed(1),
    awayImplied: +awayPts.toFixed(1),
    total, diff, homeWinProb,
    awayWinProb: +(100 - homeWinProb).toFixed(1),
    shootoutSignal, lowScoringSignal,
  };
}

module.exports = { impliedPoints, winProbFromDiff, buildGameModel, regress, LG_PPG, LG_PLAYS };
