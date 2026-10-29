// lib/red-zone.js — real red-zone/inside-the-10 touch share and team red-zone TRIP efficiency,
// from nflverse's play-by-play release. Fills the `redZoneTdRate: null` placeholder left in
// lib/nflverse.js and the "No red-zone-rate column exists in this file — would need
// play-by-play data" note in the README: this is that play-by-play data.
//
// This file is in a different size class than everything else fetched (300+ columns, tens of
// thousands of rows per season vs. one row per team/player per week) — gzipped on the wire, so
// it's decompressed with Node's built-in zlib rather than adding a dependency. Only the ~13
// columns actually used are kept per row; the other ~360 are dropped immediately during
// parsing rather than held in memory.
//
// JOIN KEY: players here are matched by `player_id` (nflverse's GSIS id), not name — PBP's own
// name fields (`rusher_player_name`/`receiver_player_name`) are abbreviated ("J.Allen", not
// "Josh Allen"), verified against real rows, so they don't match stats_player_week's
// `player_display_name` directly. `player_id` is the exact same GSIS id format in both files
// (verified: "00-0023459" in both), so every caller should look players up by `player_id`
// (already present on every row returned by lib/player-stats.js) rather than by name.
const zlib = require('zlib');
const { splitCSVLine } = require('./player-stats.js');

const CACHE_TTL = 6 * 60 * 60 * 1000; // red-zone usage shifts slowly across a season — no need to refetch hourly
let cache = { season: null, rows: null, timestamp: null, sourceSeason: null };

const PBP_URL = (season) => `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;

const NEEDED_COLS = [
  'game_id', 'week', 'season_type', 'posteam', 'yardline_100', 'play_type',
  'rush_attempt', 'pass_attempt', 'rusher_player_id', 'receiver_player_id',
  'fixed_drive', 'fixed_drive_result', 'drive_inside20',
];

async function fetchSeasonPbp(season) {
  try {
    const r = await fetch(PBP_URL(season), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const gz = Buffer.from(await r.arrayBuffer());
    const text = zlib.gunzipSync(gz).toString('utf8');
    const lines = text.split('\n');
    if (!lines.length) return null;

    const header = splitCSVLine(lines[0]);
    const idx = {};
    for (const c of NEEDED_COLS) {
      const i = header.indexOf(c);
      if (i >= 0) idx[c] = i;
    }

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cells = splitCSVLine(line);
      const row = {};
      for (const c of NEEDED_COLS) row[c] = idx[c] != null ? cells[idx[c]] : '';
      rows.push(row);
    }
    return rows;
  } catch (e) {
    console.warn(`nflverse play-by-play fetch failed for ${season}:`, e.message);
    return null;
  }
}

// Single-season fetch with a whole-season fallback (not the per-team blend lib/player-stats.js
// does) — early in a season with few real red-zone trips yet, last season's full distribution
// is a more honest denominator than a tiny, noisy current-season one. A proper per-team blend
// across two play-by-play files is a real gap, not implemented here.
async function fetchPbp(season) {
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (cache.season === season && age < CACHE_TTL && cache.rows) return cache.rows;

  let rows = await fetchSeasonPbp(season);
  let sourceSeason = season;
  const hasAnyReg = rows && rows.some(r => r.season_type === 'REG');
  if (!hasAnyReg) {
    const prior = await fetchSeasonPbp(season - 1);
    if (prior) { rows = prior; sourceSeason = season - 1; }
  }
  if (!rows) return null;

  cache = { season, rows, timestamp: Date.now(), sourceSeason };
  return rows;
}

const RZ_YARDLINE = 20;
const INSIDE10_YARDLINE = 10;

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

// Aggregates real red-zone (yardline_100 <= 20) and inside-the-10 (<= 10) touches — rush
// attempts plus targets (any pass attempt with a credited receiver, caught or not: target
// volume is the usage signal, not just completions) — per player (by player_id) and per team
// (the denominator for touch SHARE), plus a per-TRIP red-zone TD rate derived from real drive
// outcomes (`fixed_drive_result`/`drive_inside20`), not a per-play proxy that would understate
// teams who run extra red-zone plays before scoring.
function computeRedZoneStats(rows, throughWeek) {
  const weekFilter = throughWeek < 1 ? () => true : (r) => Number(r.week) <= throughWeek;
  const reg = rows.filter(r => r.season_type === 'REG' && weekFilter(r));

  const playerRz = {};   // "team|player_id" -> { team, rzTouches, inside10Touches }
  const teamRzTotal = {}; // team -> { rzTouches, inside10Touches }

  for (const r of reg) {
    if (r.play_type !== 'run' && r.play_type !== 'pass') continue;
    const yd = num(r.yardline_100);
    if (yd <= 0 || yd > RZ_YARDLINE) continue;
    const team = r.posteam;
    if (!team) continue;
    const inside10 = yd <= INSIDE10_YARDLINE;

    const playerId = r.rush_attempt === '1' ? r.rusher_player_id
      : r.pass_attempt === '1' ? r.receiver_player_id
      : null;
    if (!playerId) continue; // scrambles/sacks/spikes/kneels carry no credited rusher or target

    const key = team + '|' + playerId;
    if (!playerRz[key]) playerRz[key] = { team, rzTouches: 0, inside10Touches: 0 };
    playerRz[key].rzTouches++;
    if (inside10) playerRz[key].inside10Touches++;

    if (!teamRzTotal[team]) teamRzTotal[team] = { rzTouches: 0, inside10Touches: 0 };
    teamRzTotal[team].rzTouches++;
    if (inside10) teamRzTotal[team].inside10Touches++;
  }

  // One row per drive is enough to grade it, so dedupe by (game_id, fixed_drive) rather than
  // counting every play in the drive.
  const seenDrives = new Set();
  const teamTrips = {}; // team -> { trips, tds }
  for (const r of reg) {
    if (r.drive_inside20 !== '1') continue;
    const driveKey = r.game_id + '|' + r.fixed_drive;
    if (seenDrives.has(driveKey)) continue;
    seenDrives.add(driveKey);
    const team = r.posteam;
    if (!team) continue;
    if (!teamTrips[team]) teamTrips[team] = { trips: 0, tds: 0 };
    teamTrips[team].trips++;
    if (r.fixed_drive_result === 'Touchdown') teamTrips[team].tds++;
  }

  return { playerRz, teamRzTotal, teamTrips };
}

// playerId must be the player's GSIS `player_id` — see the JOIN KEY note at the top of this file.
function playerRedZoneShare(stats, team, playerId) {
  if (!playerId) return null;
  const p = stats.playerRz[team + '|' + playerId];
  const teamTotal = stats.teamRzTotal[team];
  if (!p || !teamTotal || !teamTotal.rzTouches) return null;
  return {
    rzTouches: p.rzTouches,
    inside10Touches: p.inside10Touches,
    rzTouchShare: +(p.rzTouches / teamTotal.rzTouches).toFixed(3),
    inside10Share: teamTotal.inside10Touches ? +(p.inside10Touches / teamTotal.inside10Touches).toFixed(3) : null,
  };
}

// Real red-zone-trips-to-touchdown rate for a team — fills lib/nflverse.js's
// `redZoneTdRate: null` placeholder, which lib/team-scoring.js already has a (previously dead)
// hook for.
function teamRedZoneTdRate(stats, team) {
  const t = stats.teamTrips[team];
  if (!t || !t.trips) return null;
  return +(t.tds / t.trips).toFixed(3);
}

module.exports = { fetchPbp, computeRedZoneStats, playerRedZoneShare, teamRedZoneTdRate, PBP_URL };
