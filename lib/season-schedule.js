// lib/season-schedule.js — full season schedule per team via ESPN (same family as lib/schedule.js)
//
// NOT YET VERIFIED LIVE — my sandbox can't reach ESPN's domain at all (confirmed earlier:
// `host_not_allowed` on any espn.com request). This uses the same site.api.espn.com
// convention as lib/schedule.js, which DOES work in your deployed Vercel environment —
// but this specific endpoint (team schedule, not week scoreboard) hasn't been separately
// tested against a real response. First thing to check if season projections come back
// empty: confirm this URL shape and the `ev.week.number` / `seasonType` field paths below
// actually match what ESPN returns.

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours — full season schedule barely changes week to week
const cache = {}; // keyed by `${teamAbbr}-${year}`

const TEAM_SCHEDULE_URL = (teamAbbr, year) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamAbbr}/schedule?season=${year}`;

async function fetchTeamSeasonSchedule(teamAbbr, year) {
  const key = `${teamAbbr}-${year}`;
  const cached = cache[key];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.games;

  try {
    const r = await fetch(TEAM_SCHEDULE_URL(teamAbbr, year), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const d = await r.json();
    const events = d.events || [];

    const games = events
      .filter(ev => ev.seasonType?.type === 2 || ev.seasonType?.id === '2') // regular season only, drop preseason/postseason
      .map(ev => {
        const comp = ev.competitions?.[0];
        const self = comp?.competitors?.find(c => c.team?.abbreviation === teamAbbr);
        const opp = comp?.competitors?.find(c => c.team?.abbreviation !== teamAbbr);
        return {
          week: ev.week?.number,
          oppAbbr: opp?.team?.abbreviation,
          isHome: self?.homeAway === 'home',
          completed: comp?.status?.type?.completed || false,
          teamScore: self?.score != null ? Number(self.score) : null,
          oppScore: opp?.score != null ? Number(opp.score) : null,
        };
      })
      .filter(g => g.oppAbbr && g.week); // drop bye weeks / malformed entries

    cache[key] = { games, timestamp: Date.now() };
    return games;
  } catch (e) {
    console.warn(`ESPN season schedule fetch failed for ${teamAbbr}:`, e.message);
    return null;
  }
}

module.exports = { fetchTeamSeasonSchedule };
