// lib/roster.js — current active roster per team via ESPN (same family as lib/schedule.js)
//
// VERIFIED against a real PIT roster response (pasted directly from the live endpoint) —
// see git history / conversation for that verification.
//
// NAME NORMALIZATION FIX: isOnRoster() originally did an exact string match between
// nflverse's player_display_name and ESPN's displayName. Real bug found in production: A.J.
// Brown is stored as "A.J. Brown" (with periods) in nflverse, but real rosters/APIs commonly
// format the same name without periods ("AJ Brown") — an exact-match comparison silently
// drops a real, obviously-rostered star player with no error, no warning, nothing. Since this
// is a class of bug (any player with periods, suffixes, or spacing that differs between the
// two data sources), the fix is a normalized comparison, not a special case for one player.

const CACHE_TTL = 6 * 60 * 60 * 1000;
const cache = {};

const ROSTER_URL = (teamAbbr) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamAbbr}/roster`;

const EXCLUDED_GROUPS = new Set(['suspended', 'practiceSquad']);

// A suspended player (Commissioner's Exempt List, NFL suspension, etc.) is a HARD exclusion,
// not just a flag — unlike "questionable"/"day-to-day," there's zero chance they play this
// week. ESPN doesn't reliably re-bucket a suspended player into a dedicated top-level group;
// they can remain listed in their normal offense/defense group with a status field indicating
// suspension instead. Real example that surfaced this: Josh Jacobs (GB) — real, confirmed
// suspension — still showing up with a normal-looking projection, meaning ESPN's response for
// him wasn't landing in the 'suspended' top-level group this code already excludes.
function isSuspendedStatus(p) {
  const statusText = `${p.status?.type || ''} ${p.status?.name || ''} ${p.status?.abbreviation || ''}`.toLowerCase();
  if (/suspend|exempt/.test(statusText)) return true;
  const injuryText = (p.injuries || []).map(i => i.status || '').join(' ').toLowerCase();
  if (/suspend|exempt/.test(injuryText)) return true;
  return false;
}

// Strips periods, collapses whitespace, lowercases. Deliberately does NOT strip suffixes
// (Jr./Sr./II/III) since those usually distinguish real different players (e.g. two family
// members in the league) rather than being a formatting inconsistency.
function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

async function fetchTeamRoster(teamAbbr) {
  const cached = cache[teamAbbr];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.roster;

  try {
    const r = await fetch(ROSTER_URL(teamAbbr), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const d = await r.json();
    const groups = d.athletes || [];

    // Keyed by NORMALIZED name so lookups are resilient to punctuation/spacing differences
    // between nflverse and ESPN. Original displayName is kept too, for display purposes.
    const roster = {};
    for (const g of groups) {
      if (EXCLUDED_GROUPS.has(g.position)) continue;
      for (const p of (g.items || [])) {
        const hasInjuryEntry = Array.isArray(p.injuries) && p.injuries.length > 0;
        roster[normalizeName(p.displayName)] = {
          displayName: p.displayName,
          position: p.position?.abbreviation || null,
          injured: hasInjuryEntry || g.position === 'injuredReserveOrOut',
          injuryStatus: hasInjuryEntry ? p.injuries[0].status : (g.position === 'injuredReserveOrOut' ? 'Injured Reserve' : null),
          suspended: isSuspendedStatus(p),
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
  return Object.prototype.hasOwnProperty.call(roster, normalizeName(playerName));
}

function isHealthy(roster, playerName) {
  if (!roster) return true;
  const entry = roster[normalizeName(playerName)];
  if (!entry) return true;
  return !entry.injured;
}

// Looks up the roster entry (for injuryStatus, etc.) using the same normalized-name logic,
// since callers currently do roster?.[candidate.name]?.injuryStatus with the RAW name — that
// exact-match lookup has the identical bug this file just fixed for isOnRoster/isHealthy.
function getRosterEntry(roster, playerName) {
  if (!roster) return null;
  return roster[normalizeName(playerName)] || null;
}

function isSuspended(roster, playerName) {
  if (!roster) return false; // fail open, same principle as isHealthy — no roster data means we can't verify, don't assume
  const entry = roster[normalizeName(playerName)];
  return !!entry?.suspended;
}

module.exports = { fetchTeamRoster, isOnRoster, isHealthy, isSuspended, getRosterEntry, normalizeName };
