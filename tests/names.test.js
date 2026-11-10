// ESPN and nflverse spell names differently: ESPN "James Cook III", nflverse "James Cook".
const test = require('node:test');
const assert = require('node:assert');
const { statsName, poolFromRoster } = require('../lib/roster-pool.js');
const { getRosterEntry, isHealthy, normalizeName } = require('../lib/roster.js');
const { computeRushUsage } = require('../lib/rush-scoring.js');
const { computeRecUsage } = require('../lib/rec-scoring.js');

const row = (name, position, week, x = {}) => ({ player_display_name: name, team: 'BUF', position, season_type: 'REG', week: String(week), carries: '0', targets: '0', rushing_yards: '0', receiving_yards: '0', ...x });
const rows = [
  ...[6, 7, 8].map(w => row('James Cook', 'RB', w, { carries: '18', rushing_yards: '95', targets: '3', receiving_yards: '18' })),
  ...[6, 7, 8].map(w => row('Josh Allen', 'QB', w, { carries: '8', rushing_yards: '40' })),
  row('A.J. Brown', 'WR', 8, { targets: '9' }),
  row('Marvin Harrison Jr.', 'WR', 8), row('Marvin Harrison', 'WR', 8), // two players, one base name
];
const entry = (displayName, position, x = {}) => ({ displayName, position, injured: false, injuryStatus: null, definitelyOut: false, ...x });

test('ESPN name → stats name: suffix, periods; ambiguous or unknown → null', () => {
  assert.equal(statsName(rows, 'James Cook III', 'RB'), 'James Cook');
  assert.equal(statsName(rows, 'AJ Brown', 'WR'), 'A.J. Brown');
  assert.equal(statsName(rows, 'Josh Allen', 'QB'), 'Josh Allen');
  assert.equal(statsName(rows, 'Marvin Harrison III', 'WR'), null); // two candidates: never guess
  assert.equal(statsName(rows, 'Nobody Here', 'RB'), null);
});

test('roster pool keeps a suffix-mismatched player, under his stats name', () => {
  const roster = { [normalizeName('James Cook III')]: entry('James Cook III', 'RB') };
  const pool = poolFromRoster(roster, rows, ['RB'], 'carries', 4, 8);
  assert.deepEqual(pool.map(p => [p.name, p.displayName]), [['James Cook', 'James Cook III']]);
});

test('roster lookups by the stats name find the ESPN entry (injury status)', () => {
  const roster = { [normalizeName('James Cook III')]: entry('James Cook III', 'RB', { injured: true, injuryStatus: 'Questionable' }) };
  assert.equal(getRosterEntry(roster, 'James Cook').injuryStatus, 'Questionable');
  assert.equal(isHealthy(roster, 'James Cook'), false);
});

test('rushing model takes a QB; receiving model takes an RB when asked', () => {
  const qb = computeRushUsage(rows, 'Josh Allen', 'BUF', 8, 5, { position: 'QB' });
  assert.equal(qb.carries, 24); assert.equal(qb.position, 'QB'); assert.equal(qb.recentShare, null);
  assert.equal(computeRushUsage(rows, 'Josh Allen', 'BUF', 8, 5), null); // RB default unchanged
  assert.equal(computeRecUsage(rows, 'James Cook', 'BUF', 8, 5), null);
  assert.equal(computeRecUsage(rows, 'James Cook', 'BUF', 8, 5, { positions: ['WR', 'TE', 'RB'] }).targets, 9);
});
