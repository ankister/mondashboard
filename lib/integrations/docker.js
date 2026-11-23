// API Docker Engine exposée par un socket-proxy (ex. lscr.io/linuxserver/socket-proxy
// ou tecnativa/docker-socket-proxy) avec CONTAINERS=1. Ne jamais exposer le socket brut.
import { getJson, request, joinUrl } from '../http.js';

const o = c => ({ insecure: !!c.insecure, basicAuth: c.username ? { username: c.username, password: c.password } : null });

export default {
  label: 'Docker (via socket-proxy)',
  help: 'Déploie un socket-proxy sur la machine (CONTAINERS=1 ; ALLOW_START/ALLOW_STOP/ALLOW_RESTARTS=1 seulement si tu actives les actions). Port habituel : 2375.',
  provides: ['docker'],
  fields: [
    { key: 'url', label: 'URL du socket-proxy', placeholder: 'http://192.168.1.21:2375', required: true },
    { key: 'allowActions', label: 'Autoriser start / stop / restart (nécessite ALLOW_START/STOP/RESTARTS=1 sur le proxy)', type: 'checkbox' },
    { key: 'username', label: 'Utilisateur (si proxy protégé par auth basique)' },
    { key: 'password', label: 'Mot de passe', type: 'password', secret: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],

  async test(c) {
    const v = await getJson(joinUrl(c.url, '/version'), o(c));
    return `Docker ${v.Version} (${v.Os}/${v.Arch})`;
  },

  async fetch(_kind, c, _w, integration) {
    const list = await getJson(joinUrl(c.url, '/containers/json?all=1'), o(c));
    return {
      containers: list.map(x => ({
        id: x.Id,
        host: integration.name,
        integrationId: integration.id,
        name: (x.Names?.[0] || '').replace(/^\//, ''),
        image: x.Image,
        state: x.State,
        status: x.Status,
        canAct: !!c.allowActions
      }))
    };
  },

  async action(c, payload) {
    if (!c.allowActions) throw new Error('Actions désactivées pour cet hôte Docker');
    const { containerId, op } = payload;
    if (!['start', 'stop', 'restart'].includes(op) || !/^[a-f0-9]{12,64}$/.test(containerId || '')) {
      throw new Error('Action invalide');
    }
    const res = await request(joinUrl(c.url, `/containers/${containerId}/${op}`), { ...o(c), method: 'POST', timeout: 30000 });
    if (res.status >= 400) throw new Error(`Docker a répondu ${res.status}`);
    return { ok: true };
  }
};
