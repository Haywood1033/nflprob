// The Monday-night Vikings case: nflverse still names Kyler Murray, ESPN has him Out, and
// Carson Wentz (weeks 1-2 starter, no games since) starts.
const test = require('node:test');
const assert = require('node:assert');
const { resolveStarter } = require('../lib/qb-starter.js');
const { buildStalenessChecks, buildNameIndex, makePlayerRowsFor } = require('../lib/dfs-projections.js');

const row = (name, week, attempts) => ({ player_display_name: name, player_name: name, team: 'MIN', position: 'QB', season_type: 'REG', week: String(week), attempts: String(attempts) });
const rows = [row('Carson Wentz', 1, 19), row('Carson Wentz', 2, 20), ...[3, 4, 5, 6, 7, 8].map(w => row('Kyler Murray', w, 30)), row('Max Brosmer', 8, 3)];
const entry = (displayName, extra = {}) => ({ displayName, position: 'QB', injuryStatus: null, definitelyOut: false, ...extra });
const roster = {
  'kyler murray': entry('Kyler Murray', { injuryStatus: 'Out', definitelyOut: true }),
  'carson wentz': entry('Carson Wentz'),
  'max brosmer': entry('Max Brosmer'),
};

test('named QB ruled out → the healthy QB with the most starts', async () => {
  const r = await resolveStarter({ teamAbbr: 'MIN', namedQb: 'Kyler Murray', playerRows: rows, roster });
  assert.equal(r.name, 'Carson Wentz');
  assert.equal(r.source, 'injury');
  assert.match(r.note, /Kyler Murray is out/);
});

test('named QB healthy → stays the starter; Questionable stays too', async () => {
  const healthy = { ...roster, 'kyler murray': entry('Kyler Murray', { injuryStatus: 'Questionable' }) };
  const r = await resolveStarter({ teamAbbr: 'MIN', namedQb: 'Kyler Murray', playerRows: rows, roster: healthy });
  assert.deepEqual([r.name, r.source], ['Kyler Murray', 'nflverse']);
});

test('Doubtful counts as out; no roster → unverified, keep the named QB', async () => {
  const doubtful = { ...roster, 'kyler murray': entry('Kyler Murray', { injuryStatus: 'Doubtful' }) };
  assert.equal((await resolveStarter({ teamAbbr: 'MIN', namedQb: 'Kyler Murray', playerRows: rows, roster: doubtful })).name, 'Carson Wentz');
  assert.deepEqual(await resolveStarter({ teamAbbr: 'MIN', namedQb: 'Kyler Murray', playerRows: rows, roster: null }), { name: 'Kyler Murray', source: 'unverified' });
});

test('DFS: the resolved starter is not benched even though another QB played more recently', async () => {
  const { byNormName, byNormNameNoSuffix } = buildNameIndex(rows);
  const playerRowsFor = makePlayerRowsFor(byNormName, byNormNameNoSuffix);
  const uploadedPlayers = [{ name: 'Carson Wentz', position: 'QB', teamAbbrev: 'MIN' }, { name: 'Kyler Murray', position: 'QB', teamAbbrev: 'MIN', status: '' }];
  const args = { uploadedPlayers, playerRowsAll: rows, throughWeek: 8, playerRowsFor };
  // Without a starter: the old recency rule benches Wentz (Murray played week 8).
  assert.ok(buildStalenessChecks(args).benchedQbNote('Carson Wentz', 'MIN'));
  const starters = new Map([['MIN', await resolveStarter({ teamAbbr: 'MIN', namedQb: 'Kyler Murray', playerRows: rows, roster })]]);
  const { benchedQbNote } = buildStalenessChecks({ ...args, starters });
  assert.equal(benchedQbNote('Carson Wentz', 'MIN'), null);
  assert.match(benchedQbNote('Kyler Murray', 'MIN'), /Carson Wentz/);
});

test('DFS: a lead back who missed the last game is projected with a warning; a buried back stays at zero', () => {
  const rb = (name, week, carries, targets) => ({ player_display_name: name, player_name: name, team: 'NYG', position: 'RB', season_type: 'REG', week: String(week), carries: String(carries), targets: String(targets) });
  const rbRows = [...[5, 6, 7, 8].map(w => rb('Lead Back', w, 17, 4)), ...[5, 6, 7, 8, 9].map(w => rb('Other Back', w, 9, 2)), rb('Buried Back', 6, 2, 0), rb('Buried Back', 7, 1, 1)];
  const { byNormName, byNormNameNoSuffix } = buildNameIndex(rbRows);
  const playerRowsFor = makePlayerRowsFor(byNormName, byNormNameNoSuffix);
  const { staleRoleNote, returningRoleNote } = buildStalenessChecks({ uploadedPlayers: [], playerRowsAll: rbRows, throughWeek: 9, playerRowsFor });
  assert.ok(staleRoleNote('Lead Back', 'NYG', 'RB'));
  assert.match(returningRoleNote("Lead Back", "NYG", "RB"), /last stat line week 8/);
  assert.ok(staleRoleNote('Buried Back', 'NYG', 'RB'));
  assert.equal(returningRoleNote('Buried Back', 'NYG', 'RB'), null);
  assert.equal(staleRoleNote('Other Back', 'NYG', 'RB'), null);
});
