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

// gameTeams = array of home team names for this week's slate
async function fetchAllWeather(gameDate, gameTeams = [], gameTimes = {}) {
  const results = {};

  for (const [team, info] of Object.entries(STADIUM_COORDS)) {
    if (info.dome && (!gameTeams.length || gameTeams.includes(team))) {
      results[team] = { t:72, h:50, w:0, d:999, c:'—', s:'Dome', dome:true };
    }
  }

  const outdoor = Object.entries(STADIUM_COORDS)
    .filter(([t, info]) => !info.dome && (gameTeams.length === 0 || gameTeams.includes(t)));

  if (!outdoor.length) return results;

  const lats = outdoor.map(([, info]) => info.lat).join(',');
  const lons = outdoor.map(([, info]) => info.lon).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;

  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const responses = Array.isArray(d) ? d : [d];

    responses.forEach((data, idx) => {
      const [team, , ] = outdoor[idx];
      const hourly = data?.hourly;
      if (!hourly?.time?.length) return;

      const kickoffET = gameTimes[team]; // e.g. "1:00 PM"
      let hi = -1;
      if (kickoffET) {
        const match = kickoffET.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (match) {
          let hour = parseInt(match[1]);
          const isPM = match[3].toUpperCase() === 'PM';
          if (isPM && hour !== 12) hour += 12;
          if (!isPM && hour === 12) hour = 0;
          hi = hourly.time.findIndex(x => x.endsWith(`T${String(hour).padStart(2,'0')}:00`) && x.startsWith(gameDate));
        }
      }
      if (hi < 0) hi = hourly.time.findIndex(t => t.startsWith(gameDate) && t.endsWith('T13:00'));
      if (hi < 0) hi = hourly.time.findIndex(t => t.startsWith(gameDate));
      if (hi < 0) hi = 12;

      const t    = Math.round(hourly.temperature_2m[hi]);
      const w    = Math.round(hourly.wind_speed_10m[hi]);
      const wdir = Math.round(hourly.wind_direction_10m[hi]);
      const code = hourly.weather_code[hi];
      results[team] = { t, w, d: wdir, c: CARDS[Math.round(wdir/22.5)%16], s: weatherCode(code), dome: false, src: 'live', hour: hi };
    });
  } catch (e) {
    console.warn('NFL weather batch fetch failed:', e.message);
  }

  return results;
}

module.exports = { fetchAllWeather, STADIUM_COORDS };
