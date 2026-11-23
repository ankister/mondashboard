// Glances (https://github.com/nicolargo/glances) en mode serveur web (`glances -w`).
// Fonctionne sur Debian, Unraid (appli Community Apps) et tout Linux.
// Fournit : supervision machine + liste des conteneurs.
import { getJson, joinUrl } from '../http.js';

const IGNORED_IFACES = /^(lo|docker|veth|br-|virbr|tun|wg|tailscale|shim|vnet|dummy)/;

function opts(c) {
  return { insecure: !!c.insecure, basicAuth: c.username ? { username: c.username, password: c.password } : null };
}
const base = c => joinUrl(c.url, `/api/${c.apiVersion || 4}`);

async function plugin(c, name) {
  return getJson(`${base(c)}/${name}`, opts(c));
}

function smartHealth(disk) {
  // Le plugin SMART de Glances renvoie les attributs par identifiant : { "5": {name, raw, ...}, ... }
  const attrs = Object.values(disk).filter(v => v && typeof v === 'object' && v.name);
  const get = re => attrs.find(a => re.test(a.name));
  const raw = a => (a ? parseInt(String(a.raw).split(/\s/)[0], 10) || 0 : 0);
  const notes = [];
  let health = attrs.length ? 'ok' : 'unknown';
  const realloc = raw(get(/Reallocated_Sector/i));
  const pending = raw(get(/Current_Pending_Sector/i));
  const uncorr = raw(get(/Offline_Uncorrectable/i));
  if (realloc > 0) { notes.push(`${realloc} secteur(s) réalloué(s)`); health = 'warn'; }
  if (pending > 0) { notes.push(`${pending} secteur(s) en attente`); health = 'warn'; }
  if (uncorr > 0) { notes.push(`${uncorr} secteur(s) non corrigible(s)`); health = 'fail'; }
  for (const a of attrs) {
    const v = Number(a.val ?? a.value), th = Number(a.thresh ?? a.threshold);
    if (th > 0 && v > 0 && v <= th) { notes.push(`${a.name} sous le seuil`); health = 'fail'; }
  }
  const temp = get(/Temperature_Celsius|Airflow_Temperature|^Temperature$/i);
  return { health, notes, temp: temp ? raw(temp) : null };
}

export default {
  label: 'Glances (Debian / Unraid / Linux)',
  help: 'Lance Glances en mode web (`glances -w`, port 61208). Pour SMART, Glances doit tourner en root avec accès aux disques.',
  provides: ['machine', 'docker'],
  fields: [
    { key: 'url', label: 'URL', placeholder: 'http://192.168.1.21:61208', required: true },
    { key: 'apiVersion', label: 'Version API', type: 'select', options: ['4', '3'], default: '4' },
    { key: 'username', label: 'Utilisateur (si --password)', placeholder: 'glances' },
    { key: 'password', label: 'Mot de passe', type: 'password', secret: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],

  async test(c) {
    const s = await plugin(c, 'system');
    return `Connecté à ${s.hostname || 'Glances'} (${s.os_name || ''} ${s.os_version || ''})`.trim();
  },

  async fetch(kind, c, _w, integration) {
    if (kind === 'docker') {
      const list = await plugin(c, c.apiVersion === '3' ? 'docker' : 'containers').catch(() => []);
      const arr = Array.isArray(list) ? list : (list.containers || []);
      return {
        containers: arr.map(x => ({
          host: integration.name,
          name: x.name,
          image: Array.isArray(x.image) ? x.image.join(', ') : (x.image || ''),
          state: String(x.status || x.Status || '').toLowerCase().includes('running') || x.status === 'healthy' ? 'running' : String(x.status || '').toLowerCase(),
          status: x.uptime ? `Up ${x.uptime}` : (x.status || ''),
          cpu: x.cpu_percent ?? x.cpu?.total ?? null,
          mem: x.memory_usage ?? x.memory?.usage ?? null
        }))
      };
    }

    const names = ['system', 'cpu', 'mem', 'load', 'network', 'sensors', 'gpu', 'fs', 'smart', 'uptime'];
    const results = await Promise.allSettled(names.map(n => plugin(c, n)));
    const r = Object.fromEntries(names.map((n, i) => [n, results[i].status === 'fulfilled' ? results[i].value : null]));
    if (!r.cpu && !r.mem) {
      throw new Error(results.find(x => x.status === 'rejected')?.reason?.message || 'Glances injoignable');
    }

    const ifaces = (r.network || []).filter(n => !IGNORED_IFACES.test(n.interface_name || ''));
    let rx = 0, tx = 0;
    for (const n of ifaces) {
      if (n.bytes_recv_rate_per_sec !== undefined) { rx += n.bytes_recv_rate_per_sec; tx += n.bytes_sent_rate_per_sec; }
      else { const t = n.time_since_update || 1; rx += (n.rx || 0) / t; tx += (n.tx || 0) / t; }
    }

    const temps = (r.sensors || [])
      .filter(s => String(s.type || '').startsWith('temperature') && s.value > 0)
      .slice(0, 6).map(s => ({ label: s.label, value: s.value }));

    const disks = r.smart && typeof r.smart === 'object'
      ? Object.entries(r.smart).map(([dev, d]) => ({ name: dev, model: d.DeviceName || '', ...smartHealth(d) }))
      : [];

    return {
      name: r.system?.hostname || integration.name,
      os: r.system?.linux_distro || [r.system?.os_name, r.system?.os_version].filter(Boolean).join(' '),
      uptime: typeof r.uptime === 'string' ? r.uptime : (r.uptime?.uptime || null),
      cpu: { percent: r.cpu?.total ?? null, cores: r.load?.cpucore ?? null },
      load: r.load ? [r.load.min1, r.load.min5, r.load.min15] : null,
      mem: r.mem ? { percent: r.mem.percent, used: r.mem.used, total: r.mem.total } : null,
      net: { rx, tx },
      temps,
      gpus: (r.gpu || []).map(g => ({ name: g.name, util: g.proc, memPercent: g.mem, temp: g.temperature })),
      fs: (r.fs || []).filter(f => f.size > 1e9).slice(0, 8)
        .map(f => ({ mount: f.mnt_point, used: f.used, total: f.size, percent: f.percent })),
      disks,
      updates: null,
      smartAvailable: !!r.smart
    };
  }
};
