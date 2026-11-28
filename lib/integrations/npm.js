// Nginx Proxy Manager : hôtes proxy (domaines, cible, SSL, état), redirections, flux, certificats
// et activation / désactivation d'un hôte. API /api, jeton obtenu avec l'e-mail et le mot de passe.
import { request, joinUrl } from '../http.js';

const tokens = new Map(); // id d'intégration → { token, until }

async function login(c, key) {
  const res = await request(joinUrl(c.url, '/api/tokens'), {
    method: 'POST', insecure: !!c.insecure, timeout: 10000,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: c.email || '', secret: c.password || '' })
  });
  if (res.status === 401 || res.status === 400 || res.status === 403) throw new Error('Identifiants Nginx Proxy Manager refusés');
  if (!res.ok) throw new Error(`Nginx Proxy Manager a répondu ${res.status} à la connexion`);
  let j;
  try { j = await res.json(); } catch { throw new Error('La réponse n\'est pas celle de Nginx Proxy Manager : vérifie que l\'URL mène bien à l\'interface d\'administration (port 81)'); }
  if (j.requires_2fa) throw new Error('Ce compte utilise la double authentification : crée un utilisateur dédié sans 2FA pour le dashboard');
  if (!j.token) throw new Error('Nginx Proxy Manager n\'a pas renvoyé de jeton : vérifie l\'URL de l\'interface d\'administration');
  const until = Date.parse(j.expires) || Date.now() + 3600e3;
  tokens.set(key, { token: j.token, until: until - 60e3 });
  return j.token;
}

async function api(c, key, path, { method = 'GET', retry = true } = {}) {
  const t = tokens.get(key);
  const token = t && t.until > Date.now() ? t.token : await login(c, key);
  const res = await request(joinUrl(c.url, '/api' + path), { method, insecure: !!c.insecure, timeout: 15000, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (res.status === 401 && retry) { tokens.delete(key); return api(c, key, path, { method, retry: false }); }
  if (res.status === 403) throw new Error('Droits insuffisants dans Nginx Proxy Manager (il faut voir les hôtes proxy)');
  if (!res.ok) throw new Error(`Nginx Proxy Manager a répondu ${res.status} (${path.split('?')[0]})`);
  const txt = await res.text();
  try { return txt ? JSON.parse(txt) : {}; } catch { return {}; }
}

// « 2026-01-31T10:00:00.000Z » (récent) ou « 2026-01-31 10:00:00 » (UTC, anciennes versions)
const when = v => (v ? Date.parse(/T/.test(v) ? v : String(v).replace(' ', 'T') + 'Z') || null : null);

export default {
  label: 'Nginx Proxy Manager',
  help: 'URL de l\'interface d\'administration (port 81 par défaut) et un compte NPM. Un compte en lecture seule suffit pour l\'affichage ; il faut le droit de gérer les hôtes proxy pour les activer / désactiver.',
  provides: ['proxy'],
  fields: [
    { key: 'url', label: 'URL de l\'interface d\'administration', placeholder: 'http://192.168.1.2:81', required: true },
    { key: 'email', label: 'E-mail du compte', required: true },
    { key: 'password', label: 'Mot de passe', type: 'password', secret: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],

  async test(c) {
    tokens.delete('test');
    const hosts = await api(c, 'test', '/nginx/proxy-hosts');
    return `Nginx Proxy Manager joignable : ${hosts.length} hôte(s) proxy`;
  },

  async fetch(_k, c, _w, integration) {
    const key = integration.id;
    const [hosts, redirs, dead, streams, certs] = await Promise.all([
      api(c, key, '/nginx/proxy-hosts?expand=certificate,access_list'),
      api(c, key, '/nginx/redirection-hosts').catch(() => []),
      api(c, key, '/nginx/dead-hosts').catch(() => []),
      api(c, key, '/nginx/streams').catch(() => []),
      api(c, key, '/nginx/certificates').catch(() => [])
    ]);
    return {
      integrationId: integration.id, name: integration.name, adminUrl: c.url,
      hosts: (hosts || []).map(h => ({
        id: h.id, integrationId: integration.id,
        domains: h.domain_names || [],
        target: `${h.forward_scheme || 'http'}://${h.forward_host}:${h.forward_port}`,
        enabled: h.enabled !== false && h.enabled !== 0,
        online: h.meta?.nginx_online !== false, error: h.meta?.nginx_err || '',
        ssl: Number(h.certificate_id) > 0 || h.certificate_id === 'new', forced: !!h.ssl_forced,
        access: Number(h.access_list_id) > 0 ? (h.access_list?.name || 'liste d\'accès') : '',
        certExp: when(h.certificate?.expires_on), certName: h.certificate?.nice_name || ''
      })),
      counts: { redirect: redirs?.length || 0, dead: dead?.length || 0, streams: streams?.length || 0 },
      certs: (certs || []).map(x => ({ name: x.nice_name || (x.domain_names || [])[0] || '', exp: when(x.expires_on), provider: x.provider || '' }))
    };
  },

  // activer / désactiver un hôte proxy
  async action(c, p, integration) {
    if (p.op !== 'host') throw new Error('Action invalide');
    const id = Number(p.hostId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Hôte invalide');
    await api(c, integration.id, `/nginx/proxy-hosts/${id}/${p.enabled ? 'enable' : 'disable'}`, { method: 'POST' });
    return { ok: true };
  }
};
