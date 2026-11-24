// Umami (statistiques de visite) : liste de tous les sites avec visiteurs, vues, rebond,
// visiteurs en ligne et courbe des vues sur la période.
// Auto-hébergé : identifiant + mot de passe (POST /api/auth/login) ou clé d'API « umami_… ».
// Umami Cloud : clé d'API avec l'URL https://api.umami.is/v1 (en-tête x-umami-api-key).
import { request, joinUrl } from '../http.js';

const tokens = new Map(); // integrationId -> jeton de session

const isCloud = c => /api\.umami\.is/i.test(c.url || '');

async function login(c, key) {
  const res = await request(joinUrl(c.url, '/api/auth/login'), {
    method: 'POST', insecure: !!c.insecure, timeout: 15000,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: c.username || '', password: c.password || '' })
  });
  if (res.status === 401 || res.status === 403) throw new Error('Identifiants Umami refusés');
  if (!res.ok) throw new Error(`Umami a répondu ${res.status} à la connexion`);
  const j = await res.json();
  if (!j.token) throw new Error('Umami n\'a pas renvoyé de jeton');
  tokens.set(key, j.token);
  return j.token;
}

async function api(c, key, path, retry = true) {
  const headers = { Accept: 'application/json' };
  if (c.apiKey) {
    if (isCloud(c)) headers['x-umami-api-key'] = c.apiKey;
    else headers.Authorization = `Bearer ${c.apiKey}`;
  } else {
    headers.Authorization = `Bearer ${tokens.get(key) ?? await login(c, key)}`;
  }
  // Umami Cloud : l'URL contient déjà /v1 et les routes n'ont pas le préfixe /api
  const url = joinUrl(c.url, isCloud(c) ? path.replace(/^\/api/, '') : path);
  const res = await request(url, { insecure: !!c.insecure, timeout: 20000, headers });
  if (res.status === 401 && !c.apiKey && retry) { tokens.delete(key); return api(c, key, path, false); }
  if (res.status === 401) throw new Error(c.apiKey ? 'Clé d\'API Umami refusée' : 'Identifiants Umami refusés');
  if (!res.ok) throw new Error(`Umami a répondu ${res.status} (${path.split('?')[0]})`);
  return res.json();
}

// v3 : { pageviews: 12, comparison: { pageviews: 10 } } ; v2 : { pageviews: { value: 12, prev: 10 } }
const num = v => (typeof v === 'number' ? v : typeof v?.value === 'number' ? v.value : 0);
const prevOf = (s, k) => (s?.comparison && typeof s.comparison[k] === 'number' ? s.comparison[k]
  : typeof s?.[k]?.prev === 'number' ? s[k].prev : null);

const PERIODS = {
  "Aujourd'hui": () => { const d = new Date(); d.setHours(0, 0, 0, 0); return { start: +d, unit: 'hour' }; },
  '24 heures': () => ({ start: Date.now() - 864e5, unit: 'hour' }),
  '7 jours': () => ({ start: Date.now() - 7 * 864e5, unit: 'day' }),
  '30 jours': () => ({ start: Date.now() - 30 * 864e5, unit: 'day' })
};

// Umami ne renvoie que les tranches qui ont des vues : on remet les tranches vides à 0
function buckets(points, per, end) {
  const step = per.unit === 'hour' ? 36e5 : 864e5;
  const first = new Date(per.start);
  if (per.unit === 'hour') first.setMinutes(0, 0, 0); else first.setHours(0, 0, 0, 0);
  const n = Math.max(1, Math.ceil((end - first) / step));
  const out = Array(n).fill(0);
  for (const p of points) {
    const t = Date.parse(String(p.x).replace(' ', 'T'));
    const i = Math.floor((t - first) / step);
    if (i >= 0 && i < n) out[i] += Number(p.y) || 0;
  }
  return out;
}

async function listWebsites(c, key) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const j = await api(c, key, `/api/websites?page=${page}&pageSize=100&includeTeams=true`);
    const data = Array.isArray(j) ? j : j.data || [];
    all.push(...data);
    if (Array.isArray(j) || data.length < 100 || all.length >= (j.count || 0)) break;
  }
  return all;
}

export default {
  label: 'Umami',
  help: 'Auto-hébergé : URL de ton Umami + identifiant et mot de passe (ou une clé d\'API « umami_… » créée dans Paramètres → Clés d\'API). Umami Cloud : URL https://api.umami.is/v1 + clé d\'API.',
  provides: ['analytics'],
  fields: [
    { key: 'url', label: 'URL d\'Umami', placeholder: 'https://umami.exemple.fr', required: true },
    { key: 'username', label: 'Utilisateur', placeholder: 'admin' },
    { key: 'password', label: 'Mot de passe', type: 'password', secret: true },
    { key: 'apiKey', label: 'Clé d\'API (à la place de l\'utilisateur et du mot de passe)', type: 'password', secret: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],

  async test(c) {
    tokens.delete('test');
    const sites = await listWebsites(c, 'test');
    return `Umami joignable : ${sites.length} site(s)`;
  },

  async fetch(_k, c, w, integration) {
    const key = integration.id;
    const per = (PERIODS[w.period] || PERIODS['24 heures'])();
    const end = Date.now();
    const tz = encodeURIComponent(process.env.TZ || 'Europe/Paris');
    const range = `startAt=${per.start}&endAt=${end}`;
    const sites = await listWebsites(c, key);
    const base = (c.url || '').replace(/\/+$/, '').replace(/\/v1$/, '');
    const out = await Promise.all(sites.map(async s => {
      const [stats, active, series] = await Promise.all([
        api(c, key, `/api/websites/${s.id}/stats?${range}&compare=prev`).catch(() => null),
        w.showActive === false ? null : api(c, key, `/api/websites/${s.id}/active`).catch(() => null),
        w.showChart === false ? null : api(c, key, `/api/websites/${s.id}/pageviews?${range}&unit=${per.unit}&timezone=${tz}`).catch(() => null)
      ]);
      const visits = num(stats?.visits), bounces = num(stats?.bounces);
      return {
        id: s.id, name: s.name || s.domain, domain: s.domain || '',
        link: isCloud(c) ? `https://cloud.umami.is/websites/${s.id}` : `${base}/websites/${s.id}`,
        visitors: num(stats?.visitors), pageviews: num(stats?.pageviews), visits,
        prevVisitors: prevOf(stats, 'visitors'), prevPageviews: prevOf(stats, 'pageviews'),
        bounce: visits ? Math.round((Math.min(bounces, visits) / visits) * 100) : null,
        avgTime: visits ? Math.round(num(stats?.totaltime) / visits) : null,
        active: active == null ? null : num(active.visitors ?? active.x ?? (Array.isArray(active) ? active[0]?.x : 0)),
        series: Array.isArray(series?.pageviews) ? buckets(series.pageviews, per, end) : null,
        error: stats ? null : 'statistiques indisponibles'
      };
    }));
    return { sites: out, period: w.period || '24 heures' };
  }
};
