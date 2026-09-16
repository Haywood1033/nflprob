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

// Calls ESPN's scoreboard endpoint with NO week/year params, to get ESPN's own baseline
// "current week" signal. This is a STARTING POINT, not the final answer — ESPN's own label
// doesn't reliably advance the moment a week's games finish, so the real rollover rule
// (below, in fetchCurrentWeek) checks actual game completion + a Tuesday-morning ET buffer
// on top of this.
async function fetchRawCurrentWeek() {
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

// Returns the Eastern-time calendar date (Y-M-D, day-level only — not exact timestamps, to
// stay simple and avoid DST-edge-case bugs) for a given real Date.
function easternCalendarDate(date) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), weekday: parts.weekday };
}

// Given the Eastern calendar date of a week's LAST game, finds the very next Tuesday's
// Eastern calendar date (as a plain UTC-midnight-anchored Date, used only for day-level
// comparison — this deliberately never compares exact timestamps, since the goal is "has the
// calendar day become Tuesday or later," not to-the-minute precision).
function nextTuesdayAfter(easternDate) {
  const asUTCMidnight = new Date(Date.UTC(easternDate.y, easternDate.m - 1, easternDate.d));
  const weekdayIndex = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[easternDate.weekday];
  const daysUntilTuesday = ((2 - weekdayIndex) + 7) % 7 || 7; // if the last game itself fell on a Tuesday (rare), roll to the FOLLOWING Tuesday, not the same day
  return new Date(asUTCMidnight.getTime() + daysUntilTuesday * 24 * 60 * 60 * 1000);
}

// THE ACTUAL ROLLOVER RULE: once every game in the currently-reported week is complete, wait
// until the following Tuesday (Eastern calendar date) before advancing to week+1. Until then,
// even a fully-completed week still reports its own number — this matches the real request
// ("advance every Tuesday morning once games are officially over"), rather than advancing
// the instant the last game ends (which could be very late Monday night) or relying on
// ESPN's own current-week label, which doesn't update on this same schedule.
async function fetchCurrentWeek() {
  const raw = await fetchRawCurrentWeek();
  if (!raw) return null;

  const schedule = await fetchWeekSchedule(raw.year, raw.week, raw.seasonType);
  if (!schedule?.length) return raw; // can't verify completion — trust ESPN's raw label rather than guessing

  const allCompleted = schedule.every(g => g.completed);
  if (!allCompleted) return raw; // week genuinely isn't over yet

  const latestGameDate = new Date(Math.max(...schedule.map(g => new Date(g.date).getTime())));
  const rolloverDate = nextTuesdayAfter(easternCalendarDate(latestGameDate));
  const todayET = easternCalendarDate(new Date());
  const todayAsUTCMidnight = new Date(Date.UTC(todayET.y, todayET.m - 1, todayET.d));

  if (todayAsUTCMidnight >= rolloverDate) {
    return { week: raw.week + 1, year: raw.year, seasonType: raw.seasonType };
  }
  return raw; // week is done, but it's not Tuesday (ET) yet — hold at the current week
}

module.exports = { fetchWeekSchedule, fetchCurrentWeek, ESPN_TEAM_NAME };
