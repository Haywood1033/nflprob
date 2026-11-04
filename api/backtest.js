// GET /api/backtest?seasons=2025,2026 — leak-free backtest of the game model and the TD and
// yardage props (lib/backtest.js), scored against real results and the Vegas lines. With a
// database, a run over 150+ games saves the calibrations it fitted (lib/calibration.js); each one
// is applied live only if it helped on the held-out half of the games.
const { runBacktest } = require('../lib/backtest.js');
const { saveCalibration, hasDb } = require('../lib/calibration.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    const seasons = String(req.query.seasons || '').split(',').map(Number).filter(n => n >= 2015 && n <= 2100);
    const bt = await runBacktest(seasons.length ? { seasons } : { currentOnly: req.query.scope === 'current' });
    bt.calibrationSaved = false;
    if (hasDb && bt.games >= 150) { try { bt.calibrationSaved = await saveCalibration(bt); } catch (e) { bt.calibrationError = e.message; } }
    else bt.calibrationNote = hasDb ? `Calibrations are saved from runs of 150+ games (this one has ${bt.games}).` : 'No database connected, so calibrations are not saved.';
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(bt);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};
