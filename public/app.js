// Mon dashboard — interface (JavaScript natif, sans étape de build)
import { md, toggleTask } from '/markdown.js';

// ================= Utilitaires =================
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^(https?:)?\/\//i.test(String(u || '')) ? String(u) : '#');
const uid = () => Math.random().toString(16).slice(2, 14);
const clone = o => JSON.parse(JSON.stringify(o));

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  let i = 0; n = Number(n);
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0).replace('.', ',')} ${UNITS[i]}`;
}
const fmtSpeed = n => `${fmtBytes(n)}/s`;
const pct = n => (n == null || isNaN(n) ? '—' : `${Math.round(n)} %`);
function fmtEta(s) {
  if (!s || s >= 8640000) return '∞';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)}`;
  return `${Math.round(s / 86400)} j`;
}
function relTime(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso)) / 1000;
  if (d < 60) return 'à l\'instant';
  if (d < 3600) return `il y a ${Math.round(d / 60)} min`;
  if (d < 86400) return `il y a ${Math.round(d / 3600)} h`;
  return `il y a ${Math.round(d / 86400)} j`;
}
const level = v => (v >= 90 ? 'bad' : v >= 75 ? 'warn' : '');

function toast(msg, ko = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (ko ? ' ko' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ko ? 5000 : 2500);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Erreur ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Icônes : URL, emoji, ou nom du catalogue dashboard-icons (ex. « plex »).
// Ordre d'essai : catalogue (SVG puis PNG) → icône du site lui-même → initiale.
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons';
const slugify = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function siteIcons(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return [];
    return [`${u.origin}/apple-touch-icon.png`, `${u.origin}/favicon.svg`, `${u.origin}/favicon.ico`, `${u.origin}/favicon.png`];
  } catch { return []; }
}
function iconHtml(icon, name, url) {
  const letter = `<span class="letter">${esc((name || '?').trim()[0]?.toUpperCase() || '?')}</span>`;
  icon = String(icon || '').trim();
  if (icon && /\p{Extended_Pictographic}/u.test(icon) && !/[a-z0-9]/i.test(icon)) return `<span style="font-size:26px">${esc(icon)}</span>`;
  let list;
  if (/^(https?:)?\/\//.test(icon) || icon.startsWith('/')) list = [icon];
  else {
    const slugs = [...new Set([slugify(icon), slugify(name)].filter(Boolean))];
    list = slugs.flatMap(sl => [`${ICON_CDN}/svg/${sl}.svg`, `${ICON_CDN}/png/${sl}.png`]);
  }
  list.push(...siteIcons(url));
  if (!list.length) return letter;
  const [first, ...rest] = list;
  return `<img src="${esc(first)}" data-fb="${esc(JSON.stringify(rest))}" data-letter="${esc(name)}" alt="" loading="lazy">`;
}
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.closest('.reader-body')) { img.remove(); return; } // image d'article introuvable
  if (img.tagName !== 'IMG' || img.dataset.letter === undefined) return;
  let rest = [];
  try { rest = JSON.parse(img.dataset.fb || '[]'); } catch { /* liste illisible */ }
  if (rest.length) { img.dataset.fb = JSON.stringify(rest.slice(1)); img.src = rest[0]; return; }
  const sp = document.createElement('span');
  sp.className = 'letter';
  sp.textContent = (img.dataset.letter || '?').trim()[0]?.toUpperCase() || '?';
  img.replaceWith(sp);
}, true);
// une image chargée mais minuscule (favicon vide, pixel de suivi) est ignorée
document.addEventListener('load', e => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.dataset.letter !== undefined && img.naturalWidth > 0 && img.naturalWidth < 8) img.dispatchEvent(new Event('error'));
}, true);

// ================= État =================
const S = {
  session: null, dash: null, meta: null, integrations: [],
  edit: false, pageId: null, timers: [], cache: {}, filters: {}
};
const page = () => S.dash.pages.find(p => p.id === S.pageId) || S.dash.pages[0];
const canEdit = () => !!S.dash?.canEdit;

async function ensureAdminData() {
  if (!S.meta) S.meta = await api('/meta');
  S.integrations = await api('/integrations');
}

// ================= Démarrage / connexion =================
async function boot() {
  stopTimers();
  S.session = await api('/session');
  document.title = S.session.title || 'Mon dashboard';
  if (S.session.setupNeeded) return renderAuth('setup');
  try {
    S.dash = await api('/dashboard');
  } catch (e) {
    if (e.status === 401) return renderAuth('login');
    throw e;
  }
  S.pageId = location.hash.slice(2) || S.pageId || S.dash.pages[0]?.id;
  if (!S.dash.pages.find(p => p.id === S.pageId)) S.pageId = S.dash.pages[0]?.id;
  renderApp();
}

function renderAuth(mode) {
  const setup = mode === 'setup';
  $('#root').innerHTML = `
  <div class="auth-wrap"><div class="auth">
    <h1>Mon <span>dashboard</span></h1>
    <div class="muted small">${setup ? 'Première ouverture : crée le compte administrateur.' : 'Connexion administrateur'}</div>
    <form class="form" id="authForm">
      <label>Identifiant<input name="username" autocomplete="username" required></label>
      <label>Mot de passe<input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 8 : 1}"></label>
      ${setup ? '<label>Confirmer le mot de passe<input name="confirm" type="password" autocomplete="new-password" required></label>' : ''}
      <div class="err" id="authErr"></div>
      <button class="btn primary" type="submit">${setup ? 'Créer le compte' : 'Se connecter'}</button>
      ${!setup && S.session.publicView ? '<button class="btn" type="button" id="backView">Retour au tableau de bord</button>' : ''}
    </form>
  </div></div>`;
  $('#backView')?.addEventListener('click', boot);
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (setup && f.password !== f.confirm) { $('#authErr').textContent = 'Les mots de passe ne correspondent pas'; return; }
    try {
      await api(setup ? '/setup' : '/login', { method: 'POST', body: { username: f.username, password: f.password } });
      boot();
    } catch (err) { $('#authErr').textContent = err.message; }
  });
  $('input', $('#authForm')).focus();
}

// ================= Rendu principal =================
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Bonne nuit' : h < 18 ? 'Bonjour' : 'Bonsoir';
}
function dateLine() {
  const d = new Date();
  const s = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  return `${s.charAt(0).toUpperCase() + s.slice(1)} · ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

function renderApp() {
  stopTimers();
  const st = S.dash.settings;
  const p = page();
  $('#root').innerHTML = `
  <div class="app ${S.edit ? 'editing' : ''}">
    <header class="top">
      <div class="greet">
        <div class="date" id="clock">${esc(dateLine())}</div>
        <h1>${st.greeting !== false ? `${greeting()}${S.session.user ? ` <span class="accent">${esc(S.session.user)}</span>` : ''} !` : esc(st.title)}</h1>
      </div>
      <div class="top-actions">
        ${canEdit() ? `
          <button class="btn ${S.edit ? 'on' : ''}" data-act="toggle-edit">${S.edit ? '✓ Terminer' : '✎ Modifier'}</button>
          <button class="btn" data-act="admin">⚙ Administration</button>`
        : '<button class="btn" data-act="login">Connexion</button>'}
      </div>
    </header>
    <nav class="tabs" id="tabs">
      ${S.dash.pages.map(pg => `
        <button class="tab ${pg.id === p?.id ? 'active' : ''}" data-tab="${pg.id}" ${S.edit ? 'draggable="true"' : ''}>
          ${pg.icon ? `<span>${esc(pg.icon)}</span>` : ''}${esc(pg.name)}
          ${S.edit && pg.id === p?.id ? '<span class="tab-edit" data-act="edit-tab" title="Modifier l\'onglet">✎</span>' : ''}
        </button>`).join('')}
      ${S.edit ? '<button class="tab tab-add" data-act="add-tab">＋ Onglet</button>' : ''}
    </nav>
    <main>
      ${p ? `<div class="grid-stack" id="grid">${p.widgets.map(widgetShell).join('')}</div>` : '<div class="empty">Aucun onglet. Passe en mode « Modifier » pour en créer un.</div>'}
      ${S.edit && p ? '<button class="add-widget" data-act="add-widget">＋ Ajouter un widget</button>' : ''}
      ${!S.edit && p && !p.widgets.length ? `<div class="empty">Onglet vide.${canEdit() ? ' Clique sur « Modifier » pour ajouter des widgets.' : ''}</div>` : ''}
    </main>
  </div>`;
  bindApp();
  if (p) { initGrid(p); p.widgets.forEach(startWidget); }
  S.timers.push(setInterval(() => { const c = $('#clock'); if (c) c.textContent = dateLine(); }, 20000));
}

const WIDTHS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const HEIGHTS = [0, 150, 250, 350, 450, 600, 800];
const heightOptions = h => {
  const list = HEIGHTS.includes(h) ? HEIGHTS : [...HEIGHTS, h].sort((a, b) => a - b);
  return list.map(n => `<option value="${n}" ${n === h ? 'selected' : ''}>${n ? n + ' px' : 'Auto'}</option>`).join('');
};
// Grille libre (gridstack) : 12 colonnes, lignes de 10 px, marge de 9 px autour de chaque bloc
const CELL = 10, GAP = 9;
const rowsFor = px => Math.max(6, Math.round((px + 2 * GAP) / CELL));
const pxFor = rows => rows * CELL - 2 * GAP;
let GRID = null;

function widgetShell(w) {
  const r = RENDER[w.type] || {};
  const h = Number(w.h) || 0;
  const pos = Number.isInteger(w.x) && Number.isInteger(w.y) ? `gs-x="${w.x}" gs-y="${w.y}"` : 'gs-auto-position="true"';
  return `
  <div class="grid-stack-item" gs-id="${w.id}" gs-min-w="2" gs-min-h="6" gs-w="${w.w}" gs-h="${h ? rowsFor(h) : 12}" ${pos} ${h ? '' : 'gs-size-to-content="true"'}>
  <div class="grid-stack-item-content">
  <section class="widget ${w.type === 'bookmarks' ? 'bare' : ''} ${h ? 'fixed-h' : ''}" data-wid="${w.id}">
    <div class="w-head">
      ${S.edit ? '<span class="iconbtn handle" title="Glisser pour déplacer">⠿</span>' : ''}
      <div class="w-title">${esc(w.title)}</div>
      <div class="w-tools">
        <select data-act="width" title="Largeur">${WIDTHS.map(n => `<option value="${n}" ${n === w.w ? 'selected' : ''}>${n}/12</option>`).join('')}</select>
        <select data-act="height" title="Hauteur (tu peux aussi tirer le coin bas-droit)">${heightOptions(h)}</select>
        <button class="iconbtn" data-act="config-widget" title="Configurer">⚙</button>
        <button class="iconbtn" data-act="delete-widget" title="Supprimer">✕</button>
      </div>
    </div>
    <div class="w-body">
      ${r.static ? `<div class="w-static">${r.static(w)}</div>` : ''}
      <div class="w-dyn">${r.static && w.type === 'bookmarks' ? '' : '<div class="skeleton"></div>'}</div>
    </div>
  </section>
  </div></div>`;
}

function initGrid(p) {
  if (GRID) { try { GRID.destroy(false); } catch { /* déjà détruite */ } GRID = null; }
  const el = $('#grid');
  if (!el || !window.GridStack) return;
  GRID = GridStack.init({
    column: 12, cellHeight: CELL, margin: GAP, mode: 'top', animate: true,
    handle: '.handle', staticGrid: !S.edit,
    resizable: { handles: 'e,se,s,sw,w' },
    columnOpts: { breakpoints: [{ w: 760, c: 1 }], layout: 'list' }
  }, el);
  // ajuste les blocs « Auto » à leur contenu une fois affichés
  setTimeout(() => $$('.grid-stack-item[gs-size-to-content]', el).forEach(i => GRID?.resizeToContent(i)), 50);
  let userResized = new Set();
  // dès qu'on attrape un coin, le bloc quitte le mode « Auto » pour garder la hauteur choisie
  GRID.on('resizestart', (_e, item) => {
    if (item.hasAttribute('gs-size-to-content')) {
      item.removeAttribute('gs-size-to-content');
      GRID.update(item, { sizeToContent: false });
      $('.widget', item)?.classList.add('fixed-h');
    }
  });
  GRID.on('resizestop', (_e, item) => userResized.add(item.getAttribute('gs-id')));
  GRID.on('change', (_e, nodes) => {
    if (!S.edit) return;
    let dirty = false;
    for (const n of nodes) {
      const w = p.widgets.find(x => x.id === n.id);
      if (!w) continue;
      if (w.x !== n.x || w.y !== n.y || w.w !== n.w) {
        w.x = n.x; w.y = n.y; w.w = n.w; dirty = true;
        const ws = $('select[data-act=width]', n.el);
        if (ws) ws.value = String(n.w);
      }
      if (userResized.has(n.id)) {
        // hauteur choisie à la main : le bloc devient de hauteur fixe
        w.h = pxFor(n.h);
        n.el.removeAttribute('gs-size-to-content');
        GRID.update(n.el, { sizeToContent: false });
        $('.widget', n.el)?.classList.add('fixed-h');
        const sel = $('select[data-act=height]', n.el);
        if (sel) sel.innerHTML = heightOptions(w.h);
        dirty = true;
      }
    }
    // fige aussi la position des blocs placés automatiquement, pour une disposition stable
    for (const n of GRID.engine.nodes) {
      const w = p.widgets.find(x => x.id === n.id);
      if (w && (w.x !== n.x || w.y !== n.y)) { w.x = n.x; w.y = n.y; dirty = true; }
    }
    userResized = new Set();
    if (dirty) savePages(false);
  });
}

// après chaque rafraîchissement, un bloc « Auto » reprend la hauteur de son contenu
function fitWidget(id) {
  const item = $(`.grid-stack-item[gs-id="${id}"]`);
  if (GRID && item && item.hasAttribute('gs-size-to-content')) GRID.resizeToContent(item);
}

function stopTimers() { S.timers.forEach(clearInterval); S.timers = []; }

function startWidget(w) {
  if (w.type === 'notes') { RENDER.notes.bind(w, widgetEl(w.id)); return; }
  const load = () => loadWidget(w);
  load();
  S.timers.push(setInterval(() => { if (!document.hidden) load(); }, Math.max(3, w.refresh) * 1000));
  RENDER[w.type]?.bind?.(w, widgetEl(w.id));
}
const widgetEl = id => $(`.widget[data-wid="${id}"]`);

async function loadWidget(w) {
  const el = widgetEl(w.id);
  if (!el) return;
  const dyn = $('.w-dyn', el);
  try {
    const q = RENDER[w.type]?.query?.(w) || '';
    const data = await api(`/widgets/${page().id}/${w.id}${q}`);
    S.cache[w.id] = data;
    paintWidget(w, data);
  } catch (e) {
    if (e.status === 401) { boot(); return; }
    dyn.innerHTML = `<div class="w-err">⚠ ${esc(e.message)}</div>`;
    fitWidget(w.id);
  }
}

function paintWidget(w, data) {
  const el = widgetEl(w.id);
  if (!el) return;
  const dyn = $('.w-dyn', el);
  if (data.empty) {
    dyn.innerHTML = `<div class="empty">Aucune intégration liée.${canEdit() ? ' Configure ce widget (⚙ en mode Modifier).' : ''}</div>`;
    fitWidget(w.id);
    return;
  }
  const html = RENDER[w.type].dyn(data, w, el);
  if (html !== undefined) dyn.innerHTML = html + errorsHtml(data.errors);
  fitWidget(w.id);
}
const errorsHtml = errs => (errs?.length ? errs.map(e => `<div class="w-warn">⚠ ${esc(e.name)} : ${esc(e.error)}</div>`).join('') : '');

// ================= Widgets =================
const bar = (label, value, text) => `
  <div class="bar-row"><span class="lbl">${esc(label)}</span>
  <div class="bar"><i class="${level(value)}" style="width:${Math.min(100, Math.max(0, value || 0))}%"></i></div>
  <span class="val">${esc(text ?? pct(value))}</span></div>`;

// ---------- calendrier : utilitaires ----------
const calKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const evDate = (s, allDay) => (allDay && s.length === 10 ? new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : new Date(s));
function monthRange(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const from = new Date(first); from.setDate(1 - ((first.getDay() + 6) % 7)); // lundi de la 1re semaine
  const to = new Date(from); to.setDate(from.getDate() + 42);
  return { from, to };
}
// jours (clés AAAA-MM-JJ) couverts par un événement
function evDays(e) {
  const s = evDate(e.start, e.allDay);
  let end = evDate(e.end || e.start, e.allDay);
  if (e.allDay) end = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1); // fin exclusive
  else if (+end > +s) end = new Date(+end - 1);
  const out = [];
  const d = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  for (let i = 0; i < 62 && d <= end; i++) { out.push(calKey(d)); d.setDate(d.getDate() + 1); }
  return out.length ? out : [calKey(s)];
}
const evLine = e => {
  const s = evDate(e.start, e.allDay);
  return `<div class="ev" style="border-color:${esc(e.color || 'var(--accent)')}">
    <span class="h">${e.allDay ? 'Journée' : s.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
    <span><b style="font-weight:500">${esc(e.title)}</b>${e.location ? `<span class="muted small"> · ${esc(e.location)}</span>` : ''}
    <div class="muted small">${esc(e.calendar || '')}</div></span>
  </div>`;
};
function calList(evs) {
  if (!evs.length) return '<div class="empty">Rien de prévu 🎉</div>';
  const today = new Date(), todayKey = calKey(today), tomorrowKey = calKey(new Date(Date.now() + 864e5));
  const groups = new Map();
  for (const e of evs) {
    const s = evDate(e.start, e.allDay);
    if (!e.allDay && new Date(e.end) < today) continue;
    const k = e.allDay && s < today ? todayKey : calKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, items]) => {
    const d = evDate(k, true);
    const lbl = k === todayKey ? 'Aujourd\'hui' : k === tomorrowKey ? 'Demain'
      : d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'short' });
    return `<div class="day"><div class="day-lbl">${esc(lbl)}</div>${items.map(evLine).join('')}</div>`;
  }).join('') || '<div class="empty">Rien de prévu 🎉</div>';
}
function calMonth(evs, st) {
  const byDay = new Map();
  for (const e of evs) for (const k of evDays(e)) {
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  const { from } = monthRange(st.month);
  const todayKey = calKey(new Date());
  const title = st.month.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(from); d.setDate(from.getDate() + i);
    const k = calKey(d), list = byDay.get(k) || [];
    const colors = [...new Set(list.map(e => e.color || 'var(--accent)'))].slice(0, 3);
    cells.push(`<button type="button" class="cal-day${d.getMonth() !== st.month.getMonth() ? ' out' : ''}${k === todayKey ? ' today' : ''}${k === st.sel ? ' sel' : ''}" data-day="${k}" title="${list.length ? esc(list.map(e => e.title).join(' · ')) : ''}">
      <span class="n">${d.getDate()}</span>
      <span class="dots">${colors.map(c => `<i style="background:${esc(c)}"></i>`).join('')}</span>
    </button>`);
  }
  const selDate = evDate(st.sel, true);
  const selList = (byDay.get(st.sel) || []).slice().sort((a, b) => (b.allDay - a.allDay) || a.start.localeCompare(b.start));
  return `
    <div class="cal-head">
      <span class="cal-title">${esc(title)}</span>
      <span>
        <button type="button" class="iconbtn" data-cnav="today" title="Aujourd'hui">●</button>
        <button type="button" class="iconbtn" data-cnav="prev" title="Mois précédent">▲</button>
        <button type="button" class="iconbtn" data-cnav="next" title="Mois suivant">▼</button>
      </span>
    </div>
    <div class="cal-grid">
      ${['lu', 'ma', 'me', 'je', 've', 'sa', 'di'].map(j => `<span class="cal-wd">${j}</span>`).join('')}
      ${cells.join('')}
    </div>
    <div class="cal-sel">
      <div class="day-lbl">${esc(selDate.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }))}</div>
      ${selList.length ? selList.map(evLine).join('') : '<div class="muted small">Aucun événement</div>'}
    </div>`;
}

// ---------- torrents : utilitaires ----------
const isPaused = st => /^(paused|stopped)/.test(st || '');
const TOR_STATE = {
  downloading: ['⬇', 'Téléchargement', 'run'], forcedDL: ['⬇', 'Téléchargement forcé', 'run'], metaDL: ['🔍', 'Métadonnées', 'run'],
  stalledDL: ['⏳', 'En attente de pairs', 'wait'], queuedDL: ['…', 'En file', 'wait'], checkingDL: ['🔍', 'Vérification', 'wait'],
  uploading: ['⬆', 'En partage', 'seed'], forcedUP: ['⬆', 'Partage forcé', 'seed'], stalledUP: ['⬆', 'En partage', 'seed'],
  queuedUP: ['…', 'En file', 'wait'], checkingUP: ['🔍', 'Vérification', 'wait'],
  pausedDL: ['⏸', 'En pause', 'pause'], stoppedDL: ['⏸', 'En pause', 'pause'], pausedUP: ['✓', 'Terminé', 'done'], stoppedUP: ['✓', 'Terminé', 'done'],
  error: ['⚠', 'Erreur', 'err'], missingFiles: ['⚠', 'Fichiers manquants', 'err'], moving: ['⇄', 'Déplacement', 'wait']
};
const fmtDate = ts => (ts > 0 ? new Date(ts * 1000).toLocaleString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const ring = (pctv, cls) => {
  const r = 26, c = 2 * Math.PI * r;
  return `<svg class="ring ${cls}" viewBox="0 0 64 64"><circle cx="32" cy="32" r="${r}" class="bg"/><circle cx="32" cy="32" r="${r}" class="fg" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(100, pctv) / 100)}"/><text x="32" y="37">${Math.floor(pctv)}%</text></svg>`;
};
function torRow(t, open, intId) {
  const [ico, label, cls] = TOR_STATE[t.state] || ['•', t.state, 'wait'];
  const paused = isPaused(t.state);
  const icoPlay = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>';
  const icoPause = '<svg viewBox="0 0 24 24" width="15" height="15"><rect x="5.5" y="4.5" width="4.5" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4.5" height="15" rx="1" fill="currentColor"/></svg>';
  const btn = canEdit() ? `<button type="button" class="iconbtn tor-btn" data-tor-op="${paused ? 'resume' : 'pause'}" data-hash="${esc(t.hash)}" data-int="${esc(intId || '')}" title="${paused ? 'Reprendre' : 'Mettre en pause'}">${paused ? icoPlay : icoPause}</button>` : '';
  const right = t.progress < 100 && !paused ? `${fmtSpeed(t.dlspeed)} · ${fmtEta(t.eta)}` : fmtBytes(t.size);
  return `
    <div class="tor ${open ? 'open' : ''} st-${cls}" data-hash="${esc(t.hash)}">
      <div class="tor-row" data-tor-toggle="${esc(t.hash)}">
        <span class="tor-ico" title="${esc(label)}">${ico}</span>
        <span class="tor-name" title="${esc(t.name)}">${esc(t.name)}</span>
        <span class="tor-pct">${t.progress.toFixed(t.progress < 100 ? 1 : 0).replace('.', ',')} %</span>
        <span class="tor-bar"><span class="bar"><i class="${cls === 'err' ? 'bad' : cls === 'pause' ? 'warn' : ''}" style="width:${t.progress}%"></i></span></span>
        <span class="tor-right small">${right}</span>
        ${btn}
      </div>
      ${open ? `<div class="tor-det">
        ${ring(t.progress, cls)}
        <div class="tor-grid">
          <div><span>État</span><b>${esc(label)}</b></div>
          <div><span>Taille</span><b>${fmtBytes(t.downloaded)} / ${fmtBytes(t.totalSize || t.size)}</b></div>
          <div><span>Ratio</span><b>${t.ratio != null ? Number(t.ratio).toFixed(2).replace('.', ',') : '—'}</b></div>
          <div><span>Total envoyé</span><b>${fmtBytes(t.uploaded)}</b></div>
          <div><span>Vitesses</span><b>↓ ${fmtSpeed(t.dlspeed)} · ↑ ${fmtSpeed(t.upspeed)}</b></div>
          <div><span>Seeds / pairs</span><b>${t.seeds ?? '—'} (${t.seedsTotal ?? '?'}) / ${t.peers ?? '—'} (${t.peersTotal ?? '?'})</b></div>
          <div><span>Ajouté</span><b>${fmtDate(t.addedOn)}</b></div>
          <div><span>${t.completionOn > 0 ? 'Terminé' : 'Fin estimée'}</span><b>${t.completionOn > 0 ? relTime(new Date(t.completionOn * 1000).toISOString()) : (paused ? '—' : fmtEta(t.eta))}</b></div>
          <div><span>Catégorie</span><b>${esc(t.category || '—')}</b></div>
          <div class="wide"><span>Dossier</span><b class="mono">${esc(t.savePath || '—')}</b></div>
          <div class="wide"><span>Hash</span><b class="mono">${esc(t.hash)}</b></div>
        </div>
      </div>` : ''}
    </div>`;
}

// ---------- lecteur d'articles : nettoyage du HTML des flux ----------
const SAFE_TAGS = new Set(['P', 'BR', 'A', 'IMG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'DEL', 'SUP', 'SUB', 'SMALL', 'MARK', 'HR', 'FIGURE', 'FIGCAPTION', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'DIV', 'SPAN', 'PICTURE', 'SOURCE', 'DL', 'DT', 'DD', 'ABBR', 'CITE', 'Q', 'TIME']);
function sanitizeHtml(html, base) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const abs = v => { try { return new URL(v, base || undefined).href; } catch { return ''; } };
  const walk = node => {
    for (const el of [...node.children]) {
      if (!SAFE_TAGS.has(el.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'NOSCRIPT', 'SVG', 'MATH', 'LINK', 'META', 'BASE'].includes(el.tagName)) { el.remove(); continue; }
        el.replaceWith(...el.childNodes); // garde le texte, retire la balise
        continue;
      }
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        const keep = (n === 'href' && el.tagName === 'A') || (['src', 'srcset', 'alt', 'width', 'height'].includes(n) && ['IMG', 'SOURCE'].includes(el.tagName)) || (n === 'title') || (['colspan', 'rowspan'].includes(n));
        if (!keep) { el.removeAttribute(a.name); continue; }
        if (n === 'href' || n === 'src') {
          const u = abs(a.value);
          if (!/^(https?:|mailto:)/i.test(u) || (n === 'src' && !/^https?:/i.test(u))) el.removeAttribute(a.name);
          else el.setAttribute(a.name, u);
        }
        if (n === 'srcset') el.removeAttribute(a.name);
      }
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      if (el.tagName === 'IMG') { el.setAttribute('loading', 'lazy'); el.setAttribute('referrerpolicy', 'no-referrer'); }
      walk(el);
    }
  };
  walk(doc.body.firstChild);
  return doc.body.firstChild.innerHTML;
}

// ---------- flux RSS : liste défilante, chargement continu, lu au défilement ----------
function rssPaint(w, el, errors) {
  const st = RENDER.rss.st(w);
  const dyn = $('.w-dyn', el);
  let list = $('.rss-list', dyn);
  const prevScroll = list ? list.scrollTop : 0;
  if (!st.items.length) { dyn.innerHTML = '<div class="empty">Aucun article</div>' + errorsHtml(errors); fitWidget(w.id); return; }
  const unread = st.items.filter(i => i.integrationId && !i.read).length;
  dyn.innerHTML = `
    <div class="rss-meta muted small">${st.items.length} article(s)${unread ? ` · <b style="color:var(--accent)">${unread} non lu(s)</b>` : ''}</div>
    <div class="rss-list">${st.items.map((i, k) => `
      <a class="rss-item ${i.read ? 'read' : ''}" href="${esc(safeUrl(i.link))}" data-k="${k}" target="_blank" rel="noopener">
        <div class="t">${i.integrationId && !i.read ? '<i class="unread-dot"></i>' : ''}${esc(i.title)}</div>
        <div class="s">${esc(i.source)}${i.date ? ` · ${relTime(i.date)}` : ''}</div>
      </a>`).join('')}
      ${st.cont ? '<div class="rss-more muted small">Chargement des articles suivants…</div>' : '<div class="rss-end muted small">— Fin des articles —</div>'}
    </div>${errorsHtml(errors)}`;
  list = $('.rss-list', dyn);
  list.scrollTop = prevScroll;
  rssObserve(w, el, list);
  fitWidget(w.id);
}
function rssObserve(w, el, list) {
  const st = RENDER.rss.st(w);
  st.obs?.disconnect();
  const markOnScroll = w.config?.markOnScroll !== false && canEdit();
  // un article qui sort par le haut de la liste a été « vu » : on le marque lu
  st.obs = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (en.isIntersecting || !en.rootBounds || en.boundingClientRect.bottom > en.rootBounds.top + 4) continue;
      const it = st.items[Number(en.target.dataset.k)];
      if (it && it.integrationId && !it.read && markOnScroll) rssMarkRead(w, el, [it]);
    }
  }, { root: list, threshold: 0 });
  $$('.rss-item:not(.read)', list).forEach(a => st.obs.observe(a));
  list.onscroll = () => {
    if (st.cont && !st.loading && list.scrollTop + list.clientHeight > list.scrollHeight - 200) rssMore(w, el);
  };
  list.onclick = e => {
    const a = e.target.closest('.rss-item');
    if (!a || e.ctrlKey || e.metaKey || e.button === 1) return; // Ctrl+clic : nouvel onglet
    if (w.config?.openInPage === false) {
      // ouverture dans un nouvel onglet : l'article est quand même marqué lu
      const it = st.items[Number(a.dataset.k)];
      if (it && canEdit()) rssMarkRead(w, el, [it]);
      return;
    }
    e.preventDefault();
    const it = st.items[Number(a.dataset.k)];
    rssReader(w, el, it);
  };
}
async function rssMore(w, el) {
  const st = RENDER.rss.st(w);
  st.loading = true;
  try {
    const d = await api(`/widgets/${page().id}/${w.id}?c=${encodeURIComponent(st.cont)}`);
    const add = (d.items || []).filter(i => !st.ids.has(i.id || i.link));
    add.forEach(i => st.ids.add(i.id || i.link));
    st.items.push(...add);
    st.cont = d.continuation || null;
    rssPaint(w, el);
  } catch (e) { toast(e.message, true); }
  st.loading = false;
}
function rssMarkRead(w, el, items) {
  const st = RENDER.rss.st(w);
  for (const it of items) {
    if (!it.integrationId || it.read) continue;
    it.read = true;
    if (!st.queue.has(it.integrationId)) st.queue.set(it.integrationId, new Set());
    st.queue.get(it.integrationId).add(it.id);
    const a = $(`.rss-item[data-k="${st.items.indexOf(it)}"]`, el);
    if (a) { a.classList.add('read'); a.querySelector('.unread-dot')?.remove(); }
  }
  const meta = $('.rss-meta', el);
  if (meta) {
    const unread = st.items.filter(i => i.integrationId && !i.read).length;
    meta.innerHTML = `${st.items.length} article(s)${unread ? ` · <b style="color:var(--accent)">${unread} non lu(s)</b>` : ''}`;
  }
  clearTimeout(st.flushT);
  st.flushT = setTimeout(async () => {
    for (const [integrationId, ids] of st.queue) {
      st.queue.delete(integrationId);
      try { await api(`/widgets/${page().id}/${w.id}/action`, { method: 'POST', body: { op: 'read', integrationId, ids: [...ids] } }); }
      catch (e) { toast(`FreshRSS : ${e.message}`, true); }
    }
  }, 1200);
}
function rssReader(w, el, it) {
  if (!it) return;
  if (canEdit()) rssMarkRead(w, el, [it]);
  const body = it.content ? sanitizeHtml(it.content, it.link) : '<p class="muted">Pas de contenu dans le flux pour cet article.</p>';
  const m = modal({
    title: it.source || 'Article', wide: true,
    body: `<article class="reader">
      <h1>${esc(it.title)}</h1>
      <div class="muted small">${esc([it.author, it.date ? new Date(it.date).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }) : ''].filter(Boolean).join(' · '))}</div>
      <div class="reader-body md">${body}</div>
    </article>`,
    footer: `<a class="btn" href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener">Ouvrir l'article original ↗</a><button class="btn primary" data-close2>Fermer</button>`
  });
  $('[data-close2]', m.el).onclick = m.close;
}

// ---------- météo : pictogrammes au trait et couleurs de température ----------
function tempColor(t) {
  const stops = [[-10, [110, 160, 255]], [0, [120, 190, 235]], [8, [120, 205, 200]], [15, [130, 215, 150]], [22, [235, 215, 110]], [28, [245, 165, 85]], [35, [235, 95, 85]]];
  if (t <= stops[0][0]) return `rgb(${stops[0][1]})`;
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    const [t0, c0] = stops[i - 1];
    if (t <= t1) {
      const k = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(',')})`;
    }
  }
  return `rgb(${stops.at(-1)[1]})`;
}
function wxIcon(kind, day = true, size = 64) {
  const cloud = (x = 0, y = 0, s = 1, fill = 'none') => `<path transform="translate(${x} ${y}) scale(${s})" d="M18 46h28a11 11 0 0 0 1-22 15 15 0 0 0-28-4 10 10 0 0 0-1 26z" fill="${fill}" stroke="#e8f1fb" stroke-width="${3 / s}" stroke-linejoin="round"/>`;
  const sun = (x, y, r) => `<g stroke="#ffc94a" stroke-width="2.6" stroke-linecap="round" fill="none"><circle cx="${x}" cy="${y}" r="${r}"/>${[0, 45, 90, 135, 180, 225, 270, 315].map(a => {
    const rad = a * Math.PI / 180, r1 = r + 4, r2 = r + 8;
    return `<line x1="${x + r1 * Math.cos(rad)}" y1="${y + r1 * Math.sin(rad)}" x2="${x + r2 * Math.cos(rad)}" y2="${y + r2 * Math.sin(rad)}"/>`;
  }).join('')}</g>`;
  const moon = (x, y, r) => `<path d="M${x + r * 0.35} ${y - r} a${r} ${r} 0 1 0 ${r * 0.9} ${r * 1.55} a${r * 0.8} ${r * 0.8} 0 0 1 ${-r * 0.9} ${-r * 1.55}z" fill="#7cc4f0"/>`;
  const drops = n => [...Array(n)].map((_, i) => `<line x1="${24 + i * 8}" y1="50" x2="${21 + i * 8}" y2="58" stroke="#5aa9ff" stroke-width="2.6" stroke-linecap="round"/>`).join('');
  const flakes = `<g fill="#e8f1fb">${[24, 34, 44].map(x => `<circle cx="${x}" cy="54" r="2.2"/>`).join('')}</g>`;
  let g;
  switch (kind) {
    case 'clear': g = day ? sun(32, 32, 11) : moon(30, 32, 14); break;
    case 'mostly-clear': g = (day ? sun(24, 22, 8) : moon(20, 20, 9)) + cloud(14, 10, 0.75, 'var(--card)'); break;
    case 'partly': g = (day ? sun(22, 20, 8) : moon(18, 16, 9)) + cloud(6, 6, 0.9, 'var(--card)'); break;
    case 'cloudy': g = cloud(0, 2, 1); break;
    case 'fog': g = cloud(0, -4, 1) + [50, 56].map(y => `<line x1="14" y1="${y}" x2="50" y2="${y}" stroke="#9fb3c5" stroke-width="2.6" stroke-linecap="round"/>`).join(''); break;
    case 'drizzle': g = cloud(0, -4, 1) + drops(2); break;
    case 'rain': case 'showers': g = (kind === 'showers' && day ? sun(46, 14, 6) : '') + cloud(0, -4, 1, kind === 'showers' ? 'var(--card)' : 'none') + drops(3); break;
    case 'heavy-rain': g = cloud(0, -4, 1) + drops(4); break;
    case 'snow': g = cloud(0, -4, 1) + flakes; break;
    case 'storm': g = cloud(0, -4, 1) + '<path d="M33 46l-6 9h7l-4 8" fill="none" stroke="#ffc94a" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>'; break;
    default: g = cloud(0, 2, 1);
  }
  return `<svg class="wxi" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">${g}</svg>`;
}

const RENDER = {
  bookmarks: {
    static(w) {
      const c = w.config || {};
      const cats = c.categories || [];
      if (!cats.length) return `<div class="empty">Aucun favori.${canEdit() ? ' Configure ce widget pour en ajouter.' : ''}</div>`;
      const dot = l => (c.showStatus !== false && !l.noPing ? `<span class="dot" data-link="${l.id}"></span>` : '');
      if (c.style === 'liste') {
        return `<div class="bm-cols">${cats.map(cat => `
          <div><div class="bm-cat">${esc(cat.name)}</div>
          ${cat.links.map(l => `<a class="bm-link" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener" title="${esc(l.url)}">
            ${iconHtml(l.icon, l.name, l.url)}<span class="app-name">${esc(l.name)}</span>${dot(l)}</a>`).join('')}
          </div>`).join('')}</div>`;
      }
      return cats.map(cat => `
        <div class="bm-section"><div class="bm-cat">${esc(cat.name)}</div>
        <div class="apps">${cat.links.map(l => `
          <a class="app-tile" data-tile="${l.id}" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener" title="${esc(l.url)}">
            <div class="app-ico">${iconHtml(l.icon, l.name, l.url)}</div>
            <div class="app-txt"><div class="app-name">${esc(l.name)}</div>
            <div class="app-url">${esc(l.desc || l.url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</div></div>
            ${dot(l)}
          </a>`).join('')}</div></div>`).join('');
    },
    dyn(data, w, el) {
      for (const [id, s] of Object.entries(data.status || {})) {
        const d = $(`[data-link="${id}"]`, el);
        if (d) {
          d.className = 'dot ' + (s.online ? 'up' : 'down');
          d.title = s.online ? `En ligne · HTTP ${s.status} · ${s.ms} ms` : `Hors ligne${s.error ? ' · ' + s.error : ''}`;
        }
        $(`[data-tile="${id}"]`, el)?.classList.toggle('is-down', !s.online);
      }
      return undefined;
    }
  },

  machine: {
    dyn(d, w) {
      if (d.offline) return '<div class="m-head"><div class="small" style="display:flex;align-items:center;gap:8px;color:var(--bad)"><span class="dot down"></span>Hors ligne</div></div>';
      const c = w.config || {};
      const rows = [
        d.cpu?.percent != null ? bar('CPU', d.cpu.percent) : '',
        d.mem?.percent != null ? bar('RAM', d.mem.percent, d.mem.total ? `${fmtBytes(d.mem.used)}` : pct(d.mem.percent)) : '',
        ...(d.gpus || []).map(g => bar('GPU', g.util, pct(g.util))),
        ...(d.fs || []).slice(0, 2).map(f => bar(f.mount.length > 7 ? '…' + f.mount.slice(-6) : f.mount, f.percent))
      ].join('');
      const kv = [
        d.net ? `<span>↓ <b>${fmtSpeed(d.net.rx)}</b></span><span>↑ <b>${fmtSpeed(d.net.tx)}</b></span>` : '',
        d.load ? `<span class="muted">Charge <b>${d.load.map(x => Number(x).toFixed(2)).join(' · ')}</b></span>` : '',
        ...(d.temps || []).slice(0, 3).map(t => `<span>🌡 ${esc(t.label)} <b>${Math.round(t.value)} °C</b></span>`),
        ...(d.gpus || []).map(g => `<span class="muted">${esc(g.name)}${g.temp != null ? ` <b>${g.temp} °C</b>` : ''}${g.memPercent != null ? ` · VRAM <b>${Math.round(g.memPercent)} %</b>` : ''}${g.enc != null ? ` · enc <b>${g.enc} %</b> · déc <b>${g.dec} %</b>` : ''}</span>`)
      ].join('');
      let disks = '';
      if (c.showDisks !== false && d.disks?.length) {
        disks = `<div class="section-lbl">Disques · SMART</div><div class="chips">${d.disks.map(k => `
          <span class="chip ${k.standby ? 'sleep' : k.health}" title="${esc([k.model, k.hours != null ? `${k.hours} h de fonctionnement` : '', k.wear != null ? `usure ${k.wear} %` : '', k.standby ? 'en veille (non réveillé pour la lecture SMART)' : '', ...(k.notes || [])].filter(Boolean).join(' · '))}">
            ${k.standby ? '💤' : k.health === 'ok' ? '●' : k.health === 'unknown' ? '○' : '⚠'} ${esc(k.name)}${k.temp && !k.standby ? ` · ${k.temp}°` : ''}
          </span>`).join('')}</div>`;
        const issues = d.disks.filter(k => k.notes?.length);
        if (issues.length) disks += issues.map(k => `<div class="w-warn">⚠ ${esc(k.name)} : ${esc(k.notes.join(', '))}</div>`).join('');
      } else if (c.showDisks !== false && d.smartAvailable === false) {
        disks = '<div class="muted small" style="margin-top:8px">SMART indisponible (Glances doit tourner en root avec accès aux disques).</div>';
      }
      const sec = (d.updates || []).filter(u => u.security).length;
      let upd = d.updates?.length ? `
        <details class="upd"><summary>${d.updates.length} mise(s) à jour disponible(s)${sec ? ` <span class="chip fail" style="margin-left:4px">🔒 ${sec} sécurité</span>` : ''}</summary>
        <ul>${d.updates.map(u => `<li>${u.security ? '🔒 ' : ''}${esc(u.name)} <span class="muted">${esc(u.from || '')} → ${esc(u.to || '')}</span></li>`).join('')}</ul></details>`
        : (d.updates ? '<div class="muted small" style="margin-top:10px">✓ Système à jour</div>' : '');
      if (d.imageUpdates) upd += `<div class="w-warn">⬆ ${d.imageUpdates} conteneur(s) avec une image plus récente disponible</div>`;
      if ((d.fs || []).length > 2) {
        upd += `<details class="upd store"><summary>Stockage (${d.fs.length} volumes)</summary>${d.fs.map(f => bar(f.mount.length > 12 ? '…' + f.mount.slice(-11) : f.mount, f.percent, `${fmtBytes(f.used)} / ${fmtBytes(f.total)}`)).join('')}</details>`;
      }
      return `
        <div class="m-head">
          <div class="small muted" style="display:flex;align-items:center;gap:8px"><span class="dot up" title="En ligne"></span>${d.name && d.name !== w.title ? `<b style="color:var(--text)">${esc(d.name)}</b> · ` : ''}${esc(d.os || '')}</div>
          <div class="muted small">${d.uptime ? `⏱ ${esc(d.uptime)}` : ''}</div>
        </div>
        ${rows}<div class="kv">${kv}</div>${disks}${upd}`;
    }
  },

  docker: {
    static: w => `<div class="toolbar"><input class="input" data-filter placeholder="Filtrer (nom, image, hôte)…" style="flex:1;min-width:180px">
      <label class="small muted"><input type="checkbox" data-stopped ${w.config?.onlyStopped ? 'checked' : ''}> Arrêtés uniquement</label></div>`,
    bind(w, el) {
      const f = S.filters[w.id] ||= { q: '', stopped: !!w.config?.onlyStopped };
      const inp = $('[data-filter]', el), chk = $('[data-stopped]', el);
      inp.value = f.q; chk.checked = f.stopped;
      const re = () => S.cache[w.id] && paintWidget(w, S.cache[w.id]);
      inp.addEventListener('input', () => { f.q = inp.value.toLowerCase(); re(); });
      chk.addEventListener('change', () => { f.stopped = chk.checked; re(); });
      el.addEventListener('click', async e => {
        const b = e.target.closest('[data-op]');
        if (!b) return;
        const verb = { start: 'Démarrer', stop: 'Arrêter', restart: 'Redémarrer' }[b.dataset.op];
        if (b.dataset.op !== 'start' && !confirm(`${verb} le conteneur « ${b.dataset.name} » ?`)) return;
        const row = b.closest('tr');
        $$('[data-op]', row).forEach(x => { x.disabled = true; });
        const st = $('.st-cell', row);
        if (st) st.innerHTML = `<span class="st-restarting">◌ <span class="small">${{ start: 'Démarrage', stop: 'Arrêt', restart: 'Redémarrage' }[b.dataset.op]} en cours…</span></span>`;
        try {
          await api(`/widgets/${page().id}/${w.id}/action`, { method: 'POST', body: { integrationId: b.dataset.int, containerId: b.dataset.cid, op: b.dataset.op } });
          toast(`${b.dataset.name} : ${{ start: 'démarré', stop: 'arrêté', restart: 'redémarré' }[b.dataset.op]} ✓`);
        } catch (err) { toast(err.message, true); }
        delete S.cache[w.id];
        loadWidget(w);
      });
    },
    dyn(d, w) {
      const f = S.filters[w.id] || { q: '', stopped: false };
      const all = d.containers || [];
      const running = all.filter(c => c.state === 'running').length;
      const outdated = all.filter(c => c.imageUpdate).length;
      const list = all.filter(c => (!f.stopped || c.state !== 'running')
        && (!f.q || `${c.name} ${c.image} ${c.host}`.toLowerCase().includes(f.q)))
        .sort((a, b) => a.host.localeCompare(b.host) || (a.state === 'running') - (b.state === 'running') || a.name.localeCompare(b.name));
      const actions = c => (c.canAct && canEdit() ? `
        <span style="white-space:nowrap">${c.state === 'running'
          ? `<button class="iconbtn" data-op="restart" data-cid="${c.id}" data-int="${c.integrationId}" data-name="${esc(c.name)}" title="Redémarrer">↻</button>
             <button class="iconbtn" data-op="stop" data-cid="${c.id}" data-int="${c.integrationId}" data-name="${esc(c.name)}" title="Arrêter">■</button>`
          : `<button class="iconbtn" data-op="start" data-cid="${c.id}" data-int="${c.integrationId}" data-name="${esc(c.name)}" title="Démarrer">▶</button>`}</span>` : '');
      const noActs = canEdit() && all.length && !all.some(c => c.canAct)
        ? '<div class="help" style="margin-bottom:8px">Actions indisponibles sur ces sources. Pour démarrer / arrêter / redémarrer, installe l\'agent Mon dashboard sur la machine (⚙ Administration → Intégrations → Agent Mon dashboard) avec « Autoriser start / stop / restart », puis sélectionne-le dans ce widget.</div>' : '';
      return `${noActs}
        <div class="muted small" style="margin-bottom:6px">${all.length} conteneur(s) · <span class="st-running">${running} actif(s)</span> · <span class="st-exited">${all.length - running} arrêté(s)</span>${outdated ? ` · <span style="color:var(--warn)">⬆ ${outdated} image(s) à mettre à jour</span>` : ''}</div>
        <div style="overflow-x:auto"><table class="tbl">
          <thead><tr><th>Hôte</th><th>Conteneur</th><th>Image</th><th>État</th><th></th></tr></thead>
          <tbody>${list.map(c => `<tr>
            <td><span class="host-pill">${esc(c.host)}</span></td>
            <td><b>${esc(c.name)}</b></td>
            <td class="ellip muted mono" title="${esc(c.image)}${c.imageUpdate ? ' — nouvelle version disponible' : ''}">${c.imageUpdate ? '<span class="chip warn" style="margin-right:6px">⬆ MAJ</span>' : ''}${esc(c.image)}</td>
            <td class="st-cell st-${esc(c.state)}">● <span class="small">${esc(c.status)}</span></td>
            <td style="text-align:right">${actions(c)}</td></tr>`).join('')
            || '<tr><td colspan="5" class="empty">Aucun conteneur</td></tr>'}</tbody>
        </table></div>`;
    }
  },

  media: {
    dyn(d) {
      const s = d.sessions || [];
      if (!s.length) return '<div class="empty">Rien en lecture pour le moment 🍿</div>';
      return s.map(x => `
        <div class="sess">
          <div class="srv ${x.server}" title="${esc(x.serverName)}">${x.server === 'plex' ? 'P' : 'J'}</div>
          <div class="meta">
            <div class="t">${x.state === 'paused' ? '⏸ ' : '▶ '}${esc(x.title)} <span class="muted" style="font-weight:400">${esc(x.subtitle)}</span></div>
            <div class="small muted">${esc(x.user)} · ${esc(x.device)}</div>
            <div class="bar"><i style="width:${x.progress}%"></i></div>
          </div>
          <span class="tag ${x.method === 'Transcodage' ? 'tc' : ''}">${esc(x.method)}</span>
        </div>`).join('');
    }
  },

  torrents: {
    static: () => (canEdit() ? `
      <form class="add-row" data-add>
        <input class="input" name="magnet" placeholder="Lien magnet ou URL .torrent…">
        <label class="btn" title="Envoyer un fichier .torrent">📎<input type="file" accept=".torrent,application/x-bittorrent" hidden name="file"></label>
        <button class="btn primary" type="submit">Ajouter</button>
      </form>` : ''),
    bind(w, el) {
      S.tor ||= {};
      el.addEventListener('click', async e => {
        const op = e.target.closest('[data-tor-op]');
        if (op) {
          e.stopPropagation();
          op.disabled = true;
          try {
            await api(`/widgets/${page().id}/${w.id}/action`, { method: 'POST', body: { op: op.dataset.torOp, hash: op.dataset.hash, integrationId: op.dataset.int || undefined } });
            toast(op.dataset.torOp === 'pause' ? 'Torrent mis en pause' : 'Torrent repris');
          } catch (err) { toast(err.message, true); }
          setTimeout(() => loadWidget(w), 600);
          return;
        }
        const row = e.target.closest('[data-tor-toggle]');
        if (row) {
          const h = row.dataset.torToggle;
          S.tor[w.id] = S.tor[w.id] === h ? null : h;
          if (S.cache[w.id]) paintWidget(w, S.cache[w.id]);
        }
      });
      const form = $('[data-add]', el);
      if (!form) return;
      const send = async body => {
        try {
          await api(`/widgets/${page().id}/${w.id}/action`, { method: 'POST', body: { op: 'add', ...body } });
          toast('Torrent ajouté ✓');
          form.reset();
          setTimeout(() => loadWidget(w), 1000);
        } catch (e) { toast(e.message, true); }
      };
      form.addEventListener('submit', e => {
        e.preventDefault();
        const m = form.magnet.value.trim();
        if (m) send({ magnet: m });
      });
      form.file.addEventListener('change', () => {
        const file = form.file.files[0];
        if (!file) return;
        const rd = new FileReader();
        rd.onload = () => send({ fileBase64: rd.result.split(',')[1], fileName: file.name });
        rd.readAsDataURL(file);
      });
    },
    dyn(d, w) {
      if (d.offline) return '<div class="w-err">qBittorrent injoignable</div>';
      S.tor ||= {};
      const open = S.tor[w.id];
      const conn = { connected: '<span class="st-running">● Connecté</span>', firewalled: '<span class="st-paused">● Derrière un pare-feu</span>', disconnected: '<span class="st-exited">● Déconnecté</span>' }[d.connection] || '';
      const list = d.torrents || [];
      const active = list.filter(t => !isPaused(t.state) && t.progress < 100).length;
      return `
        <div class="speeds"><span>↓ <b>${fmtSpeed(d.dl)}</b></span><span>↑ <b>${fmtSpeed(d.ul)}</b></span><span class="small">${conn}</span>
          <span class="muted small" style="margin-left:auto">${list.length} torrent(s) · ${active} en cours</span></div>
        <div class="tor-list">${list.map(t => torRow(t, open === t.hash, d.integrationId)).join('') || '<div class="empty">Aucun torrent</div>'}</div>`;
    }
  },

  rss: {
    // les articles sont gardés côté navigateur pour pouvoir défiler et charger la suite
    st(w) {
      S.rss ||= {};
      return (S.rss[w.id] ||= { items: [], ids: new Set(), cont: null, loading: false, queue: new Map(), scroll: 0 });
    },
    dyn(d, w, el) {
      const st = RENDER.rss.st(w);
      // rafraîchissement : nouveaux articles en tête, les articles déjà chargés sont conservés
      const fresh = (d.items || []).filter(i => !st.ids.has(i.id || i.link));
      fresh.forEach(i => st.ids.add(i.id || i.link));
      if (!st.items.length) { st.items = d.items || []; st.cont = d.continuation || null; }
      else {
        st.items = [...fresh, ...st.items];
        const byId = new Map((d.items || []).map(i => [i.id || i.link, i]));
        st.items = st.items.map(i => (byId.has(i.id || i.link) ? { ...byId.get(i.id || i.link), read: i.read || byId.get(i.id || i.link).read } : i));
      }
      rssPaint(w, el, d.errors);
      return undefined;
    }
  },

  calendar: {
    // état par widget : vue (liste / mois), mois affiché, jour sélectionné
    state(w) {
      if (!S.cal) S.cal = {};
      if (!S.cal[w.id]) {
        const now = new Date();
        S.cal[w.id] = {
          view: localStorageGet(`cal_view_${w.id}`) || (w.config?.view === 'mois' ? 'month' : 'list'),
          month: new Date(now.getFullYear(), now.getMonth(), 1),
          sel: calKey(now)
        };
      }
      return S.cal[w.id];
    },
    query(w) {
      const st = RENDER.calendar.state(w);
      if (st.view !== 'month') return '';
      const { from, to } = monthRange(st.month);
      return `?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
    },
    static: w => `<div class="cal-switch" role="tablist">
        <button type="button" class="btn sm" data-cv="list">Liste</button>
        <button type="button" class="btn sm" data-cv="month">Mois</button>
      </div>`,
    bind(w, el) {
      const st = RENDER.calendar.state(w);
      const sync = () => $$('[data-cv]', el).forEach(b => b.classList.toggle('on', b.dataset.cv === st.view));
      sync();
      el.addEventListener('click', e => {
        const v = e.target.closest('[data-cv]');
        if (v && v.dataset.cv !== st.view) {
          st.view = v.dataset.cv;
          localStorageSet(`cal_view_${w.id}`, st.view);
          sync();
          $('.w-dyn', el).innerHTML = '<div class="skeleton"></div>';
          loadWidget(w);
          return;
        }
        const nav = e.target.closest('[data-cnav]');
        if (nav) {
          const n = nav.dataset.cnav;
          const now = new Date();
          st.month = n === 'today' ? new Date(now.getFullYear(), now.getMonth(), 1)
            : new Date(st.month.getFullYear(), st.month.getMonth() + (n === 'next' ? 1 : -1), 1);
          if (n === 'today') st.sel = calKey(now);
          loadWidget(w);
          return;
        }
        const day = e.target.closest('[data-day]');
        if (day) {
          st.sel = day.dataset.day;
          if (S.cache[w.id]) paintWidget(w, S.cache[w.id]);
        }
      });
    },
    dyn(d, w) {
      const st = RENDER.calendar.state(w);
      return st.view === 'month' ? calMonth(d.events || [], st) : calList(d.events || []);
    }
  },

  notes: {
    static: w => `
      <div class="note-view">
        ${canEdit() ? '<button class="iconbtn note-edit" data-note="edit" title="Modifier la note">✎</button>' : ''}
        <div class="md">${(w.config?.content || '').trim() ? md(w.config.content) : `<div class="empty">Note vide.${canEdit() ? ' Clique sur ✎ pour écrire.' : ''}</div>`}</div>
      </div>
      <div class="note-editor hidden">
        <div class="toolbar note-bar">
          <button type="button" class="btn sm on" data-note="write">Écrire</button>
          <button type="button" class="btn sm" data-note="preview">Aperçu</button>
          <span style="flex:1"></span>
          <button type="button" class="btn sm" data-note="cancel">Annuler</button>
          <button type="button" class="btn sm primary" data-note="save">Enregistrer</button>
        </div>
        <textarea class="note-src mono" spellcheck="true" title="Markdown · Ctrl+S pour enregistrer · Échap pour annuler" placeholder="# Titre&#10;&#10;- [ ] une tâche&#10;- **gras**, *italique*, \`code\`, [lien](https://…)"></textarea>
        <div class="md note-preview hidden"></div>
      </div>`,
    bind(w, el) {
      const body = $('.w-body', el);
      const view = $('.note-view', el), editor = $('.note-editor', el);
      const ta = $('.note-src', el), prev = $('.note-preview', el);
      $('.w-dyn', el).remove();
      const save = async content => {
        try {
          const r = await api(`/widgets/${page().id}/${w.id}/note`, { method: 'PUT', body: { content } });
          w.config = { ...(w.config || {}), content, updatedAt: r.updatedAt };
          $('.md', view).innerHTML = content.trim() ? md(content) : '<div class="empty">Note vide. Clique sur ✎ pour écrire.</div>';
          return true;
        } catch (e) { toast(e.message, true); return false; }
      };
      const close = () => { editor.classList.add('hidden'); view.classList.remove('hidden'); body.classList.remove('editing-note'); };
      const open = () => {
        ta.value = w.config?.content || '';
        view.classList.add('hidden'); editor.classList.remove('hidden'); body.classList.add('editing-note');
        prev.classList.add('hidden'); ta.classList.remove('hidden');
        $$('[data-note=write],[data-note=preview]', el).forEach(b => b.classList.toggle('on', b.dataset.note === 'write'));
        ta.focus();
      };
      el.addEventListener('click', async e => {
        const b = e.target.closest('[data-note]');
        if (!b) return;
        const a = b.dataset.note;
        if (a === 'edit') open();
        else if (a === 'cancel') {
          if (ta.value !== (w.config?.content || '') && !confirm('Abandonner les modifications ?')) return;
          close();
        } else if (a === 'save') { if (await save(ta.value)) { toast('Note enregistrée ✓'); close(); } }
        else if (a === 'write' || a === 'preview') {
          const p = a === 'preview';
          if (p) prev.innerHTML = md(ta.value) || '<div class="empty">Rien à afficher</div>';
          prev.classList.toggle('hidden', !p); ta.classList.toggle('hidden', p);
          $$('[data-note=write],[data-note=preview]', el).forEach(x => x.classList.toggle('on', x === b));
        }
      });
      ta.addEventListener('keydown', async e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (await save(ta.value)) toast('Note enregistrée ✓'); }
        else if (e.key === 'Escape') { e.preventDefault(); $('[data-note=cancel]', el).click(); }
        else if (e.key === 'Tab') {
          e.preventDefault();
          const st = ta.selectionStart;
          ta.setRangeText('  ', st, ta.selectionEnd, 'end');
        }
      });
      // cases à cocher cliquables directement dans la note
      view.addEventListener('change', async e => {
        const cb = e.target.closest('input[type=checkbox][data-line]');
        if (!cb) return;
        if (!canEdit()) { cb.checked = !cb.checked; return; }
        await save(toggleTask(w.config?.content || '', Number(cb.dataset.line)));
      });
    }
  },

  weather: {
    bind(w, el) {
      // molette verticale → défilement horizontal du bandeau des heures
      el.addEventListener('wheel', e => {
        const strip = e.target.closest('.wx-hours');
        if (!strip || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        if (strip.scrollWidth <= strip.clientWidth) return;
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }, { passive: false });
      // horloge du widget, mise à jour toutes les 10 s
      S.timers.push(setInterval(() => {
        const c = $('.wx-clock', el);
        if (c) c.textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      }, 10000));
    },
    dyn(d, w) {
      const cfg = w.config || {};
      const c = d.current;
      const now = new Date();
      const head = `
        <div class="wx-top">
          <div class="wx-big">${wxIcon(c.kind, c.day)}</div>
          <div class="wx-info">
            <div class="wx-line"><span class="wx-t">🌡 ${Math.round(c.temp)}°C</span><span>${esc(c.label)}</span></div>
            ${cfg.showClock !== false ? `
              <div class="wx-clock">${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</div>
              <div class="wx-date">📅 ${esc(now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }))}</div>`
              : `<div class="wx-clock">${Math.round(c.temp)}°</div>`}
            <div class="wx-sub">${esc(d.city || '')}${d.city ? ' · ' : ''}ressenti ${Math.round(c.feels)}° · 💧 ${c.humidity} % · 💨 ${Math.round(c.wind)} km/h</div>
          </div>
        </div>`;
      const hourly = cfg.showHourly !== false && d.hours?.length ? `
        <div class="wx-hours">${d.hours.map(h => `
          <div class="wx-h" title="${esc(h.label)}${h.rain != null ? ` · pluie ${h.rain} %` : ''}">
            <span class="wx-ht">${esc(h.time)}</span>${wxIcon(h.kind, h.day, 30)}<b>${Math.round(h.temp)}°</b>
            ${h.rain ? `<span class="wx-hr">💧${h.rain}%</span>` : '<span class="wx-hr"></span>'}
          </div>`).join('')}</div>` : '';
      let daily = '';
      if (cfg.showDaily !== false && d.days?.length) {
        const lo = Math.min(...d.days.map(x => x.min)), hi = Math.max(...d.days.map(x => x.max));
        const span = Math.max(1, hi - lo), pos = t => ((t - lo) / span) * 100;
        daily = `<div class="wx-days2">${d.days.map((x, i) => {
          const left = pos(x.min), width = Math.max(4, pos(x.max) - left);
          const mark = i === 0 && c.temp >= x.min - 1 && c.temp <= x.max + 1
            ? `<i class="wx-mark" style="left:calc(${Math.min(100, Math.max(0, pos(c.temp)))}% - 9px)"></i>` : '';
          return `<div class="wx-d" title="${esc(x.label)}${x.rain != null ? ` · pluie ${x.rain} %` : ''}">
            <span class="wx-dn">${i === 0 ? 'Auj.' : esc(new Date(x.date + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short' }))}</span>
            ${wxIcon(x.kind, true, 24)}
            <span class="wx-mn">${Math.round(x.min)}°C</span>
            <span class="wx-track"><span class="wx-range" style="left:${left}%;width:${width}%;background:linear-gradient(90deg, ${tempColor(x.min)}, ${tempColor(x.max)})"></span>${mark}</span>
            <span class="wx-mx">${Math.round(x.max)}°C</span>
          </div>`;
        }).join('')}</div>`;
      }
      return head + hourly + daily;
    }
  }
};

// ================= Interactions =================
function bindApp() {
  const root = $('.app');
  root.addEventListener('click', async e => {
    const t = e.target.closest('[data-act], [data-tab]');
    if (!t) return;
    const act = t.dataset.act;
    if (!act && t.dataset.tab) {
      S.pageId = t.dataset.tab;
      history.replaceState(null, '', '#/' + S.pageId);
      renderApp();
      return;
    }
    const wEl = t.closest('.widget');
    const w = wEl && page().widgets.find(x => x.id === wEl.dataset.wid);
    switch (act) {
      case 'login': renderAuth('login'); break;
      case 'toggle-edit':
        S.edit = !S.edit;
        if (S.edit) await ensureAdminData();
        renderApp(); break;
      case 'admin': openAdmin(); break;
      case 'add-tab': e.stopPropagation(); editTab(null); break;
      case 'edit-tab': e.stopPropagation(); editTab(page()); break;
      case 'add-widget': pickWidgetType(); break;
      case 'config-widget': widgetForm(w); break;
      case 'delete-widget':
        if (confirm(`Supprimer le widget « ${w.title} » ?`)) {
          page().widgets = page().widgets.filter(x => x.id !== w.id);
          savePages();
        }
        break;
    }
  });
  root.addEventListener('change', e => {
    const act = e.target.dataset.act;
    if (act !== 'width' && act !== 'height') return;
    const w = page().widgets.find(x => x.id === e.target.closest('.widget').dataset.wid);
    if (act === 'width') w.w = Number(e.target.value);
    else w.h = Number(e.target.value);
    savePages();
  });
  if (S.edit) bindTabDrag();
}

// Glisser-déposer des onglets pour les réordonner
function bindTabDrag() {
  let drag = null;
  $('#tabs').addEventListener('dragstart', e => {
    const t = e.target.closest('.tab[data-tab]');
    if (t) { drag = t.dataset.tab; e.dataTransfer.setData('text/plain', drag); }
  });
  $('#tabs').addEventListener('dragend', () => { drag = null; $$('.drop-target').forEach(x => x.classList.remove('drop-target')); });
  $('#tabs').addEventListener('dragover', e => {
    const t = e.target.closest('.tab[data-tab]');
    if (!drag || !t) return;
    e.preventDefault();
    $$('.drop-target').forEach(x => x.classList.remove('drop-target'));
    t.classList.add('drop-target');
  });
  $('#tabs').addEventListener('drop', e => {
    const t = e.target.closest('.tab[data-tab]');
    if (!drag || !t || drag === t.dataset.tab) return;
    e.preventDefault();
    const pages = S.dash.pages;
    const [m] = pages.splice(pages.findIndex(p => p.id === drag), 1);
    pages.splice(pages.findIndex(p => p.id === t.dataset.tab), 0, m);
    savePages();
  });
}

// rerender=false : sauvegarde silencieuse (déplacement / redimensionnement dans la grille)
let saveTimer = null;
async function savePages(rerender = true) {
  if (!rerender) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await api('/pages', { method: 'PUT', body: { pages: S.dash.pages } }); }
      catch (e) { toast(e.message, true); }
    }, 400);
    return;
  }
  try {
    const r = await api('/pages', { method: 'PUT', body: { pages: S.dash.pages } });
    S.dash.pages = r.pages;
  } catch (e) { toast(e.message, true); }
  renderApp();
}

// ================= Modales =================
function modal({ title, body, footer = '', wide = false }) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">
    <div class="modal-h"><h2>${esc(title)}</h2><button class="iconbtn" data-close>✕</button></div>
    <div class="modal-b">${body}</div>${footer ? `<div class="modal-f">${footer}</div>` : ''}</div>`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  $('[data-close]', ov).addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
  return { el: ov, close };
}

function editTab(pg) {
  const m = modal({
    title: pg ? 'Modifier l\'onglet' : 'Nouvel onglet',
    body: `<form class="form" id="tabForm"><div class="row2">
      <label>Nom<input name="name" value="${esc(pg?.name || '')}" required maxlength="40"></label>
      <label>Icône (emoji, optionnel)<input name="icon" value="${esc(pg?.icon || '')}" maxlength="8" placeholder="🏠"></label></div></form>`,
    footer: `${pg ? '<button class="btn danger" data-del style="margin-right:auto">Supprimer l\'onglet</button>' : ''}
      <button class="btn" data-close2>Annuler</button><button class="btn primary" data-ok>Enregistrer</button>`
  });
  $('[data-close2]', m.el).onclick = m.close;
  $('[data-ok]', m.el).onclick = () => {
    const f = Object.fromEntries(new FormData($('#tabForm', m.el)));
    if (!f.name.trim()) return;
    if (pg) Object.assign(pg, { name: f.name.trim(), icon: f.icon.trim() });
    else {
      const np = { id: uid(), name: f.name.trim(), icon: f.icon.trim(), widgets: [] };
      S.dash.pages.push(np);
      S.pageId = np.id;
      history.replaceState(null, '', '#/' + np.id);
    }
    m.close();
    savePages();
  };
  $('[data-del]', m.el)?.addEventListener('click', () => {
    if (!confirm(`Supprimer l'onglet « ${pg.name} » et ses ${pg.widgets.length} widget(s) ?`)) return;
    S.dash.pages = S.dash.pages.filter(p => p.id !== pg.id);
    S.pageId = S.dash.pages[0]?.id;
    m.close();
    savePages();
  });
  $('input', m.el).focus();
}

function pickWidgetType() {
  const m = modal({
    title: 'Ajouter un widget', wide: true,
    body: `<div class="type-grid">${Object.entries(S.meta.widgets).map(([k, d]) => `
      <button class="type-card" data-type="${k}"><div class="e">${d.icon}</div><b>${esc(d.label)}</b></button>`).join('')}</div>`
  });
  m.el.addEventListener('click', e => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    m.close();
    const d = S.meta.widgets[b.dataset.type];
    const cfg = Object.fromEntries((d.options || []).filter(o => o.default !== undefined).map(o => [o.key, o.default]));
    if (b.dataset.type === 'bookmarks') cfg.categories = [];
    widgetForm({ id: null, type: b.dataset.type, title: d.label, w: d.w, refresh: d.refresh, integrations: [], config: cfg });
  });
}

function optionField(o, val) {
  const v = val ?? o.default ?? '';
  switch (o.type) {
    case 'checkbox': return `<label class="chk"><input type="checkbox" name="opt_${o.key}" ${v ? 'checked' : ''}> ${esc(o.label)}</label>`;
    case 'number': return `<label>${esc(o.label)}<input type="number" step="any" name="opt_${o.key}" value="${esc(v)}"></label>`;
    case 'select': return `<label>${esc(o.label)}<select name="opt_${o.key}">${o.options.map(x => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`;
    case 'textarea': return `<label>${esc(o.label)}<textarea name="opt_${o.key}">${esc(v)}</textarea></label>`;
    case 'city': return `<label>${esc(o.label)}<div style="display:flex;gap:8px"><input name="opt_${o.key}" value="${esc(v)}" style="flex:1"><button class="btn" type="button" data-geo>Rechercher</button></div></label><div class="geo-res" data-geores></div>`;
    default: return `<label>${esc(o.label)}<input name="opt_${o.key}" value="${esc(v)}"></label>`;
  }
}

function widgetForm(orig) {
  const w = clone(orig);
  const d = S.meta.widgets[w.type];
  const compatible = S.integrations.filter(i => S.meta.integrations[i.type]?.provides.includes(d.kind));
  const intField = !d.integrations ? '' : `
    <div><div class="small muted" style="margin-bottom:6px">${d.integrations === 'one' ? 'Source' : 'Sources'}${d.integrations === 'optional' ? ' (optionnel)' : ''}</div>
    ${compatible.length ? `<div class="int-pick">${compatible.map(i => `
      <label class="chk"><input type="${d.integrations === 'one' ? 'radio' : 'checkbox'}" name="int" value="${i.id}" ${w.integrations.includes(i.id) ? 'checked' : ''}>
      ${esc(i.name)} <span class="muted small">(${esc(S.meta.integrations[i.type].label)})</span></label>`).join('')}</div>`
      : '<div class="help">Aucune intégration compatible. Ajoute-en une dans ⚙ Administration → Intégrations.</div>'}</div>`;
  const m = modal({
    title: `${orig.id ? 'Configurer' : 'Nouveau'} : ${d.label}`, wide: w.type === 'bookmarks',
    body: `<form class="form" id="wForm">
      <div class="row2">
        <label>Titre<input name="title" value="${esc(w.title)}" maxlength="60"></label>
        <div class="row2">
          <label>Largeur<select name="w">${WIDTHS.map(n => `<option value="${n}" ${n === w.w ? 'selected' : ''}>${n}/12</option>`).join('')}</select></label>
          <label>Rafraîchir (s)<input type="number" name="refresh" min="3" value="${w.refresh}"></label>
        </div>
      </div>
      <div class="row2">
        <label>Hauteur en px (0 = automatique)<input type="number" name="h" min="0" step="10" value="${Number(w.h) || 0}"></label>
        ${orig.id ? `<label>Onglet<select name="tab">${S.dash.pages.map(pg => `<option value="${pg.id}" ${pg.id === page().id ? 'selected' : ''}>${esc(pg.icon || '')} ${esc(pg.name)}</option>`).join('')}</select></label>` : '<div></div>'}
      </div>
      ${intField}
      ${(d.options || []).map(o => optionField(o, w.config?.[o.key])).join('')}
      ${w.type === 'bookmarks' ? '<div class="section-lbl">Catégories et liens</div><div id="bmEditor"></div><div class="help">Icône : nom du catalogue <a href="https://dashboardicons.com" target="_blank" rel="noopener" style="color:var(--accent)">dashboardicons.com</a> (ex. <span class="mono">plex</span>, <span class="mono">uptime-kuma</span>), une URL d\'image ou un emoji. Laisse vide pour essayer le nom du service puis l\'icône du site. « URL de test » permet de vérifier une adresse interne différente du lien.</div>' : ''}
    </form>`,
    footer: '<button class="btn" data-cancel>Annuler</button><button class="btn primary" data-save>Enregistrer</button>'
  });
  const form = $('#wForm', m.el);

  // --- éditeur de favoris ---
  let cats = clone(w.config?.categories || []);
  const bmEl = $('#bmEditor', m.el);
  const collect = () => {
    if (!bmEl) return;
    cats = $$('.cat-box', bmEl).map(box => ({
      id: box.dataset.id, name: $('[data-cname]', box).value,
      links: $$('.link-row', box).map(r => ({
        id: r.dataset.id, name: $('[data-k=name]', r).value, url: $('[data-k=url]', r).value.trim(),
        icon: $('[data-k=icon]', r).value.trim(), desc: $('[data-k=desc]', r).value,
        pingUrl: r.dataset.ping || '', noPing: r.dataset.noping === '1'
      }))
    }));
  };
  const drawBm = () => {
    if (!bmEl) return;
    bmEl.innerHTML = cats.map((c, ci) => `
      <div class="cat-box" data-id="${c.id}">
        <div class="cat-h"><input class="input" data-cname value="${esc(c.name)}" placeholder="Nom de la catégorie">
          <button type="button" class="iconbtn" data-cup="${ci}" title="Monter">↑</button>
          <button type="button" class="iconbtn" data-cdel="${ci}" title="Supprimer la catégorie">✕</button></div>
        ${c.links.map((l, li) => `
          <div class="link-row" data-id="${l.id}" data-ping="${esc(l.pingUrl || '')}" data-noping="${l.noPing ? 1 : 0}">
            <span class="ico-prev" title="Aperçu de l'icône">${iconHtml(l.icon, l.name, l.url)}</span>
            <input class="input" data-k="name" value="${esc(l.name)}" placeholder="Nom">
            <input class="input" data-k="url" value="${esc(l.url)}" placeholder="https://…">
            <input class="input" data-k="icon" value="${esc(l.icon)}" placeholder="nom ou URL d’image" title="Nom du catalogue dashboardicons.com (ex. plex), URL d’une image (https://…/logo.png) ou emoji">
            <input class="input" data-k="desc" value="${esc(l.desc)}" placeholder="description">
            <span style="white-space:nowrap">
              <button type="button" class="iconbtn" data-lping="${ci}.${li}" title="Test de statut : ${l.noPing ? 'désactivé' : (l.pingUrl ? 'URL ' + esc(l.pingUrl) : 'sur le lien')}">${l.noPing ? '○' : '●'}</button>
              <button type="button" class="iconbtn" data-lup="${ci}.${li}" title="Monter">↑</button>
              <button type="button" class="iconbtn" data-ldel="${ci}.${li}" title="Supprimer">✕</button></span>
          </div>`).join('')}
        <button type="button" class="btn sm" data-ladd="${ci}">＋ Lien</button>
      </div>`).join('') + '<button type="button" class="btn sm" data-cadd>＋ Catégorie</button>';
  };
  drawBm();
  // aperçu de l'icône mis à jour pendant la saisie
  let prevT = null;
  bmEl?.addEventListener('input', e => {
    const row = e.target.closest('.link-row');
    if (!row || !['icon', 'name', 'url'].includes(e.target.dataset.k)) return;
    clearTimeout(prevT);
    prevT = setTimeout(() => {
      $('.ico-prev', row).innerHTML = iconHtml($('[data-k=icon]', row).value, $('[data-k=name]', row).value, $('[data-k=url]', row).value);
    }, 400);
  });
  bmEl?.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    collect();
    const ds = b.dataset;
    const [ci, li] = String(ds.lup ?? ds.ldel ?? ds.lping ?? '').split('.').map(Number);
    if ('cadd' in ds) cats.push({ id: uid(), name: 'Nouvelle catégorie', links: [] });
    else if (ds.cdel !== undefined) { if (confirm('Supprimer cette catégorie ?')) cats.splice(+ds.cdel, 1); }
    else if (ds.cup !== undefined && +ds.cup > 0) cats.splice(+ds.cup - 1, 0, cats.splice(+ds.cup, 1)[0]);
    else if (ds.ladd !== undefined) cats[+ds.ladd].links.push({ id: uid(), name: '', url: '', icon: '', desc: '' });
    else if (ds.ldel !== undefined) cats[ci].links.splice(li, 1);
    else if (ds.lup !== undefined && li > 0) cats[ci].links.splice(li - 1, 0, cats[ci].links.splice(li, 1)[0]);
    else if (ds.lping !== undefined) {
      const l = cats[ci].links[li];
      const v = prompt('URL à tester pour le statut (vide = le lien lui-même, « non » = pas de test) :', l.noPing ? 'non' : (l.pingUrl || ''));
      if (v !== null) { l.noPing = v.trim().toLowerCase() === 'non'; l.pingUrl = l.noPing ? '' : v.trim(); }
    }
    drawBm();
  });

  // --- recherche de ville (météo) ---
  $('[data-geo]', m.el)?.addEventListener('click', async () => {
    const q = form.opt_city.value.trim();
    const box = $('[data-geores]', m.el);
    if (!q) return;
    box.innerHTML = '<span class="muted small">Recherche…</span>';
    try {
      const res = await api('/geocode?q=' + encodeURIComponent(q));
      box.innerHTML = res.map((r, i) => `<button type="button" class="btn sm" data-gi="${i}">${esc(r.name)} <span class="muted">${esc(r.admin)}</span></button>`).join('') || '<span class="muted small">Aucun résultat</span>';
      box.onclick = e => {
        const b = e.target.closest('[data-gi]');
        if (!b) return;
        const r = res[+b.dataset.gi];
        form.opt_city.value = r.name; form.opt_lat.value = r.lat; form.opt_lon.value = r.lon;
        box.innerHTML = `<span class="small" style="color:var(--ok)">✓ ${esc(r.name)} (${r.lat.toFixed(3)}, ${r.lon.toFixed(3)})</span>`;
      };
    } catch (e) { box.innerHTML = `<span class="w-err">${esc(e.message)}</span>`; }
  });

  $('[data-cancel]', m.el).onclick = m.close;
  $('[data-save]', m.el).onclick = () => {
    collect();
    const fd = new FormData(form);
    w.title = fd.get('title').trim() || d.label;
    w.w = Number(fd.get('w'));
    w.refresh = Math.max(3, Number(fd.get('refresh')) || d.refresh);
    w.h = Math.max(0, Number(fd.get('h')) || 0);
    w.integrations = d.integrations ? fd.getAll('int') : [];
    w.config = w.config || {};
    for (const o of d.options || []) {
      const el = form[`opt_${o.key}`];
      w.config[o.key] = o.type === 'checkbox' ? el.checked : o.type === 'number' ? Number(el.value) : el.value;
    }
    if (w.type === 'bookmarks') w.config.categories = cats.map(c => ({ ...c, links: c.links.filter(l => l.url) }));
    const ws = page().widgets;
    const dest = fd.get('tab');
    if (orig.id && dest && dest !== page().id) {
      // déplacement vers un autre onglet : placé automatiquement dans la grille de destination
      ws.splice(ws.findIndex(x => x.id === orig.id), 1);
      delete w.x; delete w.y;
      S.dash.pages.find(pg => pg.id === dest).widgets.push(w);
      toast(`Widget déplacé vers « ${S.dash.pages.find(pg => pg.id === dest).name} »`);
    } else if (orig.id) ws[ws.findIndex(x => x.id === orig.id)] = w;
    else ws.push({ ...w, id: uid() });
    m.close();
    savePages();
  };
}

// ================= Administration =================
async function openAdmin(tab = 'int') {
  await ensureAdminData();
  const m = modal({ title: 'Administration', wide: true, body: '<div class="pills"><button class="btn" data-pill="int">🔌 Intégrations</button><button class="btn" data-pill="set">⚙ Paramètres</button></div><div id="admBody"></div>' });
  const show = t => {
    $$('[data-pill]', m.el).forEach(b => b.classList.toggle('on', b.dataset.pill === t));
    (t === 'int' ? adminIntegrations : adminSettings)($('#admBody', m.el), m);
  };
  m.el.addEventListener('click', e => { const p = e.target.closest('[data-pill]'); if (p) show(p.dataset.pill); });
  show(tab);
}

function adminIntegrations(box, m) {
  const types = S.meta.integrations;
  box.innerHTML = `
    <div class="toolbar"><span class="muted small" style="flex:1">Les intégrations sont les connexions à tes serveurs. Les mots de passe et jetons sont chiffrés et ne quittent jamais le serveur.</span>
    <button class="btn primary" data-new>＋ Ajouter</button></div>
    <div class="int-list">${S.integrations.map(i => `
      <div class="int-row"><div class="n"><b>${esc(i.name)}</b><span class="muted small">${esc(types[i.type]?.label || i.type)}${i.type === 'agent' ? ` · ${esc(i.config.mode)}` : ''}${i.config.url ? ' · ' + esc(i.config.url) : ''}${i.type === 'agent' && i.config.mode === 'push' ? ` · ${i.lastSeen ? `vu ${relTime(new Date(i.lastSeen).toISOString())}` : 'jamais vu'}` : ''}</span></div>
      ${i.type === 'agent' ? `<button class="btn sm" data-install="${i.id}">Installer l'agent</button>` : ''}
      <button class="btn sm" data-edit="${i.id}">Modifier</button><button class="btn sm danger" data-del="${i.id}">Supprimer</button></div>`).join('')
      || '<div class="empty">Aucune intégration pour l\'instant.</div>'}</div>`;
  box.onclick = async e => {
    if (e.target.closest('[data-new]')) {
      box.innerHTML = `<div class="type-grid">${Object.entries(types).map(([k, t]) => `
        <button class="type-card" data-t="${k}"><b>${esc(t.label)}</b><div class="muted small">Pour : ${t.provides.map(p => esc(S.meta.widgets[p]?.label || p)).join(', ')}</div></button>`).join('')}</div>
        <div style="margin-top:12px"><button class="btn" data-back>← Retour</button></div>`;
      return;
    }
    if (e.target.closest('[data-back]')) return adminIntegrations(box, m);
    const t = e.target.closest('[data-t]');
    if (t) return integrationForm(box, m, { type: t.dataset.t, name: types[t.dataset.t].label, config: {}, secretsSet: {} });
    const ins = e.target.closest('[data-install]');
    if (ins) return agentSetup(box, m, S.integrations.find(i => i.id === ins.dataset.install));
    const ed = e.target.closest('[data-edit]');
    if (ed) return integrationForm(box, m, S.integrations.find(i => i.id === ed.dataset.edit));
    const del = e.target.closest('[data-del]');
    if (del) {
      const it = S.integrations.find(i => i.id === del.dataset.del);
      if (!confirm(`Supprimer « ${it.name} » ? Les widgets qui l'utilisent perdront cette source.`)) return;
      await api('/integrations/' + it.id, { method: 'DELETE' });
      await ensureAdminData();
      S.dash = await api('/dashboard');
      adminIntegrations(box, m);
      renderApp();
    }
  };
}

function integrationForm(box, m, it) {
  const def = S.meta.integrations[it.type];
  const field = f => {
    const v = it.config?.[f.key] ?? f.default ?? '';
    if (f.type === 'checkbox') return `<label class="chk"><input type="checkbox" name="${f.key}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
    if (f.type === 'select') return `<label>${esc(f.label)}<select name="${f.key}">${f.options.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    if (f.type === 'password') return `<label>${esc(f.label)}${f.required && !it.secretsSet?.[f.key] ? ' *' : ''}<input type="password" name="${f.key}" autocomplete="new-password" placeholder="${it.secretsSet?.[f.key] ? '•••••••• (inchangé si vide)' : ''}"></label>`;
    if (f.type === 'color') return `<label>${esc(f.label)}<input type="color" name="${f.key}" value="${esc(v || '#6ee2ff')}"></label>`;
    return `<label>${esc(f.label)}${f.required ? ' *' : ''}<input name="${f.key}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}"></label>`;
  };
  box.innerHTML = `
    <form class="form" id="intForm">
      <div class="help">${esc(def.help || '')}</div>
      <label>Nom affiché *<input name="__name" value="${esc(it.name)}" required></label>
      ${def.fields.filter(f => !f.auto).map(field).join('')}
      <div class="test-msg" id="testMsg"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" type="button" data-back>← Retour</button>
        <button class="btn" type="button" data-test>Tester la connexion</button>
        <button class="btn primary" type="submit">Enregistrer</button>
      </div>
    </form>`;
  const form = $('#intForm', box);
  const values = () => Object.fromEntries(def.fields.filter(f => !f.auto).map(f => [f.key, f.type === 'checkbox' ? form[f.key].checked : form[f.key].value]));
  box.onclick = async e => {
    if (e.target.closest('[data-back]')) return adminIntegrations(box, m);
    if (e.target.closest('[data-test]')) {
      const msg = $('#testMsg', box);
      msg.className = 'test-msg'; msg.textContent = 'Test en cours…';
      try {
        const r = await api('/integrations/test', { method: 'POST', body: { id: it.id, type: it.type, config: values() } });
        msg.className = 'test-msg ok'; msg.textContent = '✓ ' + r.message;
      } catch (err) { msg.className = 'test-msg ko'; msg.textContent = '✗ ' + err.message; }
    }
  };
  form.onsubmit = async e => {
    e.preventDefault();
    try {
      const body = { type: it.type, name: form.__name.value, config: values() };
      const saved = await api(it.id ? '/integrations/' + it.id : '/integrations', { method: it.id ? 'PUT' : 'POST', body });
      toast('Intégration enregistrée ✓');
      await ensureAdminData();
      renderApp();
      if (it.type === 'agent' && !it.id) return agentSetup(box, m, S.integrations.find(i => i.id === saved.id));
      adminIntegrations(box, m);
    } catch (err) { const msg = $('#testMsg', box); msg.className = 'test-msg ko'; msg.textContent = '✗ ' + err.message; }
  };
}

function copyBlock(label, text) {
  return `<div class="cmd-box"><div class="cmd-h"><span class="small muted">${esc(label)}</span><button type="button" class="btn sm" data-copy>Copier</button></div><pre class="mono">${esc(text)}</pre></div>`;
}

function agentSetup(box, m, it) {
  const pull = it.config.mode === 'pull';
  box.innerHTML = `
    <div class="form">
      <div class="help">
        <b>Installer l'agent sur « ${esc(it.name)} »</b> (mode ${esc(it.config.mode)})<br>
        ${pull
          ? `Mon dashboard interrogera l'agent à l'adresse <span class="mono">${esc(it.config.url || '(URL manquante !)')}</span> : le port doit être joignable depuis la machine qui héberge Mon dashboard.`
          : 'L\'agent enverra ses données à Mon dashboard toutes les 10 s. Aucun port à ouvrir sur la machine, mais elle doit pouvoir joindre Mon dashboard (en HTTPS via NPM si elle est hors de ton réseau).'}
      </div>
      <label>Adresse de Mon dashboard vue depuis la machine
        <input name="serverUrl" value="${esc(localStorageGet('hd_server_url') || location.origin)}" placeholder="http://192.168.1.10:3080"></label>
      <div class="w-warn hidden" id="lhWarn">⚠ « localhost » désigne la machine elle-même : remplace-le par l'adresse IP de l'ordinateur qui fait tourner Mon dashboard (ex. http://192.168.1.20:3080), sinon l'installation échouera.</div>
      <label class="chk"><input type="checkbox" name="gpu"> Carte graphique Nvidia à superviser (nécessite le pilote Nvidia + NVIDIA Container Toolkit ; sur Unraid, le plugin « Nvidia Driver »)</label>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" type="button" data-back>← Retour</button>
        <button class="btn primary" type="button" data-gen>Générer la commande d'installation</button>
      </div>
      <div id="setupOut"></div>
    </div>`;
  const urlIn = $('[name=serverUrl]', box);
  const checkLh = () => $('#lhWarn', box).classList.toggle('hidden', !/\/\/(localhost|127\.|\[::1\])/.test(urlIn.value));
  urlIn.addEventListener('input', checkLh); checkLh();
  box.onclick = async e => {
    if (e.target.closest('[data-back]')) return adminIntegrations(box, m);
    const cp = e.target.closest('[data-copy]');
    if (cp) {
      const txt = cp.closest('.cmd-box').querySelector('pre').textContent;
      try { await navigator.clipboard.writeText(txt); toast('Copié ✓'); }
      catch {
        const r = document.createRange(); r.selectNodeContents(cp.closest('.cmd-box').querySelector('pre'));
        getSelection().removeAllRanges(); getSelection().addRange(r); toast('Texte sélectionné : Ctrl+C pour copier');
      }
      return;
    }
    if (!e.target.closest('[data-gen]')) return;
    const serverUrl = $('[name=serverUrl]', box).value.trim();
    localStorageSet('hd_server_url', serverUrl);
    try {
      const r = await api(`/integrations/${it.id}/agent-setup`, { method: 'POST', body: { serverUrl, gpu: $('[name=gpu]', box).checked } });
      $('#setupOut', box).innerHTML = `
        <div class="section-lbl">1. Sur la machine, en SSH, lance UNE de ces commandes</div>
        ${copyBlock('Unraid (tu es déjà root)', r.curlRoot)}
        ${copyBlock('Debian (avec sudo)', r.curl)}
        ${copyBlock('Si curl est absent', r.wget)}
        <div class="muted small">Commande valable 1 h (jusqu'à ${new Date(r.expires).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}). Elle télécharge l'agent depuis Mon dashboard, construit l'image <span class="mono">homedash-agent</span> sur la machine et démarre le conteneur.</div>
        <div class="section-lbl">2. Vérifie</div>
        <div class="muted small">Reviens à la liste, clique « Modifier » puis « Tester la connexion », puis ajoute un widget « Machine » et/ou « Conteneurs Docker » avec cette source.</div>
        <details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">Installation manuelle (Compose Manager, docker run)</summary>
          ${copyBlock('docker-compose.yml (à placer à côté de agent.js et Dockerfile, fournis dans le dossier agent/ du projet)', r.compose)}
          ${copyBlock('docker run', r.run)}
        </details>
        <div class="w-warn">Ces commandes contiennent le jeton secret de l'agent : ne les partage pas.</div>`;
    } catch (err) { toast(err.message, true); }
  };
}
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } }

function adminSettings(box) {
  const st = S.dash.settings;
  box.innerHTML = `
    <form class="form" id="setForm">
      <label>Titre du site<input name="title" value="${esc(st.title)}"></label>
      <label class="chk"><input type="checkbox" name="greeting" ${st.greeting !== false ? 'checked' : ''}> Afficher le message d'accueil (sinon le titre)</label>
      <label class="chk"><input type="checkbox" name="publicView" ${st.publicView ? 'checked' : ''}> Consultation sans connexion (lecture seule ; les actions restent réservées à l'admin)</label>
      <label>Durée de session (heures)<input type="number" name="sessionHours" min="1" value="${st.sessionHours || 168}"></label>
      <div style="display:flex;justify-content:flex-end"><button class="btn primary">Enregistrer</button></div>
    </form>
    <div class="muted small" style="margin-top:14px">Version : <b class="mono">${esc(S.session.version || '?')}</b></div>
    <div class="section-lbl" style="margin-top:22px">Mot de passe</div>
    <form class="form" id="pwForm"><div class="row2">
      <label>Actuel<input type="password" name="current" autocomplete="current-password"></label>
      <label>Nouveau (8 caractères min.)<input type="password" name="next" autocomplete="new-password" minlength="8"></label></div>
      <div style="display:flex;justify-content:space-between"><button class="btn danger" type="button" data-logout>Se déconnecter</button><button class="btn">Changer le mot de passe</button></div>
    </form>`;
  $('#setForm', box).onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/settings', { method: 'PUT', body: { title: f.title.value, greeting: f.greeting.checked, publicView: f.publicView.checked, sessionHours: f.sessionHours.value } });
      S.dash.settings = r.settings; S.session.title = r.settings.title; document.title = r.settings.title;
      toast('Paramètres enregistrés ✓');
      renderApp();
    } catch (err) { toast(err.message, true); }
  };
  $('#pwForm', box).onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/password', { method: 'POST', body: { current: e.target.current.value, next: e.target.next.value } });
      toast('Mot de passe changé ✓'); e.target.reset();
    } catch (err) { toast(err.message, true); }
  };
  $('[data-logout]', box).onclick = async () => { await api('/logout', { method: 'POST' }); location.hash = ''; location.reload(); };
}

window.addEventListener('hashchange', () => {
  const id = location.hash.slice(2);
  if (S.dash && id && id !== S.pageId && S.dash.pages.find(p => p.id === id)) { S.pageId = id; renderApp(); }
});
boot().catch(e => { $('#root').innerHTML = `<div class="auth-wrap"><div class="auth"><h1>Erreur</h1><p class="err">${esc(e.message)}</p></div></div>`; });
