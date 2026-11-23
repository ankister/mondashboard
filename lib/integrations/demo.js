// Intégration de démonstration : données fictives réalistes pour tester l'interface
// sans aucun serveur. À supprimer une fois les vraies intégrations ajoutées.
const r = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.round(r(a, b));
const GB = 1024 ** 3;

const MACHINES = {
  'unRaid': { os: 'Unraid 7.2', cores: 16, mem: 64, gpu: 'GPU Nvidia', disks: ['sdb', 'sdc', 'sdd', 'sde', 'sdf', 'nvme0n1'], badDisk: 'sdf' },
  'unRaid-2': { os: 'Unraid 7.2', cores: 4, mem: 16, disks: ['sdb', 'sdc', 'sdd'] },
  'debian': { os: 'Debian 13', cores: 4, mem: 8, disks: ['nvme0n1'], apt: true },
  'debian-2': { os: 'Debian 13', cores: 4, mem: 8, disks: ['nvme0n1', 'sda'], apt: true },
  'Home Assistant': { os: 'Home Assistant OS 16.3', cores: 2, mem: 8, disks: ['sda'], ha: true }
};
const CONTAINERS = {
  'unRaid': ['plex', 'jellyfin', 'qbittorrent', 'sonarr', 'radarr', 'prowlarr', 'jellyseerr', 'nextcloud', 'mariadb', 'freshrss', 'vaultwarden', 'paperless-ngx', 'mealie'],
  'unRaid-2': ['rest-server', 'syncthing'],
  'debian': ['nginx-proxy-manager', 'uptime-kuma', 'portainer'],
  'debian-2': ['pihole', 'wireguard']
};

const dockerState = new Map(); // id -> { state, since } (actions simulées)

function machine(name) {
  const m = MACHINES[name] || MACHINES['debian-2'];
  const memPct = r(25, 75);
  return {
    name, os: m.os, uptime: `${ri(1, 40)} jours, ${ri(0, 23)}:${String(ri(0, 59)).padStart(2, '0')}`,
    cpu: { percent: r(3, 65), cores: m.cores },
    load: [r(0.5, 6), r(0.5, 5), r(0.5, 4)].map(x => +x.toFixed(2)),
    mem: { percent: memPct, used: m.mem * GB * memPct / 100, total: m.mem * GB },
    net: { rx: r(1e4, 3e7), tx: r(1e4, 1.2e7) },
    temps: [{ label: 'CPU', value: ri(38, 68) }],
    gpus: m.gpu ? [{ name: m.gpu, util: ri(0, 60), memPercent: ri(5, 40), temp: ri(35, 70) }] : [],
    fs: [{ mount: '/', used: 40 * GB, total: 120 * GB, percent: 33 }],
    disks: m.disks.map(d => d === m.badDisk
      ? { name: d, model: 'WDC WD40EFRX', temp: null, health: 'fail', notes: ['Le disque ne répond plus aux requêtes SMART'] }
      : d === 'sde' ? { name: d, model: 'Seagate IronWolf 8To', temp: null, health: 'ok', standby: true, notes: [] }
      : { name: d, model: d.startsWith('nvme') ? 'Samsung 970 EVO' : 'Seagate IronWolf 8To', temp: ri(30, 42), health: d === 'sdc' && name === 'unRaid' ? 'warn' : 'ok', notes: d === 'sdc' && name === 'unRaid' ? ['8 secteur(s) réalloué(s)'] : [] }),
    updates: m.ha
      ? [{ name: 'Home Assistant Core', from: '2026.11.1', to: '2026.11.3' }, { name: 'Mosquitto broker (add-on)', from: '6.5.1', to: '6.5.2' }]
      : m.apt
      ?[{ name: 'linux-image-amd64', from: '6.12.48-1', to: '6.12.57-1' }, { name: 'openssl', from: '3.5.1-1', to: '3.5.4-1', security: true }]
      : name === 'unRaid' ? [{ name: 'Plugin Compose Manager Plus', from: '2026.10.01', to: '2026.11.12' }] : [],
    smartAvailable: true,
    imageUpdates: name === 'unRaid' ? 2 : name === 'debian' ? 1 : 0
  };
}

export default {
  label: 'Démo (données fictives)',
  help: 'Données inventées pour tester l\'affichage. Indique un nom de machine (unRaid, unRaid-2, debian-2, debian) dans « Machine simulée ».',
  provides: ['machine', 'docker', 'media', 'torrents', 'rss', 'calendar'],
  fields: [{ key: 'machine', label: 'Machine simulée', placeholder: 'unRaid' }],
  async test() { return 'Mode démo : rien à tester'; },
  async action(_c, payload) {
    if (payload.op === 'add') return { ok: true };
    if (!['start', 'stop', 'restart'].includes(payload.op)) throw new Error('Action invalide');
    await new Promise(r => setTimeout(r, 900)); // simule le délai de Docker
    dockerState.set(payload.containerId, { state: payload.op === 'stop' ? 'exited' : 'running', since: Date.now() });
    return { ok: true };
  },

  async fetch(kind, c, w, integration) {
    if (kind === 'machine') return machine(c.machine || 'unRaid');
    if (kind === 'docker') {
      const hosts = c.machine ? [c.machine] : Object.keys(CONTAINERS);
      return {
        containers: hosts.flatMap(h => CONTAINERS[h].map(n => {
          const id = Buffer.from(h + n).toString('hex').padEnd(12, '0').slice(0, 12);
          const st = dockerState.get(id) || { state: n === 'mealie' || n === 'paperless-ngx' ? 'exited' : 'running', since: Date.now() - ri(1, 20) * 864e5 };
          const mins = Math.round((Date.now() - st.since) / 60000);
          const ago = mins < 1 ? 'Less than a second' : mins < 60 ? `${mins} minutes` : mins < 1440 ? `${Math.round(mins / 60)} hours` : `${Math.round(mins / 1440)} days`;
          return {
            id, host: h, integrationId: integration.id,
            name: n, image: n === 'qbittorrent' ? 'lscr.io/linuxserver/qbittorrent:latest' : `lscr.io/linuxserver/${n}:latest`,
            state: st.state,
            status: st.state === 'running' ? `Up ${ago}` : `Exited (0) ${ago} ago`, canAct: true,
            imageUpdate: ['plex', 'jellyfin', 'portainer'].includes(n)
          };
        }))
      };
    }
    if (kind === 'media') {
      return {
        sessions: [
          { server: 'plex', serverName: 'Plex', user: 'alice', title: 'The Bear', subtitle: 'S03E04 · Violet', state: 'playing', progress: ri(10, 90), method: 'Direct play', device: 'Plex for Android · Galaxy Tab' },
          { server: 'jellyfin', serverName: 'Jellyfin', user: 'bob', title: 'Le Comte de Monte-Cristo', subtitle: '2024', state: 'playing', progress: ri(10, 90), method: 'Transcodage', device: 'Jellyfin Web · Firefox' },
          { server: 'plex', serverName: 'Plex', user: 'admin', title: 'Severance', subtitle: 'S02E07 · Chikhai Bardo', state: 'paused', progress: 42, method: 'Direct stream', device: 'Plex HTPC · Salon' }
        ]
      };
    }
    if (kind === 'torrents') {
      const names = ['debian-13.2.0-amd64-netinst.iso', 'ubuntu-26.04-desktop-amd64.iso', 'Fedora-Workstation-Live-44.iso', 'archlinux-2026.11.01-x86_64.iso', 'Big.Buck.Bunny.4K.mkv'];
      return {
        dl: r(1e5, 2e7), ul: r(1e5, 5e6), connection: 'connected', canAdd: true,
        torrents: names.map((n, i) => {
          const p = i < 2 ? r(10, 95) : 100;
          return { name: n, progress: +p.toFixed(1), state: p < 100 ? 'downloading' : 'uploading', dlspeed: p < 100 ? r(1e5, 1e7) : 0, upspeed: r(0, 2e6), eta: p < 100 ? ri(60, 3600) : 8640000, size: r(0.5, 8) * GB };
        })
      };
    }
    if (kind === 'rss') {
      const src = ['Korben', 'Linuxfr', 'Selfh.st', 'Next', 'Numerama'];
      return {
        items: Array.from({ length: w.limit || 10 }, (_, i) => ({
          title: ['Unraid 7.3 : ce qui change', 'Debian 13.2 est disponible', 'Les meilleures applis auto-hébergées de l\'année', 'Jellyfin 10.11 améliore le transcodage', 'Home Assistant 2026.11 : nouveautés', 'Glances 4.4 : supervision GPU', 'Nextcloud Hub 11 en test', 'Plex change sa politique de partage'][i % 8],
          link: 'https://example.org/article-' + i, source: src[i % src.length],
          date: new Date(Date.now() - i * 3.6e6 * ri(1, 5)).toISOString()
        }))
      };
    }
    if (kind === 'calendar') {
      const d = (days, h, m = 0) => { const x = new Date(); x.setDate(x.getDate() + days); x.setHours(h, m, 0, 0); return x; };
      const ev = (title, s, durH, cal, color, allDay = false) => ({ title, start: s.toISOString(), end: new Date(+s + durH * 36e5).toISOString(), calendar: cal, color, allDay, location: '' });
      return {
        events: [
          ev('Réunion d\'équipe', d(0, 14, 30), 1.5, 'Travail', '#6ee2ff'),
          ev('Dîner entre amis', d(1, 19), 3, 'Perso', '#ff9f6e'),
          ev('Cours de sport', d(2, 18, 30), 1, 'Perso', '#ff9f6e'),
          ev('Sauvegarde mensuelle', d(4, 3), 1, 'Serveurs', '#9bff6e'),
          ev('Week-end à la montagne', d(5, 0), 48, 'Perso', '#ff9f6e', true),
          ev('Point projet', d(8, 9), 2, 'Travail', '#6ee2ff')
        ]
      };
    }
    throw new Error('Type non géré en démo');
  }
};
