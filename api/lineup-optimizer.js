const { buildDfsProjections } = require('../lib/dfs-projections.js');
const { optimizeLineups } = require('../lib/dfs-optimizer.js');

// Single-game Showdown only (Captain + 5 FLEX, one game). A DK "Classic" multi-game slate
// uses real roster positions (QB/RB/RB/WR/WR/WR/TE/FLEX/DST) and a schedule spanning several
// games — different enough (different roster shape, different "which week" inference per
// game, no single Captain multiplier) that it isn't supported here yet.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { players, awayAbbr, homeAbbr, year, lockedIds, captainLockId, excludedIds, lineupCount, maxExposure } = req.body || {};
  if (!Array.isArray(players) || !players.length) {
    return res.status(400).json({ error: 'players array required — upload a DK Showdown salary CSV/XLSX and pass its FLEX rows' });
  }
  if (!awayAbbr || !homeAbbr || !year) {
    return res.status(400).json({ error: 'awayAbbr, homeAbbr, and year are required (parsed from the salary file\'s Game Info column)' });
  }

  const start = Date.now();
  try {
    const projectionData = await buildDfsProjections({ uploadedPlayers: players, year: Number(year), awayAbbr, homeAbbr });

    const pool = projectionData.players.filter(p => p.points > 0);
    // Capped at 20 to match standard large-field GPP max-entry limits. Each additional lineup
    // only re-runs the knapsack DP once for its candidate captain (a few thousand ops on a
    // ~30-40 player Showdown pool), so even 20 stays well within the request budget — the
    // expensive part (ranking every possible captain) happens once regardless of count.
    const count = Math.min(Math.max(Number(lineupCount) || 1, 1), 20);
    const lineups = optimizeLineups(pool, {
      count,
      maxExposure: Number(maxExposure) || 0.35,
      lockedIds: Array.isArray(lockedIds) ? lockedIds : [],
      captainLockId: captainLockId || null,
      excludedIds: Array.isArray(excludedIds) ? excludedIds : [],
    });

    if (!lineups.length) {
      return res.status(200).json({
        error: 'No valid lineup fits the salary cap with these locks/excludes — try unlocking a player or freeing up salary',
        week: projectionData.week, year: projectionData.year, model: projectionData.model,
        players: projectionData.players,
      });
    }

    return res.status(200).json({
      week: projectionData.week, year: projectionData.year,
      away: projectionData.away, home: projectionData.home,
      model: projectionData.model,
      lineups,
      players: projectionData.players,
      elapsed: Date.now() - start,
    });
  } catch (e) {
    return res.status(200).json({ error: e.message || String(e) });
  }
};
