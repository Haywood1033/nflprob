// lib/espn-props.js — pre-game player prop lines from ESPN's odds feed.
//
// ESPN's core API lists each game's odds providers, and each provider links to its player prop
// bets: one item per player per market (athlete $ref, market type name, the line and the over /
// under prices; an anytime TD is a one-sided "yes" price). The athlete is an ESPN id, matched to a
// name through the ESPN team rosters the props endpoints already load.
//
// CHECKED ON THE LIVE FEED (Nov 2026, DraftKings via ESPN): items carry the line only
// (current.target, and open.target for the opening line), with NO prices; anytime TD items are
// empty. So yardage lines work and anytime TD can't be priced from ESPN. The price fields below
// stay in case ESPN adds them. /api/props?view=lines reports what was parsed and skipped.

const { parseAmerican, americanToProb, priceAnytimeTd, priceYards } = require('./prop-ev.js');

const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
const ODDS_URL = id => `${CORE}/events/${id}/competitions/${id}/odds?lang=en&region=us`;
const PROPS_URL = (id, provider) => `${CORE}/events/${id}/competitions/${id}/odds/${provider}/propBets?lang=en&region=us&limit=1000`;
const FALLBACK_PROVIDERS = [100, 58]; // DraftKings, ESPN BET
const TTL = 10 * 60 * 1000;
const cache = new Map();

const https = u => String(u).replace(/^http:\/\//, 'https://');
async function getJSON(url) {
  const r = await fetch(https(url), { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ESPN market name → this app's market, or null for markets the app doesn't model.
function marketOf(typeName) {
  const n = String(typeName || '').toLowerCase();
  const td = /(touchdown|\btds?\b)/.test(n);
  // Anytime TD goes by several names: "Anytime Touchdown Scorer", "To Score a Touchdown",
  // "Touchdown Scorer", or a 0.5 total-touchdowns over (checked against the line in parsePropItem).
  // Not first / last / 2+ scorer, and not passing / rushing / receiving touchdown totals.
  if (td && !/first|1st|last|2\+|two|3\+|three|half|quarter|pass|rush|rec|team|game/.test(n)) {
    if (/anytime|to score|scorer/.test(n)) return 'anytime_td';
    if (/^(total |player )?(touchdowns?|tds?)$/.test(n.trim())) return 'anytime_td';
  }
  if (td) return null;
  if (/longest|first|1st|2nd|half|quarter|\+|combined|&| and |alt|milestone|\d+\+/.test(n)) return null;
  if (/rush(ing)?\s*(yards|yds)/.test(n)) return 'rush_yds';
  if (/rec(eiving)?\s*(yards|yds)/.test(n)) return 'rec_yds';
  if (/pass(ing)?\s*(yards|yds)/.test(n)) return 'pass_yds';
  if (/receptions/.test(n)) return 'receptions';
  return null;
}

const num = v => { const n = parseFloat(typeof v === 'object' && v ? v.value ?? v.displayValue : v); return Number.isFinite(n) ? n : null; };
// A decimal price (2.2) → American (+120); only used when no American price is given.
const decimalToAmerican = d => (d > 1 && d < 100 ? Math.round(d >= 2 ? (d - 1) * 100 : -100 / (d - 1)) : null);
const price = side => {
  if (side == null) return null;
  if (typeof side !== 'object') return parseAmerican(side);
  const a = parseAmerican(side.american ?? side.odds?.american ?? side.moneyLine ?? side.alternateDisplayValue ?? side.displayValue);
  return a ?? decimalToAmerican(parseFloat(side.value ?? side.odds?.value));
};

// A raw item without the long $ref links, for the report.
function slim(it) {
  const out = JSON.parse(JSON.stringify(it || {}));
  delete out.competition; delete out.provider;
  if (out.athlete?.$ref) out.athlete = (out.athlete.$ref.match(/athletes\/(\d+)/) || [])[1] || out.athlete.$ref;
  for (const [k, v] of Object.entries(out)) if (v && typeof v === 'object' && Object.keys(v).length === 1 && v.$ref) out[k] = '(link)';
  return out;
}

// One raw prop item → { athleteId, market, typeName, line, overPrice, underPrice, price } or null.
function parsePropItem(item) {
  const typeName = item?.type?.name || item?.type?.displayName || item?.name || '';
  const market = marketOf(typeName);
  const ref = item?.athlete?.$ref || item?.athlete?.href || '';
  const athleteId = String(item?.athlete?.id || (ref.match(/athletes\/(\d+)/) || [])[1] || '') || null;
  if (!athleteId) return { skip: 'no athlete', typeName };
  if (!market) return { skip: 'market', typeName };
  const cur = item.current || {}, odds = item.odds || {};
  const line = num(cur.target) ?? num(odds.total) ?? num(cur.total) ?? num(item.line) ?? null;
  const openLine = num(item.open?.target) ?? null;
  const overPrice = price(cur.over) ?? price(odds.over);
  const underPrice = price(cur.under) ?? price(odds.under);
  const yes = overPrice ?? price(cur.yes) ?? price(odds.yes) ?? price(cur.odds) ?? price(odds.moneyLine) ?? parseAmerican(odds.american ?? cur.american) ?? price(odds.total) ?? price(cur.target);
  // A plain touchdowns total only counts as anytime when it's the 0.5 line.
  if (market === 'anytime_td' && line != null && line > 0.5 && !/anytime|to score|scorer/i.test(typeName)) return { skip: 'market', typeName };
  if (market === 'anytime_td') return yes != null ? { athleteId, market, typeName, line: null, overPrice: null, underPrice: null, price: yes } : { skip: 'no price', typeName };
  if (line == null) return { skip: 'no line', typeName };
  return { athleteId, market, typeName, line, openLine, overPrice, underPrice, price: null };
}

// Books list alternate lines too; the main one is two-sided with the prices closest to even.
// With no prices (ESPN's feed today has none), the middle of the player's listed lines.
function mainLines(parsed) {
  const groups = new Map();
  for (const l of parsed) {
    const k = l.athleteId + '|' + l.market;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const score = l => Math.abs(americanToProb(l.overPrice) - americanToProb(l.underPrice));
  return [...groups.values()].map(g => {
    if (g.length === 1 || g[0].market === 'anytime_td') return g[0];
    const priced = g.filter(l => l.overPrice != null && l.underPrice != null);
    if (priced.length) return priced.reduce((a, b) => (score(b) < score(a) ? b : a));
    const sorted = [...g].sort((a, b) => a.line - b.line);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  });
}

async function providerPropUrls(eventId) {
  const urls = [];
  try {
    const d = await getJSON(ODDS_URL(eventId));
    for (let it of d.items || []) {
      if (!it.provider && it.$ref) it = await getJSON(it.$ref).catch(() => ({}));
      if (it.propBets?.$ref) urls.push({ provider: it.provider?.name || String(it.provider?.id || ''), url: it.propBets.$ref });
      else if (it.provider?.id != null) urls.push({ provider: it.provider.name || String(it.provider.id), url: PROPS_URL(eventId, it.provider.id) });
    }
  } catch { /* fall through to the known providers */ }
  for (const p of FALLBACK_PROVIDERS) if (!urls.some(u => u.url.includes(`/odds/${p}/`))) urls.push({ provider: String(p), url: PROPS_URL(eventId, p) });
  return urls;
}

// All of one game's prop lines from the first provider that has any. Never throws.
async function fetchGamePropLines(eventId) {
  if (!eventId) return { lines: [], provider: null, raw: 0, skipped: {} };
  const hit = cache.get(eventId);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  let data = { lines: [], provider: null, raw: 0, skipped: {}, unknownMarkets: [] };
  for (const { provider, url } of await providerPropUrls(eventId)) {
    try {
      // ESPN's link carries no page size and defaults to 25 per page; ask for 1000.
      const base = /[?&]limit=/.test(url) ? url : url + (url.includes('?') ? '&' : '?') + 'limit=1000';
      const items = [];
      const first = await getJSON(base);
      items.push(...(first.items || []));
      for (let i = 2; i <= (first.pageCount || 1) && i <= 40; i++) {
        const page = await getJSON(base + '&page=' + i);
        items.push(...(page.items || []));
      }
      if (!items.length) continue;
      const parsed = [], skipped = {}, unknown = new Set(), rawSamples = {};
      for (const it of items) {
        const r = parsePropItem(it);
        // One raw example per skip reason (anytime TD preferred), plus one parsed yardage item.
        const key = r.skip ? r.skip : (r.market !== 'anytime_td' ? 'parsed yardage' : 'parsed anytime td');
        if (r.skip !== 'market' && (!rawSamples[key] || (/anytime/i.test(r.typeName || '') && !/anytime/i.test(rawSamples[key].type?.name || '')))) rawSamples[key] = slim(it);
        if (r.skip) { skipped[r.skip] = (skipped[r.skip] || 0) + 1; if (r.skip === 'market' && r.typeName) unknown.add(r.typeName); }
        else parsed.push(r);
      }
      data = { lines: mainLines(parsed), provider, raw: items.length, espnCount: first.count ?? null, pages: first.pageCount ?? null, skipped, unknownMarkets: [...unknown].slice(0, 40), rawSamples };
      if (data.lines.length) break;
    } catch { /* try the next provider */ }
  }
  cache.set(eventId, { ts: Date.now(), data });
  return data;
}

// Name key shared by ESPN roster names and nflverse stats names: no punctuation, no suffix.
function nameKey(name) {
  return String(name || '').toLowerCase().replace(/[.'’]/g, '').replace(/-/g, ' ')
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/, '').replace(/\s+/g, ' ').trim();
}

// Lines for one market, keyed by player name, using the rosters to turn ESPN ids into names.
function linesByName(lines, rosters, market) {
  const idToName = new Map();
  for (const roster of rosters) for (const e of Object.values(roster || {})) if (e?.id) idToName.set(String(e.id), e.displayName);
  const out = new Map();
  for (const l of lines) {
    if (l.market !== market) continue;
    const name = idToName.get(l.athleteId);
    if (name) out.set(nameKey(name), l);
  }
  return out;
}

// Adds each player's book line, priced against the model, as p.line. market: 'anytime_td' |
// 'rush_yds' | 'rec_yds' | 'pass_yds'. A player with no line gets no p.line. Never throws.
async function attachPropLines(players, schedule, rosterCache, market) {
  try {
    const byGame = new Map();
    await Promise.all(schedule.map(async g => byGame.set(String(g.gameId), {
      g, data: await fetchGamePropLines(g.gameId).catch(() => ({ lines: [] })),
    })));
    const indexes = new Map();
    for (const [id, { g, data }] of byGame) indexes.set(id, { provider: data.provider, idx: linesByName(data.lines || [], [rosterCache[g.homeAbbr], rosterCache[g.awayAbbr]], market) });
    let matched = 0;
    for (const p of players) {
      const gi = indexes.get(String(p.gameId));
      const l = gi?.idx.get(nameKey(p.name));
      if (!l) continue;
      const priced = market === 'anytime_td' ? priceAnytimeTd(p.prob, l.price) : priceYards(p, l);
      if (!priced) continue;
      p.line = { ...priced, openLine: l.openLine ?? null, book: gi.provider || null };
      matched++;
    }
    return { matched, games: byGame.size };
  } catch (e) {
    console.warn('prop lines failed:', e.message);
    return { matched: 0, error: e.message };
  }
}

// What the feed returned for a week's games, for checking the parser against live data: per game
// the book, raw item count, parsed lines by market, unmatched athletes, skip reasons, unknown
// market names and a few samples. rosterFor(abbr) → roster. Served at /api/props?view=lines.
async function propLinesReport(schedule, rosterFor) {
  return Promise.all(schedule.map(async g => {
    const [d, home, away] = await Promise.all([fetchGamePropLines(g.gameId), rosterFor(g.homeAbbr), rosterFor(g.awayAbbr)]);
    const names = new Map();
    for (const r of [home, away]) for (const e of Object.values(r || {})) if (e?.id) names.set(e.id, e.displayName);
    const byMarket = {};
    for (const l of d.lines) byMarket[l.market] = (byMarket[l.market] || 0) + 1;
    return {
      game: `${g.awayAbbr}@${g.homeAbbr}`, gameId: g.gameId, book: d.provider, rawItems: d.raw, espnCount: d.espnCount, pages: d.pages, byMarket,
      unmatchedAthletes: d.lines.filter(l => !names.has(l.athleteId)).length,
      skipped: d.skipped, unknownMarkets: d.unknownMarkets,
      // Raw ESPN items (links trimmed): one per skip reason, and one parsed yardage line.
      rawSamples: d.rawSamples || {},
      samples: d.lines.slice(0, 6).map(l => ({ ...l, name: names.get(l.athleteId) || null })),
    };
  }));
}

module.exports = { propLinesReport, attachPropLines, fetchGamePropLines, parsePropItem, mainLines, marketOf, linesByName, nameKey };
