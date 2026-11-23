// Météo via Open-Meteo (gratuit, sans clé API).
import { getJson } from './http.js';

// Codes météo WMO → libellé + famille d'icône (dessinée côté interface)
const CODES = {
  0: ['Ciel dégagé', 'clear'], 1: ['Plutôt dégagé', 'mostly-clear'], 2: ['Partiellement nuageux', 'partly'], 3: ['Couvert', 'cloudy'],
  45: ['Brouillard', 'fog'], 48: ['Brouillard givrant', 'fog'],
  51: ['Bruine légère', 'drizzle'], 53: ['Bruine', 'drizzle'], 55: ['Bruine dense', 'drizzle'], 56: ['Bruine verglaçante', 'drizzle'], 57: ['Bruine verglaçante', 'drizzle'],
  61: ['Pluie faible', 'rain'], 63: ['Pluie', 'rain'], 65: ['Forte pluie', 'heavy-rain'],
  66: ['Pluie verglaçante', 'rain'], 67: ['Pluie verglaçante', 'heavy-rain'],
  71: ['Neige faible', 'snow'], 73: ['Neige', 'snow'], 75: ['Forte neige', 'snow'], 77: ['Grains de neige', 'snow'],
  80: ['Averses', 'showers'], 81: ['Averses', 'showers'], 82: ['Fortes averses', 'heavy-rain'],
  85: ['Averses de neige', 'snow'], 86: ['Averses de neige', 'snow'],
  95: ['Orage', 'storm'], 96: ['Orage et grêle', 'storm'], 99: ['Orage et grêle', 'storm']
};
const desc = (code, isDay = 1) => {
  const c = CODES[code] || ['—', 'cloudy'];
  return { label: c[0], kind: c[1], day: isDay !== 0 };
};

export async function weather({ lat = 48.8566, lon = 2.3522, city = '', days = 5, hours = 24 }) {
  const nDays = Math.min(14, Math.max(3, Number(days) || 5));
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day'
    + '&hourly=temperature_2m,weather_code,is_day,precipitation_probability'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset'
    + `&timezone=auto&forecast_days=${Math.max(nDays, 2)}`;
  const d = await getJson(u, { timeout: 10000 });
  // heures à venir à partir de l'heure en cours (heure locale du lieu)
  const nowHour = String(d.current.time || '').slice(0, 13);
  const h = d.hourly || { time: [] };
  const first = Math.max(0, h.time.findIndex(t => t.slice(0, 13) >= nowHour));
  const nHours = Math.min(48, Math.max(6, Number(hours) || 24));
  return {
    city,
    localTime: d.current.time, utcOffset: d.utc_offset_seconds ?? null,
    current: {
      temp: d.current.temperature_2m, feels: d.current.apparent_temperature,
      humidity: d.current.relative_humidity_2m, wind: d.current.wind_speed_10m,
      ...desc(d.current.weather_code, d.current.is_day)
    },
    hours: h.time.slice(first, first + nHours).map((t, k) => {
      const i = first + k;
      return { time: t.slice(11, 16), date: t.slice(0, 10), temp: h.temperature_2m[i], rain: h.precipitation_probability?.[i], ...desc(h.weather_code[i], h.is_day?.[i]) };
    }),
    days: d.daily.time.slice(0, nDays).map((t, i) => ({
      date: t, max: d.daily.temperature_2m_max[i], min: d.daily.temperature_2m_min[i],
      rain: d.daily.precipitation_probability_max?.[i], sunrise: d.daily.sunrise?.[i]?.slice(11), sunset: d.daily.sunset?.[i]?.slice(11),
      ...desc(d.daily.weather_code[i])
    }))
  };
}

export async function geocode(q) {
  const d = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=fr`, { timeout: 8000 });
  return (d.results || []).map(x => ({ name: x.name, admin: [x.admin1, x.country].filter(Boolean).join(', '), lat: x.latitude, lon: x.longitude }));
}
