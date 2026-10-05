// lib/grading.js — grades a saved week of predictions against what actually happened, and
// aggregates graded weeks into calibration summaries. Pure functions over already-fetched
// data (no fetching itself beyond the two nflverse calls in gradeWeekPredictions) so the hard
// part — matching predictions to real outcomes and scoring them correctly — is fully unit
// testable without a database.

const { fetchPlayerWeekStats, toNflverseAbbr } = require('./player-stats.js');
const { fetchGames, completedGamesForWeek } = require('./nflverse-games.js');
const { normalizeName } = require('./dfs-projections.js');

const YARDAGE_FIELD = { rush_yds: 'rushing_yards', rec_yds: 'receiving_yards', pass_yds: 'passing_yards' };

// A total-points "hit" has no natural binary line the way a TD prop does (it's a projected
// mean, not a bet against a sportsbook number) — treat "within 7 points" as a reasonable
// proxy for "the model had the game's scoring environment basically right."
const TOTAL_POINTS_HIT_WINDOW = 7;

function gradePlayerProp(p, playerRowsByKey) {
  const teamAbbr = toNflverseAbbr(p.team);
  const row = playerRowsByKey[normalizeName(p.name) + '|' + teamAbbr];
  if (!row) {
    return { ...p, actual: p.propType === 'anytime_td' ? false : null, hit: p.propType === 'anytime_td' ? false : null, note: 'no stat line found this week (inactive, or a name/team mismatch)' };
  }
  if (p.propType === 'anytime_td') {
    const tds = (parseFloat(row.rushing_tds) || 0) + (parseFloat(row.receiving_tds) || 0);
    return { ...p, actual: tds > 0, actualTds: tds, hit: tds > 0 };
  }
  const field = YARDAGE_FIELD[p.propType];
  const actual = parseFloat(row[field]) || 0;
  const hit = (p.floor != null && p.ceiling != null) ? (actual >= p.floor && actual <= p.ceiling) : null;
  return { ...p, actual, error: +(p.prediction - actual).toFixed(1), hit };
}

function gradeGameProp(p, gamesByMatchup) {
  const awayAbbr = toNflverseAbbr(p.opponent), homeAbbr = toNflverseAbbr(p.team);
  const g = gamesByMatchup[awayAbbr + '@' + homeAbbr];
  if (!g) return p; // this specific game hasn't finished yet — leave ungraded
  const awayScore = Number(g.away_score), homeScore = Number(g.home_score);
  if (p.propType === 'game_winner') {
    const actualWinner = homeScore > awayScore ? 'home' : awayScore > homeScore ? 'away' : 'tie';
    const predictedWinner = p.prediction >= 50 ? 'home' : 'away';
    return { ...p, actual: actualWinner, actualScore: `${awayScore}-${homeScore}`, hit: actualWinner === 'tie' ? null : predictedWinner === actualWinner };
  }
  // total_points
  const actualTotal = awayScore + homeScore;
  return { ...p, actual: actualTotal, error: +(p.prediction - actualTotal).toFixed(1), hit: Math.abs(p.prediction - actualTotal) <= TOTAL_POINTS_HIT_WINDOW };
}

// Grades one saved week's predictions against real nflverse results. Games/players whose
// game hasn't been played yet are left ungraded (hit stays whatever it was, i.e. null) rather
// than guessed at — a week can be partially graded if it's mid-slate (e.g. graded right after
// the early Sunday games before SNF/MNF).
async function gradeWeekPredictions(week, year, predictions) {
  const [playerRows, games] = await Promise.all([
    fetchPlayerWeekStats(year),
    fetchGames(),
  ]);
  if (!playerRows) throw new Error('Player stats unavailable for grading');
  if (!games) throw new Error('Game results unavailable for grading');

  const completed = completedGamesForWeek(games, year, week);
  const completedTeams = new Set();
  completed.forEach(g => { completedTeams.add(g.away_team); completedTeams.add(g.home_team); });
  const gamesByMatchup = {};
  completed.forEach(g => { gamesByMatchup[toNflverseAbbr(g.away_team) + '@' + toNflverseAbbr(g.home_team)] = g; });

  const playerRowsByKey = {};
  for (const r of playerRows) {
    if (r.season_type !== 'REG' || Number(r.week) !== Number(week)) continue;
    playerRowsByKey[normalizeName(r.player_display_name) + '|' + r.team] = r;
  }

  const graded = predictions.map(p => {
    if (p.propType === 'game_winner' || p.propType === 'total_points') return gradeGameProp(p, gamesByMatchup);
    if (!completedTeams.has(toNflverseAbbr(p.team))) return p; // that player's game hasn't happened yet
    return gradePlayerProp(p, playerRowsByKey);
  });

  const anyGraded = graded.some(p => 'actual' in p);
  return { graded, fullyGraded: graded.every(p => 'actual' in p), partiallyGraded: anyGraded, summary: summarizeGraded(graded) };
}

function tierOf(badge) {
  if (!badge) return 'none';
  if (badge.includes('Elite')) return 'Elite';
  if (badge.includes('All-Star')) return 'All-Star';
  if (badge.includes('Value')) return 'Value';
  return 'none';
}

function mean(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null; }

function bucketAccuracy(preds) {
  const graded = preds.filter(p => p.hit === true || p.hit === false);
  const hits = graded.filter(p => p.hit === true).length;
  return { n: graded.length, hits, hitRate: graded.length ? +(hits / graded.length * 100).toFixed(1) : null };
}

function bucketError(preds) {
  const graded = preds.filter(p => p.error != null);
  return {
    n: graded.length,
    mae: graded.length ? +mean(graded.map(p => Math.abs(p.error))).toFixed(1) : null,
    bias: graded.length ? +mean(graded.map(p => p.error)).toFixed(1) : null, // + = model over-projects, - = under-projects
    coverageRate: (() => {
      const withLine = graded.filter(p => p.hit === true || p.hit === false);
      return withLine.length ? +(withLine.filter(p => p.hit).length / withLine.length * 100).toFixed(1) : null;
    })(),
  };
}

// Aggregates one or many (already-graded) weeks' predictions into calibration summaries —
// this is the thing the Accuracy tab actually displays, and the whole point of tracking any
// of this: does the model's own confidence signal (badge tier, CI tier) actually correlate
// with real hit rate, and is the yardage model's error centered on zero or systematically
// biased in one direction.
function summarizeGraded(predictions) {
  const td = predictions.filter(p => p.propType === 'anytime_td');
  const rush = predictions.filter(p => p.propType === 'rush_yds');
  const rec = predictions.filter(p => p.propType === 'rec_yds');
  const pass = predictions.filter(p => p.propType === 'pass_yds');
  const winner = predictions.filter(p => p.propType === 'game_winner');
  const total = predictions.filter(p => p.propType === 'total_points');

  const byBadge = {};
  for (const tier of ['Elite', 'All-Star', 'Value', 'none']) byBadge[tier] = bucketAccuracy(td.filter(p => tierOf(p.tier ?? p.badge) === tier));
  const byConfidence = {};
  for (const tier of ['high', 'mid', 'low']) byConfidence[tier] = bucketAccuracy(td.filter(p => (p.ci || '').toLowerCase() === tier));

  return {
    anytimeTd: { ...bucketAccuracy(td), byBadge, byConfidence },
    rushYds: bucketError(rush),
    recYds: bucketError(rec),
    passYds: bucketError(pass),
    gameWinner: bucketAccuracy(winner),
    totalPoints: bucketError(total),
  };
}

module.exports = { gradeWeekPredictions, summarizeGraded, tierOf };
