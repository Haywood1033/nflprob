const { fetchCurrentWeek } = require('../lib/schedule.js');

let cache = { data: null, timestamp: null };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour - the current week doesn't change more often than that

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Which commit this deployment is running (Vercel sets this), to check a deploy went live.
  const build = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null;
  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (age < CACHE_TTL && cache.data) return res.status(200).json({ ...cache.data, build, cached: true });

  const current = await fetchCurrentWeek();
  if (!current) return res.status(200).json({ week: null, year: null, build, error: 'Could not determine current week from ESPN' });

  cache = { data: current, timestamp: Date.now() };
  // Short CDN cache — see api/props.js for the reasoning. Longer than the per-week endpoints
  // (120s) since "the current week" changes at most once a day.
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
  return res.status(200).json({ ...current, build });
};
