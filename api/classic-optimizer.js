const { buildClassicProjections } = require('../lib/dfs-projections.js');
const { optimizeClassicLineups } = require('../lib/classic-optimizer.js');

// DK Classic: a full multi-game slate, real roster positions (QB/RB/RB/WR/WR/WR/TE/FLEX/DST),
// $50,000 cap, no Captain multiplier. See lib/classic-optimizer.js for the roster math and
// lib/dfs-projections.js's buildClassicProjections() for how each player is matched to their
// OWN game (not necessarily the same game as any other uploaded player, unlike Showdown).
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { players, year, lockedIds, excludedIds, lineupCount, maxExposure } = req.body || {};
  if (!Array.isArray(players) || !players.length) {
    return res.status(400).json({ error: 'players array required — upload a DK Classic salary CSV/XLSX' });
  }
  if (!year) {
    return res.status(400).json({ error: 'year is required (parsed from the salary file\'s Game Info column)' });
  }
  if (players.some(p => !p.awayAbbr || !p.homeAbbr)) {
    return res.status(400).json({ error: 'every player row needs its own awayAbbr/homeAbbr (parsed per-row from that player\'s Game Info cell)' });
  }

  const start = Date.now();
  try {
    const projectionData = await buildClassicProjections({ uploadedPlayers: players, year: Number(year) });

    const pool = projectionData.players.filter(p => p.points > 0);
    // Capped at 20 to match standard large-field GPP max-entry limits, same reasoning as
    // api/lineup-optimizer.js.
    const count = Math.min(Math.max(Number(lineupCount) || 1, 1), 20);
    const lineups = optimizeClassicLineups(pool, {
      count,
      maxExposure: Number(maxExposure) || 0.35,
      lockedIds: Array.isArray(lockedIds) ? lockedIds : [],
      excludedIds: Array.isArray(excludedIds) ? excludedIds : [],
    });

    if (!lineups.length) {
      return res.status(200).json({
        error: 'No valid lineup fits the salary cap and roster shape (QB/RB/RB/WR/WR/WR/TE/FLEX/DST) with these locks/excludes — try unlocking a player or freeing up salary',
        week: projectionData.week, year: projectionData.year, games: projectionData.games,
        players: projectionData.players,
      });
    }

    return res.status(200).json({
      week: projectionData.week, year: projectionData.year,
      games: projectionData.games,
      lineups,
      players: projectionData.players,
      elapsed: Date.now() - start,
    });
  } catch (e) {
    return res.status(200).json({ error: e.message || String(e) });
  }
};
