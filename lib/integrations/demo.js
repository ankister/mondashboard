import crypto from 'node:crypto';
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
const torrentPaused = new Set();
const readDemo = new Set();
const torrentDeleted = new Set();
const demoUpdates = new Map(); // id du conteneur -> début de la mise à jour simulée
function demoJob(id, outdated) {
  const t0 = demoUpdates.get(id);
  if (!t0) return { imageUpdate: outdated, job: null };
  const s = (Date.now() - t0) / 1000, at = new Date(t0).toISOString();
  if (s < 4) return { imageUpdate: true, job: { state: 'pulling', at } };
  if (s < 8) return { imageUpdate: true, job: { state: 'recreating', at } };
  return { imageUpdate: false, job: { state: 'done', at: new Date(t0 + 8000).toISOString() } };
}
const unreadDemo = new Set();
const starDemo = new Set(['art-3', 'art-11', 'art-24']);

// ---------- lecteur RSS : abonnements et articles fictifs ----------
const DEMO_CATS = [
  { name: 'Actualités tech', feeds: [['Korben', 'korben.info'], ['LinuxFr.org', 'linuxfr.org'], ['Next', 'next.ink'], ['Numerama', 'numerama.com']] },
  { name: 'Auto-hébergement', feeds: [['selfh.st', 'selfh.st'], ['Noted', 'noted.lol'], ['r/selfhosted', 'reddit.com']] },
  { name: 'Domotique', feeds: [['Home Assistant', 'home-assistant.io'], ['Domo-blog', 'domo-blog.fr']] },
  { name: 'Photo', feeds: [['Phototrend', 'phototrend.fr'], ['Fstoppers', 'fstoppers.com']] }
];
const DEMO_FEEDS = DEMO_CATS.flatMap((c, ci) => c.feeds.map(([name, site], fi) => ({ id: `feed/${ci * 10 + fi + 1}`, name, site, cat: c.name })));
const DEMO_TITLES = {
  'Korben': ['Cette appli open source remplace enfin Google Photos', 'Comment chiffrer ses sauvegardes sans se prendre la tête', 'Un outil pour savoir quel processus mange votre RAM', 'Le terminal le plus rapide de 2026 est écrit en Zig'],
  'LinuxFr.org': ['Debian 13.2 « Trixie » est disponible', 'Sortie de KDE Plasma 6.5', 'Le noyau Linux 6.18 arrive avec un nouveau planificateur', 'Revue de presse de novembre'],
  'Next': ['Cloud souverain : les hébergeurs français montent au créneau', 'La CNIL publie ses recommandations sur les caméras connectées', 'Fibre : la fin du cuivre se précise', 'IA locale : ce que valent vraiment les mini-PC'],
  'Numerama': ['Les meilleurs NAS pour débuter en 2026', 'Wi-Fi 7 : faut-il changer de box ?', 'Pourquoi les SSD NVMe chauffent autant', 'On a testé le nouveau Raspberry Pi'],
  'selfh.st': ['Self-host weekly : les nouveautés de la semaine', 'Les 25 applis auto-hébergées qui ont marqué l\'année', 'Immich 2.3 : partage de lieux et albums intelligents', 'Notre comparatif des gestionnaires de mots de passe'],
  'Noted': ['Installer un lecteur RSS auto-hébergé en 10 minutes', 'Remplacer Notion par une solution maison', 'Surveiller ses conteneurs Docker sans Portainer', 'Un tableau de bord pour tous vos serveurs'],
  'r/selfhosted': ['Mon setup après deux ans d\'auto-hébergement', 'Quel reverse proxy choisir en 2026 ?', 'Sauvegardes 3-2-1 : retour d\'expérience', 'Je suis passé de Plex à Jellyfin, voilà mon bilan'],
  'Home Assistant': ['Home Assistant 2026.11 : tableaux de bord par zones', 'Assist devient plus rapide en local', 'Nouvelle intégration pour les compteurs d\'énergie', 'Le point sur Matter et Thread'],
  'Domo-blog': ['Piloter ses volets roulants selon la météo', 'Test : la nouvelle passerelle Zigbee', 'Créer une alerte de fuite d\'eau fiable', 'Économiser sur le chauffage avec des têtes thermostatiques'],
  'Phototrend': ['Les plus belles photos de la Voie lactée de l\'année', 'Test du Fujifilm X-T6', 'Bien choisir son objectif pour le portrait', 'Lightroom ajoute la suppression d\'objets en local'],
  'Fstoppers': ['Cinq astuces pour réussir ses photos de nuit', 'Le format RAW expliqué simplement', 'Pourquoi la lumière du matin change tout', 'Retoucher un paysage en 15 minutes']
};
let demoCache = null;
function demoArticles() {
  if (demoCache) return demoCache;
  const out = [];
  let k = 0;
  DEMO_FEEDS.forEach((f, fi) => (DEMO_TITLES[f.name] || []).forEach((t, ti) => {
    const n = k++;
    const age = (ti * 11 + fi * 1.7 + (n % 5) * 0.6) * 3.6e6 + 20 * 6e4;
    out.push({
      id: `art-${n}`, feedId: f.id, source: f.name, cat: f.cat, title: t, author: ['Rédaction', 'Camille D.', 'Thomas L.', 'Léa M.'][n % 4],
      link: `https://${f.site}/article-${n}`, age, image: n % 3 === 2 ? null : `/demo/thumb/${n}.svg`,
      readInit: ti >= 2 && n % 4 !== 0,
      content: `<p><strong>${t}.</strong> Ceci est un article de démonstration affiché dans le lecteur, sans quitter le dashboard. Le texte provient directement du flux, tel que FreshRSS le fournit.</p>
<h2>Ce qu'il faut retenir</h2>
<p>Le lecteur reprend la mise en forme de l'article : intertitres, listes, citations, code et images. Les liens <a href="https://${f.site}">s'ouvrent dans un nouvel onglet</a>.</p>
<ul><li>Lecture dans la page, sans publicité ni pistage</li><li>Synchronisé avec FreshRSS : lu, non lu et favoris</li><li>Raccourcis clavier : <code>j</code> / <code>k</code> pour naviguer, <code>s</code> pour les favoris, <code>m</code> pour lu / non lu</li></ul>
<blockquote>Une citation, pour vérifier la mise en forme des encadrés.</blockquote>
<p>Un deuxième paragraphe plus long, pour montrer le confort de lecture sur une colonne de largeur limitée. Les images trop larges sont réduites à la taille de la colonne et les tableaux défilent horizontalement si besoin.</p>
<pre><code>docker compose pull && docker compose up -d</code></pre>
<p>Fin de l'article de démonstration.</p><script>alert('ne doit jamais s\\'exécuter')</script>`
    });
  }));
  out.sort((a, b) => a.age - b.age);
  demoCache = out;
  return out;
}
const demoRead = a => (unreadDemo.has(a.id) ? false : readDemo.has(a.id) || a.readInit);
function inStream(a, s) {
  s = String(s || 'all');
  if (s === 'all') return true;
  if (s === 'starred') return starDemo.has(a.id);
  if (s.startsWith('feed/')) return a.feedId === s;
  if (s.startsWith('user/-/label/')) return a.cat === s.slice(13);
  return false;
}
function demoReader(w, integration) {
  const arts = demoArticles();
  const unread = arts.filter(a => !demoRead(a));
  const cnt = pred => unread.filter(pred).length;
  const tree = {
    unread: unread.length,
    categories: DEMO_CATS.map(c => ({
      id: `user/-/label/${c.name}`, name: c.name, unread: cnt(a => a.cat === c.name),
      feeds: DEMO_FEEDS.filter(f => f.cat === c.name).map(f => ({ id: f.id, name: f.name, site: `https://${f.site}`, icon: '', unread: cnt(a => a.feedId === f.id) }))
    }))
  };
  let list = arts.filter(a => inStream(a, w._s) && (w._f !== 'unread' || !demoRead(a)));
  if (w.order === 'Plus anciens d\'abord') list = [...list].reverse();
  const n = Math.min(100, Math.max(10, Number(w.limit) || 30));
  const start = Number(w._c) || 0;
  const page = list.slice(start, start + n);
  const now = Date.now();
  return {
    tree: w._c ? null : tree, integrationId: integration.id, loadedAt: `${now}000`,
    continuation: start + n < list.length ? String(start + n) : null,
    items: page.map(a => ({
      id: a.id, title: a.title, link: a.link, feedId: a.feedId, source: a.source, author: a.author,
      date: new Date(now - a.age).toISOString(), read: demoRead(a), starred: starDemo.has(a.id), image: a.image, content: a.content
    }))
  };
}
const haBusy = new Map(); // entité update.* -> fin de l'installation simulée
const haDone = new Set();
const DEMO_TORRENTS = [
  { hash: 'a1'.repeat(20), name: 'debian-13.2.0-amd64-netinst.iso', p: 62.4, gb: 0.7, ratio: 0.12, cat: 'linux' },
  { hash: 'b2'.repeat(20), name: 'ubuntu-26.04-desktop-amd64.iso', p: 18.9, gb: 6.1, ratio: 0.01, cat: 'linux' },
  { hash: 'c3'.repeat(20), name: 'Fedora-Workstation-Live-44.iso', p: 100, gb: 2.4, ratio: 1.35, cat: 'linux' },
  { hash: 'd4'.repeat(20), name: 'archlinux-2026.11.01-x86_64.iso', p: 100, gb: 1.3, ratio: 0.48, cat: 'linux' },
  { hash: 'e5'.repeat(20), name: 'Big.Buck.Bunny.2008.2160p.mkv', p: 100, gb: 3.4, ratio: 0, cat: 'films' }
];

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
      ? [{ name: 'Home Assistant Core', from: '2026.11.1', to: '2026.11.3', entity: 'update.home_assistant_core_update', canInstall: true, canBackup: true },
         { name: 'Mosquitto broker (add-on)', from: '6.5.1', to: '6.5.2', entity: 'update.mosquitto_broker_update', canInstall: true, canBackup: true },
         { name: 'Home Assistant Operating System', from: '16.2', to: '16.3', entity: 'update.home_assistant_operating_system_update', canInstall: true, canBackup: false },
         { name: 'Lumière salon Micrologiciel', from: '0x0000100e', to: '0x00001102', entity: 'update.lumiere_salon_firmware', canInstall: true, canBackup: false }]
          .filter(u => !haDone.has(u.entity)).map(u => (haBusy.get(u.entity) > Date.now() ? { ...u, inProgress: true, percent: 40 } : u))
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
  provides: ['machine', 'docker', 'media', 'torrents', 'rss', 'reader', 'calendar', 'analytics'],
  fields: [{ key: 'machine', label: 'Machine simulée', placeholder: 'unRaid' }],
  async test() { return 'Mode démo : rien à tester'; },
  async action(_c, payload) {
    if (payload.op === 'add') return { ok: true };
    if (payload.op === 'pause') { torrentPaused.add(payload.hash); return { ok: true }; }
    if ((payload.op === 'install' || payload.op === 'skip') && payload.entity) {
      if (payload.op === 'skip') haDone.add(payload.entity);
      else { haBusy.set(payload.entity, Date.now() + 8000); setTimeout(() => haDone.add(payload.entity), 8000); }
      return { ok: true };
    }
    if (payload.op === 'delete') { torrentDeleted.add(payload.hash); return { ok: true }; }
    if (payload.op === 'resume') { torrentPaused.delete(payload.hash); return { ok: true }; }
    if (payload.op === 'read') { (payload.ids || []).forEach(i => { readDemo.add(i); unreadDemo.delete(i); }); return { ok: true }; }
    if (payload.op === 'unread') { (payload.ids || []).forEach(i => { readDemo.delete(i); unreadDemo.add(i); }); return { ok: true }; }
    if (payload.op === 'star') { (payload.ids || []).forEach(i => starDemo.add(i)); return { ok: true }; }
    if (payload.op === 'unstar') { (payload.ids || []).forEach(i => starDemo.delete(i)); return { ok: true }; }
    if (payload.op === 'readall') { demoArticles().filter(a => inStream(a, payload.stream)).forEach(a => { readDemo.add(a.id); unreadDemo.delete(a.id); }); return { ok: true }; }
    if (payload.op === 'update' && payload.containerId) { demoUpdates.set(payload.containerId, Date.now()); return { ok: true, queued: true }; }
    if (!['start', 'stop', 'restart'].includes(payload.op)) throw new Error('Action invalide');
    await new Promise(r => setTimeout(r, 900)); // simule le délai de Docker
    dockerState.set(payload.containerId, { state: payload.op === 'stop' ? 'exited' : 'running', since: Date.now() });
    return { ok: true };
  },

  async fetch(kind, c, w, integration) {
    if (kind === 'machine') return machine(c.machine || 'unRaid');
    if (kind === 'analytics') {
      const mk = (name, domain, base, active) => {
        const series = Array.from({ length: 24 }, (_, i) => Math.max(0, Math.round(base * (0.4 + 0.6 * Math.sin((i - 6) / 24 * Math.PI) ** 2) + (Math.random() - .5) * base * .3)));
        const pageviews = series.reduce((a, b) => a + b, 0), visitors = Math.round(pageviews / 2.4), visits = Math.round(visitors * 1.2);
        return { id: domain, name, domain, link: '#', visitors, pageviews, visits, prevVisitors: Math.round(visitors * (0.7 + Math.random() * 0.6)), prevPageviews: Math.round(pageviews * 0.9),
          bounce: 35 + Math.round(Math.random() * 30), avgTime: 40 + Math.round(Math.random() * 200), active, series };
      };
      return { period: w.period || '24 heures', sites: [mk('Blog photo', 'photo.exemple.fr', 40, 3), mk('Boutique', 'boutique.exemple.fr', 18, 1), mk('Portfolio', 'portfolio.exemple.fr', 9, 0), mk('Recettes', 'recettes.exemple.fr', 4, 0), mk('Documentation', 'docs.exemple.fr', 0, 0)] };
    }
    if (kind === 'docker') {
      const hosts = c.machine ? [c.machine] : Object.keys(CONTAINERS);
      return {
        containers: hosts.flatMap(h => CONTAINERS[h].map(n => {
          const id = crypto.createHash('md5').update(h + '/' + n).digest('hex').slice(0, 12);
          const st = dockerState.get(id) || { state: n === 'mealie' || n === 'paperless-ngx' ? 'exited' : 'running', since: Date.now() - ri(1, 20) * 864e5 };
          const mins = Math.round((Date.now() - st.since) / 60000);
          const ago = mins < 1 ? 'Less than a second' : mins < 60 ? `${mins} minutes` : mins < 1440 ? `${Math.round(mins / 60)} hours` : `${Math.round(mins / 1440)} days`;
          return {
            id, host: h, integrationId: integration.id,
            name: n, image: n === 'qbittorrent' ? 'lscr.io/linuxserver/qbittorrent:latest' : `lscr.io/linuxserver/${n}:latest`,
            state: st.state,
            status: st.state === 'running' ? `Up ${ago}` : `Exited (0) ${ago} ago`, canAct: true, canUpdate: true,
            ...demoJob(id, ['plex', 'jellyfin', 'portainer'].includes(n))
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
      const now = Math.floor(Date.now() / 1000);
      return {
        dl: r(1e6, 2e7), ul: r(1e5, 5e6), connection: 'connected', canAdd: true, integrationId: integration.id,
        torrents: DEMO_TORRENTS.filter(t => !torrentDeleted.has(t.hash)).map((t, i) => {
          const paused = torrentPaused.has(t.hash);
          const p = t.p;
          const done = p >= 100;
          const st = paused ? (done ? 'stoppedUP' : 'stoppedDL') : (done ? 'uploading' : 'downloading');
          const size = t.gb * GB;
          return {
            hash: t.hash, name: t.name, progress: p, state: st,
            dlspeed: !done && !paused ? r(1e6, 1e7) : 0, upspeed: paused ? 0 : r(0, 2e6), eta: done || paused ? 8640000 : ri(60, 3600),
            size, totalSize: size, downloaded: size * p / 100, uploaded: size * t.ratio, ratio: t.ratio,
            addedOn: now - (i + 1) * 5400, completionOn: done ? now - (i + 1) * 3600 : -1,
            seeds: ri(0, 20), seedsTotal: ri(20, 60), peers: ri(0, 8), peersTotal: ri(8, 30),
            category: t.cat, tags: '', savePath: `/data/torrents/${t.cat}`, tracker: 'udp://tracker.example.org:1337'
          };
        })
      };
    }
    if (kind === 'reader') return demoReader(w, integration);
    if (kind === 'rss') {
      // 3 pages de 20 articles pour simuler le défilement continu
      const page = w._c ? Number(w._c) : 0;
      const src = ['Korben', 'Linuxfr', 'Selfh.st', 'Next', 'Numerama'];
      const titles = ['Unraid 7.3 : ce qui change', 'Debian 13.2 est disponible', 'Les meilleures applis auto-hébergées de l\'année', 'Jellyfin 10.11 améliore le transcodage', 'Home Assistant 2026.11 : nouveautés', 'Glances 4.4 : supervision GPU', 'Nextcloud Hub 11 en test', 'Plex change sa politique de partage'];
      return {
        continuation: page < 2 ? String(page + 1) : null,
        items: Array.from({ length: 20 }, (_, k) => {
          const i = page * 20 + k;
          const id = `demo-${i}`;
          return {
            id, integrationId: integration.id, title: `${titles[i % 8]}${i >= 8 ? ` (${Math.floor(i / 8) + 1})` : ''}`,
            link: 'https://example.org/article-' + i, source: src[i % src.length], author: 'Rédaction',
            date: new Date(Date.now() - (i + 1) * 3.6e6).toISOString(), read: readDemo.has(id),
            content: `<p><strong>${titles[i % 8]}</strong> — article de démonstration n° ${i + 1}.</p><p>Le contenu complet de l'article s'affiche ici, dans la page, sans quitter le dashboard. Les liens <a href="https://example.org">s'ouvrent dans un nouvel onglet</a>.</p><blockquote>Une citation pour vérifier la mise en forme.</blockquote><ul><li>Premier point</li><li>Second point</li></ul><script>alert('ne doit jamais s\\'exécuter')</script><img src="x" onerror="alert(1)">`
          };
        })
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
          ev('Point projet', d(8, 9), 2, 'Travail', '#6ee2ff'),
          ev('Jour de paie', d(4, 0), 24, 'Travail', '#c86eff', true),
          ev('Anniversaire de Léa', d(12, 0), 24, 'Perso', '#ff9f6e', true),
          ev('Vidange voiture', d(15, 10), 1, 'Perso', '#ff9f6e'),
          ev('Formation', d(-3, 9), 7, 'Travail', '#6ee2ff')
        ]
      };
    }
    throw new Error('Type non géré en démo');
  }
};
