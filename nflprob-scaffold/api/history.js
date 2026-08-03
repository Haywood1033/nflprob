// api/history.js — uses pg (node-postgres) directly, mirrors HR engine's history.js
// Works with Supabase's Postgres connection string as-is (DATABASE_URL from Supabase settings).
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function query(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await query(`
      CREATE TABLE IF NOT EXISTS weekly_predictions (
        id            SERIAL PRIMARY KEY,
        week          VARCHAR(10) UNIQUE NOT NULL,
        predictions   JSONB,
        team_model    JSONB,
        signal_lock   JSONB,
        results_added BOOLEAN DEFAULT FALSE,
        summary       TEXT,
        saved_at      TIMESTAMP DEFAULT NOW(),
        fetched_at    TIMESTAMP
      )
    `);

    if (req.method === 'GET') {
      const { rows } = await query(`SELECT * FROM weekly_predictions ORDER BY week DESC LIMIT 30`);
      return res.status(200).json({
        records: rows.map(r => ({
          week: r.week, predictions: r.predictions,
          teamModel: r.team_model,
          signalLock: r.signal_lock,
          resultsAdded: r.results_added, summary: r.summary,
          savedAt: r.saved_at, fetchedAt: r.fetched_at,
        })),
        count: rows.length,
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
            ...record,
            predictions: record.predictions,
            teamModel: record.team_model,
            resultsAdded: record.results_added,
            summary: record.summary,
          }, alreadyAdded: true });
        }

        // NOTE: actual result-grading logic (fetching box scores, matching TD scorers,
        // actual rush/rec/pass yardage, and final scores against team_model predictions)
        // gets filled in once we build the props layer — same shape as HR engine's
        // 'results' action, just swapping MLB boxscore for NFL boxscore/game summary.
        return res.status(501).json({ error: 'Result grading not yet wired — needs props layer first' });
      }
    }
  } catch (e) {
    console.error('History API error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
};
