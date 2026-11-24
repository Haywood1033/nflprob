// Simulation-based Showdown lineups: correlated draws, and the usual locks/excludes/captain rules.
const test = require('node:test');
const assert = require('node:assert');
const { simLineups, simulate, choleskyFor, mulberry32 } = require('../lib/dfs-sim.js');

const mk = (i, team, pos, salary, points, sd = 6) => ({ id: String(i), name: 'P' + i, pos, team, salary, points, sd });
const pool = [mk(1, 'A', 'QB', 10000, 20, 7), mk(2, 'A', 'WR', 9000, 16), mk(3, 'B', 'QB', 9000, 18, 7), mk(4, 'B', 'WR', 8000, 14), mk(5, 'A', 'TE', 5000, 10, 5),
  mk(6, 'B', 'TE', 4000, 9, 5), mk(7, 'A', 'RB', 6000, 12), mk(8, 'B', 'RB', 5500, 11), mk(9, 'A', 'WR', 2000, 6), mk(10, 'B', 'WR', 1500, 5), mk(11, 'A', 'K', 4000, 8, 3.5), mk(12, 'B', 'DST', 3600, 7, 5)];
const table = { 'QB-WR|same': 0.25, 'DST-QB|opp': -0.37, 'QB-QB|opp': 0.2 };

test('draws carry the measured correlation', () => {
  const draws = simulate(pool, choleskyFor(pool, table), 4000, mulberry32(3));
  const corr = (i, j) => {
    const x = draws.map(d => d[i]), y = draws.map(d => d[j]), mx = x.reduce((a, b) => a + b) / x.length, my = y.reduce((a, b) => a + b) / y.length;
    let sxy = 0, sxx = 0, syy = 0; for (let k = 0; k < x.length; k++) { sxy += (x[k] - mx) * (y[k] - my); sxx += (x[k] - mx) ** 2; syy += (y[k] - my) ** 2; }
    return sxy / Math.sqrt(sxx * syy);
  };
  assert.ok(corr(0, 1) > 0.15 && corr(0, 1) < 0.35, 'QB-own WR ' + corr(0, 1));   // A QB with A WR
  assert.ok(corr(0, 11) < -0.25, 'A QB vs the opposing (B) DST ' + corr(0, 11));
  assert.ok(Math.abs(corr(2, 11)) < 0.06, 'B QB vs his own DST, not in the table ' + corr(2, 11));
});

test('lineups: 20 distinct, salary cap, rules respected, same input → same lineups', () => {
  const ls = simLineups(pool, { count: 20, noCaptainPositions: ['K', 'DST'], captainTopN: 4, table, candidateSims: 60, evalSims: 400 });
  assert.ok(ls.length >= 10);
  const sigs = new Set(ls.map(l => l.captain.id + '|' + l.flex.map(p => p.id).sort()));
  assert.equal(sigs.size, ls.length);
  for (const l of ls) {
    assert.ok(Math.round(l.captain.salary * 1.5) + l.flex.reduce((x, p) => x + p.salary, 0) <= 50000);
    assert.ok(['1', '2', '3', '4'].includes(l.captain.id));
    assert.equal(l.flex.length, 5);
  }
  const again = simLineups(pool, { count: 20, noCaptainPositions: ['K', 'DST'], captainTopN: 4, table, candidateSims: 60, evalSims: 400 });
  assert.deepEqual(again.map(l => l.captain.id + l.flex.map(p => p.id).join()), ls.map(l => l.captain.id + l.flex.map(p => p.id).join()));
  const withLock = simLineups(pool, { count: 5, lockedIds: ['10'], excludedIds: ['2'], table, candidateSims: 40, evalSims: 300 });
  assert.ok(withLock.every(l => [l.captain, ...l.flex].some(p => p.id === '10') && ![l.captain, ...l.flex].some(p => p.id === '2')));
});
