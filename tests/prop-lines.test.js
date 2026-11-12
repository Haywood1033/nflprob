// ESPN pre-game prop lines: parsing, picking the main line, pricing against the model, joining to
// players, and grading the model against the book. Fixtures follow ESPN's propBets item shape.
const test = require('node:test');
const assert = require('node:assert');
const { parseAmerican, normalCdf, priceAnytimeTd, priceYards } = require('../lib/prop-ev.js');
const { parsePropItem, mainLines, marketOf, attachPropLines, nameKey } = require('../lib/espn-props.js');
const { gradePlayerProp, summarizeGraded } = require('../lib/grading.js');

const ath = id => ({ $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/athletes/${id}?lang=en&region=us` });
const yards = (id, name, line, over, under) => ({ athlete: ath(id), type: { id: '1', name }, current: { target: { value: line, displayValue: String(line) }, over: { american: over }, under: { american: under } } });
const anytime = (id, price) => ({ athlete: ath(id), type: { id: '2', name: 'Anytime Touchdown Scorer' }, current: { target: { value: 0.5 }, over: { american: price } } });

test('American odds parse, normal CDF sane', () => {
  assert.deepEqual(['+150', '-115', 'EVEN', 130, '', null, 'abc'].map(parseAmerican), [150, -115, 100, 130, null, null, null]);
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normalCdf(1) - 0.8413447) < 1e-6);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.0249979) < 1e-6);
});

test('anytime TD EV: 40% model at +200 → +20%; at +100 → -20%', () => {
  assert.deepEqual(priceAnytimeTd(40, '+200'), { price: 200, bookProb: 33.3, ev: 20 });
  assert.equal(priceAnytimeTd(40, '+100').ev, -20);
  assert.equal(priceAnytimeTd(40, null), null);
});

test('yardage: projection above the line favors the over; gap flags', () => {
  const r = priceYards({ projected: 80, floor: 55, ceiling: 105 }, { line: 62.5, overPrice: -115, underPrice: -105 });
  assert.equal(r.side, 'over');
  assert.equal(r.diff, 17.5);
  assert.equal(r.farOff, true);
  assert.ok(r.modelOver > 75 && r.modelOver < 78, r.modelOver);
  assert.ok(r.ev > 30);
  assert.equal(r.bookOver, 51.1);
  const close = priceYards({ projected: 61.5, floor: 36.5, ceiling: 86.5 }, { line: 62.5, overPrice: -110, underPrice: -110 });
  assert.equal(close.farOff, false);
  assert.equal(close.side, 'under');
  assert.ok(close.ev < 0, 'a small gap does not beat the vig');
});

test('market names: the main markets only, not longest / combos / quarters', () => {
  assert.deepEqual(['Total Rushing Yards', 'Total Receiving Yards', 'Total Passing Yards', 'Anytime Touchdown Scorer', 'Total Receptions',
    'Longest Rush', 'Total Rushing + Receiving Yards', '1st Quarter Passing Yards', 'First Touchdown Scorer', 'Total Passing Touchdowns', 'Rushing Yards 100+'].map(marketOf),
  ['rush_yds', 'rec_yds', 'pass_yds', 'anytime_td', 'receptions', null, null, null, null, null, null]);
});

test('parse items; the main line is the two-sided one closest to even', () => {
  assert.deepEqual(parsePropItem(yards(4241457, 'Total Rushing Yards', 62.5, '-115', '-105')),
    { athleteId: '4241457', market: 'rush_yds', typeName: 'Total Rushing Yards', line: 62.5, overPrice: -115, underPrice: -105, price: null });
  assert.equal(parsePropItem(anytime(4241457, '+140')).price, 140);
  // Older shape: line and prices under odds.
  const old = { athlete: ath(7), type: { name: 'Total Receiving Yards' }, odds: { total: { value: '48.5' }, over: { american: '-110' }, under: { american: '-110' } } };
  assert.equal(parsePropItem(old).line, 48.5);
  assert.equal(parsePropItem({ athlete: ath(7), type: { name: 'Longest Reception' } }).skip, 'market');
  const alt = [yards(1, 'Total Rushing Yards', 49.5, '-250', '+190'), yards(1, 'Total Rushing Yards', 62.5, '-112', '-108'), yards(1, 'Total Rushing Yards', 79.5, '+210', '-280')].map(parsePropItem);
  const main = mainLines(alt);
  assert.equal(main.length, 1);
  assert.equal(main[0].line, 62.5);
});

test('attachPropLines: ESPN ids → roster names → players, suffix-insensitive', async () => {
  const realFetch = global.fetch;
  global.fetch = async url => {
    const ok = body => ({ ok: true, json: async () => body });
    if (/\/odds\?/.test(url)) return ok({ items: [{ provider: { id: 100, name: 'DraftKings' }, propBets: { $ref: 'http://sports.core.api.espn.com/v2/x/odds/100/propBets?lang=en' } }] });
    if (/propBets/.test(url)) return ok({ pageCount: 1, items: [yards(11, 'Total Rushing Yards', 62.5, '-115', '-105'), yards(22, 'Total Rushing Yards', 40.5, '-110', '-110'), anytime(11, '+120')] });
    return { ok: false, status: 404 };
  };
  try {
    const rosters = { BUF: { 'james cook iii': { id: '11', displayName: 'James Cook III' } }, NYJ: { 'breece hall': { id: '22', displayName: 'Breece Hall' } } };
    const schedule = [{ gameId: '401', homeAbbr: 'BUF', awayAbbr: 'NYJ' }];
    const players = [{ name: 'James Cook', gameId: '401', projected: 80, floor: 55, ceiling: 105 }, { name: 'Breece Hall', gameId: '401', projected: 41, floor: 20, ceiling: 62 }, { name: 'Nobody', gameId: '401', projected: 10 }];
    const info = await attachPropLines(players, schedule, rosters, 'rush_yds');
    assert.equal(info.matched, 2);
    assert.equal(players[0].line.line, 62.5);
    assert.equal(players[0].line.book, 'DraftKings');
    assert.equal(players[1].line.line, 40.5);
    assert.equal(players[2].line, undefined);
    const td = [{ name: 'James Cook', gameId: '401', prob: 50 }];
    await attachPropLines(td, schedule, rosters, 'anytime_td');
    assert.equal(td[0].line.ev, 10);
  } finally { global.fetch = realFetch; }
  assert.equal(nameKey("Ja'Marr Chase"), nameKey('JaMarr Chase'));
});

test('grading against the book: model vs line miss, +EV bets in units', () => {
  const rows = { 'james cook|BUF': { rushing_yards: '90', rushing_tds: '1', receiving_tds: '0' }, 'breece hall|NYJ': { rushing_yards: '30', rushing_tds: '0', receiving_tds: '0' } };
  const a = gradePlayerProp({ name: 'James Cook', team: 'BUF', propType: 'rush_yds', prediction: 80, floor: 55, ceiling: 105, bookLine: 62.5, bookOver: -115, bookUnder: -105, evSide: 'over', ev: 30 }, rows);
  assert.equal(a.lineError, -27.5);
  assert.equal(a.betProfit, 0.87);
  const b = gradePlayerProp({ name: 'Breece Hall', team: 'NYJ', propType: 'rush_yds', prediction: 45, floor: 20, ceiling: 70, bookLine: 40.5, bookOver: -110, bookUnder: -110, evSide: 'over', ev: 5 }, rows);
  assert.equal(b.betProfit, -1);
  const td = gradePlayerProp({ name: 'James Cook', team: 'BUF', propType: 'anytime_td', prediction: 50, bookPrice: 120, ev: 10 }, rows);
  assert.equal(td.betProfit, 1.2);
  const s = summarizeGraded([a, b, td]);
  assert.deepEqual(s.rushYds.vsLine, { n: 2, modelMae: 12.5, lineMae: 19 });
  assert.deepEqual(s.rushYds.evBets, { n: 2, won: 1, units: -0.13, roi: -6.5 });
  assert.deepEqual(s.anytimeTd.evBets, { n: 1, won: 1, units: 1.2, roi: 120 });
});

test('anytime TD under its other names and price shapes', () => {
  const names = ['Anytime Touchdown Scorer', 'Anytime TD Scorer', 'To Score a Touchdown', 'Player to Score a TD', 'Touchdown Scorer', 'Touchdowns', 'Total Touchdowns',
    'First Touchdown Scorer', 'Last Touchdown Scorer', '2+ Touchdowns', 'Total Passing Touchdowns', 'Rushing Touchdowns', 'Team Total Touchdowns'];
  assert.deepEqual(names.map(marketOf), ['anytime_td', 'anytime_td', 'anytime_td', 'anytime_td', 'anytime_td', 'anytime_td', 'anytime_td', null, null, null, null, null, null]);
  const it = (type, extra) => ({ athlete: ath(5), type: { name: type }, ...extra });
  assert.equal(parsePropItem(it('Anytime Touchdown Scorer', { odds: { american: '+175' } })).price, 175);
  assert.equal(parsePropItem(it('Anytime Touchdown Scorer', { current: { yes: { american: '-120' } } })).price, -120);
  assert.equal(parsePropItem(it('Anytime Touchdown Scorer', { odds: { moneyLine: 140 } })).price, 140);
  assert.equal(parsePropItem(it('Anytime Touchdown Scorer', { current: { over: { value: 2.5 } } })).price, 150);
  assert.equal(parsePropItem(it('Total Touchdowns', { current: { target: { value: 0.5 }, over: { american: '+130' }, under: { american: '-160' } } })).price, 130);
  assert.equal(parsePropItem(it('Total Touchdowns', { current: { target: { value: 1.5 }, over: { american: '+400' } } })).skip, 'market');
});
