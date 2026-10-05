// api/history.js — uses pg (node-postgres) directly, mirrors HR engine's history.js
// Works with Supabase's Postgres connection string as-is (DATABASE_URL from Supabase settings).
const { query, parseWeekKey, safeJsonParse, ENSURE_TABLE_SQL } = require('../lib/db.js');
const { gradeWeekPredictions, summarizeGraded } = require('../lib/grading.js');

// Combines every already-graded prediction across the stored weeks into one calibration
// summary — this is what the Accuracy tab's top-line numbers come from. Scoped to graded
// records only (resultsAdded) since an ungraded week has no `actual`/`hit` values yet.
function aggregateAcrossWeeks(rows) {
  const allPredictions = [];
  for (const r of rows) {
    if (!r.results_added || !Array.isArray(r.predictions)) continue;
    allPredictions.push(...r.predictions);
  }
  return allPredictions.length ? summarizeGraded(allPredictions) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await query(ENSURE_TABLE_SQL);

    if (req.method === 'GET') {
      const { rows } = await query(`SELECT * FROM weekly_predictions ORDER BY week DESC LIMIT 30`);
      return res.status(200).json({
        records: rows.map(r => ({
          week: r.week, predictions: r.predictions,
          teamModel: r.team_model,
          signalLock: r.signal_lock,
          resultsAdded: r.results_added, summary: safeJsonParse(r.summary),
          savedAt: r.saved_at, fetchedAt: r.fetched_at,
        })),
        count: rows.length,
        aggregate: aggregateAcrossWeeks(rows),
      });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { action, week, predictions, teamModel, signalLock } = body;

      if (action === 'save_lock') {
        if (!week || !signalLock) return res.status(400).json({ error: 'Missing week or signalLock' });
        const updated = await query(
          `UPDATE weekly_predictions SET signal_lock = $2::jsonb WHERE week = $1`,
          [week, JSON.stringify(signalLock)]
        );
        if (updated.rowCount === 0) {
          await query(
            `INSERT INTO weekly_predictions (week, signal_lock) VALUES ($1, $2::jsonb) ON CONFLICT (week) DO UPDATE SET signal_lock = $2::jsonb`,
            [week, JSON.stringify(signalLock)]
          );
        }
        return res.status(200).json({ ok: true, week });
      }

      if (action === 'save') {
        if (!week || !predictions?.length)
          return res.status(400).json({ error: 'Missing week or predictions' });

        const existing = await query(`SELECT results_added, saved_at FROM weekly_predictions WHERE week=$1`, [week]);
        if (existing.rows[0]) {
          return res.status(200).json({ ok: true, week, skipped: true, reason: 'Already saved for ' + week });
        }

        // predictions: array of { name, propType, position, team, line, prediction, hit: null }
        // propType ∈ 'anytime_td' | 'rush_yds' | 'rec_yds' | 'pass_yds' | 'game_winner' | 'total_points'
        const preds = JSON.stringify(predictions.map(p => ({ ...p, hit: null })));
        const teamModelData = teamModel ? JSON.stringify(teamModel) : null;
        const lockData = signalLock ? JSON.stringify(signalLock) : null;

        await query(`
          INSERT INTO weekly_predictions (week, predictions, team_model, signal_lock)
          VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)
          ON CONFLICT (week) DO NOTHING
        `, [week, preds, teamModelData, lockData]);

        return res.status(200).json({ ok: true, week, count: predictions.length });
      }

      if (action === 'results') {
        if (!week) return res.status(400).json({ error: 'Missing week' });

        const { rows } = await query(`SELECT * FROM weekly_predictions WHERE week=$1`, [week]);
        const record = rows[0];
        if (!record) return res.status(404).json({ error: 'No predictions for ' + week });
        if (record.results_added) {
          return res.status(200).json({ ok: true, record: {
            week: record.week,
            predictions: record.predictions,
            teamModel: record.team_model,
            resultsAdded: record.results_added,
            summary: safeJsonParse(record.summary),
          }, alreadyAdded: true });
        }

        const parsed = parseWeekKey(record.week);
        if (!parsed) return res.status(500).json({ error: `Stored week key "${record.week}" isn't in the expected YYYY-WNN format` });

        const { graded, summary, fullyGraded, partiallyGraded } = await gradeWeekPredictions(parsed.week, parsed.year, record.predictions || []);
        if (!partiallyGraded) {
          return res.status(200).json({ ok: true, week, notReady: true, message: 'None of this week\'s games have final scores yet — try again after kickoff' });
        }

        // Only mark fully graded weeks as "done" — a partial grade (e.g. checked mid-Sunday,
        // before SNF/MNF finish) gets its predictions updated with whatever's gradeable so
        // far, but stays open so a later call can fill in the rest instead of locking in an
        // incomplete picture as final.
        await query(
          `UPDATE weekly_predictions SET predictions = $2::jsonb, results_added = $3, summary = $4 WHERE week = $1`,
          [week, JSON.stringify(graded), fullyGraded, JSON.stringify(summary)]
        );

        return res.status(200).json({ ok: true, week, fullyGraded, partiallyGraded, summary, predictions: graded });
      }
    }
  } catch (e) {
    console.error('History API error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
};
