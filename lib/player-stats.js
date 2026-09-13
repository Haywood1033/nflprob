// lib/player-stats.js — pulls player-level weekly stats from nflverse-data (free, no auth)
const CACHE_TTL = 60 * 60 * 1000;
let cache = { season: null, rows: null, timestamp: null };

const PLAYER_WEEK_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`;

const NFLVERSE_ABBR_FIX = { LAR: 'LA', WSH: 'WAS' };
function toNflverseAbbr(espnAbbr) {
  return NFLVERSE_ABBR_FIX[espnAbbr] || espnAbbr;
}

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

async function fetchSeasonFile(season) {
  try {
    const r = await fetch(PLAYER_WEEK_URL(season), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const text = await r.text();
    return parseCSV(text);
  } catch (e) {
    console.warn(`nflverse player-week fetch failed for ${season}:`, e.message);
    return null;
  }
}

// BLENDED FALLBACK (not all-or-nothing): the old logic checked "does the current season have
// ANY real REG rows at all" and, if so, used ONLY that season's data — nothing from last
// year. That's wrong for the first few weeks of a real season: once even one game has been
// played, the app would fully stop using 2025 data, meaning every team that HASN'T played
// yet this week gets zero usage history and produces no projections at all. Real symptom
// this caused: only teams from the 1-2 games already played had any player prop data.
//
// Fix: for each player, use their CURRENT-season rows if any exist; if a player has no
// current-season REG rows yet, fall back to their PRIOR-season rows as a stand-in. This
// happens per-player, not as one global season choice, so early in a season the array is a
// genuine mix — real 2026 data for teams who've played, real 2025 data as a placeholder for
// teams who haven't yet.
async function fetchPlayerWeekStats(season) {
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (cache.season === season && age < CACHE_TTL && cache.rows) return cache.rows;

  const currentRows = await fetchSeasonFile(season);
  const hasAnyCurrentReg = currentRows && currentRows.some(r => r.season_type === 'REG');

  if (!hasAnyCurrentReg) {
    // No real current-season games at all yet — full prior-season fallback, same as before.
    const priorRows = await fetchSeasonFile(season - 1);
    if (priorRows) {
      cache = { season, rows: priorRows, timestamp: Date.now(), sourceSeason: season - 1 };
      return priorRows;
    }
    return null;
  }

  // Some current-season games exist. Blend: current-season rows for anyone who has them,
  // prior-season rows spliced in for anyone who doesn't yet.
  const priorRows = await fetchSeasonFile(season - 1);
  const playersWithCurrentData = new Set(
    currentRows.filter(r => r.season_type === 'REG').map(r => r.player_display_name)
  );
  const supplementalRows = (priorRows || []).filter(r => !playersWithCurrentData.has(r.player_display_name));
  const blended = [...currentRows, ...supplementalRows];

  cache = { season, rows: blended, timestamp: Date.now(), sourceSeason: `${season} (blended with ${season - 1} for players without current data)` };
  return blended;
}

module.exports = { fetchPlayerWeekStats, toNflverseAbbr, splitCSVLine };
