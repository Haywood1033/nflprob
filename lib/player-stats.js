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
// Fix: for each TEAM, use CURRENT-season rows if that team has any yet; if a team hasn't
// played its first current-season game, fall back to PRIOR-season rows for everyone on it as
// a stand-in. Early in a season the array is a genuine mix — real 2026 data for teams who've
// played, real 2025 data as a placeholder for teams who haven't yet.
//
// TEAM-SCOPED, NOT PLAYER-SCOPED: this used to check "does this PLAYER have current rows,"
// which looks equivalent early in the season (a team with no games yet means none of its
// players have rows either) but silently breaks the moment someone stops playing while their
// own team keeps playing without them — a benched or inactive veteran with zero current-week
// stats would keep getting his ENTIRE prior season spliced back in, forever, as if it were
// still current. Real symptom: Jaxson Dart (NYG, 29 real attempts in the actual current week)
// kept losing the team's passing-prop slot to Russell Wilson, who hasn't thrown a single pass
// this season — because Wilson had zero CURRENT rows, his full prior-season workload got
// blended in and outranked Dart's real, current, smaller sample. Checking the TEAM's own
// current-season presence instead of the individual player's fixes this: once NYG has a real
// 2026 game on the board, a teammate with no rows in it isn't "not in this week's data yet,"
// he's not playing — so no prior-season stand-in for him.
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

  // Some current-season games exist. Blend: current-season rows as-is, prior-season rows
  // spliced in only for players on a TEAM that hasn't recorded a current-season game yet.
  const priorRows = await fetchSeasonFile(season - 1);
  const teamsWithCurrentData = new Set(
    currentRows.filter(r => r.season_type === 'REG').map(r => r.team)
  );
  const supplementalRows = (priorRows || []).filter(r => !teamsWithCurrentData.has(r.team));
  const blended = [...currentRows, ...supplementalRows];

  cache = { season, rows: blended, timestamp: Date.now(), sourceSeason: `${season} (blended with ${season - 1} for teams without current data)` };
  return blended;
}

module.exports = { fetchPlayerWeekStats, toNflverseAbbr, splitCSVLine };
