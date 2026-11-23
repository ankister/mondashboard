// Météo via Open-Meteo (gratuit, sans clé API).
import { getJson } from './http.js';

const CODES = {
  0: ['Ciel dégagé', '☀️', '🌙'], 1: ['Plutôt dégagé', '🌤️', '🌙'], 2: ['Partiellement nuageux', '⛅', '☁️'], 3: ['Couvert', '☁️', '☁️'],
  45: ['Brouillard', '🌫️'], 48: ['Brouillard givrant', '🌫️'],
  51: ['Bruine légère', '🌦️'], 53: ['Bruine', '🌦️'], 55: ['Bruine dense', '🌧️'],
  61: ['Pluie faible', '🌦️'], 63: ['Pluie', '🌧️'], 65: ['Forte pluie', '🌧️'],
  66: ['Pluie verglaçante', '🌧️'], 67: ['Pluie verglaçante', '🌧️'],
  71: ['Neige faible', '🌨️'], 73: ['Neige', '🌨️'], 75: ['Forte neige', '❄️'], 77: ['Grains de neige', '🌨️'],
  80: ['Averses', '🌦️'], 81: ['Averses', '🌧️'], 82: ['Fortes averses', '⛈️'],
  85: ['Averses de neige', '🌨️'], 86: ['Averses de neige', '❄️'],
  95: ['Orage', '⛈️'], 96: ['Orage et grêle', '⛈️'], 99: ['Orage et grêle', '⛈️']
};
const desc = (code, isDay = 1) => {
  const c = CODES[code] || ['—', '🌡️'];
  return { label: c[0], icon: (!isDay && c[2]) || c[1] };
};

export async function weather({ lat = 48.8566, lon = 2.3522, city = '' }) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&timezone=auto&forecast_days=5';
  const d = await getJson(u, { timeout: 10000 });
  return {
    city,
    current: {
      temp: d.current.temperature_2m, feels: d.current.apparent_temperature,
      humidity: d.current.relative_humidity_2m, wind: d.current.wind_speed_10m,
      ...desc(d.current.weather_code, d.current.is_day)
    },
    days: d.daily.time.map((t, i) => ({
      date: t, max: d.daily.temperature_2m_max[i], min: d.daily.temperature_2m_min[i],
      rain: d.daily.precipitation_probability_max?.[i], ...desc(d.daily.weather_code[i])
    }))
  };
}

export async function geocode(q) {
  const d = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=fr`, { timeout: 8000 });
  return (d.results || []).map(x => ({ name: x.name, admin: [x.admin1, x.country].filter(Boolean).join(', '), lat: x.latitude, lon: x.longitude }));
}
