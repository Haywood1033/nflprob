// lib/nflverse-roster.js — the league's own roster status per player (nflverse's roster file,
// refreshed daily from the NFL's transactions), as a second availability check next to ESPN.
//
// Why: ESPN's team roster can keep a player on the active list after he's moved to the practice
// squad. Week 12 of 2026: Elijah Mitchell (PHI) was still active on ESPN and showed up in DFS
// lineups while nflverse listed him as practice squad (DEV) since week 11; Kendre Miller and Israel
// Abanikanda (DAL) the same.
//
// Status codes: ACT active, RES reserve (IR, PUP, ...), DEV practice squad, CUT released,
// INA inactive, RET retired.

const { parseCSV, toNflverseAbbr } = require('./player-stats.js');

const CACHE_TTL = 60 * 60 * 1000;
const cache = {};
const URL = season => `https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_${season}.csv`;

const key = name => String(name || '').toLowerCase().replace(/[.'’]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/, '').replace(/\s+/g, ' ').trim();

// rows → { [team]: { [name key]: { status, position, week } } }; a player listed twice on a team
// keeps the latest week.
function indexRoster(rows) {
  const out = {};
  for (const r of rows || []) {
    if (!r.team || !r.full_name) continue;
    const t = out[r.team] || (out[r.team] = {});
    const wk = Number(r.week) || 0;
    for (const n of new Set([key(r.full_name), r.football_name && r.last_name ? key(`${r.football_name} ${r.last_name}`) : null].filter(Boolean))) {
      // Same week listed twice (a call-up): active wins.
      if (!t[n] || wk > t[n].week || (wk === t[n].week && r.status === 'ACT')) t[n] = { status: r.status, position: r.position, week: wk };
    }
  }
  return out;
}

async function fetchNflverseRoster(season) {
  const c = cache[season];
  if (c && Date.now() - c.timestamp < CACHE_TTL) return c.index;
  try {
    const r = await fetch(URL(season), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const index = indexRoster(parseCSV(await r.text()));
    cache[season] = { index, timestamp: Date.now() };
    return index;
  } catch (e) {
    console.warn(`nflverse roster fetch failed for ${season}:`, e.message);
    return null;
  }
}

const UNAVAILABLE = { DEV: 'on the practice squad', CUT: 'released' };

// Why the league's roster says he can't play for this team (practice squad, released), or null.
// A team with a thin listing (the file failed or is partial) checks nothing.
function nflverseRosterNote(index, name, dkTeam) {
  const t = index?.[{ JAC: 'JAX', LVR: 'LV' }[dkTeam] || toNflverseAbbr(dkTeam)];
  if (!t || Object.keys(t).length < 40) return null;
  const e = t[key(name)];
  return e && UNAVAILABLE[e.status] ? UNAVAILABLE[e.status] : null;
}

module.exports = { fetchNflverseRoster, indexRoster, nflverseRosterNote };
