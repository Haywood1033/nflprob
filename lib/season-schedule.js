// lib/season-schedule.js — full season schedule per team via ESPN (same family as lib/schedule.js)
//
// VERIFIED against a real response (pasted directly from the live endpoint). Two real bugs
// this fixed:
//   1. Without &seasontype=2 in the URL, ESPN's team-schedule endpoint defaults to
//      PRESEASON (seasonType.type === 1). Every event came back as preseason, so the
//      regular-season filter below correctly rejected all of them — that's exactly what
//      produced "No season schedules returned from ESPN" for all 32 teams.
//   2. `score` is NOT a plain number — it's a nested object: {"value":20.0,"displayValue":"20"}.
//      The original code did Number(self.score), which silently produces NaN once real
//      games start completing (self.score is an object, not a number).

const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours — full season schedule barely changes week to week
const cache = {}; // keyed by `${teamAbbr}-${year}`

const TEAM_SCHEDULE_URL = (teamAbbr, year) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamAbbr}/schedule?season=${year}&seasontype=2`;

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
      .filter(ev => ev.seasonType?.type === 2 || ev.seasonType?.id === '2') // regular season only, drop preseason/postseason (belt-and-suspenders alongside &seasontype=2)
      .map(ev => {
        const comp = ev.competitions?.[0];
        const self = comp?.competitors?.find(c => c.team?.abbreviation === teamAbbr);
        const opp = comp?.competitors?.find(c => c.team?.abbreviation !== teamAbbr);
        return {
          week: ev.week?.number,
          oppAbbr: opp?.team?.abbreviation,
          isHome: self?.homeAway === 'home',
          completed: comp?.status?.type?.completed || false,
          teamScore: self?.score?.value != null ? Number(self.score.value) : null,
          oppScore: opp?.score?.value != null ? Number(opp.score.value) : null,
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
