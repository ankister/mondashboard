// Agent HomeDash : supervision complète d'une machine (Debian, Unraid…).
// Mode "pull" : HomeDash interroge l'agent (LAN). Mode "push" : l'agent envoie ses
// données à HomeDash (machine distante, rien à ouvrir chez elle).
import crypto from 'node:crypto';
import { request, joinUrl } from '../http.js';

// ---- état du mode push (en mémoire) ----
const reports = new Map();  // integrationId -> { report, at }
const queues = new Map();   // integrationId -> [{ id, op, containerId }]
const results = new Map();  // commandId -> { ok, error }

const sha = b => crypto.createHash('sha256').update(b || '').digest('hex');
export function signature(token, method, path, body, ts) {
  return crypto.createHmac('sha256', token).update(`${ts}.${method}.${path}.${sha(body)}`).digest('hex');
}
export function verifySignature(token, method, path, body, ts, sig) {
  if (!token || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 90) return false;
  const exp = signature(token, method, path, body, ts);
  return typeof sig === 'string' && sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
}

export function receivePush(integrationId, payload) {
  reports.set(integrationId, { report: payload.report, at: Date.now() });
  for (const r of payload.results || []) results.set(r.id, { ok: r.ok, error: r.error, at: Date.now() });
  const cmds = queues.get(integrationId) || [];
  queues.set(integrationId, []);
  return { commands: cmds };
}
export const lastSeen = id => reports.get(id)?.at || null;

async function pull(c, method, path) {
  if (!c.url) throw new Error('URL de l\'agent manquante (mode pull)');
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await request(joinUrl(c.url, path), {
    method, insecure: !!c.insecure, timeout: method === 'POST' ? 65000 : 10000,
    headers: { 'X-HD-Time': ts, 'X-HD-Sig': signature(c.token, method, path, '', ts) }
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Agent : HTTP ${res.status}`);
  return j;
}

async function getReport(c, integration) {
  if (c.mode === 'push') {
    const r = reports.get(integration.id);
    if (!r) throw new Error('En attente du premier contact de l\'agent (mode push)');
    const age = (Date.now() - r.at) / 1000;
    if (age > 90) throw new Error(`Agent silencieux depuis ${Math.round(age / 60)} min`);
    return r.report;
  }
  return pull(c, 'GET', '/v1/report');
}

const fmtUptime = s => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} j ${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
};

export default {
  label: 'Agent Mon dashboard (recommandé)',
  help: 'Supervision complète d\'une machine Linux : CPU, RAM, réseau, températures, GPU Nvidia, SMART, mises à jour (apt, Unraid, images Docker) et pilotage des conteneurs. Enregistre l\'intégration, puis utilise « Installer l\'agent » pour obtenir la commande à lancer sur la machine. Mode pull = Mon dashboard interroge l\'agent sur le réseau local ; mode push = l\'agent contacte Mon dashboard (machine distante comme unRaid-2).',
  provides: ['machine', 'docker'],
  fields: [
    { key: 'mode', label: 'Mode', type: 'select', options: ['pull', 'push'], default: 'pull' },
    { key: 'url', label: 'URL de l\'agent (mode pull)', placeholder: 'http://192.168.1.21:9123' },
    { key: 'allowActions', label: 'Autoriser start / stop / restart des conteneurs', type: 'checkbox', default: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' },
    { key: 'token', label: 'Jeton', type: 'password', secret: true, auto: true }
  ],

  async test(c, integration) {
    if (c.mode === 'push') {
      const at = integration && reports.get(integration.id)?.at;
      if (!at) return 'Mode push : en attente du premier envoi de l\'agent (installe-le, puis reteste).';
      return `Dernier contact il y a ${Math.round((Date.now() - at) / 1000)} s`;
    }
    const r = await pull(c, 'GET', '/v1/report');
    return `Agent ${r.agentVersion} sur ${r.hostname} (${r.os})`;
  },

  async fetch(kind, c, _w, integration) {
    const r = await getReport(c, integration);
    if (kind === 'docker') {
      if (!r.containers) throw new Error(r.dockerError || 'Docker indisponible sur cette machine');
      return {
        containers: r.containers.map(x => ({
          id: x.id, host: integration.name, integrationId: integration.id, name: x.name, image: x.image,
          state: x.state, status: x.status, imageUpdate: x.imageUpdate,
          canAct: !!c.allowActions && r.actionsEnabled !== false
        }))
      };
    }
    const updates = [
      ...(r.updates?.unraid || []),
      ...(r.updates?.apt || []).map(u => ({ ...u, name: u.name + (u.held ? ' (bloqué)' : '') }))
    ];
    const imgUpd = (r.containers || []).filter(x => x.imageUpdate).length;
    return {
      name: r.hostname, os: r.os, uptime: r.uptime ? fmtUptime(r.uptime) : null,
      cpu: r.cpu, load: r.load, mem: r.mem, net: r.net, temps: r.temps, gpus: r.gpus,
      fs: r.fs, disks: r.disks || [], smartAvailable: r.smartAvailable, smartAt: r.smartAt,
      updates: r.updates?.apt === null && r.updates?.unraid === null && !r.updates?.checkedAt ? null : updates,
      updatesChecked: !!r.updates?.checkedAt,
      imageUpdates: imgUpd,
      agent: { version: r.agentVersion, mode: c.mode, collectedAt: r.collectedAt }
    };
  },

  async action(c, payload, integration) {
    const { containerId, op } = payload;
    if (!c.allowActions) throw new Error('Actions désactivées pour cet agent (option de l\'intégration)');
    if (!['start', 'stop', 'restart'].includes(op) || !/^[a-f0-9]{12,64}$/.test(containerId || '')) throw new Error('Action invalide');
    if (c.mode === 'push') {
      const id = crypto.randomBytes(6).toString('hex');
      const q = queues.get(integration.id) || [];
      q.push({ id, op, containerId });
      queues.set(integration.id, q);
      // attendre le résultat (l'agent passe toutes les ~10 s)
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 500));
        const res = results.get(id);
        if (res) { results.delete(id); if (!res.ok) throw new Error(res.error); return { ok: true }; }
      }
      return { ok: true, queued: true };
    }
    return pull(c, 'POST', `/v1/docker/${containerId}/${op}`);
  }
};
