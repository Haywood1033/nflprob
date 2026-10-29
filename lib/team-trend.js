// lib/team-trend.js — each team's recent games for the Slate card charts: points for/against
// (nflverse schedules) and offensive / defensive EPA per play (nflverse team-week rows, the
// same rows the game model reads). Purely additive: nothing here feeds the game model.

const { toNflverseAbbr } = require('./nflverse.js');
const num = v => parseFloat(v) || 0;

function epaPerPlay(row) {
  const plays = num(row.attempts) + num(row.carries);
  return plays ? (num(row.passing_epa) + num(row.rushing_epa)) / plays : null;
}

// teamRows: nflverse team-week rows · games: nflverse schedule rows (may be null) · espnAbbr ·
// season · throughWeek. Returns oldest → newest, at most `n` games.
function teamTrend(teamRows, games, espnAbbr, season, throughWeek, n = 6) {
  if (!teamRows?.length) return null;
  const team = toNflverseAbbr(espnAbbr);
  const byGame = new Map();
  for (const r of teamRows) {
    if (r.season_type !== 'REG') continue;
    if (!byGame.has(r.game_id)) byGame.set(r.game_id, {});
    byGame.get(r.game_id)[r.team] = r;
  }
  const mine = teamRows
    .filter(r => r.team === team && r.season_type === 'REG' && Number(r.week) <= throughWeek && Number(r.season || season) === Number(season))
    .sort((a, b) => Number(a.week) - Number(b.week))
    .slice(-n);
  if (!mine.length) return null;
  const sched = new Map((games || []).filter(g => Number(g.season) === Number(season)).map(g => [g.game_id, g]));
  return mine.map(r => {
    const opp = byGame.get(r.game_id)?.[r.opponent_team];
    const g = sched.get(r.game_id);
    const home = g ? g.home_team === team : null;
    const pf = g && g.home_score !== '' ? num(home ? g.home_score : g.away_score) : null;
    const pa = g && g.home_score !== '' ? num(home ? g.away_score : g.home_score) : null;
    const off = epaPerPlay(r), def = opp ? epaPerPlay(opp) : null;
    return {
      week: Number(r.week), opp: r.opponent_team,
      pf, pa,
      epaOff: off === null ? null : Math.round(off * 1000) / 1000,
      epaDef: def === null ? null : Math.round(def * 1000) / 1000,
    };
  });
}

module.exports = { teamTrend };
