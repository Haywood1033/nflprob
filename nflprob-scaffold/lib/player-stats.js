// lib/player-stats.js — pulls player-level weekly stats from nflverse-data (free, no auth)
// Same release family as lib/nflverse.js (team-level), different tag: "stats_player"
//
// IMPORTANT: unlike the team-level file, this one has a quoted field with an embedded
// comma (headshot_url contains "f_auto,q_auto"), so a naive split(',') silently misaligns
// every column after it. This uses a real quote-aware parser to avoid that.

const CACHE_TTL = 60 * 60 * 1000;
let cache = { season: null, rows: null, timestamp: null };

const PLAYER_WEEK_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;

const NFLVERSE_ABBR_FIX = { LAR: 'LA', WSH: 'WAS' };
function toNflverseAbbr(espnAbbr) {
  return NFLVERSE_ABBR_FIX[espnAbbr] || espnAbbr;
}

// Quote-aware CSV line splitter — handles "a,b" as one field, "" as an escaped quote
function splitCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = splitCSVLine(line);
    const row = {};
    headers.forEach((h, i) => row[h.trim()] = cells[i]);
    return row;
  });
}

async function fetchPlayerWeekStats(season) {
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (cache.season === season && age < CACHE_TTL && cache.rows) return cache.rows;

  for (const trySeason of [season, season - 1]) {
    try {
      const r = await fetch(PLAYER_WEEK_URL(trySeason), { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const text = await r.text();
      const rows = parseCSV(text);
      cache = { season, rows, timestamp: Date.now(), sourceSeason: trySeason };
      return rows;
    } catch (e) {
      console.warn(`nflverse player-week fetch failed for ${trySeason}:`, e.message);
    }
  }
  return null;
}

module.exports = { fetchPlayerWeekStats, toNflverseAbbr, splitCSVLine };
