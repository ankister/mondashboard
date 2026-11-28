// AdGuard Home : statistiques DNS (requêtes, blocages, temps de réponse, tops)
// et commande de la protection (pause temporaire, désactivation, réactivation).
// API : /control/*, authentification HTTP basique (identifiants de l'interface web).
import { request, joinUrl } from '../http.js';

async function call(c, path, { method = 'GET', body } = {}) {
  const res = await request(joinUrl(c.url, '/control' + path), {
    method, insecure: !!c.insecure, timeout: 10000,
    basicAuth: { username: c.username, password: c.password },
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401 || res.status === 403) throw new Error('Identifiants AdGuard Home refusés');
  if (!res.ok) throw Object.assign(new Error(`AdGuard Home a répondu ${res.status} (${path})`), { status: res.status });
  const txt = await res.text();
  try { return txt ? JSON.parse(txt) : {}; } catch { return {}; }
}

// [{ "exemple.com": 12 }, …] → [["exemple.com", 12], …]
const top = (arr, n = 10) => (Array.isArray(arr) ? arr : []).slice(0, n).map(o => Object.entries(o)[0]).filter(Boolean);

export default {
  label: 'AdGuard Home',
  help: 'URL de l\'interface web d\'AdGuard Home (ex. http://192.168.1.2:3000) et les identifiants de connexion à cette interface.',
  provides: ['dns'],
  fields: [
    { key: 'url', label: 'URL d\'AdGuard Home', placeholder: 'http://192.168.1.2:3000', required: true },
    { key: 'username', label: 'Utilisateur', required: true },
    { key: 'password', label: 'Mot de passe', type: 'password', secret: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],

  async test(c) {
    const s = await call(c, '/status');
    return `AdGuard Home ${s.version || ''} joignable · protection ${s.protection_enabled ? 'active' : 'désactivée'}`;
  },

  async fetch(_k, c, _w, integration) {
    const [st, stats] = await Promise.all([call(c, '/status'), call(c, '/stats')]);
    const queries = Number(stats.num_dns_queries) || 0;
    const blocked = Number(stats.num_blocked_filtering) || 0;
    const safe = (Number(stats.num_replaced_safebrowsing) || 0) + (Number(stats.num_replaced_parental) || 0) + (Number(stats.num_replaced_safesearch) || 0);
    const paused = Number(st.protection_disabled_duration) || 0; // millisecondes restantes de la pause
    return {
      integrationId: integration.id, name: integration.name, url: c.url, version: st.version || '',
      running: st.running !== false,
      protection: !!st.protection_enabled,
      pausedUntil: !st.protection_enabled && paused > 0 ? Date.now() + paused : null,
      queries, blocked, safe,
      avgMs: Math.round((Number(stats.avg_processing_time) || 0) * 1000 * 10) / 10,
      units: stats.time_units === 'days' ? 'days' : 'hours',
      series: (stats.dns_queries || []).map(Number),
      blockedSeries: (stats.blocked_filtering || []).map((v, i) => (Number(v) || 0) + (Number(stats.replaced_safebrowsing?.[i]) || 0) + (Number(stats.replaced_parental?.[i]) || 0)),
      topBlocked: top(stats.top_blocked_domains),
      topClients: top(stats.top_clients),
      topQueried: top(stats.top_queried_domains)
    };
  },

  // op « protect » : { enabled: true } réactive ; { enabled: false, duration: ms } met en pause (sans durée = désactive)
  async action(c, p) {
    if (p.op !== 'protect') throw new Error('Action invalide');
    const enabled = !!p.enabled;
    const duration = !enabled && Number(p.duration) > 0 ? Math.min(Number(p.duration), 7 * 864e5) : undefined;
    try {
      await call(c, '/protection', { method: 'POST', body: duration ? { enabled, duration } : { enabled } });
    } catch (e) {
      // anciennes versions : pas de /protection
      if (e.status !== 404 && e.status !== 405) throw e;
      if (duration) throw new Error('Cette version d\'AdGuard Home ne gère pas la pause temporaire : mets-la à jour, ou utilise « Désactiver »');
      await call(c, '/dns_config', { method: 'POST', body: { protection_enabled: enabled } });
    }
    return { ok: true };
  }
};
