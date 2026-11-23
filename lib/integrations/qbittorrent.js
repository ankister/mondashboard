// qBittorrent WebUI API v2 (fonctionne avec binhex/arch-qbittorrentvpn).
import { FormData } from 'undici';
import { request, joinUrl } from '../http.js';

const cookies = new Map(); // integrationId -> cookie de session

async function login(c, key) {
  const res = await request(joinUrl(c.url, '/api/v2/auth/login'), {
    method: 'POST', insecure: !!c.insecure,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: c.url, Origin: c.url.replace(/\/+$/, '') },
    body: new URLSearchParams({ username: c.username || '', password: c.password || '' }).toString()
  });
  const txt = await res.text();
  if (res.status === 403) throw new Error('IP bannie par qBittorrent après trop d\'échecs');
  if (!res.ok || txt.trim() === 'Fails.') throw new Error('Identifiants qBittorrent refusés');
  const set = res.headers.get('set-cookie') || '';
  const cookie = set.split(';')[0];
  cookies.set(key, cookie);
  return cookie;
}

async function api(c, key, path, init = {}, retry = true) {
  const cookie = cookies.get(key) ?? await login(c, key);
  const res = await request(joinUrl(c.url, path), {
    ...init, insecure: !!c.insecure, timeout: 15000,
    headers: { ...(init.headers || {}), Cookie: cookie, Referer: c.url }
  });
  if (res.status === 403 && retry) { cookies.delete(key); return api(c, key, path, init, false); }
  if (!res.ok) throw new Error(`qBittorrent a répondu ${res.status}`);
  return res;
}

export default {
  label: 'qBittorrent',
  help: 'Identifiants de la WebUI qBittorrent (Options → Interface Web).',
  provides: ['torrents'],
  fields: [
    { key: 'url', label: 'URL de la WebUI', placeholder: 'http://192.168.1.10:8080', required: true },
    { key: 'username', label: 'Utilisateur', placeholder: 'admin' },
    { key: 'password', label: 'Mot de passe', type: 'password', secret: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],

  async test(c) {
    cookies.delete('test');
    const v = await (await api(c, 'test', '/api/v2/app/version')).text();
    return `qBittorrent ${v} joignable`;
  },

  async fetch(_k, c, w, integration) {
    const limit = w.limit || 15;
    const [t, list] = await Promise.all([
      api(c, integration.id, '/api/v2/transfer/info').then(r => r.json()),
      api(c, integration.id, `/api/v2/torrents/info?sort=added_on&reverse=true&limit=${limit}`).then(r => r.json())
    ]);
    return {
      dl: t.dl_info_speed, ul: t.up_info_speed, connection: t.connection_status,
      canAdd: true,
      torrents: list.map(x => ({
        name: x.name, progress: Math.round(x.progress * 1000) / 10, state: x.state,
        dlspeed: x.dlspeed, upspeed: x.upspeed, eta: x.eta, size: x.size
      }))
    };
  },

  async action(c, payload, integration) {
    if (payload.op !== 'add') throw new Error('Action inconnue');
    const fd = new FormData();
    if (payload.magnet) {
      if (!/^(magnet:\?|https?:\/\/)/i.test(payload.magnet.trim())) throw new Error('Lien magnet ou URL attendu');
      fd.append('urls', payload.magnet.trim());
    } else if (payload.fileBase64) {
      const buf = Buffer.from(payload.fileBase64, 'base64');
      if (buf.length > 10e6) throw new Error('Fichier trop gros');
      fd.append('torrents', new Blob([buf], { type: 'application/x-bittorrent' }), payload.fileName || 'upload.torrent');
    } else throw new Error('Rien à ajouter');
    if (payload.category) fd.append('category', payload.category);
    const res = await api(c, integration.id, '/api/v2/torrents/add', { method: 'POST', body: fd });
    const txt = await res.text();
    if (txt.trim() === 'Fails.') throw new Error('qBittorrent a refusé le torrent');
    return { ok: true };
  }
};
