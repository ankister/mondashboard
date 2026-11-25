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
  provides: ['rss', 'reader'],
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
  async fetch(kind, c, w, integration) {
    if (kind === 'reader') return readerFetch(c, w, integration);
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
    const key = integration.id;
    const ops = { read: ['a', READ], unread: ['r', READ], star: ['a', STAR], unstar: ['r', STAR] };
    if (payload.op === 'readall') {
      const s = cleanStream(payload.stream);
      const ts = /^\d{10,17}$/.test(String(payload.ts || '')) ? String(payload.ts) : `${Date.now()}000`;
      const res = await greaderPost(c, key, '/mark-all-as-read', { s, ts });
      if (!res.ok) throw new Error(`FreshRSS a refusé « tout marquer comme lu » (HTTP ${res.status})`);
      return { ok: true };
    }
    if (!ops[payload.op]) throw new Error('Action inconnue');
    const ids = (Array.isArray(payload.ids) ? payload.ids : []).map(String).filter(x => x.length < 200).slice(0, 200);
    if (!ids.length) return { ok: true };
    const [verb, tag] = ops[payload.op];
    const res = await greaderPost(c, key, '/edit-tag', { i: ids, [verb]: tag });
    if (!res.ok) throw new Error(`FreshRSS a refusé le marquage (HTTP ${res.status})`);
    return { ok: true, count: ids.length };
  }
};

const READ = 'user/-/state/com.google/read';
const STAR = 'user/-/state/com.google/starred';
const ALL = 'user/-/state/com.google/reading-list';

// Flux autorisés : tout, favoris, un abonnement (feed/12) ou une catégorie (user/-/label/Nom)
function cleanStream(s) {
  s = String(s || 'all');
  if (s === 'all') return ALL;
  if (s === 'starred') return STAR;
  if (/^feed\/\d{1,10}$/.test(s) || /^user\/-\/label\/[^\n]{1,200}$/.test(s)) return s;
  throw new Error('Flux inconnu');
}

// POST vers l'API avec le jeton d'écriture (T), renouvelé une fois si la session a expiré
async function greaderPost(c, key, path, fields, retry = true) {
  const auth = { Authorization: `GoogleLogin auth=${tokens.get(key) ?? await greaderLogin(c, key)}` };
  const tRes = await request(joinUrl(freshBase(c.url), '/api/greader.php/reader/api/0/token'), { insecure: !!c.insecure, headers: auth });
  if (tRes.status === 401 && retry) { tokens.delete(key); return greaderPost(c, key, path, fields, false); }
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) [].concat(v).forEach(x => body.append(k, x));
  body.append('T', (await tRes.text()).trim());
  return request(joinUrl(freshBase(c.url), `/api/greader.php/reader/api/0${path}`), {
    method: 'POST', insecure: !!c.insecure, body: body.toString(),
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' }
  });
}

const firstImg = html => {
  const m = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return m && /^https?:\/\//i.test(m[1]) ? m[1] : null;
};

// Arborescence catégories > abonnements avec le nombre de non lus
async function readerTree(c, key) {
  const [subs, counts] = await Promise.all([
    greader(c, key, '/subscription/list?output=json'),
    greader(c, key, '/unread-count?output=json')
  ]);
  const n = Object.fromEntries((counts.unreadcounts || []).map(u => [u.id, Number(u.count) || 0]));
  const base = freshBase(c.url);
  const cats = new Map();
  for (const s of subs.subscriptions || []) {
    const cat = s.categories?.[0] || { id: 'user/-/label/Sans catégorie', label: 'Sans catégorie' };
    if (!cats.has(cat.id)) cats.set(cat.id, { id: cat.id, name: cat.label || cat.id.split('/').pop(), unread: n[cat.id] || 0, feeds: [] });
    let icon = s.iconUrl || '';
    if (icon && !/^https?:/i.test(icon)) { try { icon = new URL(icon, base + '/').href; } catch { icon = ''; } }
    cats.get(cat.id).feeds.push({ id: s.id, name: s.title, site: s.htmlUrl || '', icon, unread: n[s.id] || 0 });
  }
  const list = [...cats.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  list.forEach(ct => {
    ct.feeds.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    if (!ct.unread) ct.unread = ct.feeds.reduce((t, f) => t + f.unread, 0);
  });
  return { categories: list, unread: n[ALL] ?? list.reduce((t, ct) => t + ct.unread, 0) };
}

async function readerFetch(c, w, integration) {
  const key = integration.id;
  const stream = cleanStream(w._s);
  const n = Math.min(100, Math.max(10, Number(w.limit) || 30));
  const q = [`n=${n}`, 'output=json'];
  if (w._f === 'unread') q.push(`xt=${encodeURIComponent(READ)}`);
  if (w.order === 'Plus anciens d\'abord') q.push('r=o');
  if (w._c) q.push(`c=${encodeURIComponent(w._c)}`);
  const [tree, r] = await Promise.all([
    w._c ? null : readerTree(c, key),
    // les « / » de l'identifiant restent tels quels : FreshRSS découpe le chemin dessus
    greader(c, key, `/stream/contents/${stream.split('/').map(encodeURIComponent).join('/')}?${q.join('&')}`)
  ]);
  return {
    tree, integrationId: integration.id, continuation: r.continuation || null, loadedAt: `${Date.now()}000`,
    items: (r.items || []).map(i => {
      const content = String(i.content?.content || i.summary?.content || '').slice(0, 120000);
      const enc = [].concat(i.enclosure || []).find(e => /^image\//.test(e.type || '') && /^https?:/i.test(e.href || ''));
      const cats = i.categories || [];
      return {
        id: i.id, title: i.title || '(sans titre)', link: i.alternate?.[0]?.href || i.canonical?.[0]?.href || '',
        feedId: i.origin?.streamId || '', source: i.origin?.title || '', author: i.author || '',
        date: i.published ? new Date(i.published * 1000).toISOString() : null,
        read: cats.some(x => /state\/com\.google\/read$/.test(x)),
        starred: cats.some(x => /state\/com\.google\/starred$/.test(x)),
        image: enc?.href || firstImg(content), content
      };
    })
  };
}

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
