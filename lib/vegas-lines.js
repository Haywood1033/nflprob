// lib/vegas-lines.js — real market lines (spread/total/moneyline), real rest days, and
// stadium roof/surface, all from nflverse's schedules release (same file lib/nflverse-games.js
// already fetches for grading, so this adds no new fetch cost).
//
// VERIFIED live against the real file: betting columns (spread_line/total_line/moneylines)
// are populated roughly from the current week through ~1 week out, and genuinely blank for
// games further in the future — that's the file reflecting real market reality (no book has
// posted a number yet), not a parsing bug. away_rest/home_rest and roof/surface are populated
// for every week, including far-future ones, since those come from the schedule itself.
//
// SIGN CONVENTION (derived from real rows, since nflverse's own docs are easy to misread):
// spread_line is the AWAY team's spread as a bettor would write it — negative means the away
// team is favored by that many points, positive means the away team is the underdog (i.e. the
// home team is favored). Verified against two real 2026 rows:
//   2026_04_PIT_CLE: spread_line=-2.5, away(PIT) moneyline=-148 (favorite)   → away favored ✓.
//   2026_04_NE_BUF:  spread_line=7,    away(NE)  moneyline=+275 (underdog)  → away underdog ✓.
const { fetchGames } = require('./nflverse-games.js');
const { toNflverseAbbr } = require('./nflverse.js');

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function findGameRow(games, season, week, awayAbbr, homeAbbr) {
  const away = toNflverseAbbr(awayAbbr), home = toNflverseAbbr(homeAbbr);
  return games.find(g =>
    Number(g.season) === Number(season) &&
    Number(g.week) === Number(week) &&
    g.game_type === 'REG' &&
    g.away_team === away && g.home_team === home
  ) || null;
}

// Classic NFL margin-distribution clusters (3 and 7 dominate; 6/10/4/1/14 cover most of the
// rest of the long tail). A line sitting within half a point of one of these means a single
// score swings the bet across the number — real "hook" risk, independent of which side you're
// on.
const KEY_NUMBERS = [3, 7, 6, 10, 4, 1, 14];
function nearestKeyNumber(absMargin) {
  let nearest = null, dist = Infinity;
  for (const k of KEY_NUMBERS) {
    const d = Math.abs(absMargin - k);
    if (d < dist) { dist = d; nearest = k; }
  }
  return { nearestKeyNumber: nearest, distance: +dist.toFixed(1) };
}
function keyNumberRisk(spreadLine) {
  if (spreadLine == null) return null;
  const { nearestKeyNumber: k, distance } = nearestKeyNumber(Math.abs(spreadLine));
  return { nearestKeyNumber: k, distance, onHook: distance <= 0.5 };
}

// A standard 6-point teaser moves the line 6 points in the bettor's favor on each leg. If that
// shift carries the spread across (not just near) a key number, the teaser is "crossing" one of
// the real clusters where margins pile up — the entire reason teasers built around 3-and-7
// crossings are a known structural edge rather than just free points.
const TEASER_POINTS = 6;
function teaserCrossings(spreadLine, points = TEASER_POINTS) {
  if (spreadLine == null) return [];
  // Teasing always buys points toward the underdog side regardless of which team you bet, so
  // model it directionlessly: the number shifts by `points` away from zero on the favorite's
  // side. Concretely: shift the raw line by -points (bettor takes the favored side cheaper) AND
  // by +points (bettor takes the dog with more cushion), and report any key number strictly
  // between the pre- and post-tease line in either direction.
  const shifted = [spreadLine - points, spreadLine + points];
  const crossed = [];
  for (const end of shifted) {
    const lo = Math.min(spreadLine, end), hi = Math.max(spreadLine, end);
    for (const k of KEY_NUMBERS) {
      if ((k > lo && k < hi) || (-k > lo && -k < hi)) crossed.push(k);
    }
  }
  return [...new Set(crossed)].sort((a, b) => a - b);
}

// A double-digit market spread means the book itself expects a lopsided game — exactly when
// backup-tier usage (garbage-time receptions, mop-up carries) gets noisy relative to what the
// base model's usage-rate signals assume from a competitive-game sample. This is a confidence
// flag surfaced alongside a projection, not a change to the projection itself.
function blowoutRisk(spreadLine) {
  if (spreadLine == null) return null;
  const abs = Math.abs(spreadLine);
  if (abs >= 13.5) return 'high';
  if (abs >= 9.5) return 'moderate';
  return null;
}

function getMarketContext(games, season, week, awayAbbr, homeAbbr) {
  if (!games) return { available: false };
  const row = findGameRow(games, season, week, awayAbbr, homeAbbr);
  if (!row) return { available: false };

  const spreadLine = num(row.spread_line);
  const totalLine = num(row.total_line);

  return {
    available: spreadLine != null || totalLine != null,
    spreadLine, totalLine,
    awaySpread: spreadLine,
    homeSpread: spreadLine != null ? -spreadLine : null,
    awayMoneyline: num(row.away_moneyline),
    homeMoneyline: num(row.home_moneyline),
    awayRestDays: num(row.away_rest),
    homeRestDays: num(row.home_rest),
    divGame: row.div_game === '1',
    roof: row.roof || null,
    surface: row.surface || null,
    awayQbName: row.away_qb_name || null,
    homeQbName: row.home_qb_name || null,
    keyNumber: keyNumberRisk(spreadLine),
    blowoutRisk: blowoutRisk(spreadLine),
    teaserCrossings: teaserCrossings(spreadLine),
  };
}

module.exports = { fetchGames, getMarketContext, keyNumberRisk, blowoutRisk, teaserCrossings, findGameRow };
