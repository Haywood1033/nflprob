// lib/schedule.js — ESPN's unofficial API (free, no auth), mirrors lib/lineups.js pattern from HR engine
// Provides: week schedule, venue info, spreads/O-U if ESPN exposes them, injury reports

const SCOREBOARD_URL = (year, week, seasontype = 2) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=${year}&week=${week}&seasontype=${seasontype}`;

const TEAM_INJURIES_URL = (teamId) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/injuries`;

// ESPN team abbreviation → our display name (matches weather.js STADIUM_COORDS keys)
const ESPN_TEAM_NAME = {
  BUF:'Bills', MIA:'Dolphins', NE:'Patriots', NYJ:'Jets',
  BAL:'Ravens', CIN:'Bengals', CLE:'Browns', PIT:'Steelers',
  HOU:'Texans', IND:'Colts', JAX:'Jaguars', TEN:'Titans',
  DEN:'Broncos', KC:'Chiefs', LV:'Raiders', LAC:'Chargers',
  DAL:'Cowboys', NYG:'Giants', PHI:'Eagles', WSH:'Commanders',
  CHI:'Bears', DET:'Lions', GB:'Packers', MIN:'Vikings',
  ATL:'Falcons', CAR:'Panthers', NO:'Saints', TB:'Buccaneers',
  ARI:'Cardinals', LAR:'Rams', SF:'49ers', SEA:'Seahawks',
};

async function fetchWeekSchedule(year, week, seasontype = 2) {
  try {
    const r = await fetch(SCOREBOARD_URL(year, week, seasontype), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const d = await r.json();
    const events = d.events || [];

    return events.map(ev => {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      const odds = comp?.odds?.[0]; // ESPN sometimes exposes a consensus line — treat as supplementary only, not primary signal per our free-data decision
      return {
        gameId:    ev.id,
        date:      ev.date,
        homeTeam:  ESPN_TEAM_NAME[home?.team?.abbreviation] || home?.team?.displayName,
        awayTeam:  ESPN_TEAM_NAME[away?.team?.abbreviation] || away?.team?.displayName,
        homeAbbr:  home?.team?.abbreviation,
        awayAbbr:  away?.team?.abbreviation,
        venue:     comp?.venue?.fullName,
        indoor:    comp?.venue?.indoor || false,
        espnSpread: odds?.details || null,
        espnOU:     odds?.overUnder || null,
        completed:  comp?.status?.type?.completed || false,
        homeScore:  home?.score ? Number(home.score) : null,
        awayScore:  away?.score ? Number(away.score) : null,
      };
    });
  } catch (e) {
    console.warn('ESPN schedule fetch failed:', e.message);
    return null;
  }
}

async function fetchTeamInjuries(espnTeamId) {
  try {
    const r = await fetch(TEAM_INJURIES_URL(espnTeamId), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const d = await r.json();
    const items = d.injuries || [];
    return items.map(i => ({
      player:  i.athlete?.displayName,
      status:  i.status, // Out / Doubtful / Questionable / IR
      details: i.details?.type,
    }));
  } catch (e) {
    return [];
  }
}

module.exports = { fetchWeekSchedule, fetchTeamInjuries, ESPN_TEAM_NAME };
