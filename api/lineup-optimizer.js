const { buildDfsProjections } = require('../lib/dfs-projections.js');
const { optimizeLineups } = require('../lib/dfs-optimizer.js');
const { simLineups } = require('../lib/dfs-sim.js');

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

    // A QB who isn't this week's starter keeps his projection (shown, lockable) but only enters the
    // pool when the user locks him in.
    const isLocked = p => (Array.isArray(lockedIds) && lockedIds.includes(p.id)) || captainLockId === p.id;
    const pool = projectionData.players.filter(p => p.points > 0 && (!p.benched || isLocked(p)));
    // Capped at 20 to match standard large-field GPP max-entry limits. Each additional lineup
    // only re-runs the knapsack DP once for its candidate captain (a few thousand ops on a
    // ~30-40 player Showdown pool), so even 20 stays well within the request budget — the
    // expensive part (ranking every possible captain) happens once regardless of count.
    const count = Math.min(Math.max(Number(lineupCount) || 1, 1), 20);
    const opts = {
      count,
      maxExposure: Number(maxExposure) || 0.35,
      lockedIds: Array.isArray(lockedIds) ? lockedIds : [],
      captainLockId: captainLockId || null,
      excludedIds: Array.isArray(excludedIds) ? excludedIds : [],
      model: projectionData.model,
      // No kicker or defense captains unless locked there: across 370 replayed games they made
      // 12% / 5% of our captains vs 2% / 3% of the best lineups, and leaving them out raised the
      // best-of-20 lineup by +0.30 points a game (better in 62 games, worse in 39).
      noCaptainPositions: ['K', 'DST'],
      // Star captain: only the slate's top 4 projected players (excluding K/DST) captain unless one
      // is locked. Across the same 370 games: best of 20 +1.41 points (95% CI +0.71 to +2.13),
      // better in 176 games vs worse in 101, positive in both 2025 and 2026; average lineup +9.2.
      // Forcing a cheap ($3,000-or-less) receiver into every lineup was tested too and was worse
      // (−2.5), so the optimizer still only picks one when it pays.
      captainTopN: 4,
    };
    // Two or more lineups: chosen by simulating the game (lib/dfs-sim.js). On 370 replayed games
    // the best of 20 rose +2.88 points vs the optimizer (95% CI +2.17 to +3.63; better in 200
    // games, worse in 104; both seasons) and lineups within 90% of the best possible went from 24%
    // to 33% of games. One lineup stays the highest-projected build. If the simulation comes up
    // short of the count, the optimizer's lineups fill the rest.
    let lineups = count > 1 ? simLineups(pool, opts) : optimizeLineups(pool, opts);
    if (count > 1 && lineups.length < count) {
      const have = new Set(lineups.map(l => l.captain.id + '|' + l.flex.map(p => p.id).sort().join(',')));
      for (const l of optimizeLineups(pool, opts)) {
        if (lineups.length >= count) break;
        const k = l.captain.id + '|' + l.flex.map(p => p.id).sort().join(',');
        if (!have.has(k)) { have.add(k); lineups.push(l); }
      }
    }

    if (!lineups.length) {
      return res.status(200).json({
        error: 'No valid lineup fits the salary cap with these locks/excludes, or every remaining build would be drawn from a single team (DK Showdown requires both teams represented) — try unlocking a player, freeing up salary, or un-excluding someone from the other team',
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
