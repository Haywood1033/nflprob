// lib/player-detail.js — the evidence behind a prop projection, for the player panel: the last
// eight games (volume, yards, TDs, share of the team's volume) and how the opponent ranks
// against the player's position. Purely additive: it reads the same nflverse rows the props
// endpoints already fetched and never feeds back into any projection, probability or signal.

const MARKETS = {
  rush: { vol: r => num(r.carries), yds: r => num(r.rushing_yards), tds: r => num(r.rushing_tds), volLabel: 'Carries', sharePool: ['RB'], shareOf: r => num(r.carries) },
  rec:  { vol: r => num(r.targets), yds: r => num(r.receiving_yards), tds: r => num(r.receiving_tds), volLabel: 'Targets', sharePool: null, shareOf: r => num(r.targets) },
  pass: { vol: r => num(r.attempts), yds: r => num(r.passing_yards), tds: r => num(r.passing_tds), volLabel: 'Attempts', sharePool: null, shareOf: null },
  td:   { vol: r => num(r.carries) + num(r.targets), yds: r => num(r.rushing_yards) + num(r.receiving_yards), tds: r => num(r.rushing_tds) + num(r.receiving_tds), volLabel: 'Touches', sharePool: null, shareOf: r => num(r.carries) + num(r.targets) },
};
const num = v => parseFloat(v) || 0;
const r2 = v => Math.round(v * 1000) / 1000;

// What "allowed to the position" means per market, for the opponent rank.
const ALLOWED = {
  rush: { pos: () => ['RB'], val: r => num(r.rushing_yards), label: 'rushing yards allowed to RBs' },
  rec:  { pos: p => [p], val: r => num(r.receiving_yards), label: p => `receiving yards allowed to ${p}s` },
  pass: { pos: () => ['QB'], val: r => num(r.passing_yards), label: 'passing yards allowed' },
  td:   { pos: p => [p], val: r => num(r.rushing_tds) + num(r.receiving_tds), label: p => `TDs allowed to ${p}s` },
};

const rankMemo = new WeakMap(); // rows array -> Map(key -> ranking)

// Per-game average allowed by every defense, ranked 1 = most allowed (the friendliest matchup).
function defenseRanking(rows, market, position, throughWeek) {
  let byKey = rankMemo.get(rows);
  if (!byKey) { byKey = new Map(); rankMemo.set(rows, byKey); }
  const key = `${market}|${position}|${throughWeek}`;
  if (byKey.has(key)) return byKey.get(key);
  const a = ALLOWED[market];
  const positions = a.pos(position);
  const perGame = new Map(); // defense -> Map(game_id -> total)
  for (const r of rows) {
    if (r.season_type !== 'REG' || Number(r.week) > throughWeek || !positions.includes(r.position) || !r.opponent_team) continue;
    if (!perGame.has(r.opponent_team)) perGame.set(r.opponent_team, new Map());
    const g = perGame.get(r.opponent_team);
    g.set(r.game_id, (g.get(r.game_id) || 0) + a.val(r));
  }
  const table = [...perGame.entries()].map(([team, games]) => ({ team, perGame: [...games.values()].reduce((s, v) => s + v, 0) / games.size }))
    .sort((x, y) => y.perGame - x.perGame);
  const ranking = { of: table.length, byTeam: new Map(table.map((t, i) => [t.team, { rank: i + 1, perGame: t.perGame }])) };
  byKey.set(key, ranking);
  return ranking;
}

// rows: nflverse player-week rows · name/team: the player as the props endpoint resolved them
// (team = nflverse abbr, or null when the endpoint matches by name alone) · oppAbbr: this
// week's opponent in nflverse form · market: rush | rec | pass | td.
function playerDetail(rows, { name, team = null, position = null, oppAbbr, market, throughWeek, games = 8 }) {
  const m = MARKETS[market];
  if (!m || !rows?.length) return null;
  const mine = rows
    .filter(r => r.player_display_name === name && (!team || r.team === team) && r.season_type === 'REG' && Number(r.week) <= throughWeek)
    .sort((a, b) => Number(a.week) - Number(b.week));
  if (!mine.length) return null;
  const pos = position || mine[mine.length - 1].position;

  // Team volume per game for the share line (same pool conventions as the scoring libs).
  const teamVol = new Map();
  if (m.shareOf) {
    for (const r of rows) {
      if (r.season_type !== 'REG' || Number(r.week) > throughWeek) continue;
      if (m.sharePool && !m.sharePool.includes(r.position)) continue;
      const k = `${r.team}|${r.game_id}`;
      teamVol.set(k, (teamVol.get(k) || 0) + m.shareOf(r));
    }
  }
  const log = mine.slice(-games).map(r => {
    const tv = teamVol.get(`${r.team}|${r.game_id}`);
    return { week: Number(r.week), opp: r.opponent_team, vol: m.vol(r), yds: m.yds(r), tds: m.tds(r), share: m.shareOf && tv ? r2(m.shareOf(r) / tv) : null };
  });
  const shares = log.map(g => g.share).filter(v => v !== null);
  const avg = a => (a.length ? r2(a.reduce((s, v) => s + v, 0) / a.length) : null);

  const ranking = defenseRanking(rows, market, pos, throughWeek);
  const opp = ranking.byTeam.get(oppAbbr) || null;
  const lbl = ALLOWED[market].label;
  return {
    market, position: pos, volLabel: m.volLabel,
    games: log,
    shareL3: avg(shares.slice(-3)), shareSeason: avg(shares),
    oppRank: opp ? { team: oppAbbr, rank: opp.rank, of: ranking.of, perGame: Math.round(opp.perGame * 10) / 10, label: typeof lbl === 'function' ? lbl(pos) : lbl } : null,
  };
}

module.exports = { playerDetail };
