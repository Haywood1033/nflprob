// lib/weather.js — CommonJS, mirrors HR engine's Open-Meteo pattern
// Wind matters most for passing yards; rushing/receiving care less; dome games are static.

const STADIUM_COORDS = {
  'Bills':          { lat:42.774, lon:-78.787,  dome:false },
  'Dolphins':       { lat:25.958, lon:-80.239,  dome:false },
  'Patriots':       { lat:42.091, lon:-71.264,  dome:false },
  'Jets':           { lat:40.813, lon:-74.074,  dome:false },
  'Ravens':         { lat:39.278, lon:-76.623,  dome:false },
  'Bengals':        { lat:39.095, lon:-84.516,  dome:false },
  'Browns':         { lat:41.506, lon:-81.700,  dome:false },
  'Steelers':       { lat:40.447, lon:-80.016,  dome:false },
  'Texans':         { lat:29.685, lon:-95.411,  dome:true  },
  'Colts':          { lat:39.760, lon:-86.164,  dome:true  },
  'Jaguars':        { lat:30.324, lon:-81.637,  dome:false },
  'Titans':         { lat:36.166, lon:-86.771,  dome:false },
  'Broncos':        { lat:39.744, lon:-105.020, dome:false },
  'Chiefs':         { lat:39.049, lon:-94.484,  dome:false },
  'Raiders':        { lat:36.091, lon:-115.184, dome:true  },
  'Chargers':       { lat:33.954, lon:-118.339, dome:true  },
  'Cowboys':        { lat:32.748, lon:-97.093,  dome:true  },
  'Giants':         { lat:40.813, lon:-74.074,  dome:false },
  'Eagles':         { lat:39.901, lon:-75.168,  dome:false },
  'Commanders':     { lat:38.908, lon:-76.864,  dome:false },
  'Bears':          { lat:41.862, lon:-87.617,  dome:false },
  'Lions':          { lat:42.340, lon:-83.046,  dome:true  },
  'Packers':        { lat:44.501, lon:-88.062,  dome:false },
  'Vikings':        { lat:44.974, lon:-93.258,  dome:true  },
  'Falcons':        { lat:33.755, lon:-84.401,  dome:true  },
  'Panthers':       { lat:35.226, lon:-80.853,  dome:false },
  'Saints':         { lat:29.951, lon:-90.081,  dome:true  },
  'Buccaneers':     { lat:27.976, lon:-82.503,  dome:false },
  'Cardinals':      { lat:33.528, lon:-112.263, dome:true  },
  'Rams':           { lat:33.953, lon:-118.339, dome:true  },
  '49ers':          { lat:37.403, lon:-121.970, dome:false },
  'Seahawks':       { lat:47.595, lon:-122.332, dome:false },
};

const CARDS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

function weatherCode(code) {
  if (code <= 1) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 49) return 'Foggy';
  if (code <= 69) return 'Rainy';
  if (code <= 79) return 'Snow';
  return 'Thunderstorm';
}

// Eastern-time calendar date (YYYY-MM-DD) and hour (0-23) of a kickoff timestamp.
function etDateHour(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

// Index of the kickoff hour in an hourly series whose times are ET wall-clock ("2026-11-15T13:00").
// -1 when the game is outside the forecast window.
function kickoffHourIndex(times, iso) {
  const k = etDateHour(iso);
  if (!k || !times?.length) return -1;
  return times.indexOf(`${k.date}T${String(k.hour).padStart(2, '0')}:00`);
}

// Is this game played under a roof? nflverse's roof field first (dome/closed = covered,
// outdoors/open = weather applies), then ESPN's venue flag, then the home stadium's default.
function isCovered(game) {
  const roof = String(game.roof || '').toLowerCase();
  if (roof === 'dome' || roof === 'closed') return true;
  if (roof === 'outdoors' || roof === 'open') return false;
  if (game.indoor) return true;
  return !game.neutralSite && !!STADIUM_COORDS[game.homeTeam]?.dome;
}

const DOME = { t:72, h:50, w:0, d:999, c:'—', s:'Dome', dome:true };

// Game-day weather at kickoff, per game. games: [{ key, homeTeam, date (ISO kickoff), roof,
// indoor, neutralSite }]. Returns { [key]: weather }; a game with no usable forecast (outside
// the forecast window, or an outdoor neutral site with no known coordinates) gets {} so no
// weather adjustment is applied.
async function fetchGameWeather(games = []) {
  const results = {};
  const outdoor = [];
  for (const g of games) {
    if (isCovered(g)) { results[g.key] = { ...DOME }; continue; }
    const coords = g.neutralSite ? null : STADIUM_COORDS[g.homeTeam];
    if (!coords || !g.date) { results[g.key] = {}; continue; }
    outdoor.push({ g, coords });
  }
  if (!outdoor.length) return results;

  const lats = outdoor.map(o => o.coords.lat).join(',');
  const lons = outdoor.map(o => o.coords.lon).join(',');
  // timezone=America/New_York: hourly times come back in ET, the same clock as the kickoff.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York&forecast_days=10`;

  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const responses = Array.isArray(d) ? d : [d];
    outdoor.forEach(({ g }, idx) => {
      const hourly = responses[idx]?.hourly;
      const hi = kickoffHourIndex(hourly?.time, g.date);
      if (hi < 0) { results[g.key] = {}; return; }
      const t    = Math.round(hourly.temperature_2m[hi]);
      const w    = Math.round(hourly.wind_speed_10m[hi]);
      const wdir = Math.round(hourly.wind_direction_10m[hi]);
      const code = hourly.weather_code[hi];
      results[g.key] = { t, w, d: wdir, c: CARDS[Math.round(wdir/22.5)%16], s: weatherCode(code), dome: false, src: 'live', hour: hi };
    });
  } catch (e) {
    console.warn('NFL weather batch fetch failed:', e.message);
  }
  for (const { g } of outdoor) if (!(g.key in results)) results[g.key] = {};
  return results;
}

module.exports = { fetchGameWeather, etDateHour, kickoffHourIndex, isCovered, STADIUM_COORDS };
