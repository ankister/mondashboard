// Plex et Jellyfin : sessions de lecture en cours, normalisées dans un format commun.
import { getJson, joinUrl } from '../http.js';

const pct = (pos, dur) => (dur ? Math.min(100, Math.round((pos / dur) * 100)) : 0);

export const plex = {
  label: 'Plex',
  help: 'Jeton X-Plex-Token : ouvre un média dans Plex Web → ⋯ → Infos → « Afficher le XML », le jeton est à la fin de l\'URL.',
  provides: ['media'],
  fields: [
    { key: 'url', label: 'URL', placeholder: 'http://192.168.1.10:32400', required: true },
    { key: 'token', label: 'X-Plex-Token', type: 'password', secret: true, required: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],
  opts: c => ({ insecure: !!c.insecure, headers: { 'X-Plex-Token': c.token } }),
  async test(c) {
    const r = await getJson(joinUrl(c.url, '/identity'), this.opts(c));
    return `Plex ${r.MediaContainer?.version || ''} joignable`;
  },
  async fetch(_k, c, _w, integration) {
    const r = await getJson(joinUrl(c.url, '/status/sessions'), this.opts(c));
    const items = r.MediaContainer?.Metadata || [];
    return {
      sessions: items.map(m => ({
        server: 'plex', serverName: integration.name,
        user: m.User?.title || '?',
        title: m.type === 'episode' ? m.grandparentTitle : m.title,
        subtitle: m.type === 'episode'
          ? `S${String(m.parentIndex).padStart(2, '0')}E${String(m.index).padStart(2, '0')} · ${m.title}`
          : (m.year ? String(m.year) : (m.type === 'track' ? `${m.grandparentTitle} · ${m.parentTitle}` : '')),
        state: m.Player?.state === 'paused' ? 'paused' : 'playing',
        progress: pct(m.viewOffset, m.duration),
        method: m.TranscodeSession
          ? (m.TranscodeSession.videoDecision === 'transcode' ? 'Transcodage' : 'Direct stream')
          : 'Direct play',
        device: [m.Player?.product, m.Player?.title].filter(Boolean).join(' · ')
      }))
    };
  }
};

export const jellyfin = {
  label: 'Jellyfin',
  help: 'Tableau de bord Jellyfin → Clés API → « + ».',
  provides: ['media'],
  fields: [
    { key: 'url', label: 'URL', placeholder: 'http://192.168.1.10:8096', required: true },
    { key: 'apiKey', label: 'Clé API', type: 'password', secret: true, required: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],
  opts: c => ({ insecure: !!c.insecure, headers: { Authorization: `MediaBrowser Token="${c.apiKey}"` } }),
  async test(c) {
    const r = await getJson(joinUrl(c.url, '/System/Info'), this.opts(c));
    return `${r.ServerName} (Jellyfin ${r.Version})`;
  },
  async fetch(_k, c, _w, integration) {
    const list = await getJson(joinUrl(c.url, '/Sessions?activeWithinSeconds=960'), this.opts(c));
    return {
      sessions: list.filter(s => s.NowPlayingItem).map(s => {
        const it = s.NowPlayingItem;
        const method = s.PlayState?.PlayMethod;
        return {
          server: 'jellyfin', serverName: integration.name,
          user: s.UserName || '?',
          title: it.Type === 'Episode' ? it.SeriesName : it.Name,
          subtitle: it.Type === 'Episode'
            ? `S${String(it.ParentIndexNumber).padStart(2, '0')}E${String(it.IndexNumber).padStart(2, '0')} · ${it.Name}`
            : (it.ProductionYear ? String(it.ProductionYear) : ''),
          state: s.PlayState?.IsPaused ? 'paused' : 'playing',
          progress: pct(s.PlayState?.PositionTicks || 0, it.RunTimeTicks),
          method: method === 'Transcode' ? 'Transcodage' : method === 'DirectStream' ? 'Direct stream' : 'Direct play',
          device: [s.Client, s.DeviceName].filter(Boolean).join(' · ')
        };
      })
    };
  }
};
