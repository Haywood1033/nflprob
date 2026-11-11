// Regression tests for the margin-edge sign, game-day weather, January season year and
// anytime-TD voids.
const test = require('node:test');
const assert = require('node:assert');
const { marketEdge } = require('../lib/vegas-lines.js');
const { etDateHour, kickoffHourIndex, isCovered } = require('../lib/weather.js');
const { nflSeasonYear, seasonFromQuery } = require('../lib/schedule.js');
const { gradePlayerProp, summarizeGraded } = require('../lib/grading.js');
const { buildGameModel } = require('../lib/team-scoring.js');

test('margin edge: model home by 6, market home -7 → -1 (market likes home more)', () => {
  const e = marketEdge({ diff: 6, total: 44 }, { available: true, homeSpread: -7, totalLine: 45.5 });
  assert.equal(e.homeMarginEdge, -1);
  assert.equal(e.totalEdge, -1.5);
});

test('margin edge: model home by 3, market home +2.5 (away favored) → +5.5', () => {
  assert.equal(marketEdge({ diff: 3, total: 40 }, { available: true, homeSpread: 2.5, totalLine: null }).homeMarginEdge, 5.5);
  assert.equal(marketEdge({ diff: 3, total: 40 }, { available: false }), null);
});

test('kickoff converts to ET date and hour, across the UTC date line', () => {
  // Sunday Night Football, 8:20 PM ET = 01:20 UTC Monday.
  assert.deepEqual(etDateHour('2026-11-16T01:20Z'), { date: '2026-11-15', hour: 20 });
  // A 4:25 PM ET kickoff in Seattle is 4 PM on the ET clock, not 4 PM Pacific.
  assert.deepEqual(etDateHour('2026-11-15T21:25Z'), { date: '2026-11-15', hour: 16 });
  // Summer-time offset (September, EDT).
  assert.deepEqual(etDateHour('2026-09-13T17:00Z'), { date: '2026-09-13', hour: 13 });
});

test('kickoff hour picks the game-day slot, not today, and -1 outside the forecast', () => {
  const times = ['2026-11-11T13:00', '2026-11-15T12:00', '2026-11-15T13:00', '2026-11-15T14:00'];
  assert.equal(kickoffHourIndex(times, '2026-11-15T18:00Z'), 2);
  assert.equal(kickoffHourIndex(times, '2026-11-22T18:00Z'), -1);
});

test('roof: nflverse first, then ESPN indoor, neutral outdoor sites get no home-stadium default', () => {
  assert.equal(isCovered({ roof: 'closed', homeTeam: 'Bills' }), true);
  assert.equal(isCovered({ roof: 'outdoors', homeTeam: 'Cowboys' }), false);
  assert.equal(isCovered({ homeTeam: 'Lions' }), true);
  assert.equal(isCovered({ homeTeam: 'Lions', neutralSite: true }), false);
  assert.equal(isCovered({ homeTeam: 'Bills', neutralSite: true, indoor: true }), true);
});

test('neutral site: no home-field point', () => {
  const eff = { games: 8, epaPlayOff: 0, epaPlayDef: 0, playsPerGame: 63.5 };
  assert.equal(buildGameModel(eff, eff, {}).diff, 1);
  assert.equal(buildGameModel(eff, eff, { neutralSite: true }).diff, 0);
});

test('season year: January and February belong to the prior season', () => {
  assert.equal(nflSeasonYear(new Date('2027-01-03T18:00Z')), 2026);
  assert.equal(nflSeasonYear(new Date('2027-02-14T23:00Z')), 2026);
  assert.equal(nflSeasonYear(new Date('2026-11-11T18:00Z')), 2026);
  assert.equal(nflSeasonYear(new Date('2026-09-10T23:00Z')), 2026);
  assert.equal(seasonFromQuery({ year: '2025' }), 2025);
  assert.equal(typeof seasonFromQuery({}), 'number');
});

test('anytime TD with no stat line is a void, kept out of the hit rate', () => {
  const td = (name, team) => ({ name, team, propType: 'anytime_td', badge: 'Elite', ci: 'high' });
  const rows = { 'jahmyr gibbs|DET': { rushing_tds: '1', receiving_tds: '0' } };
  const inactive = gradePlayerProp(td('Some Inactive Guy', 'DET'), rows);
  assert.equal(inactive.hit, null);
  assert.equal(inactive.void, true);
  const scored = gradePlayerProp(td('Jahmyr Gibbs', 'DET'), rows);
  assert.equal(scored.hit, true);
  const s = summarizeGraded([inactive, scored]);
  assert.equal(s.anytimeTd.n, 1);
  assert.equal(s.anytimeTd.hitRate, 100);
});
