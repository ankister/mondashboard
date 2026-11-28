import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { load, save, isFresh, id, encrypt, decrypt, getIntegration, findWidget } from './lib/store.js';
import { setup, login, logout, changePassword, currentUser, requireAdmin, requireView } from './lib/auth.js';
import { INTEGRATIONS, WIDGETS, publicMeta } from './lib/integrations/index.js';
import { readFeed } from './lib/integrations/feeds.js';
import { weather, geocode } from './lib/weather.js';
import { quote, searchSymbol } from './lib/finance.js';
import { uptimeData, parseTarget } from './lib/uptime.js';
import { suggest } from './lib/search.js';
import { ping } from './lib/http.js';
import { seed } from './lib/seed.js';
import { agentRoutes } from './lib/agentSetup.js';
import { lastSeen } from './lib/integrations/agent.js';
import { cleanTheme, themeCss, themeMeta } from './lib/themes.js';
import { applySmartAck, setSmartAck } from './lib/smartAck.js';

const PORT = Number(process.env.PORT || 3080);
const PKG = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
// APP_VERSION est fourni par l'image Docker (identifiant du commit GitHub)
const APP_VERSION = `${PKG.version}${process.env.APP_VERSION ? '-' + String(process.env.APP_VERSION).slice(0, 7) : ''}`;
const fresh = isFresh();
load();
if (fresh) { seed(process.env.DEMO === '1'); save(); }

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ---------- Session ----------
app.get('/api/session', (req, res) => {
  const st = load();
  res.json({ setupNeeded: !st.auth, user: currentUser(req), publicView: !!st.settings.publicView, title: st.settings.title, version: APP_VERSION, themeMode: cleanTheme(st.settings.theme).mode });
});
// feuille de style du thème (publique : la page de connexion en a besoin aussi)
app.get('/theme.css', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('css').send(themeCss(load().settings.theme));
});
// ---------- Favicon : icône (Lucide ou emoji) sur fond coloré facultatif, ou image envoyée ----------
const FAV_FILE = path.join(process.env.DATA_DIR || path.resolve('data'), 'favicon.img');
const FAV_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml'];
const HEX = /^#[0-9a-f]{6}$/i;
function cleanFavicon(f = {}) {
  const icon = typeof f.icon === 'string' && (/^lucide:[a-z0-9-]{1,60}$/.test(f.icon) || (f.icon.length <= 8 && !/[<>&"']/.test(f.icon))) ? f.icon : '🏠';
  return { mode: f.mode === 'image' ? 'image' : 'icon', icon: icon || '🏠', color: HEX.test(f.color) ? f.color : '#3b82f6', bg: f.bg === true || f.bg === '1' };
}
function parseFavImage(d) {
  const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(d));
  if (!m || !FAV_TYPES.includes(m[1])) throw bad('Format d\'image non pris en charge (PNG, JPG, WebP, GIF, SVG ou ICO)');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1024 * 1024) throw bad('Image trop lourde (1 Mo maximum)');
  return { type: m[1], buf };
}
function faviconSvg(f) {
  const bgRect = f.bg ? `<rect width="24" height="24" rx="5" fill="${f.color}"/>` : '';
  const lm = /^lucide:([a-z0-9-]+)$/.exec(f.icon);
  if (lm) {
    let inner = '';
    try { inner = fs.readFileSync(path.resolve('public/icons/lucide', lm[1] + '.svg'), 'utf8').replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, ''); } catch { /* icône inconnue */ }
    const t = f.bg ? 'translate(4 4) scale(.6667)' : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${bgRect}<g transform="${t}" fill="none" stroke="${f.bg ? '#ffffff' : f.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${bgRect}<text x="12" y="${f.bg ? 17.2 : 19.5}" font-size="${f.bg ? 15 : 20}" text-anchor="middle">${f.icon}</text></svg>`;
}
// public : l'onglet de la page de connexion l'affiche aussi. ?preview=1 sert l'aperçu des réglages.
app.get(/^\/favicon(\.ico)?$/, (req, res) => {
  const st = load();
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  if (req.query.preview) return res.type('image/svg+xml').send(faviconSvg(cleanFavicon(req.query)));
  const f = cleanFavicon(st.settings.favicon);
  if (f.mode === 'image' && st.settings.faviconType && fs.existsSync(FAV_FILE)) return res.type(st.settings.faviconType).send(fs.readFileSync(FAV_FILE));
  res.type('image/svg+xml').send(faviconSvg(f));
});
app.post('/api/setup', setup);
app.post('/api/login', login);
app.post('/api/logout', logout);
app.post('/api/password', requireAdmin, changePassword);

// ---------- Tableau de bord ----------
app.get('/api/dashboard', requireView, (req, res) => {
  const st = load();
  res.json({ settings: st.settings, pages: st.pages, canEdit: !!currentUser(req) });
});

function cleanPages(pages) {
  if (!Array.isArray(pages)) throw bad('Format de pages invalide');
  const ints = new Set(load().integrations.map(i => i.id));
  return pages.map(p => ({
    id: p.id || id(),
    name: String(p.name || 'Onglet').slice(0, 40),
    icon: /^lucide:[a-z0-9-]{1,60}$/.test(p.icon || '') ? p.icon : String(p.icon || '').slice(0, 8),
    ...(p.free ? { free: true } : {}),
    ...(p.hideMobile ? { hideMobile: true } : {}),
    widgets: (p.widgets || []).filter(w => WIDGETS[w.type]).map(w => {
      const cfg = w.config && typeof w.config === 'object' ? w.config : {};
      if (w.type === 'bookmarks') {
        cfg.categories = (cfg.categories || []).map(c => ({
          id: c.id || id(), name: String(c.name || '').slice(0, 60),
          links: (c.links || []).filter(l => l.url).map(l => ({
            id: l.id || id(), name: String(l.name || l.url).slice(0, 60), url: String(l.url),
            icon: String(l.icon || '').slice(0, 300), desc: String(l.desc || '').slice(0, 120),
            pingUrl: String(l.pingUrl || '').slice(0, 300), noPing: !!l.noPing
          }))
        }));
      }
      if (w.type === 'notes') cfg.content = String(cfg.content || '').slice(0, 100000);
      if (w.type === 'uptime') {
        cfg.targets = (Array.isArray(cfg.targets) ? cfg.targets : []).filter(t => parseTarget(t?.url)).slice(0, 100)
          .map(t => ({ id: String(t.id || id()).slice(0, 20), name: String(t.name || '').slice(0, 60), url: String(t.url).trim().slice(0, 300) }));
      }
      if (w.type === 'ha') {
        const okIcon = v => (/^lucide:[a-z0-9-]{1,60}$/.test(v || '') || (typeof v === 'string' && v.length <= 8 && !/[<>&"']/.test(v)) ? v || '' : '');
        cfg.entities = (Array.isArray(cfg.entities) ? cfg.entities : []).filter(e => /^[a-z_]+\.[a-z0-9_]+$/.test(e?.id || '')).slice(0, 100)
          .map(e => ({ id: e.id, name: String(e.name || '').slice(0, 60), icon: okIcon(e.icon), label: String(e.label || '').slice(0, 80), dc: String(e.dc || '').slice(0, 30) }));
      }
      return {
        id: w.id || id(), type: w.type, title: String(w.title ?? WIDGETS[w.type].label).slice(0, 60),
        w: Math.min(12, Math.max(2, Number(w.w) || WIDGETS[w.type].w)),
        ...(Number.isInteger(w.x) && Number.isInteger(w.y) ? { x: Math.min(11, Math.max(0, w.x)), y: Math.max(0, w.y) } : {}),
        // h : hauteur en px ; 0 = automatique ; -1 = aligner sur les blocs voisins
        h: Number(w.h) === -1 ? -1 : Math.min(3000, Math.max(0, Math.round(Number(w.h) || 0))),
        refresh: Math.max(3, Number(w.refresh) || WIDGETS[w.type].refresh),
        ...(w.hideMobile ? { hideMobile: true } : {}),
        ...(w.anchor && typeof w.anchor.id === 'string' && ['top', 'bottom'].includes(w.anchor.edge)
          ? { anchor: { id: w.anchor.id.slice(0, 40), edge: w.anchor.edge } } : {}),
        integrations: (w.integrations || []).filter(x => ints.has(x)),
        config: cfg
      };
    })
  }));
}

app.put('/api/pages', requireAdmin, wrap(req => {
  const st = load();
  st.pages = cleanPages(req.body.pages);
  save();
  cache.clear();
  return { pages: st.pages };
}));

app.put('/api/settings', requireAdmin, wrap(req => {
  const st = load();
  const { title, publicView, greeting, sessionHours, rememberDays, theme, linkTarget, favicon, faviconImage, mobileWidth, mobileTabLabels } = req.body || {};
  if (title !== undefined) st.settings.title = String(title).trim().slice(0, 40) || 'Mon dashboard';
  if (publicView !== undefined) st.settings.publicView = !!publicView;
  if (greeting !== undefined) st.settings.greeting = !!greeting;
  if (sessionHours !== undefined) st.settings.sessionHours = Math.min(8760, Math.max(1, Number(sessionHours) || 168));
  if (theme !== undefined) st.settings.theme = cleanTheme(theme);
  if (linkTarget !== undefined) st.settings.linkTarget = linkTarget === 'same' ? 'same' : 'new';
  if (mobileWidth !== undefined) st.settings.mobileWidth = Math.min(2000, Math.max(320, Math.round(Number(mobileWidth)) || 760));
  if (mobileTabLabels !== undefined) st.settings.mobileTabLabels = !!mobileTabLabels;
  if (favicon !== undefined) st.settings.favicon = { ...cleanFavicon(favicon), v: Date.now() };
  if (faviconImage !== undefined) {
    if (!faviconImage) { try { fs.unlinkSync(FAV_FILE); } catch { /* déjà absent */ } delete st.settings.faviconType; }
    else { const img = parseFavImage(faviconImage); fs.writeFileSync(FAV_FILE, img.buf); st.settings.faviconType = img.type; }
    st.settings.favicon = { ...cleanFavicon(st.settings.favicon), v: Date.now() };
  }
  if (rememberDays !== undefined) st.settings.rememberDays = Math.min(365, Math.max(1, Number(rememberDays) || 30));
  save();
  return { settings: st.settings };
}));

// ---------- Intégrations ----------
app.get('/api/meta', requireAdmin, (req, res) => res.json({ ...publicMeta(), themes: themeMeta() }));

const publicIntegration = it => {
  const def = INTEGRATIONS[it.type];
  const secrets = decrypt(it.secret);
  return {
    id: it.id, type: it.type, name: it.name, config: it.config,
    lastSeen: it.type === 'agent' ? lastSeen(it.id) : undefined,
    secretsSet: Object.fromEntries((def?.fields || []).filter(f => f.secret).map(f => [f.key, !!secrets[f.key]]))
  };
};

function splitConfig(type, input, previousSecret) {
  const def = INTEGRATIONS[type];
  if (!def) throw bad('Type d\'intégration inconnu');
  const config = {}, secret = decrypt(previousSecret);
  for (const f of def.fields) {
    let v = input?.[f.key];
    if (f.type === 'checkbox') v = !!v;
    else v = v == null ? '' : String(v).trim();
    if (f.secret) {
      if (v) secret[f.key] = v;
      if (f.auto && !secret[f.key]) secret[f.key] = crypto.randomBytes(32).toString('hex');
    }
    else config[f.key] = v;
    if (f.required && !f.secret && !v) throw bad(`Champ requis : ${f.label}`);
  }
  if (config.url && !/^https?:\/\//i.test(config.url)) throw bad('L\'URL doit commencer par http:// ou https://');
  return { config, secret: encrypt(secret) };
}

app.get('/api/integrations', requireAdmin, (req, res) => res.json(load().integrations.map(publicIntegration)));
// liste d'éléments proposée par une intégration (ex. entités Home Assistant pour le sélecteur)
app.get('/api/integrations/:id/list', requireAdmin, wrap(async req => {
  const it = getIntegration(req.params.id);
  const def = INTEGRATIONS[it?.type];
  if (!def?.list) throw bad('Liste non disponible pour cette intégration', 404);
  return def.list(it.config, req.query);
}));

app.post('/api/integrations', requireAdmin, wrap(req => {
  const { type, name, config } = req.body || {};
  const it = { id: id(), type, name: String(name || INTEGRATIONS[type]?.label || type).slice(0, 60), ...splitConfig(type, config) };
  load().integrations.push(it);
  save();
  return publicIntegration(it);
}));

app.put('/api/integrations/:id', requireAdmin, wrap(req => {
  const it = load().integrations.find(i => i.id === req.params.id);
  if (!it) throw bad('Intégration introuvable', 404);
  const { name, config } = req.body || {};
  Object.assign(it, { name: String(name || it.name).slice(0, 60), ...splitConfig(it.type, config, it.secret) });
  save();
  cache.clear();
  return publicIntegration(it);
}));

app.delete('/api/integrations/:id', requireAdmin, wrap(req => {
  const st = load();
  st.integrations = st.integrations.filter(i => i.id !== req.params.id);
  st.pages.forEach(p => p.widgets.forEach(w => { w.integrations = (w.integrations || []).filter(x => x !== req.params.id); }));
  save();
  return { ok: true };
}));

// Test d'une configuration (enregistrée ou non). Les secrets vides reprennent ceux déjà enregistrés.
app.post('/api/integrations/test', requireAdmin, wrap(async req => {
  const { id: intId, type, config } = req.body || {};
  const existing = intId ? load().integrations.find(i => i.id === intId) : null;
  const t = existing?.type || type;
  const { config: plain, secret } = splitConfig(t, config, existing?.secret);
  return { message: await INTEGRATIONS[t].test({ ...plain, ...decrypt(secret) }, existing) };
}));

app.get('/api/geocode', requireAdmin, wrap(req => geocode(String(req.query.q || ''))));
// suggestions de la barre de recherche (réglages pris dans le widget, jamais dans la requête)
app.get('/api/search/suggest', requireView, wrap(async req => {
  const w = findWidget(String(req.query.p || ''), String(req.query.w || ''));
  if (!w || w.type !== 'search' || w.config?.suggest === false) return [];
  const engine = ['DuckDuckGo', 'Google', 'Bing', 'Qwant', 'Ecosia', 'Brave', 'Startpage', 'SearXNG'].includes(req.query.e) ? req.query.e : w.config?.engine;
  try { return await suggest(engine, w.config?.searxUrl, String(req.query.q || '')); } catch { return []; }
}));
app.get('/api/finance/search', requireAdmin, wrap(req => searchSymbol(String(req.query.q || '').slice(0, 60))));

// ---------- Données des widgets ----------
const cache = new Map(); // widgetId -> { at, data }

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function fromIntegrations(w, kind) {
  const results = [], errors = [];
  await Promise.all((w.integrations || []).map(async intId => {
    const it = getIntegration(intId);
    const def = it && INTEGRATIONS[it.type];
    if (!def || !def.provides.includes(kind)) return;
    try { results.push(await def.fetch(kind, it.config, w.config || {}, it)); }
    catch (e) { errors.push({ name: it.name, error: e.message }); }
  }));
  return { results, errors };
}

async function widgetData(w) {
  const cfg = w.config || {};
  switch (w.type) {
    case 'bookmarks': {
      if (cfg.showStatus === false) return { status: {} };
      const links = (cfg.categories || []).flatMap(c => c.links).filter(l => !l.noPing);
      const res = await pool(links, 8, l => ping(l.pingUrl || l.url));
      return { status: Object.fromEntries(links.map((l, i) => [l.id, res[i]])) };
    }
    case 'weather':
      return weather(cfg);
    case 'stock':
      return quote(cfg);
    case 'uptime':
      return uptimeData(cfg);
    case 'notes':
    case 'title':
    case 'search':
      return {};
    case 'rss': {
      const { results, errors } = await fromIntegrations(w, 'rss');
      const feeds = String(cfg.feeds || '').split(/\s+/).filter(u => /^https?:\/\//.test(u));
      if (!cfg._c) await Promise.all(feeds.map(async u => {
        try { results.push({ items: await readFeed(u) }); }
        catch (e) { errors.push({ name: u, error: e.message }); }
      }));
      // pages suivantes (défilement) : uniquement la source qui pagine (FreshRSS)
      const items = results.flatMap(r => r.items)
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .slice(0, cfg._c ? 200 : Math.max(cfg.limit || 40, 40));
      const continuation = results.find(r => r.continuation)?.continuation || null;
      return { items, errors, continuation };
    }
    case 'reader': {
      if (!w.integrations?.length) return { empty: true };
      const { results, errors } = await fromIntegrations(w, 'reader');
      if (!results.length) return { errors, offline: true };
      return { ...results[0], errors, stream: cfg._s || 'all', filter: cfg._f || 'all' };
    }
    default: {
      const kind = WIDGETS[w.type].kind;
      if (!w.integrations?.length) return { empty: true };
      const { results, errors } = await fromIntegrations(w, kind);
      if (kind === 'machine' || kind === 'torrents') return { ...(results[0] || {}), errors, offline: !results.length };
      if (kind === 'docker') return { containers: results.flatMap(r => r.containers), checks: results.flatMap(r => r.checks || []), errors };
      if (kind === 'media') return { sessions: results.flatMap(r => r.sessions), errors };
      if (kind === 'dns' || kind === 'proxy') return { servers: results, errors };
      if (kind === 'backup') return { items: results.flatMap(r => r.items || []), errors };
      if (kind === 'ha') return { ...(results[0] || { entities: [] }), errors, offline: !results.length };
      if (kind === 'analytics') return { sites: results.flatMap(r => r.sites), period: results[0]?.period, errors };
      if (kind === 'calendar') {
        return { events: results.flatMap(r => r.events).sort((a, b) => a.start.localeCompare(b.start)), errors };
      }
      return { errors };
    }
  }
}

app.get('/api/widgets/:pageId/:widgetId', requireView, wrap(async req => {
  const found = findWidget(req.params.pageId, req.params.widgetId);
  if (!found) throw bad('Widget introuvable', 404);
  let w = found, key = found.id;
  // plage de dates explicite (vue mensuelle du calendrier), limitée à 70 jours
  const from = Date.parse(req.query.from || ''), to = Date.parse(req.query.to || '');
  if (found.type === 'calendar' && from && to && to > from && to - from <= 70 * 864e5) {
    w = { ...found, config: { ...(found.config || {}), _from: new Date(from).toISOString(), _to: new Date(to).toISOString() } };
    key = `${found.id}|${from}|${to}`;
  }
  if (found.type === 'rss' && req.query.c) {
    w = { ...found, config: { ...(found.config || {}), _c: String(req.query.c).slice(0, 300) } };
    key = `${found.id}|c|${req.query.c}`;
  }
  if (found.type === 'reader') {
    const s = String(req.query.s || 'all').slice(0, 250), f = req.query.f === 'unread' ? 'unread' : 'all', c = String(req.query.c || '').slice(0, 300);
    w = { ...found, config: { ...(found.config || {}), _s: s, _f: f, _c: c || undefined } };
    key = `${found.id}|r|${s}|${f}|${c}`;
  }
  // live=1 : suivi d'une action en cours (mise à jour d'un conteneur…), on ne garde le cache que 2 s
  const ttl = req.query.live === '1' ? 2000 : Math.max(2000, w.refresh * 1000 * 0.8);
  const c = cache.get(key);
  // alertes SMART acquittées : appliquées à la lecture, pour qu'un acquittement soit visible tout de suite
  const ack = d => (WIDGETS[found.type]?.kind === 'machine' ? applySmartAck(d, d?.integrationId || found.integrations?.[0]) : d);
  if (c && Date.now() - c.at < ttl) return ack(c.data);
  const data = await widgetData(w);
  cache.set(key, { at: Date.now(), data });
  return ack(data);
}));

// Acquitter (ou réafficher) les alertes SMART d'une machine
app.post('/api/smart-ack', requireAdmin, wrap(req => {
  const { integrationId, disks, clear } = req.body || {};
  if (!load().integrations.some(i => i.id === integrationId)) throw bad('Intégration inconnue', 404);
  setSmartAck(integrationId, Array.isArray(disks) ? disks.slice(0, 64) : [], !!clear);
  return { ok: true };
}));

// Enregistrement d'une note (widget Notes)
app.put('/api/widgets/:pageId/:widgetId/note', requireAdmin, wrap(req => {
  const w = findWidget(req.params.pageId, req.params.widgetId);
  if (!w || w.type !== 'notes') throw bad('Widget Notes introuvable', 404);
  const content = String(req.body?.content ?? '');
  if (content.length > 100000) throw bad('Note trop longue (100 000 caractères max.)');
  w.config = { ...(w.config || {}), content, updatedAt: new Date().toISOString() };
  save();
  return { ok: true, updatedAt: w.config.updatedAt };
}));

// Actions (ajout de torrent, start/stop conteneur) : toujours réservées à l'admin connecté
app.post('/api/widgets/:pageId/:widgetId/action', requireAdmin, wrap(async req => {
  const w = findWidget(req.params.pageId, req.params.widgetId);
  if (!w) throw bad('Widget introuvable', 404);
  const intId = req.body.integrationId || w.integrations?.[0];
  if (!w.integrations.includes(intId)) throw bad('Intégration non liée à ce widget', 403);
  const it = getIntegration(intId);
  const def = INTEGRATIONS[it?.type];
  if (!def?.action) throw bad('Action non disponible');
  const r = await def.action(it.config, req.body, it);
  // vide le cache de ce widget et de tous ceux qui utilisent la même intégration
  const ids = new Set([w.id, ...load().pages.flatMap(p => p.widgets).filter(x => x.integrations?.includes(intId)).map(x => x.id)]);
  for (const k of cache.keys()) if (ids.has(k.split('|')[0])) cache.delete(k);
  return r;
}));

// ---------- Publication sur les réseaux sociaux ----------
const socialDefs = () => load().integrations.filter(i => INTEGRATIONS[i.type]?.provides?.includes('social'));
const netOf = it => INTEGRATIONS[it.type].network || it.config?.network || '';
const handles = new Map(); // integrationId -> { at, handle }
app.get('/api/share/accounts', requireAdmin, wrap(async () => Promise.all(socialDefs().map(async i => {
  const it = getIntegration(i.id);
  let handle = handles.get(i.id);
  if (!handle || Date.now() - handle.at > 6 * 3600e3) {
    try { handle = { at: Date.now(), handle: await INTEGRATIONS[i.type].handle(it.config) }; }
    catch { handle = { at: Date.now() - 6 * 3600e3 + 60e3, handle: '' }; }
    handles.set(i.id, handle);
  }
  let instance = '';
  if (netOf(i) === 'Mastodon') { try { instance = new URL(/^https?:/i.test(it.config.url || '') ? it.config.url : `https://${it.config.url || 'mastodon.social'}`).host; } catch { /* ignoré */ } }
  return { id: i.id, name: i.name, network: netOf(i), handle: handle.handle, instance };
}))));

app.post('/api/share/publish', requireAdmin, wrap(async req => {
  const { posts, article } = req.body || {};
  if (!Array.isArray(posts) || !posts.length || posts.length > 12) throw bad('Rien à publier');
  const art = {
    title: String(article?.title || '').slice(0, 300), link: String(article?.link || '').slice(0, 2000),
    description: String(article?.description || '').slice(0, 300), image: String(article?.image || '').slice(0, 2000)
  };
  return Promise.all(posts.map(async p => {
    const it = getIntegration(String(p.id));
    const def = INTEGRATIONS[it?.type];
    if (!def?.provides?.includes('social')) return { id: p.id, ok: false, error: 'Compte introuvable' };
    const text = String(p.text || '').trim().slice(0, 5000);
    if (!text) return { id: p.id, ok: false, error: 'Texte vide' };
    try { return { id: p.id, ok: true, ...(await def.post(it.config, text, art, it)) }; }
    catch (e) { return { id: p.id, ok: false, error: e.message }; }
  }));
}));

// ---------- Agent (push, installation) ----------
agentRoutes(app, { requireAdmin, wrap, bad });

// ---------- Frontend ----------
// vignettes générées pour les articles de démonstration
if (process.env.DEMO === '1') {
  app.get('/demo/thumb/:n.svg', (req, res) => {
    const n = Number.parseInt(req.params.n, 10) || 0;
    const hues = [200, 160, 28, 280, 340, 120, 48, 220];
    const h = hues[n % hues.length], h2 = (h + 40) % 360;
    const shapes = [
      '<circle cx="250" cy="120" r="70" fill="#fff" opacity=".18"/><circle cx="110" cy="200" r="110" fill="#fff" opacity=".1"/>',
      '<rect x="60" y="70" width="140" height="110" rx="12" fill="#fff" opacity=".18"/><rect x="190" y="120" width="170" height="120" rx="12" fill="#fff" opacity=".12"/>',
      '<path d="M0 230 L120 110 L200 190 L280 90 L400 230 Z" fill="#fff" opacity=".18"/><circle cx="310" cy="70" r="28" fill="#fff" opacity=".3"/>',
      '<path d="M40 200 Q200 20 360 200" stroke="#fff" stroke-width="22" fill="none" opacity=".2"/><circle cx="200" cy="120" r="36" fill="#fff" opacity=".22"/>'
    ];
    res.type('image/svg+xml').set('Cache-Control', 'max-age=86400').send(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240" viewBox="0 0 400 240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h} 55% 45%)"/><stop offset="1" stop-color="hsl(${h2} 60% 28%)"/></linearGradient></defs><rect width="400" height="240" fill="url(#g)"/>${shapes[n % shapes.length]}</svg>`);
  });
}

app.use('/vendor/gridstack', express.static(path.resolve('node_modules/gridstack/dist'), { maxAge: '7d' }));
// Interface : toujours revalidée (ETag), et index.html versionné pour forcer le rechargement après une mise à jour
app.use(express.static(path.resolve('public'), {
  index: false,
  setHeaders: res => res.setHeader('Cache-Control', 'no-cache')
}));
const INDEX_HTML = fs.readFileSync(path.resolve('public/index.html'), 'utf8')
  .replace(/(href|src)="\/(app\.js|style\.css|theme\.css)"/g, `$1="/$2?v=${encodeURIComponent(APP_VERSION)}"`);
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const st = load();
  const ttl = String(st.settings.title || 'Mon dashboard').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  res.type('html').send(INDEX_HTML.replace('href="/favicon"', `href="/favicon?v=${st.settings.favicon?.v || 0}"`).replace('<title>Mon dashboard</title>', `<title>${ttl}</title>`));
});

app.listen(PORT, () => {
  console.log(`Mon dashboard ${APP_VERSION} démarré sur http://localhost:${PORT}${fresh && process.env.DEMO === '1' ? ' (contenu de démo créé)' : ''}`);
});
