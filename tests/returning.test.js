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
