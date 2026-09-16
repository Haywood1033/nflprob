const LG_EPA_OFF = 0.00;
const LG_EPA_DEF = 0.00;
const LG_PLAYS   = 63.5;
const LG_PPG     = 22.0;
const K_EPA      = 2; // was 5 — verified against real data that 5 crushed the entire league's real EPA variance (std dev 0.206, real range -0.37 to +0.49) down to a 3.8-point implied-points spread across all 32 teams. Real NFL team quality spans closer to 10-14 points (good offenses ~26-30 PPG, bad ones ~15-18 PPG). K=2 is still a real regression toward league average (appropriate given we're only 1 game into the season), just not one that erases nearly all signal.
const K_PACE     = 3;

function regress(actual, lgAvg, games, k) {
  if (games == null || games <= 0) return lgAvg;
  return (actual * games + lgAvg * k) / (games + k);
}

function impliedPoints(off, oppDef, ctx = {}) {
  const gOff = off?.games || 0;
  const gDef = oppDef?.games || 0;

  const epaOff = regress(off?.epaPlayOff ?? LG_EPA_OFF, LG_EPA_OFF, gOff, K_EPA);
  const epaDefAllowed = regress(oppDef?.epaPlayDef ?? LG_EPA_DEF, LG_EPA_DEF, gDef, K_EPA);
  const pace = regress(off?.playsPerGame ?? LG_PLAYS, LG_PLAYS, gOff, K_PACE);

  const netEpa = epaOff + epaDefAllowed;
  let points = LG_PPG + (netEpa * pace * 0.55); // was 0.35 — verified together with K_EPA against real data (see K_EPA comment above)
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

  return {
    homeImplied: +homePts.toFixed(1),
    awayImplied: +awayPts.toFixed(1),
    total, diff, homeWinProb,
    awayWinProb: +(100 - homeWinProb).toFixed(1),
    shootoutSignal: total >= 48,
    lowScoringSignal: total <= 40,
  };
}

module.exports = { impliedPoints, winProbFromDiff, buildGameModel, regress, LG_PPG, LG_PLAYS };
