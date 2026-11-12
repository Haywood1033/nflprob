// api/prop-lines.js — what ESPN's prop feed returned for a week, for checking the parser against
// the live feed: per game, the book used, raw item count, parsed lines by market, why items were
// skipped, unrecognized market names and a few parsed samples. Not shown on the page.

const { fetchWeekSchedule, seasonFromQuery } = require('../lib/schedule.js');
const { fetchGamePropLines } = require('../lib/espn-props.js');
const { fetchTeamRoster } = require('../lib/roster.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const week = req.query.week;
  const year = seasonFromQuery(req.query);
  if (!week) return res.status(400).json({ error: 'week query param required, e.g. ?week=11' });

  const schedule = await fetchWeekSchedule(year, week);
  if (!schedule?.length) return res.status(200).json({ week, year, games: [], error: 'No schedule found' });

  const games = await Promise.all(schedule.map(async g => {
    const [d, home, away] = await Promise.all([fetchGamePropLines(g.gameId), fetchTeamRoster(g.homeAbbr), fetchTeamRoster(g.awayAbbr)]);
    const names = new Map();
    for (const r of [home, away]) for (const e of Object.values(r || {})) if (e?.id) names.set(e.id, e.displayName);
    const byMarket = {};
    for (const l of d.lines) byMarket[l.market] = (byMarket[l.market] || 0) + 1;
    return {
      game: `${g.awayAbbr}@${g.homeAbbr}`, gameId: g.gameId, book: d.provider, rawItems: d.raw, byMarket,
      unmatchedAthletes: d.lines.filter(l => !names.has(l.athleteId)).length,
      skipped: d.skipped, unknownMarkets: d.unknownMarkets,
      samples: d.lines.slice(0, 6).map(l => ({ ...l, name: names.get(l.athleteId) || null })),
    };
  }));
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
  return res.status(200).json({ week, year, games });
};
