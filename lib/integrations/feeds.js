// FreshRSS (API Google Reader) + lecture de flux RSS/Atom simples.
import { XMLParser } from 'fast-xml-parser';
import { request, getText, joinUrl } from '../http.js';

const tokens = new Map();
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
const txt = v => (v == null ? '' : typeof v === 'object' ? (v['#text'] ?? '') : String(v));

// Accepte l'adresse de base de FreshRSS, ou une adresse collée avec /api, /api/greader.php, /i/ ou /p/
export const freshBase = url => String(url || '').trim()
  .replace(/\/+$/, '')
  .replace(/\/(api(\/greader\.php)?|i|p\/?i?)$/i, '')
  .replace(/\/+$/, '');

async function greaderLogin(c, key) {
  const res = await request(joinUrl(freshBase(c.url), '/api/greader.php/accounts/ClientLogin'), {
    method: 'POST', insecure: !!c.insecure,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Email: c.username, Passwd: c.apiPassword }).toString()
  });
  const body = await res.text();
  const m = body.match(/Auth=(.+)/);
  if (res.status === 404) throw new Error(`API FreshRSS introuvable (HTTP 404) : indique l'adresse de base de FreshRSS, ex. https://rss.example.com`);
  if (res.status === 401 || res.status === 403 || /BadAuthentication/i.test(body)) {
    throw new Error('Identifiants refusés par FreshRSS : vérifie l\'utilisateur et le « mot de passe API » (différent du mot de passe de connexion), et que l\'accès API est autorisé');
  }
  if (!res.ok || !m) throw new Error(`Réponse inattendue de FreshRSS (HTTP ${res.status}) : ${body.slice(0, 120)}`);
  tokens.set(key, m[1].trim());
  return m[1].trim();
}

async function greader(c, key, path, retry = true) {
  const token = tokens.get(key) ?? await greaderLogin(c, key);
  const res = await request(joinUrl(freshBase(c.url), `/api/greader.php/reader/api/0${path}`), {
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
    { key: 'url', label: 'URL de FreshRSS (sans /api)', placeholder: 'https://rss.example.com', required: true },
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
    const n = Math.min(100, w.limit || 40);
    const filter = w.unreadOnly ? '&xt=user/-/state/com.google/read' : '';
    const cont = w._c ? `&c=${encodeURIComponent(w._c)}` : '';
    const r = await greader(c, integration.id, `/stream/contents/reading-list?output=json&n=${n}${filter}${cont}`);
    return {
      continuation: r.continuation || null,
      items: (r.items || []).map(i => ({
        id: i.id, integrationId: integration.id,
        title: i.title, link: i.alternate?.[0]?.href || i.canonical?.[0]?.href,
        source: i.origin?.title || '', author: i.author || '',
        date: i.published ? new Date(i.published * 1000).toISOString() : null,
        read: (i.categories || []).some(x => /state\/com\.google\/read$/.test(x)),
        content: String(i.content?.content || i.summary?.content || '').slice(0, 80000)
      }))
    };
  },
  async action(c, payload, integration) {
    if (payload.op !== 'read' && payload.op !== 'unread') throw new Error('Action inconnue');
    const ids = (Array.isArray(payload.ids) ? payload.ids : []).map(String).filter(x => x.length < 200).slice(0, 200);
    if (!ids.length) return { ok: true };
    const key = integration.id;
    const tokenRes = await request(joinUrl(freshBase(c.url), '/api/greader.php/reader/api/0/token'), {
      insecure: !!c.insecure, headers: { Authorization: `GoogleLogin auth=${tokens.get(key) ?? await greaderLogin(c, key)}` }
    });
    const T = (await tokenRes.text()).trim();
    const body = new URLSearchParams();
    ids.forEach(i => body.append('i', i));
    body.append(payload.op === 'read' ? 'a' : 'r', 'user/-/state/com.google/read');
    body.append('T', T);
    const res = await request(joinUrl(freshBase(c.url), '/api/greader.php/reader/api/0/edit-tag'), {
      method: 'POST', insecure: !!c.insecure, body: body.toString(),
      headers: { Authorization: `GoogleLogin auth=${tokens.get(key)}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!res.ok) throw new Error(`FreshRSS a refusé le marquage (HTTP ${res.status})`);
    return { ok: true, count: ids.length };
  }
};

// Flux RSS/Atom bruts (pas d'intégration nécessaire)
export async function readFeed(url) {
  const doc = xml.parse(await getText(url, { timeout: 10000 }));
  if (doc.rss) {
    const ch = doc.rss.channel;
    return [].concat(ch.item || []).map(i => ({
      id: txt(i.guid) || txt(i.link), title: txt(i.title), link: txt(i.link), source: txt(ch.title),
      date: i.pubDate ? new Date(i.pubDate).toISOString() : null,
      content: txt(i['content:encoded'] || i.description).slice(0, 80000)
    }));
  }
  if (doc.feed) {
    return [].concat(doc.feed.entry || []).map(e => {
      const links = [].concat(e.link || []);
      const l = links.find(x => x['@rel'] === 'alternate') || links[0];
      return {
        id: txt(e.id) || l?.['@href'], title: txt(e.title), link: l?.['@href'] || txt(l), source: txt(doc.feed.title),
        date: e.updated || e.published ? new Date(e.updated || e.published).toISOString() : null,
        content: txt(e.content || e.summary).slice(0, 80000)
      };
    });
  }
  if (doc['rdf:RDF']) {
    return [].concat(doc['rdf:RDF'].item || []).map(i => ({ title: txt(i.title), link: txt(i.link), source: '', date: null }));
  }
  throw new Error('Format de flux non reconnu');
}
