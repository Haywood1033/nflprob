const SCOREBOARD_URL = (year, week, seasontype = 2) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=${year}&week=${week}&seasontype=${seasontype}`;

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
      const odds = comp?.odds?.[0];
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
        homeScore:  home?.score != null ? Number(home.score) : null,
        awayScore:  away?.score != null ? Number(away.score) : null,
      };
    });
  } catch (e) {
    console.warn('ESPN schedule fetch failed:', e.message);
    return null;
  }
}

// Calls ESPN's scoreboard endpoint with NO week/year params. Confirmed via a live check
// that ESPN's own default behavior returns the CURRENT real week and season directly
// (week.number, season.year) rather than requiring the caller to already know or guess it.
// This is what lets the app auto-advance week-to-week without a hardcoded default.
async function fetchCurrentWeek() {
  try {
    const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.week?.number || !d.season?.year) return null;
    return { week: d.week.number, year: d.season.year, seasonType: d.season.type };
  } catch (e) {
    console.warn('ESPN current-week fetch failed:', e.message);
    return null;
  }
}

module.exports = { fetchWeekSchedule, fetchCurrentWeek, ESPN_TEAM_NAME };
