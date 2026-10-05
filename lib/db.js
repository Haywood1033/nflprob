// lib/db.js — shared Postgres access + the weekly_predictions key-parsing/JSON helpers, used by
// both api/history.js (manual save/grade/read) and api/cron-grade.js (scheduled auto-grade).
// Pulled out so the two never drift on connection config or the "2026-W03" week-key format.
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function query(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

// week is stored as "2026-W03" (schema.prisma's own documented format) — split back into the
// plain year/week numbers the nflverse-backed grading functions key off of.
function parseWeekKey(weekKey) {
  const m = String(weekKey).match(/^(\d{4})-W(\d{1,2})$/);
  if (!m) return null;
  return { year: Number(m[1]), week: Number(m[2]) };
}

// `summary` is a TEXT column (predictions/team_model/signal_lock are JSONB, which pg parses
// back into objects automatically — TEXT doesn't), so it comes back from the DB as a raw
// JSON string and needs parsing on the way out.
function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const ENSURE_TABLE_SQL = `
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
`;

module.exports = { query, parseWeekKey, safeJsonParse, ENSURE_TABLE_SQL };
