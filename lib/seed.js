// Contenu initial. En mode démo (DEMO=1) : onglets complets branchés sur l'intégration fictive.
import { load, id, encrypt } from './store.js';

const L = (name, url, icon, desc = '') => ({ id: id(), name, url, icon, desc });

function bookmarks() {
  return {
    showStatus: true, style: 'tuiles',
    categories: [
      { id: id(), name: 'Médias', links: [
        L('Plex', 'http://192.168.1.10:32400/web', 'plex'),
        L('Jellyfin', 'http://192.168.1.10:8096', 'jellyfin'),
        L('Jellyseerr', 'http://192.168.1.10:5055', 'jellyseerr', 'Demandes')
      ] },
      { id: id(), name: 'Téléchargements', links: [
        L('qBittorrent', 'http://192.168.1.10:8080', 'qbittorrent'),
        L('Sonarr', 'http://192.168.1.10:8989', 'sonarr'),
        L('Radarr', 'http://192.168.1.10:7878', 'radarr'),
        L('Prowlarr', 'http://192.168.1.10:9696', 'prowlarr')
      ] },
      { id: id(), name: 'Cloud & lecture', links: [
        L('Nextcloud', 'https://nextcloud.com', 'nextcloud'),
        L('FreshRSS', 'https://freshrss.org', 'freshrss'),
        L('Wikipédia', 'https://fr.wikipedia.org', 'wikipedia')
      ] },
      { id: id(), name: 'Infrastructure', links: [
        L('Unraid', 'http://192.168.1.10', 'unraid'),
        L('Home Assistant', 'http://homeassistant.local:8123', 'home-assistant'),
        L('Portainer', 'http://192.168.1.20:9000', 'portainer'),
        L('Pi-hole', 'http://192.168.1.21/admin', 'pi-hole'),
        L('GitHub', 'https://github.com', 'github')
      ] }
    ]
  };
}

const NOTE = `## À faire

- [x] Installer Mon dashboard
- [ ] Déployer l'agent sur **debian** et **debian-2**
- [ ] Remplacer le disque \`sdf\` de unRaid
- [ ] Passer unRaid-2 en mode *push*

> Astuce : les cases se cochent directement, sans passer en édition.

| Machine | IP |
|---|---|
| unRaid | 192.168.1.10 |
| debian | 192.168.1.20 |
`;

export function seed(demo) {
  const st = load();
  const W = (type, title, w, extra = {}) => ({ id: id(), type, title, w, refresh: extra.refresh || 15, integrations: extra.integrations || [], config: extra.config || {} });
  const weather = W('weather', 'Météo', 4, { refresh: 900, config: { city: 'Paris', lat: 48.8566, lon: 2.3522 } });

  if (!demo) {
    st.pages = [{ id: id(), name: 'Accueil', icon: '🏠', widgets: [W('bookmarks', 'Favoris', 12, { refresh: 60, config: { showStatus: true, style: 'tuiles', categories: [] } }), weather] }];
    return;
  }

  const mk = (name, machine) => {
    const it = { id: id(), type: 'demo', name, config: { machine }, secret: encrypt({}) };
    st.integrations.push(it);
    return it.id;
  };
  const all = mk('Démo (toutes machines)', '');
  for (const [network, handle] of [['X', '@moi_demo'], ['Mastodon', '@demo@mastodon.social'], ['Threads', '@demo'], ['Bluesky', '@demo.bsky.social']]) {
    st.integrations.push({ id: id(), type: 'demosocial', name: `${network} (démo)`, config: { network, handle }, secret: encrypt({}) });
  }
  const m = Object.fromEntries(['unRaid', 'unRaid-2', 'debian-2', 'debian', 'Home Assistant'].map(n => [n, mk(`Démo ${n}`, n)]));

  st.pages = [
    { id: id(), name: 'Accueil', icon: '🏠', widgets: [
      W('bookmarks', 'Favoris', 12, { refresh: 60, config: bookmarks() }),
      weather,
      W('calendar', 'Agenda', 4, { refresh: 900, integrations: [all], config: { days: 14 } }),
      W('rss', 'Actualités FreshRSS', 4, { refresh: 600, integrations: [all], config: { limit: 8 } }),
      W('notes', 'Notes', 4, { refresh: 3600, config: { content: NOTE } })
    ] },
    { id: id(), name: 'Serveurs', icon: '🖥️', widgets: [
      ...['unRaid', 'unRaid-2', 'debian-2', 'debian', 'Home Assistant'].map(n =>
        W('machine', n, n === 'unRaid' ? 6 : n === 'Home Assistant' ? 6 : 4, { refresh: 10, integrations: [m[n]], config: { showDisks: true } }))
    ] },
    { id: id(), name: 'Docker', icon: '🐳', widgets: [
      W('docker', 'Tous les conteneurs', 12, { refresh: 30, integrations: [all] })
    ] },
    { id: id(), name: 'Lecture', icon: '📖', widgets: [
      W('reader', 'Lecteur RSS', 12, { refresh: 300, integrations: [all], config: { fill: true, unreadOnly: true, order: 'Plus récents d\'abord', limit: 30, showImages: true, markOnScroll: false } })
    ] },
    { id: id(), name: 'Médias', icon: '🎬', widgets: [
      W('media', 'En cours de lecture', 6, { refresh: 10, integrations: [all] }),
      W('torrents', 'qBittorrentVPN', 6, { refresh: 5, integrations: [all], config: { limit: 10 } })
    ] }
  ];
}
