// api/cron-grade.js — grades every saved week whose results aren't final yet, so accuracy
// tracking needs no manual "grade now" click. Triggered on a schedule by Vercel Cron (see
// vercel.json's `crons`). Logic mirrors the `results` action in api/history.js exactly — same
// partial-grading behavior (a week checked mid-slate gets whatever's gradeable so far, stays
// open for the next run to finish) — just looped over every ungraded week instead of one.
const { query, parseWeekKey, safeJsonParse, ENSURE_TABLE_SQL } = require('../lib/db.js');
const { gradeWeekPredictions } = require('../lib/grading.js');

module.exports = async function handler(req, res) {
  // Vercel sets this header on requests it fires from a configured cron schedule. When
  // CRON_SECRET is set (recommended — see Vercel's cron docs), it also sends that secret as a
  // bearer token, so a stray public request can't trigger (and burn DB/API time on) this route.
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await query(ENSURE_TABLE_SQL);
    const { rows } = await query(`SELECT * FROM weekly_predictions WHERE results_added = FALSE`);

    const results = [];
    for (const record of rows) {
      const parsed = parseWeekKey(record.week);
      if (!parsed) { results.push({ week: record.week, status: 'error', detail: `week key "${record.week}" isn't in the expected YYYY-WNN format` }); continue; }
      try {
        const { graded, summary, fullyGraded, partiallyGraded } = await gradeWeekPredictions(parsed.week, parsed.year, record.predictions || []);
        if (!partiallyGraded) { results.push({ week: record.week, status: 'not ready' }); continue; }
        await query(
          `UPDATE weekly_predictions SET predictions = $2::jsonb, results_added = $3, summary = $4 WHERE week = $1`,
          [record.week, JSON.stringify(graded), fullyGraded, JSON.stringify(summary)]
        );
        results.push({ week: record.week, status: fullyGraded ? 'fully graded' : 'partially graded' });
      } catch (e) {
        console.error('cron-grade failed for week', record.week, e.message);
        results.push({ week: record.week, status: 'error', detail: e.message });
      }
    }

    return res.status(200).json({ ok: true, checked: rows.length, results });
  } catch (e) {
    console.error('cron-grade error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
};
