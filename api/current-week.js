const { fetchCurrentWeek } = require('../lib/schedule.js');

let cache = { data: null, timestamp: null };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour - the current week doesn't change more often than that

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const age = cache.timestamp ? Date.now() - cache.timestamp : Infinity;
  if (age < CACHE_TTL && cache.data) return res.status(200).json({ ...cache.data, cached: true });

  const current = await fetchCurrentWeek();
  if (!current) return res.status(200).json({ week: null, year: null, error: 'Could not determine current week from ESPN' });

  cache = { data: current, timestamp: Date.now() };
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
  return res.status(200).json(current);
};
