import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { load, save, isFresh, id, encrypt, decrypt, getIntegration, findWidget } from './lib/store.js';
import { setup, login, logout, changePassword, currentUser, requireAdmin, requireView } from './lib/auth.js';
import { INTEGRATIONS, WIDGETS, publicMeta } from './lib/integrations/index.js';
import { readFeed } from './lib/integrations/feeds.js';
import { weather, geocode } from './lib/weather.js';
import { ping } from './lib/http.js';
import { seed } from './lib/seed.js';
import { agentRoutes } from './lib/agentSetup.js';
import { lastSeen } from './lib/integrations/agent.js';
import { cleanTheme, themeCss, themeMeta } from './lib/themes.js';

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
    icon: String(p.icon || '').slice(0, 8),
    ...(p.free ? { free: true } : {}),
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
  const { title, publicView, greeting, sessionHours, rememberDays, theme } = req.body || {};
  if (title !== undefined) st.settings.title = String(title).slice(0, 40) || 'Mon dashboard';
  if (publicView !== undefined) st.settings.publicView = !!publicView;
  if (greeting !== undefined) st.settings.greeting = !!greeting;
  if (sessionHours !== undefined) st.settings.sessionHours = Math.min(8760, Math.max(1, Number(sessionHours) || 168));
  if (theme !== undefined) st.settings.theme = cleanTheme(theme);
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
    case 'notes':
    case 'title':
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
    default: {
      const kind = WIDGETS[w.type].kind;
      if (!w.integrations?.length) return { empty: true };
      const { results, errors } = await fromIntegrations(w, kind);
      if (kind === 'machine' || kind === 'torrents') return { ...(results[0] || {}), errors, offline: !results.length };
      if (kind === 'docker') return { containers: results.flatMap(r => r.containers), errors };
      if (kind === 'media') return { sessions: results.flatMap(r => r.sessions), errors };
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
  const ttl = Math.max(2000, w.refresh * 1000 * 0.8);
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttl) return c.data;
  const data = await widgetData(w);
  cache.set(key, { at: Date.now(), data });
  return data;
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
  for (const k of cache.keys()) if (k === w.id || k.startsWith(w.id + '|')) cache.delete(k);
  return r;
}));

// ---------- Agent (push, installation) ----------
agentRoutes(app, { requireAdmin, wrap, bad });

// ---------- Frontend ----------
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
  res.type('html').send(INDEX_HTML);
});

app.listen(PORT, () => {
  console.log(`Mon dashboard ${APP_VERSION} démarré sur http://localhost:${PORT}${fresh && process.env.DEMO === '1' ? ' (contenu de démo créé)' : ''}`);
});
