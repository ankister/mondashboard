// Uptime Kuma : sondes d'une page de statut (état, 100 dernières vérifications, disponibilité 24 h,
// temps de réponse, certificats si la page les affiche), incidents épinglés et maintenances.
// Lecture seule, sans mot de passe : /api/status-page/<slug> et /api/status-page/heartbeat/<slug>.
import { getJson, joinUrl } from '../http.js';

// heures en UTC « AAAA-MM-JJ HH:mm:ss.SSS »
const utc = v => (v ? Date.parse(String(v).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? '' : 'Z')) || null : null);
const ST = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };
const slugOf = c => String(c.slug || '').trim().replace(/^.*\/status\//, '').replace(/\/+$/, '').toLowerCase();

async function page(c) {
  const slug = slugOf(c);
  if (!/^[a-z0-9-_]{1,100}$/.test(slug)) throw new Error('Identifiant (slug) de page de statut invalide');
  const o = { insecure: !!c.insecure, timeout: 12000 };
  try {
    return await Promise.all([getJson(joinUrl(c.url, `/api/status-page/${slug}`), o), getJson(joinUrl(c.url, `/api/status-page/heartbeat/${slug}`), o)]);
  } catch (e) {
    if (/HTTP 404/.test(e.message)) throw new Error(`Page de statut « ${slug} » introuvable ou non publiée dans Uptime Kuma`);
    throw e;
  }
}

export default {
  label: 'Uptime Kuma',
  help: 'URL d\'Uptime Kuma et l\'identifiant (slug) d\'une page de statut publiée : dans Uptime Kuma, Pages de statut → crée une page, ajoutes-y tes sondes, enregistre. Le slug est la fin de son adresse (…/status/<slug>). Coche « Afficher l\'expiration des certificats » dans la page pour les voir aussi ici.',
  provides: ['kuma'],
  fields: [
    { key: 'url', label: 'URL d\'Uptime Kuma', placeholder: 'http://192.168.1.2:3001', required: true },
    { key: 'slug', label: 'Identifiant (slug) de la page de statut', placeholder: 'homelab', required: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],

  async test(c) {
    const [p] = await page(c);
    const n = (p.publicGroupList || []).reduce((a, g) => a + (g.monitorList || []).length, 0);
    return `Page « ${p.config?.title || slugOf(c)} » : ${n} sonde(s) dans ${(p.publicGroupList || []).length} groupe(s)`;
  },

  async fetch(_k, c, _w, integration) {
    const [p, hb] = await page(c);
    const base = String(c.url || '').replace(/\/+$/, '');
    const incidents = (Array.isArray(p.incidents) ? p.incidents : p.incident ? [p.incident] : [])
      .map(i => ({ title: i.title || '', content: String(i.content || '').slice(0, 300), style: i.style || 'warning' }));
    const groups = (p.publicGroupList || []).map(g => ({
      name: g.name || '',
      monitors: (g.monitorList || []).map(m => {
        const beats = (hb.heartbeatList?.[m.id] || []).map(b => ({ t: utc(b.time), s: ST[b.status] || 'pending', ms: typeof b.ping === 'number' ? b.ping : null }));
        const last = beats.at(-1);
        // depuis quand l'état actuel dure (dans les 100 dernières vérifications)
        let since = null;
        for (let i = beats.length - 1; i >= 0 && beats[i].s === last?.s; i--) since = beats[i].t;
        const up = hb.uptimeList?.[`${m.id}_24`];
        return {
          id: m.id, name: m.name, type: m.type || '', url: m.url || '', admin: `${base}/dashboard/${m.id}`,
          status: last?.s || 'pending', ms: last?.ms ?? null, checked: last?.t || null, since,
          uptime24: typeof up === 'number' ? up * 100 : null,
          beats: beats.slice(-60).map(b => [b.s, b.ms, b.t]),
          cert: typeof m.certExpiryDaysRemaining === 'number' && m.validCert !== undefined ? { days: m.certExpiryDaysRemaining, valid: !!m.validCert } : null
        };
      })
    }));
    return {
      integrationId: integration.id, title: p.config?.title || integration.name, url: `${base}/status/${slugOf(c)}`,
      incidents, maintenance: (p.maintenanceList || []).map(x => x.title || 'Maintenance'), groups
    };
  }
};
