// A starter back from a long absence (no games in the recent window) must be projected, and his
// teammates' target shares, earned while he was out, scaled down.
const test = require('node:test');
const assert = require('node:assert');
const { returningPlayers } = require('../lib/roster-pool.js');
const { computeRecUsage, projectRecYards } = require('../lib/rec-scoring.js');

const row = (name, pos, week, targets, yds) => ({ player_display_name: name, player_name: name, team: 'SF', position: pos, season_type: 'REG', week: String(week), targets: String(targets), receptions: String(Math.round(targets * 0.65)), receiving_yards: String(yds), carries: '0' });
// Evans: weeks 1-3, 9 targets a game, then hurt. Week 10 is next; the recent window is weeks 5-9.
const rows = [
  ...[1, 2, 3].map(w => row('Mike Evans', 'WR', w, 9, 80)),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(w => row('Jauan Jennings', 'WR', w, w <= 3 ? 5 : 9, w <= 3 ? 45 : 75)),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(w => row('George Kittle', 'TE', w, 6, 55)),
  ...[2, 3].map(w => row('Depth Guy', 'WR', w, 1, 8)),
];
const e = (displayName, position, extra = {}) => ({ displayName, position, definitelyOut: false, ...extra });
const roster = { 'mike evans': e('Mike Evans', 'WR'), 'jauan jennings': e('Jauan Jennings', 'WR'), 'george kittle': e('George Kittle', 'TE'), 'depth guy': e('Depth Guy', 'WR') };

test('returningPlayers: a real role, no recent games, active → returning; others not', () => {
  const r = returningPlayers(roster, rows, ['WR', 'TE'], 9, 'targets', 4);
  assert.deepEqual(r.map(x => [x.name, x.lastWeekPlayed, x.returning]), [['Mike Evans', 3, true]]);
  // Still listed on IR / Out → not back.
  assert.deepEqual(returningPlayers({ ...roster, 'mike evans': e('Mike Evans', 'WR', { definitelyOut: true }) }, rows, ['WR', 'TE'], 9, 'targets', 4), []);
  // Before any current-season games there's no "recent window" to be missing from.
  assert.deepEqual(returningPlayers(roster, rows, ['WR', 'TE'], 0, 'targets', 4), []);
});

test('season usage projects the returner; a teammate scaled by his share drops', () => {
  assert.equal(computeRecUsage(rows, 'Mike Evans', 'SF', 9, 5), null); // why he vanished before
  const evans = computeRecUsage(rows, 'Mike Evans', 'SF', 9, 18);
  assert.ok(evans && evans.recentShare > 0.4 && evans.recentShare < 0.5, String(evans?.recentShare));
  const jen = computeRecUsage(rows, 'Jauan Jennings', 'SF', 9, 5);
  const before = projectRecYards(jen, null, 22).projected;
  const scaled = { ...jen, recentShare: jen.recentShare * (1 - Math.min(0.4, evans.recentShare)) };
  const after = projectRecYards(scaled, null, 22).projected;
  assert.ok(after < before * 0.65, `${before} → ${after}`);
  assert.ok(projectRecYards(evans, null, 22).projected > 50);
});

test('DFS: a returner gets a season-based projection, not zero', () => {
  const { buildStalenessChecks, buildNameIndex, makePlayerRowsFor } = require('../lib/dfs-projections.js');
  const { byNormName, byNormNameNoSuffix } = buildNameIndex(rows);
  const playerRowsFor = makePlayerRowsFor(byNormName, byNormNameNoSuffix);
  const { staleRoleNote, returningRoleNote } = buildStalenessChecks({ uploadedPlayers: [], playerRowsAll: rows, throughWeek: 9, playerRowsFor });
  assert.ok(staleRoleNote('Mike Evans', 'SF', 'WR'));
  assert.match(returningRoleNote('Mike Evans', 'SF', 'WR'), /week 3/);
  assert.equal(returningRoleNote('Depth Guy', 'SF', 'WR'), null);
});

test('returning also covers a player who played inside the window, then missed the latest games', () => {
  const r2 = [...[1, 2, 3, 4, 5, 6, 7].map(w => row('Mike Evans', 'WR', w, 9, 80)),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(w => row('Jauan Jennings', 'WR', w, 7, 60))];
  const r = returningPlayers(roster, r2, ['WR', 'TE'], 9, 'targets', 4);
  assert.equal(r.length, 1);
  assert.equal(r[0].lastWeekPlayed, 7);
  assert.equal(r[0].missedShare, 2 / 5); // window weeks 5-9: missed 8 and 9
  // Played the latest game → handled by the normal pool, not returning.
  assert.deepEqual(returningPlayers(roster, r2, ['WR', 'TE'], 7, 'targets', 4), []);
});

test('optimizer: 20 lineups keep every player at or under the exposure cap when the slate allows it', () => {
  const { optimizeLineups } = require('../lib/dfs-optimizer.js');
  const mk = (i, team, pos, salary, points) => ({ id: String(i), name: 'P' + i, pos, team, salary, points });
  const pool = [mk(1, 'A', 'RB', 11800, 26), mk(2, 'A', 'QB', 10800, 20), mk(3, 'B', 'QB', 9400, 17), mk(4, 'B', 'WR', 10400, 14.5), mk(5, 'A', 'TE', 8400, 14.5),
    mk(6, 'A', 'WR', 6600, 11.6), mk(7, 'B', 'TE', 5400, 11), mk(8, 'A', 'RB', 4800, 9.3), mk(9, 'B', 'K', 5000, 8.8), mk(10, 'A', 'WR', 8000, 12),
    mk(11, 'B', 'DST', 3600, 8.5), mk(12, 'A', 'DST', 4000, 7.3), mk(13, 'A', 'WR', 3400, 6.7), mk(14, 'B', 'RB', 7200, 9), mk(15, 'B', 'RB', 7000, 5.8),
    mk(16, 'A', 'K', 4600, 5.8), mk(17, 'B', 'TE', 2400, 5.5), mk(18, 'B', 'WR', 2800, 5.1), mk(19, 'B', 'WR', 3000, 4.3), mk(20, 'A', 'RB', 1400, 3.5),
    mk(21, 'A', 'WR', 800, 2), mk(22, 'B', 'TE', 1600, 1.5), mk(23, 'B', 'QB', 6000, 3.9), mk(24, 'A', 'WR', 7600, 9)];
  const lineups = optimizeLineups(pool, { count: 20, maxExposure: 0.35 });
  assert.equal(lineups.length, 20);
  const n = {};
  for (const l of lineups) for (const p of [l.captain, ...l.flex]) n[p.id] = (n[p.id] || 0) + 1;
  assert.ok(Math.max(...Object.values(n)) <= 10, JSON.stringify(n)); // was 17 of 20 before the cap held
});

test('optimizer: no kicker or defense captains unless locked there', () => {
  const { optimizeLineups } = require('../lib/dfs-optimizer.js');
  const mk = (i, team, pos, salary, points) => ({ id: String(i), name: 'P' + i, pos, team, salary, points });
  const pool = [mk(1, 'A', 'QB', 10000, 20), mk(2, 'A', 'WR', 9000, 16), mk(3, 'B', 'QB', 9000, 18), mk(4, 'B', 'WR', 8000, 14), mk(5, 'A', 'K', 4000, 9),
    mk(6, 'B', 'K', 4000, 9), mk(7, 'A', 'DST', 3600, 8), mk(8, 'B', 'DST', 3600, 8), mk(9, 'A', 'TE', 5000, 10), mk(10, 'B', 'TE', 5000, 9), mk(11, 'A', 'RB', 6000, 12), mk(12, 'B', 'RB', 6000, 11)];
  const free = optimizeLineups(pool, { count: 10, noCaptainPositions: ['K', 'DST'] });
  assert.ok(free.length > 0 && free.every(l => !['K', 'DST'].includes(l.captain.pos)));
  const locked = optimizeLineups(pool, { count: 1, captainLockId: '5', lockedIds: ['5'], noCaptainPositions: ['K', 'DST'] });
  assert.equal(locked[0].captain.id, '5');
});
