// lib/roster.js — current active roster per team via ESPN (same family as lib/schedule.js)
//
// VERIFIED against a real PIT roster response (pasted directly from the live endpoint).
// This is the fix for the core problem flagged repeatedly this session: usage-history-based
// candidate pools have no way to know a player was released or traded in the offseason —
// Kenny Gainwell's 2025 game logs say Steelers, but he wasn't re-signed for 2026, and the
// real roster response confirms he simply doesn't appear anywhere in it.
//
// Real structure: { athletes: [ {position: 'offense'|'defense'|'specialTeam'|
// 'injuredReserveOrOut'|'suspended'|'practiceSquad', items: [...players]} ], team: {...} }
// Each player has position.abbreviation (matches nflverse's position codes directly, e.g.
// 'QB'/'WR'/'RB'/'TE' — no remapping needed) and an `injuries` array. IMPORTANT: injured
// players (confirmed via real data — Joey Porter Jr., Jalen Ramsey, both "status":"Out")
// can still appear in the main position groups, not just 'injuredReserveOrOut' — the
// authoritative injury signal is each player's own `injuries` array, not which group
// they're filed under.

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours — rosters don't change minute to minute
const cache = {}; // keyed by teamAbbr

const ROSTER_URL = (teamAbbr) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamAbbr}/roster`;

// Groups that represent players who could plausibly play this week.
// 'suspended' and 'practiceSquad' are excluded — neither is going to show up in a box score.
const EXCLUDED_GROUPS = new Set(['suspended', 'practiceSquad']);

async function fetchTeamRoster(teamAbbr) {
  const cached = cache[teamAbbr];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.roster;

  try {
    const r = await fetch(ROSTER_URL(teamAbbr), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const d = await r.json();
    const groups = d.athletes || [];

    const roster = {}; // displayName -> { position, injured, injuryStatus, statusGroup }
    for (const g of groups) {
      if (EXCLUDED_GROUPS.has(g.position)) continue;
      for (const p of (g.items || [])) {
        const hasInjuryEntry = Array.isArray(p.injuries) && p.injuries.length > 0;
        roster[p.displayName] = {
          position: p.position?.abbreviation || null,
          injured: hasInjuryEntry || g.position === 'injuredReserveOrOut',
          injuryStatus: hasInjuryEntry ? p.injuries[0].status : (g.position === 'injuredReserveOrOut' ? 'Injured Reserve' : null),
          statusGroup: g.position,
        };
      }
    }

    cache[teamAbbr] = { roster, timestamp: Date.now() };
    return roster;
  } catch (e) {
    console.warn(`ESPN roster fetch failed for ${teamAbbr}:`, e.message);
    return null;
  }
}

// roster is null if the fetch failed — callers should treat that as "couldn't verify,
// don't filter" rather than silently excluding everyone.
function isOnRoster(roster, playerName) {
  if (!roster) return true;
  return Object.prototype.hasOwnProperty.call(roster, playerName);
}

function isHealthy(roster, playerName) {
  if (!roster || !roster[playerName]) return true;
  return !roster[playerName].injured;
}

module.exports = { fetchTeamRoster, isOnRoster, isHealthy };
