// FreshRSS (API Google Reader) + lecture de flux RSS/Atom simples.
import { XMLParser } from 'fast-xml-parser';
import { request, getText, joinUrl } from '../http.js';

const tokens = new Map();
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
const txt = v => (v == null ? '' : typeof v === 'object' ? (v['#text'] ?? '') : String(v));

async function greaderLogin(c, key) {
  const res = await request(joinUrl(c.url, '/api/greader.php/accounts/ClientLogin'), {
    method: 'POST', insecure: !!c.insecure,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Email: c.username, Passwd: c.apiPassword }).toString()
  });
  const body = await res.text();
  const m = body.match(/Auth=(.+)/);
  if (!res.ok || !m) throw new Error('Connexion FreshRSS refusée (vérifie le mot de passe API et l\'activation de l\'API)');
  tokens.set(key, m[1].trim());
  return m[1].trim();
}

async function greader(c, key, path, retry = true) {
  const token = tokens.get(key) ?? await greaderLogin(c, key);
  const res = await request(joinUrl(c.url, `/api/greader.php/reader/api/0${path}`), {
    insecure: !!c.insecure, headers: { Authorization: `GoogleLogin auth=${token}` }
  });
  if (res.status === 401 && retry) { tokens.delete(key); return greader(c, key, path, false); }
  if (!res.ok) throw new Error(`FreshRSS a répondu ${res.status}`);
  return res.json();
}

export const freshrss = {
  label: 'FreshRSS',
  help: 'FreshRSS → Configuration → Authentification : autoriser l\'accès API. Puis Profil → « Mot de passe API ».',
  provides: ['rss'],
  fields: [
    { key: 'url', label: 'URL', placeholder: 'https://rss.example.com', required: true },
    { key: 'username', label: 'Utilisateur', required: true },
    { key: 'apiPassword', label: 'Mot de passe API', type: 'password', secret: true, required: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],
  async test(c) {
    tokens.delete('test');
    const r = await greader(c, 'test', '/subscription/list?output=json');
    return `FreshRSS joignable : ${r.subscriptions?.length ?? 0} abonnement(s)`;
  },
  async fetch(_k, c, w, integration) {
    const n = w.limit || 15;
    const filter = w.unreadOnly ? '&xt=user/-/state/com.google/read' : '';
    const r = await greader(c, integration.id, `/stream/contents/reading-list?output=json&n=${n}${filter}`);
    return {
      items: (r.items || []).map(i => ({
        title: i.title, link: i.alternate?.[0]?.href || i.canonical?.[0]?.href,
        source: i.origin?.title || '', date: i.published ? new Date(i.published * 1000).toISOString() : null
      }))
    };
  }
};

// Flux RSS/Atom bruts (pas d'intégration nécessaire)
export async function readFeed(url) {
  const doc = xml.parse(await getText(url, { timeout: 10000 }));
  if (doc.rss) {
    const ch = doc.rss.channel;
    return [].concat(ch.item || []).map(i => ({
      title: txt(i.title), link: txt(i.link), source: txt(ch.title),
      date: i.pubDate ? new Date(i.pubDate).toISOString() : null
    }));
  }
  if (doc.feed) {
    return [].concat(doc.feed.entry || []).map(e => {
      const links = [].concat(e.link || []);
      const l = links.find(x => x['@rel'] === 'alternate') || links[0];
      return {
        title: txt(e.title), link: l?.['@href'] || txt(l), source: txt(doc.feed.title),
        date: e.updated || e.published ? new Date(e.updated || e.published).toISOString() : null
      };
    });
  }
  if (doc['rdf:RDF']) {
    return [].concat(doc['rdf:RDF'].item || []).map(i => ({ title: txt(i.title), link: txt(i.link), source: '', date: null }));
  }
  throw new Error('Format de flux non reconnu');
}
