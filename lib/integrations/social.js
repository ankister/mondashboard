// Publication directe sur les réseaux sociaux (Mastodon, Bluesky, Threads, X).
// Chaque compte est une intégration ; le lecteur RSS publie le texte choisi sur les comptes cochés.
// Interface commune : { network, provides: ['social'], fields, test(c), post(c, text, article, integration) }
// post() renvoie { url } (lien vers la publication) ou lève une erreur au message lisible.
import crypto from 'node:crypto';
import { request, joinUrl } from '../http.js';
import { load, save, encrypt, decrypt } from '../store.js';

const readErr = async (res, label) => {
  let detail = '';
  try {
    const t = await res.text();
    try { const j = JSON.parse(t); detail = j.error_description || j.error?.message || j.message || j.detail || j.title || (typeof j.error === 'string' ? j.error : '') || j.errors?.[0]?.message || ''; }
    catch { detail = t.slice(0, 160); }
  } catch { /* ignoré */ }
  return new Error(`${label} a répondu ${res.status}${detail ? ` : ${detail}` : ''}`);
};

// ---------- Mastodon : jeton d'accès créé dans Préférences → Développement ----------
const mastoBase = c => {
  const u = String(c.url || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
};
async function mastoMe(c) {
  const res = await request(joinUrl(mastoBase(c), '/api/v1/accounts/verify_credentials'), {
    timeout: 15000, headers: { Authorization: `Bearer ${c.token}` }
  });
  if (res.status === 401 || res.status === 403) throw new Error('Jeton Mastodon refusé (droit « write:statuses » requis)');
  if (!res.ok) throw await readErr(res, 'Mastodon');
  return res.json();
}
export const mastodon = {
  label: 'Mastodon', network: 'Mastodon',
  help: 'Sur ton instance : Préférences → Développement → Nouvelle application, coche au moins « read:accounts » et « write:statuses », puis copie le « Jeton d\'accès ».',
  provides: ['social'],
  fields: [
    { key: 'url', label: 'Instance', placeholder: 'https://mastodon.social', required: true },
    { key: 'visibility', label: 'Visibilité des messages', type: 'select', options: ['public', 'unlisted', 'private'], default: 'public' },
    { key: 'token', label: 'Jeton d\'accès', type: 'password', secret: true, required: true }
  ],
  async test(c) {
    const me = await mastoMe(c);
    return `Connecté en tant que @${me.acct}@${new URL(mastoBase(c)).host}`;
  },
  async handle(c) { const me = await mastoMe(c); return `@${me.acct}`; },
  async post(c, text) {
    const res = await request(joinUrl(mastoBase(c), '/api/v1/statuses'), {
      method: 'POST', timeout: 20000,
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.createHash('sha256').update(text).digest('hex') },
      body: JSON.stringify({ status: text, visibility: c.visibility || 'public', language: 'fr' })
    });
    if (!res.ok) throw await readErr(res, 'Mastodon');
    const j = await res.json();
    return { url: j.url };
  }
};

// ---------- Bluesky : identifiant + mot de passe d'application ----------
const bskyService = c => (String(c.service || '').trim().replace(/\/+$/, '') || 'https://bsky.social');
async function bskySession(c) {
  const res = await request(`${bskyService(c)}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', timeout: 15000, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: String(c.handle || '').replace(/^@/, ''), password: c.appPassword })
  });
  if (res.status === 401) throw new Error('Identifiant ou mot de passe d\'application Bluesky refusé');
  if (!res.ok) throw await readErr(res, 'Bluesky');
  return res.json();
}
// Liens et hashtags cliquables : Bluesky veut leurs positions en octets UTF-8
export function bskyFacets(text) {
  const enc = new TextEncoder();
  const pos = i => enc.encode(text.slice(0, i)).length;
  const facets = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)»]/g)) {
    facets.push({ index: { byteStart: pos(m.index), byteEnd: pos(m.index + m[0].length) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] });
  }
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_]{1,64})/gu)) {
    const start = m.index + m[1].length;
    facets.push({ index: { byteStart: pos(start), byteEnd: pos(start + m[2].length + 1) }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2] }] });
  }
  return facets;
}
// Carte d'aperçu du lien (titre, résumé, vignette si l'image est récupérable)
async function bskyCard(c, s, article) {
  if (!/^https?:\/\//i.test(article?.link || '')) return undefined;
  const external = { uri: article.link, title: String(article.title || '').slice(0, 300), description: String(article.description || '').slice(0, 300) };
  if (/^https?:\/\//i.test(article.image || '')) {
    try {
      const img = await request(article.image, { timeout: 10000 });
      const type = img.headers.get('content-type') || '';
      const buf = Buffer.from(await img.arrayBuffer());
      if (img.ok && /^image\/(jpeg|png|webp|gif)/.test(type) && buf.length < 950000) {
        const up = await request(`${bskyService(c)}/xrpc/com.atproto.repo.uploadBlob`, {
          method: 'POST', timeout: 20000, headers: { Authorization: `Bearer ${s.accessJwt}`, 'Content-Type': type }, body: buf
        });
        if (up.ok) external.thumb = (await up.json()).blob;
      }
    } catch { /* vignette facultative */ }
  }
  return { $type: 'app.bsky.embed.external', external };
}
export const bluesky = {
  label: 'Bluesky', network: 'Bluesky',
  help: 'Bluesky → Paramètres → Confidentialité et sécurité → Mots de passe d\'application → Ajouter. N\'utilise jamais ton mot de passe principal ici.',
  provides: ['social'],
  fields: [
    { key: 'handle', label: 'Identifiant', placeholder: 'moi.bsky.social', required: true },
    { key: 'service', label: 'Serveur (PDS), laisser vide pour bsky.social', placeholder: 'https://bsky.social' },
    { key: 'card', label: 'Ajouter la carte d\'aperçu du lien (titre, résumé, vignette)', type: 'checkbox', default: true },
    { key: 'appPassword', label: 'Mot de passe d\'application', type: 'password', secret: true, required: true }
  ],
  async test(c) { const s = await bskySession(c); return `Connecté en tant que @${s.handle}`; },
  async handle(c) { return `@${String(c.handle || '').replace(/^@/, '')}`; },
  async post(c, text, article) {
    const s = await bskySession(c);
    const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), langs: ['fr'] };
    const facets = bskyFacets(text);
    if (facets.length) record.facets = facets;
    if (c.card !== false) { const embed = await bskyCard(c, s, article); if (embed) record.embed = embed; }
    const res = await request(`${bskyService(c)}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST', timeout: 20000, headers: { Authorization: `Bearer ${s.accessJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: s.did, collection: 'app.bsky.feed.post', record })
    });
    if (!res.ok) throw await readErr(res, 'Bluesky');
    const j = await res.json();
    return { url: `https://bsky.app/profile/${s.handle}/post/${String(j.uri).split('/').pop()}` };
  }
};

// ---------- Threads : jeton longue durée (60 jours), renouvelé automatiquement ----------
const TH = 'https://graph.threads.net/v1.0';
async function thCall(path, params, method = 'GET') {
  const qs = new URLSearchParams(params);
  const res = await request(method === 'GET' ? `${path}?${qs}` : path, {
    method, timeout: 20000,
    ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs.toString() })
  });
  if (res.status === 401 || res.status === 190) throw new Error('Jeton Threads refusé ou expiré : génère-en un nouveau');
  if (!res.ok) throw await readErr(res, 'Threads');
  return res.json();
}
// Un jeton longue durée se renouvelle tant qu'il est valide : on le fait au plus une fois par jour
async function thToken(c, integration) {
  const it = integration && load().integrations.find(i => i.id === integration.id);
  const last = Number(it?.config?.refreshedAt) || 0;
  if (!it || Date.now() - last < 86400000) return c.token;
  try {
    const r = await thCall('https://graph.threads.net/refresh_access_token', { grant_type: 'th_refresh_token', access_token: c.token });
    if (r.access_token) {
      it.secret = encrypt({ ...decrypt(it.secret), token: r.access_token });
      it.config = { ...it.config, refreshedAt: String(Date.now()) };
      save();
      return r.access_token;
    }
  } catch { /* on garde le jeton actuel */ }
  return c.token;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const threads = {
  label: 'Threads', network: 'Threads',
  help: 'Nécessite une application Meta (developers.facebook.com) avec le cas d\'usage « Threads API » et les droits threads_basic + threads_content_publish. Génère un jeton pour ton compte, échange-le contre un jeton longue durée (60 jours) et colle-le ici : le dashboard le renouvelle ensuite tout seul.',
  provides: ['social'],
  fields: [
    { key: 'token', label: 'Jeton d\'accès longue durée', type: 'password', secret: true, required: true }
  ],
  async test(c) {
    const me = await thCall(`${TH}/me`, { fields: 'username', access_token: c.token });
    return `Connecté en tant que @${me.username}`;
  },
  async handle(c) { const me = await thCall(`${TH}/me`, { fields: 'username', access_token: c.token }); return `@${me.username}`; },
  async post(c, text, _article, integration) {
    const token = await thToken(c, integration);
    const box = await thCall(`${TH}/me/threads`, { media_type: 'TEXT', text, access_token: token }, 'POST');
    let pub;
    for (let i = 0; i < 4; i++) { // le conteneur peut ne pas être prêt immédiatement
      try { pub = await thCall(`${TH}/me/threads_publish`, { creation_id: box.id, access_token: token }, 'POST'); break; }
      catch (e) { if (i === 3) throw e; await sleep(2500); }
    }
    let url = 'https://www.threads.com/';
    try { url = (await thCall(`${TH}/${pub.id}`, { fields: 'permalink', access_token: token })).permalink || url; } catch { /* lien facultatif */ }
    return { url };
  }
};

// ---------- X : API v2, OAuth 1.0a (clés de l'application + jetons du compte) ----------
const pct = s => encodeURIComponent(s).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
export function oauthHeader(c, method, url, fixed = {}) {
  const o = {
    oauth_consumer_key: c.apiKey, oauth_nonce: fixed.nonce || crypto.randomBytes(16).toString('hex'), oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: fixed.timestamp || String(Math.floor(Date.now() / 1000)), oauth_token: c.accessToken, oauth_version: '1.0'
  };
  const u = new URL(url);
  const params = [...Object.entries(o), ...u.searchParams.entries()].map(([k, v]) => [pct(k), pct(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = [method, pct(`${u.origin}${u.pathname}`), pct(params.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  o.oauth_signature = crypto.createHmac('sha1', `${pct(c.apiSecret)}&${pct(c.accessSecret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.entries(o).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ');
}
async function xCall(c, method, url, body) {
  const res = await request(url, {
    method, timeout: 20000,
    headers: { Authorization: oauthHeader(c, method, url), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) throw new Error('Clés X refusées (vérifie les 4 clés et le droit « Read and write » de l\'application)');
  if (res.status === 402) throw new Error('Crédits X épuisés : recharge ton compte développeur X');
  if (!res.ok) throw await readErr(res, 'X');
  return res.json();
}
export const xsocial = {
  label: 'X', network: 'X',
  help: 'console.x.com : crée une application avec les droits « Read and write », puis copie la clé et le secret de l\'application (API Key / Secret) et le jeton d\'accès du compte (Access Token / Secret). L\'API de X est payante à l\'usage : chaque publication est facturée sur tes crédits, plus cher quand elle contient un lien.',
  provides: ['social'],
  fields: [
    { key: 'apiKey', label: 'API Key (clé de l\'application)', required: true },
    { key: 'apiSecret', label: 'API Key Secret', type: 'password', secret: true, required: true },
    { key: 'accessToken', label: 'Access Token (jeton du compte)', required: true },
    { key: 'accessSecret', label: 'Access Token Secret', type: 'password', secret: true, required: true }
  ],
  async test(c) {
    const me = await xCall(c, 'GET', 'https://api.x.com/2/users/me');
    return `Connecté en tant que @${me.data?.username} (attention : la lecture de test peut être facturée)`;
  },
  // pas d'appel à l'API (facturé) juste pour afficher le pseudo
  async handle() { return ''; },
  async post(c, text) {
    const j = await xCall(c, 'POST', 'https://api.x.com/2/tweets', { text });
    return { url: `https://x.com/i/status/${j.data?.id}` };
  }
};

// ---------- démonstration : comptes fictifs, rien n'est envoyé ----------
export const demosocial = {
  label: 'Démo (réseau social)', network: null,
  help: 'Compte fictif pour tester la publication sans rien envoyer.',
  provides: ['social'],
  fields: [
    { key: 'network', label: 'Réseau', type: 'select', options: ['X', 'Mastodon', 'Threads', 'Bluesky'], default: 'Mastodon' },
    { key: 'handle', label: 'Pseudo affiché', placeholder: '@moi' }
  ],
  async test() { return 'Compte de démonstration'; },
  async handle(c) { return c.handle || ''; },
  async post(c, text) {
    await sleep(500 + Math.random() * 900);
    if (/échec/i.test(text)) throw new Error('Erreur simulée (le texte contient « échec »)');
    return { url: `https://exemple.invalid/${(c.network || 'reseau').toLowerCase()}/${Date.now()}` };
  }
};
