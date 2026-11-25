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
// ---------- Mode clair / sombre ----------
// réglage par défaut (Administration → Apparence), remplaçable sur chaque appareil avec le bouton de l'en-tête
const MODE_ICON = { auto: '🌓', clair: '☀️', sombre: '🌙' };
const MODE_LABEL = { auto: 'Automatique (suit l\'appareil)', clair: 'Clair', sombre: 'Sombre' };
const LIGHT_MQ = window.matchMedia('(prefers-color-scheme: light)');
const deviceMode = () => localStorageGet('hd_mode') || '';
const currentMode = () => deviceMode() || S.session?.themeMode || 'auto';
function applyMode() {
  let m = currentMode();
  if (m === 'auto') m = LIGHT_MQ.matches ? 'clair' : 'sombre';
  document.documentElement.className = m === 'clair' ? 'th-light' : 'th-dark';
  requestAnimationFrame(() => $('#themeColor')?.setAttribute('content', getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#1f252c'));
}
LIGHT_MQ.addEventListener('change', applyMode);
function reloadThemeCss() {
  const l = $('#themeCss');
  if (l) l.href = '/theme.css?t=' + Date.now();
}

// onglet qui contient le widget (et pas l'onglet affiché : une requête différée peut partir après un changement d'onglet)
const pageOf = w => (S.dash.pages.find(p => p.widgets.some(x => x.id === w.id)) || page()).id;

async function boot() {
  stopTimers();
  S.session = await api('/session');
  document.title = S.session.title || 'Mon dashboard';
  localStorageSet('hd_mode_default', S.session.themeMode || 'auto');
  applyMode();
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

// bouton « œil » pour afficher le mot de passe en clair
const PW_EYE = `<button type="button" class="pw-eye" data-pw-eye aria-label="Afficher le mot de passe" title="Afficher le mot de passe">
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path class="pw-slash" d="M3 3l18 18"/></svg></button>`;
function bindPwEyes(root) {
  $$('[data-pw-eye]', root).forEach(b => b.addEventListener('click', () => {
    const input = b.previousElementSibling;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.classList.toggle('on', show);
    b.title = b.ariaLabel = show ? 'Masquer le mot de passe' : 'Afficher le mot de passe';
    input.focus();
  }));
}

function renderAuth(mode) {
  const setup = mode === 'setup';
  $('#root').innerHTML = `
  <div class="auth-wrap"><div class="auth">
    <h1>Mon <span>dashboard</span></h1>
    <div class="muted small">${setup ? 'Première ouverture : crée le compte administrateur.' : 'Connexion administrateur'}</div>
    <form class="form" id="authForm">
      <label>Identifiant<input name="username" autocomplete="username" required></label>
      <label>Mot de passe<span class="pw-wrap"><input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 8 : 1}">${PW_EYE}</span></label>
      ${setup ? `<label>Confirmer le mot de passe<span class="pw-wrap"><input name="confirm" type="password" autocomplete="new-password" required>${PW_EYE}</span></label>` : ''}
      <label class="chk"><input type="checkbox" name="remember" ${localStorageGet('hd_remember') === '0' ? '' : 'checked'}> Rester connecté</label>
      <div class="err" id="authErr"></div>
      <button class="btn primary" type="submit">${setup ? 'Créer le compte' : 'Se connecter'}</button>
      ${!setup && S.session.publicView ? '<button class="btn" type="button" id="backView">Retour au tableau de bord</button>' : ''}
    </form>
  </div></div>`;
  $('#backView')?.addEventListener('click', boot);
  bindPwEyes($('#authForm'));
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (setup && f.password !== f.confirm) { $('#authErr').textContent = 'Les mots de passe ne correspondent pas'; return; }
    try {
      localStorageSet('hd_remember', f.remember ? '1' : '0');
      await api(setup ? '/setup' : '/login', { method: 'POST', body: { username: f.username, password: f.password, remember: !!f.remember } });
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

// téléphone : même seuil que la grille à une colonne
const MOBILE = window.matchMedia('(max-width: 759px)');
const shown = w => S.edit || !(w.hideMobile && MOBILE.matches);
let mobileWatch = false;

function renderApp() {
  if (!mobileWatch) { mobileWatch = true; MOBILE.addEventListener('change', () => { if (!S.edit && S.dash) renderApp(); }); }
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
        <button class="btn mode-btn" data-act="mode" title="Mode : ${esc(MODE_LABEL[currentMode()])}${deviceMode() ? ' (cet appareil)' : ''} — cliquer pour changer">${MODE_ICON[currentMode()]}</button>
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
      ${S.edit && p ? `<div class="place-bar">
        <span class="muted small">Placement</span>
        <div class="seg">
          <button class="btn sm ${p.free ? '' : 'on'}" data-act="place" data-free="0" title="Les widgets remontent tout seuls pour combler les vides">Compact</button>
          <button class="btn sm ${p.free ? 'on' : ''}" data-act="place" data-free="1" title="Les widgets restent où tu les poses, même avec de l'espace vide au-dessus">Libre</button>
        </div>
        <span class="muted small">${p.free ? 'Pose les widgets où tu veux. Pour caler un widget sur un autre : ⚙ → « Aligner le haut sur ».' : 'Les widgets se tassent vers le haut.'}</span>
      </div>` : ''}
      ${p ? `<div class="grid-stack" id="grid">${p.widgets.filter(shown).map(widgetShell).join('')}</div>` : '<div class="empty">Aucun onglet. Passe en mode « Modifier » pour en créer un.</div>'}
      ${S.edit && p ? '<button class="add-widget" data-act="add-widget">＋ Ajouter un widget</button>' : ''}
      ${!S.edit && p && !p.widgets.length ? `<div class="empty">Onglet vide.${canEdit() ? ' Clique sur « Modifier » pour ajouter des widgets.' : ''}</div>` : ''}
    </main>
  </div>`;
  bindApp();
  if (p) { initGrid(p); p.widgets.filter(shown).forEach(startWidget); }
  S.timers.push(setInterval(() => { const c = $('#clock'); if (c) c.textContent = dateLine(); }, 20000));
}

const WIDTHS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const HEIGHTS = [0, 150, 250, 350, 450, 600, 800];
const heightOptions = h => {
  const list = HEIGHTS.includes(h) || h === -1 ? HEIGHTS : [...HEIGHTS, h].sort((a, b) => a - b);
  return `<option value="-1" ${h === -1 ? 'selected' : ''} title="Étire le bloc pour que son bas s'aligne sur celui des blocs d'à côté">Aligner</option>`
    + list.map(n => `<option value="${n}" ${n === h ? 'selected' : ''}>${n ? n + ' px' : 'Auto'}</option>`).join('');
};
// Grille libre (gridstack) : 12 colonnes, lignes de 10 px, marge de 9 px autour de chaque bloc
const CELL = 10, GAP = 9;
const rowsFor = px => Math.max(6, Math.round((px + 2 * GAP) / CELL));
const pxFor = rows => rows * CELL - 2 * GAP;
let GRID = null;

function widgetShell(w) {
  const r = RENDER[w.type] || {};
  const h = rdFill(w) ? rdFillPx() : (Number(w.h) || 0);
  const align = h === -1;
  const tcfg = w.type === 'title' ? { line: true, ...(w.config || {}) } : null;
  const pos = Number.isInteger(w.x) && Number.isInteger(w.y) ? `gs-x="${w.x}" gs-y="${w.y}"` : 'gs-auto-position="true"';
  return `
  <div class="grid-stack-item" gs-id="${w.id}" gs-min-w="2" gs-min-h="6" gs-w="${w.w}" gs-h="${h > 0 ? rowsFor(h) : 12}" ${pos} ${w.anchor ? `data-anchor="${esc(w.anchor.id)}:${w.anchor.edge}"` : ''} ${h ? '' : 'gs-size-to-content="true"'} ${align ? 'data-align="1"' : ''}>
  <div class="grid-stack-item-content">
  <section class="widget ${w.type === 'bookmarks' || (tcfg && !tcfg.card) ? 'bare' : ''} ${tcfg ? 'title-w' : ''} ${w.type === 'reader' ? 'rd-w' : ''} ${h ? 'fixed-h' : ''}" data-wid="${w.id}">
    <div class="w-head">
      ${S.edit ? '<span class="iconbtn handle" title="Glisser pour déplacer">⠿</span>' : ''}
      <div class="w-title">${esc(w.title)}${S.edit && w.hideMobile ? ' <span class="w-badge" title="Masqué sur téléphone">📵 masqué</span>' : ''}</div>
      <div class="w-tools">
        <select data-act="width" title="Largeur">${WIDTHS.map(n => `<option value="${n}" ${n === w.w ? 'selected' : ''}>${n}/12</option>`).join('')}</select>
        <select data-act="height" title="Hauteur (tu peux aussi tirer le coin bas-droit)">${heightOptions(h)}</select>
        <button class="iconbtn" data-act="config-widget" title="Configurer">⚙</button>
        <button class="iconbtn" data-act="delete-widget" title="Supprimer">✕</button>
      </div>
    </div>
    <div class="w-body">
      ${r.static ? `<div class="w-static">${r.static(w)}</div>` : ''}
      <div class="w-dyn">${r.static && ['bookmarks', 'title'].includes(w.type) ? '' : '<div class="skeleton"></div>'}</div>
    </div>
  </section>
  </div></div>`;
}

let RO = null;
// Hauteur « Aligner » : le bloc s'étire jusqu'au bas du groupe de blocs placés à côté de lui.
// Ex. : Plex à droite de « Home Assistant » + « Torrents » empilés → Plex finit au même niveau que Torrents.
let ALIGNING = false;
function alignBlocks() {
  if (!GRID || ALIGNING) return;
  ALIGNING = true;
  try {
    const nodes = GRID.engine.nodes;
    const single = GRID.getColumn() === 1;
    // placement libre : un widget ancré suit le haut (ou le bas) d'un autre widget
    if (!single) for (const n of nodes) {
      const a = n.el?.getAttribute('data-anchor');
      if (!a) continue;
      const [id, edge] = a.split(':');
      const t = nodes.find(o => o.id === id);
      if (!t || t === n) continue;
      const y = edge === 'bottom' ? t.y + t.h : t.y;
      if (y === n.y) continue;
      // on ne bouscule pas un widget qui occuperait déjà la place (évite les boucles)
      const clash = nodes.some(o => o !== n && o.x < n.x + n.w && o.x + o.w > n.x && o.y < y + n.h && o.y + o.h > y);
      if (!clash || y > n.y) GRID.update(n.el, { y });
    }
    for (const n of nodes) {
      if (!n.el?.hasAttribute('data-align')) continue;
      // hauteur minimale : celle du contenu
      const wEl = $('.widget', n.el);
      const natural = wEl ? $('.w-head', wEl).offsetHeight + $('.w-body', wEl).scrollHeight + 2 : 0;
      let bottom = n.y + Math.max(6, rowsFor(natural));
      if (!single) {
        // blocs côte à côte (sans recouvrement horizontal), de proche en proche
        const side = nodes.filter(o => o !== n && !o.el?.hasAttribute('data-align') && (o.x + o.w <= n.x || o.x >= n.x + n.w));
        let grew = true;
        while (grew) {
          grew = false;
          for (const o of side) {
            // y compris les blocs empilés juste en dessous dans la colonne d'à côté
            if (o.y <= bottom && o.y + o.h > n.y && o.y + o.h > bottom) { bottom = o.y + o.h; grew = true; }
          }
        }
      }
      if (bottom - n.y !== n.h) GRID.update(n.el, { h: bottom - n.y });
    }
  } finally { ALIGNING = false; }
}
function initGrid(p) {
  if (GRID) { try { GRID.destroy(false); } catch { /* déjà détruite */ } GRID = null; }
  const el = $('#grid');
  if (!el || !window.GridStack) return;
  GRID = GridStack.init({
    column: 12, cellHeight: CELL, margin: GAP, mode: p.free ? 'float' : 'top', animate: true,
    handle: '.handle', staticGrid: !S.edit,
    resizable: { handles: 'e,se,s,sw,w' },
    columnOpts: { breakpoints: [{ w: 760, c: 1 }], layout: 'list' }
  }, el);
  // ajuste les blocs « Auto » à leur contenu une fois affichés
  setTimeout(() => { $$('.grid-stack-item[gs-size-to-content]', el).forEach(i => GRID?.resizeToContent(i)); rdFitAll(); alignBlocks(); }, 50);
  // un bloc « Auto » suit son contenu quand celui-ci change de taille
  // (volet déplié, image chargée, liste rallongée…) au lieu d'être recouvert par le bloc du dessous
  RO?.disconnect();
  const pending = new Set();
  RO = new ResizeObserver(entries => {
    for (const en of entries) { const it = en.target.closest('.grid-stack-item'); if (it) pending.add(it); }
    requestAnimationFrame(() => {
      for (const it of pending) if (GRID && it.isConnected && it.hasAttribute('gs-size-to-content')) GRID.resizeToContent(it);
      pending.clear();
      alignBlocks();
    });
  });
  $$('.grid-stack-item .w-body', el).forEach(b => RO.observe(b));
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
  // déplacer à la main un widget ancré retire son ancrage
  GRID.on('dragstop', (_e, item) => {
    const w = p.widgets.find(x => x.id === item.getAttribute('gs-id'));
    if (w?.anchor) { delete w.anchor; item.removeAttribute('data-anchor'); toast('Ancrage retiré : le widget reste où tu l\'as posé'); }
  });
  GRID.on('change', (_e, nodes) => {
    if (!ALIGNING) setTimeout(alignBlocks, 0);
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
  if (w.type === 'title') return;
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
    const data = await api(`/widgets/${pageOf(w)}/${w.id}${q}`);
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
  if (html !== undefined) {
    // garde ouverts les volets dépliés (mises à jour, stockage…) d'un rafraîchissement à l'autre
    // repérés par leur classe + rang, pour qu'un volet qui apparaît ne décale pas les autres
    const k = x => x.dataset.k || x.className;
    const key = (x, i, all) => k(x) + '#' + all.slice(0, i).filter(o => k(o) === k(x)).length;
    const was = $$('details', dyn), opened = new Set(was.filter(x => x.open).map((x, i) => key(x, was.indexOf(x), was)));
    dyn.innerHTML = html + errorsHtml(data.errors);
    const now = $$('details', dyn);
    now.forEach((x, i) => { if (opened.has(key(x, i, now))) x.open = true; });
  }
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

// ---------- conteneurs Docker : tri et suivi des mises à jour ----------
const jobActive = c => ['queued', 'pulling', 'recreating'].includes(c.job?.state);
function dockSort(w) {
  try { const v = JSON.parse(localStorageGet('hd_dsort_' + w.id) || 'null'); if (v?.sort) return { sort: v.sort, dir: v.dir === -1 ? -1 : 1 }; } catch { /* rien */ }
  return { sort: 'host', dir: 1 };
}

// ---------- mises à jour apt (agent Mon dashboard) ----------
function aptBar(d, w) {
  const a = d.apt;
  if (!canEdit() || !a.total) return '';
  if (a.old) return '<div class="muted small upd-all-bar">Mets à jour le conteneur de l\'agent pour lancer apt depuis ici.</div>';
  if (!a.can) return '<div class="muted small upd-all-bar">Pour installer depuis ici : Administration → Intégrations → cet agent → cocher « Autoriser les mises à jour du système (apt) ».</div>';
  if (a.job && !a.job.finishedAt) return '';
  if (S.aptAsk?.[w.id]) {
    const sec = S.aptAsk[w.id] === 'security';
    return `<div class="upd-ask upd-all">
      <span>${sec ? `Installer les ${a.security} mise(s) à jour de sécurité` : `Installer les ${a.total} mise(s) à jour (apt upgrade)`} sur ${esc(d.name || 'cette machine')} ?</span>
      <div class="help" style="flex:1 1 100%">apt s'exécute sur la machine ; les paquets bloqués (hold) ne bougent pas. Les fichiers de configuration modifiés sont conservés. Un redémarrage peut être demandé ensuite (noyau…).</div>
      <button type="button" class="btn sm primary" data-upd="apt-go" data-apt="${sec ? 'security' : 'upgrade'}" data-int="${esc(d.integrationId || '')}">Lancer</button>
      <button type="button" class="btn sm" data-upd="apt-cancel">Annuler</button>
    </div>`;
  }
  return `<div class="upd-all-bar">
    ${a.security ? `<button type="button" class="btn sm" data-upd="apt-ask" data-apt="security">🔒 Sécurité (${a.security})</button>` : ''}
    <button type="button" class="btn sm" data-upd="apt-ask" data-apt="upgrade">⬆ Tout mettre à jour (${a.total})</button></div>`;
}
function aptJobBox(d) {
  const j = d.apt?.job;
  let out = '';
  if (j) {
    const running = !j.finishedAt;
    const recent = running || Date.now() - Date.parse(j.finishedAt) < 30 * 60e3;
    if (recent) {
      const ok = j.code === 0;
      const what = j.op === 'upgrade' ? 'toutes les mises à jour' : j.op === 'security' ? 'mises à jour de sécurité' : `${j.packages.length} paquet(s)`;
      const last = (j.log || []).slice(-1)[0] || '';
      out += `<details data-k="apt-job" class="upd apt-job ${running ? 'run' : ok ? 'ok' : 'ko'}">
        <summary>${running ? `⏳ apt en cours (${esc(what)})…` : ok ? `✓ apt terminé (${esc(what)})` : `✗ apt a échoué (code ${esc(String(j.code))})`}
          ${running && last ? `<span class="muted small apt-last">${esc(last)}</span>` : ''}</summary>
        <pre class="apt-log">${esc((j.log || []).join('\n'))}</pre></details>`;
    }
  }
  if (d.apt?.reboot) out += '<div class="w-warn">⟳ Redémarrage de la machine nécessaire pour finir les mises à jour</div>';
  return out;
}

// ---------- mises à jour (widget Machine) ----------
// HA Core / OS / Supervisor redémarrent Home Assistant : on les installe en dernier
const isHaSelf = u => /^update\.home_assistant_/.test(u.entity || '');
// les systèmes d'exploitation (Unraid OS, HA OS…) redémarrent la machine : décochés par défaut
const isOsUpdate = u => /(^|\s)OS(\s|$)|operating system/i.test(u.name || '');
function updAll(d, w) {
  const list = (d.updates || []).filter(u => u.entity && u.canInstall && !u.inProgress && !(S.updBusy?.[u.entity] && Date.now() - S.updBusy[u.entity] < 20000));
  if (!canEdit() || list.length < 2) return '';
  if (S.updAllAsk?.[w.id]) {
    return `<div class="upd-ask upd-all">
      <span>Mettre à jour :</span>
      ${list.map(u => `<label class="chk"><input type="checkbox" data-upd-pick="${esc(u.entity)}" ${isOsUpdate(u) ? '' : 'checked'}> ${esc(u.name)} <span class="muted">${esc(u.to || '')}</span>${isOsUpdate(u) ? ' <span class="chip warn">redémarrage</span>' : ''}</label>`).join('')}
      ${list.some(u => isHaSelf(u) && u.canBackup) ? '<label class="chk"><input type="checkbox" data-upd-backup checked> Sauvegarde avant la mise à jour de Home Assistant</label>' : ''}
      <div class="help" style="flex:1 1 100%">Les mises à jour partent une par une ; celles de Home Assistant lui-même en dernier, car il redémarre.</div>
      <button type="button" class="btn sm primary" data-upd="all-go" data-int="${esc(d.integrationId || '')}">Lancer</button>
      <button type="button" class="btn sm" data-upd="all-cancel">Annuler</button>
    </div>`;
  }
  return `<div class="upd-all-bar"><button type="button" class="btn sm" data-upd="all-ask">⬆ Tout mettre à jour (${list.length})</button></div>`;
}
function updItem(u, w, d) {
  const ver = `<span class="muted">${esc(u.from || '')} → ${esc(u.to || '')}</span>`;
  const name = u.url && /^https?:\/\//.test(u.url) ? `<a href="${esc(u.url)}" target="_blank" rel="noopener" title="Notes de version">${esc(u.name)}</a>` : esc(u.name);
  // installation en cours (signalée par HA, ou lancée il y a moins de 20 s)
  const job = d.apt?.job && !d.apt.job.finishedAt ? d.apt.job : null;
  const inJob = job && u.entity?.startsWith('apt:') && (job.op === 'upgrade' || job.packages.includes(u.entity.slice(4)));
  const busy = inJob || u.inProgress || (S.updBusy?.[u.entity] && Date.now() - S.updBusy[u.entity] < 20000);
  let act = '';
  if (busy) act = `<span class="upd-busy">⏳ installation${u.percent != null ? ` ${Math.round(u.percent)} %` : '…'}</span>`;
  else if (u.entity && u.canInstall && canEdit()) act = `<button type="button" class="btn sm upd-btn" data-upd="ask" data-entity="${esc(u.entity)}">Installer</button>`;
  const ask = !busy && u.entity && u.canInstall && S.updAsk?.[w.id] === u.entity ? `<div class="upd-ask">
      <span>Installer ${esc(u.name)} ${esc(u.to || '')} ?</span>
      ${u.canBackup ? `<button type="button" class="btn sm primary" data-upd="backup" data-entity="${esc(u.entity)}" data-int="${esc(d.integrationId || '')}">Avec sauvegarde</button>` : ''}
      <button type="button" class="btn sm ${u.canBackup ? '' : 'primary'}" data-upd="install" data-entity="${esc(u.entity)}" data-int="${esc(d.integrationId || '')}">${u.canBackup ? 'Sans sauvegarde' : 'Installer'}</button>
      ${u.canSkip === false ? '' : `<button type="button" class="btn sm" data-upd="skip" data-entity="${esc(u.entity)}" data-int="${esc(d.integrationId || '')}" title="Ne plus proposer cette version">Ignorer cette version</button>`}
      <button type="button" class="btn sm" data-upd="cancel">Annuler</button>
    </div>` : '';
  return `<li class="${act ? 'upd-li' : ''}"><span class="upd-txt">${u.security ? '🔒 ' : ''}${name} ${ver}</span>${act}${ask}</li>`;
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
function torRow(t, open, intId, askDel) {
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
      </div>
      ${canEdit() ? (askDel ? `<div class="tor-del">
        <span>Supprimer ce torrent ?</span>
        <button type="button" class="btn sm" data-tor-del="keep" data-hash="${esc(t.hash)}" data-int="${esc(intId || '')}">Garder les fichiers</button>
        <button type="button" class="btn sm danger" data-tor-del="files" data-hash="${esc(t.hash)}" data-int="${esc(intId || '')}">Supprimer aussi les fichiers</button>
        <button type="button" class="btn sm" data-tor-del="cancel">Annuler</button>
      </div>` : `<div class="tor-actions"><button type="button" class="btn sm danger" data-tor-ask="${esc(t.hash)}">🗑 Supprimer</button></div>`) : ''}` : ''}
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
    const d = await api(`/widgets/${pageOf(w)}/${w.id}?c=${encodeURIComponent(st.cont)}`);
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
      try { await api(`/widgets/${pageOf(w)}/${w.id}/action`, { method: 'POST', body: { op: 'read', integrationId, ids: [...ids] } }); }
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

// ---------- lecteur RSS complet (FreshRSS) : catégories, liste, lecture ----------
const RD_KEY = id => `rd_${id}`;
function rdState(w) {
  S.rd ||= {};
  if (!S.rd[w.id]) {
    let saved = {};
    try { saved = JSON.parse(localStorageGet(RD_KEY(w.id)) || '{}'); } catch { /* ignoré */ }
    S.rd[w.id] = {
      stream: saved.stream || 'all', filter: saved.filter || (w.config?.unreadOnly === false ? 'all' : 'unread'),
      collapsed: new Set(saved.collapsed || []), items: [], ids: new Set(), cont: null, loading: false,
      sel: null, tree: null, q: '', side: false, intId: null, loadedAt: null, queue: new Map(), ready: false
    };
  }
  return S.rd[w.id];
}
function rdSave(w) {
  const st = rdState(w);
  localStorageSet(RD_KEY(w.id), JSON.stringify({ stream: st.stream, filter: st.filter, collapsed: [...st.collapsed] }));
}
const rdText = html => { const d = document.createElement('div'); d.innerHTML = String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ''); return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
const rdImg = u => (u && (/^https?:\/\//i.test(u) || /^\/[^/]/.test(u)) ? u : '');
function rdFeed(st, id) {
  for (const c of st.tree?.categories || []) { const f = c.feeds.find(x => x.id === id); if (f) return { f, c }; }
  return {};
}
function rdFavicon(feed, name) {
  const letter = esc((name || '?').trim().charAt(0).toUpperCase());
  const hue = [...String(name || '')].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
  const fb = `<span class="rd-fav l" style="--h:${hue}">${letter}</span>`;
  const src = rdImg(feed?.icon);
  return src ? `<img class="rd-fav" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='${fb.replace(/"/g, '&quot;').replace(/'/g, '&#39;')}'">` : fb;
}
function rdStreamName(st) {
  if (st.stream === 'all') return 'Tous les articles';
  if (st.stream === 'starred') return 'Favoris';
  const c = st.tree?.categories?.find(x => x.id === st.stream);
  if (c) return c.name;
  return rdFeed(st, st.stream).f?.name || 'Flux';
}
const rdCount = n => (n ? `<span class="rd-n">${n > 999 ? '999+' : n}</span>` : '');

function rdSideHtml(st) {
  const t = st.tree;
  const it = (id, icon, name, n, extra = '') => `<button type="button" class="rd-s ${st.stream === id ? 'on' : ''} ${extra}" data-rs="${esc(id)}">${icon}<span class="nm">${esc(name)}</span>${rdCount(n)}</button>`;
  return `
    ${it('all', '<span class="rd-ico">≡</span>', 'Tous les articles', t?.unread)}
    ${it('starred', '<span class="rd-ico star">★</span>', 'Favoris', 0)}
    <div class="rd-sep">Catégories</div>
    ${(t?.categories || []).map(c => {
      const closed = st.collapsed.has(c.id);
      return `<div class="rd-cat ${closed ? 'closed' : ''}">
        <div class="rd-crow">
          <button type="button" class="rd-tw" data-rtw="${esc(c.id)}" title="${closed ? 'Déplier' : 'Replier'}">▾</button>
          ${it(c.id, '', c.name, c.unread, 'cat')}
        </div>
        <div class="rd-feeds">${c.feeds.map(f => it(f.id, rdFavicon(f, f.name), f.name, f.unread, `feed ${f.unread ? '' : 'zero'}`)).join('')}</div>
      </div>`;
    }).join('') || '<div class="muted small" style="padding:8px 12px">Aucun abonnement</div>'}`;
}

function rdItemHtml(st, i, k, showImg) {
  const { f } = rdFeed(st, i.feedId);
  const img = showImg ? rdImg(i.image) : '';
  if (i._ex === undefined) {
    // l'extrait ne répète pas le titre quand l'article commence par lui
    let t = rdText(i.content);
    const head = (i.title || '').trim();
    if (head && t.toLowerCase().startsWith(head.toLowerCase())) t = t.slice(head.length).replace(/^[\s.:;,—–-]+/, '');
    i._ex = t.slice(0, 220);
  }
  const ex = i._ex;
  return `<div class="rd-item ${i.read ? 'read' : ''} ${st.sel === i.id ? 'sel' : ''}" data-rk="${k}" tabindex="-1">
    <div class="rd-im">
      <div class="rd-src">${rdFavicon(f, i.source)}<span>${esc(i.source)}</span><span class="rd-dt">${i.date ? relTime(i.date) : ''}</span></div>
      <div class="rd-t">${!i.read ? '<i class="unread-dot"></i>' : ''}${esc(i.title)}</div>
      ${ex ? `<div class="rd-ex">${esc(ex)}</div>` : ''}
    </div>
    ${img ? `<img class="rd-th" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    ${canEdit() ? `<button type="button" class="rd-star ${i.starred ? 'on' : ''}" data-rstar="${k}" title="${i.starred ? 'Retirer des favoris' : 'Ajouter aux favoris'}">★</button>` : ''}
    <button type="button" class="rd-share" data-rshare="${k}" title="Partager">↗</button>
  </div>`;
}
function rdVisible(st) {
  const q = st.q.trim().toLowerCase();
  return st.items.map((i, k) => [i, k]).filter(([i]) => !q || `${i.title} ${i.source} ${i._ex ?? rdText(i.content)}`.toLowerCase().includes(q));
}
function rdListHtml(w, st) {
  const showImg = w.config?.showImages !== false;
  const vis = rdVisible(st);
  if (!st.ready) return '<div class="rd-pad"><div class="skeleton"></div><div class="skeleton" style="margin-top:10px"></div><div class="skeleton" style="margin-top:10px"></div></div>';
  if (!vis.length) return `<div class="rd-none"><div class="e">${st.q ? '🔍' : '🎉'}</div>${st.q ? 'Aucun article chargé ne correspond à la recherche' : st.filter === 'unread' ? 'Tout est lu ici !' : 'Aucun article'}
    ${st.q && st.cont ? '<button type="button" class="btn sm" data-rb="more">Chercher dans les articles plus anciens</button>' : ''}</div>`;
  return vis.map(([i, k]) => rdItemHtml(st, i, k, showImg)).join('')
    + (st.cont ? (st.q ? `<div class="rd-more"><button type="button" class="btn sm" data-rb="more">Chercher aussi dans les ${st.items.length > 1 ? 'articles plus anciens' : 'articles suivants'}</button></div>` : '<div class="rd-more muted small">Chargement des articles suivants…</div>')
      : '<div class="rd-end muted small">— Fin des articles —</div>');
}
function rdViewHtml(st) {
  const it = st.items.find(i => i.id === st.sel);
  if (!it) {
    return `<div class="rd-empty"><div class="e">📖</div><div>Choisis un article dans la liste</div>
      <div class="muted small rd-keys"><kbd>j</kbd> <kbd>k</kbd> article suivant / précédent · <kbd>s</kbd> favori · <kbd>m</kbd> lu / non lu · <kbd>p</kbd> partager · <kbd>o</kbd> ouvrir l'original</div></div>`;
  }
  const { f } = rdFeed(st, it.feedId);
  const body = it.content ? sanitizeHtml(it.content, it.link) : '<p class="muted">Pas de contenu dans le flux pour cet article.</p>';
  const hero = rdImg(it.image) && !/<img\s/i.test(it.content || '') ? `<img class="rd-hero" src="${esc(it.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : '';
  return `<div class="rd-vbar">
      <button type="button" class="btn sm rd-back" data-rb="back">← Liste</button>
      ${canEdit() ? `<button type="button" class="btn sm ${it.starred ? 'on' : ''}" data-rb="star" title="Favori (s)">${it.starred ? '★<span class="lbl"> En favori</span>' : '☆<span class="lbl"> Favori</span>'}</button>
      <button type="button" class="btn sm" data-rb="toggle" title="Lu / non lu (m)">${it.read ? '●<span class="lbl"> Marquer non lu</span>' : '✓<span class="lbl"> Marquer lu</span>'}</button>` : ''}
      <button type="button" class="btn sm" data-rb="share" title="Partager sur les réseaux (p)">↗<span class="lbl"> Partager</span></button>
      <span style="flex:1"></span>
      <button type="button" class="btn sm" data-rb="prev" title="Article précédent (k)">↑</button>
      <button type="button" class="btn sm" data-rb="next" title="Article suivant (j)">↓</button>
      <a class="btn sm" href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener" title="Ouvrir l'original (o)"><span class="lbl">Ouvrir l'original </span>🔗</a>
    </div>
    <div class="rd-scroll"><article class="reader rd-art">
      <div class="rd-src big">${rdFavicon(f, it.source)}<span>${esc(it.source)}</span></div>
      <h1>${esc(it.title)}</h1>
      <div class="muted small">${esc([it.author, it.date ? new Date(it.date).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }) : ''].filter(Boolean).join(' · '))}</div>
      ${hero}
      <div class="reader-body md">${body}</div>
      <div class="rd-foot"><a class="btn" href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener">Lire l'article sur ${esc(it.source || 'le site')} ↗</a></div>
    </article></div>`;
}
function rdBarHtml(w, st) {
  const total = st.stream === 'all' ? st.tree?.unread : st.stream === 'starred' ? null
    : (st.tree?.categories?.find(c => c.id === st.stream)?.unread ?? rdFeed(st, st.stream).f?.unread);
  return `
    <button type="button" class="btn sm rd-burger" data-rb="side" title="Abonnements">☰</button>
    <div class="rd-title"><b>${esc(rdStreamName(st))}</b>${total != null ? `<span class="muted small">${total ? `${total} non lu${total > 1 ? 's' : ''}` : 'tout est lu'}</span>` : ''}</div>
    <input class="input rd-q" type="search" placeholder="Rechercher dans la liste…" value="${esc(st.q)}" data-rq>
    <div class="seg">
      <button type="button" class="btn sm ${st.filter === 'unread' ? 'on' : ''}" data-rf="unread">Non lus</button>
      <button type="button" class="btn sm ${st.filter === 'all' ? 'on' : ''}" data-rf="all">Tous</button>
    </div>
    ${canEdit() && st.stream !== 'starred' ? '<button type="button" class="btn sm" data-rb="readall" title="Marquer comme lus tous les articles de ce flux">✓<span class="lbl"> Tout lu</span></button>' : ''}
    <button type="button" class="btn sm" data-rb="refresh" title="Actualiser (r)">↻</button>`;
}
function rdPaint(w, el, parts = 'all') {
  const st = rdState(w);
  const dyn = $('.w-dyn', el);
  let root = $('.rd', dyn);
  if (!root) {
    dyn.innerHTML = `<div class="rd"><div class="rd-bar"></div><div class="rd-main">
      <aside class="rd-side"></aside><div class="rd-list"></div><section class="rd-view"></section></div><div class="rd-errs"></div></div>`;
    root = $('.rd', dyn);
    rdBindScroll(w, el, root);
  }
  const all = parts === 'all';
  root.classList.toggle('reading', !!st.sel);
  root.classList.toggle('side-open', st.side);
  if (all || parts.includes('bar')) {
    const q = $('[data-rq]', root), focused = document.activeElement === q, pos = q?.selectionStart;
    $('.rd-bar', root).innerHTML = rdBarHtml(w, st);
    if (focused) { const n = $('[data-rq]', root); n.focus(); n.setSelectionRange(pos, pos); }
  }
  if (all || parts.includes('side')) { const s = $('.rd-side', root), y = s.scrollTop; s.innerHTML = rdSideHtml(st); s.scrollTop = y; }
  if (all || parts.includes('list')) {
    const l = $('.rd-list', root), y = l.scrollTop;
    l.innerHTML = rdListHtml(w, st);
    l.scrollTop = y;
    rdObserve(w, el, l);
    // liste plus courte que la colonne : on charge la suite sans attendre un défilement impossible
    if (!st.q && st.cont && !st.loading && l.scrollHeight <= l.clientHeight + 40) setTimeout(() => rdMore(w, el), 0);
  }
  if (all || parts.includes('view')) { $('.rd-view', root).innerHTML = rdViewHtml(st); }
}
function rdBindScroll(w, el, root) {
  const st = rdState(w);
  const l = $('.rd-list', root);
  l.addEventListener('scroll', () => {
    if (st.cont && !st.loading && l.scrollTop + l.clientHeight > l.scrollHeight - 300) rdMore(w, el);
  });
}
function rdObserve(w, el, list) {
  const st = rdState(w);
  st.obs?.disconnect();
  if (!(w.config?.markOnScroll && canEdit())) return;
  st.obs = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (en.isIntersecting || !en.rootBounds || en.boundingClientRect.bottom > en.rootBounds.top + 4) continue;
      const it = st.items[Number(en.target.dataset.rk)];
      if (it && !it.read) rdMark(w, el, [it], true);
    }
  }, { root: list, threshold: 0 });
  $$('.rd-item:not(.read)', list).forEach(a => st.obs.observe(a));
}
async function rdMore(w, el) {
  const st = rdState(w);
  if (!st.cont || st.loading) return;
  st.loading = true;
  try {
    const d = await api(`/widgets/${pageOf(w)}/${w.id}${RENDER.reader.query(w)}&c=${encodeURIComponent(st.cont)}`);
    const add = (d.items || []).filter(i => !st.ids.has(i.id));
    add.forEach(i => st.ids.add(i.id));
    st.items.push(...add);
    st.cont = d.continuation || null;
    rdPaint(w, el, ['list']);
  } catch (e) { toast(e.message, true); }
  st.loading = false;
}
// change le compteur de non lus d'un article dans l'arborescence (abonnement, catégorie, total)
function rdBump(st, it, delta) {
  const { f, c } = rdFeed(st, it.feedId);
  if (f) f.unread = Math.max(0, f.unread + delta);
  if (c) c.unread = Math.max(0, c.unread + delta);
  if (st.tree) st.tree.unread = Math.max(0, (st.tree.unread || 0) + delta);
}
function rdSend(w, op, ids) {
  const st = rdState(w);
  return api(`/widgets/${pageOf(w)}/${w.id}/action`, { method: 'POST', body: { op, integrationId: st.intId, ids } })
    .catch(e => toast(`FreshRSS : ${e.message}`, true));
}
function rdMark(w, el, items, read) {
  if (!canEdit()) return;
  const st = rdState(w);
  const ch = items.filter(i => !!i.read !== read);
  if (!ch.length) return;
  ch.forEach(i => { i.read = read; rdBump(st, i, read ? -1 : 1); st.queue.set(i.id, read); });
  ch.forEach(i => {
    const row = $(`.rd-item[data-rk="${st.items.indexOf(i)}"]`, el);
    if (!row) return;
    row.classList.toggle('read', read);
    if (read) $('.unread-dot', row)?.remove();
    else if (!$('.unread-dot', row)) $('.rd-t', row).insertAdjacentHTML('afterbegin', '<i class="unread-dot"></i>');
  });
  rdPaint(w, el, ['bar', 'side']);
  clearTimeout(st.flushT);
  st.flushT = setTimeout(() => rdFlush(w), 800);
}
// envoie à FreshRSS les articles marqués lus / non lus en attente
function rdFlush(w) {
  const st = rdState(w);
  clearTimeout(st.flushT);
  const r = [], u = [];
  for (const [id, v] of st.queue) (v ? r : u).push(id);
  st.queue.clear();
  return Promise.all([r.length && rdSend(w, 'read', r), u.length && rdSend(w, 'unread', u)]);
}
function rdStar(w, el, it) {
  if (!canEdit() || !it) return;
  it.starred = !it.starred;
  rdSend(w, it.starred ? 'star' : 'unstar', [it.id]);
  const k = st => st.items.indexOf(it);
  const st = rdState(w);
  const b = $(`[data-rstar="${k(st)}"]`, el);
  if (b) b.classList.toggle('on', it.starred);
  if (st.sel === it.id) rdPaint(w, el, ['view']);
  toast(it.starred ? 'Ajouté aux favoris ★' : 'Retiré des favoris');
}
function rdOpen(w, el, it, scroll = true) {
  const st = rdState(w);
  if (!it) return;
  st.sel = it.id;
  $$('.rd-item.sel', el).forEach(x => x.classList.remove('sel'));
  const row = $(`.rd-item[data-rk="${st.items.indexOf(it)}"]`, el);
  row?.classList.add('sel');
  if (scroll) row?.scrollIntoView({ block: 'nearest' });
  rdMark(w, el, [it], true);
  rdPaint(w, el, ['view']);
  $('.rd', el)?.classList.add('reading');
  $('.rd-scroll', el)?.scrollTo(0, 0);
}
function rdStep(w, el, dir) {
  const st = rdState(w);
  const vis = rdVisible(st).map(([i]) => i);
  if (!vis.length) return;
  const cur = vis.findIndex(i => i.id === st.sel);
  const next = vis[cur < 0 ? 0 : Math.min(vis.length - 1, Math.max(0, cur + dir))];
  rdOpen(w, el, next);
  if (dir > 0 && vis.indexOf(next) > vis.length - 4) rdMore(w, el);
}
async function rdSwitch(w, el, patch) {
  const st = rdState(w);
  const pending = st.queue.size ? rdFlush(w) : null;
  Object.assign(st, patch, { items: [], ids: new Set(), cont: null, sel: null, ready: false, q: '', side: false });
  rdSave(w);
  rdPaint(w, el);
  await pending; // les marquages en attente partent avant de recharger la liste
  loadWidget(w);
}

// un seul écouteur clavier pour tous les lecteurs : il agit sur celui de l'onglet affiché
let RD_KEYS = false;
function rdKeys() {
  if (RD_KEYS) return;
  RD_KEYS = true;
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable || $('.overlay')) return;
    const el = $('.widget[data-wid] .rd')?.closest('.widget');
    if (!el) return;
    const w = page()?.widgets.find(x => x.id === el.dataset.wid);
    if (!w) return;
    const st = rdState(w);
    const it = st.items.find(i => i.id === st.sel);
    const k = e.key;
    if (k === 'j' || k === 'ArrowDown' && e.shiftKey) { e.preventDefault(); rdStep(w, el, 1); }
    else if (k === 'k' || k === 'ArrowUp' && e.shiftKey) { e.preventDefault(); rdStep(w, el, -1); }
    else if (k === 's' && it) rdStar(w, el, it);
    else if (k === 'm' && it) { rdMark(w, el, [it], !it.read); rdPaint(w, el, ['view']); }
    else if ((k === 'o' || k === 'v') && it?.link) window.open(safeUrl(it.link), '_blank', 'noopener');
    else if (k === 'p' && it) { e.preventDefault(); shareDialog(w, it); }
    else if (k === 'r') loadWidget(w);
    else if (k === 'Escape' && st.sel) { st.sel = null; rdPaint(w, el, ['view']); $('.rd', el)?.classList.remove('reading'); }
  });
}

// hauteur « pleine fenêtre » : le lecteur occupe l'écran sous les onglets
const rdFill = w => w.type === 'reader' && w.config?.fill !== false;
function rdFillPx() {
  const g = $('#grid');
  const top = g ? g.getBoundingClientRect().top + window.scrollY : 190;
  // téléphone : tout l'écran (on fait défiler l'en-tête), sinon l'espace restant sous les onglets
  return MOBILE.matches ? window.innerHeight - 24 : Math.max(420, window.innerHeight - top - 22);
}
function rdFitAll() {
  if (!GRID) return;
  for (const w of page()?.widgets || []) {
    if (!rdFill(w)) continue;
    const item = $(`.grid-stack-item[gs-id="${w.id}"]`);
    if (item) GRID.update(item, { h: rowsFor(rdFillPx()) });
  }
}
let RD_RESIZE = null;
window.addEventListener('resize', () => { clearTimeout(RD_RESIZE); RD_RESIZE = setTimeout(rdFitAll, 120); });

// ---------- partage d'un article sur les réseaux sociaux (texte modifiable avant publication) ----------
// Chaque réseau ouvre sa propre fenêtre de publication avec le texte déjà rempli : rien n'est publié depuis le dashboard.
const SHARE_NETS = [
  { key: 'X', opt: 'shareX', label: 'X', max: 280, urlLen: 23, color: '#8b98a5',
    href: t => `https://x.com/intent/tweet?text=${encodeURIComponent(t)}` },
  { key: 'Mastodon', opt: 'shareMastodon', label: 'Mastodon', max: 500, urlLen: 23, color: '#8c8dff',
    href: (t, inst) => (inst ? `https://${inst}/share?text=${encodeURIComponent(t)}` : '') },
  { key: 'Threads', opt: 'shareThreads', label: 'Threads', max: 500, color: '#c9c9c9',
    href: t => `https://www.threads.com/intent/post?text=${encodeURIComponent(t)}` },
  { key: 'Bluesky', opt: 'shareBluesky', label: 'Bluesky', max: 300, color: '#3b9dff',
    href: t => `https://bsky.app/intent/compose?text=${encodeURIComponent(t)}` }
];
const URL_RE = /https?:\/\/[^\s]+/g;
function shareLen(text, net) {
  // X et Mastodon comptent chaque lien pour 23 caractères ; Bluesky et Threads comptent le texte entier
  const t = net.urlLen ? text.replace(URL_RE, 'x'.repeat(net.urlLen)) : text;
  try { return [...new Intl.Segmenter('fr', { granularity: 'grapheme' }).segment(t)].length; } catch { return [...t].length; }
}
const cleanInstance = v => String(v || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
function shareText(w, it) {
  const tpl = w.config?.shareTemplate || '{titre} - {lien}';
  return tpl.replace(/\{titre\}/g, it.title || '').replace(/\{lien\}/g, it.link || '').replace(/\{source\}/g, it.source || '').trim();
}
function shareDialog(w, it) {
  if (!it) return;
  const c = w.config || {};
  const nets = SHARE_NETS.filter(n => c[n.opt] !== false);
  if (!nets.length) { toast('Aucun réseau activé pour le partage (⚙ du lecteur)', true); return; }
  const base = shareText(w, it);
  const texts = Object.fromEntries(nets.map(n => [n.key, base]));
  const own = new Set(); // réseaux dont le texte a été adapté à part
  let inst = cleanInstance(localStorageGet('share_mastodon') || c.mastodonInstance);
  const m = modal({
    title: 'Partager l\'article',
    body: `<div class="share">
      <div class="share-art">${rdImg(it.image) ? `<img src="${esc(it.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        <div><b>${esc(it.title)}</b><div class="muted small">${esc(it.source || '')} · <span class="mono">${esc((it.link || '').replace(/^https?:\/\//, '').slice(0, 70))}</span></div></div></div>
      <label class="share-main">Texte du message<textarea data-sh="all" rows="4">${esc(base)}</textarea></label>
      <div class="help">Modifie le texte ici, puis clique sur un réseau : sa fenêtre de publication s'ouvre avec ce texte, et tu valides (ou retouches encore) là-bas. « Adapter » donne un texte propre à un réseau.</div>
      <div class="share-nets">${nets.map(n => `
        <div class="share-net" data-net="${n.key}" style="--nc:${n.color}">
          <div class="share-row">
            <span class="share-name">${n.label}</span>
            <span class="share-cnt small" data-cnt></span>
            <button type="button" class="btn sm" data-adapt>Adapter</button>
            <a class="btn sm primary share-go" data-go target="_blank" rel="noopener">Publier sur ${n.label} ↗</a>
          </div>
          ${n.key === 'Mastodon' ? `<div class="share-inst"><span class="muted small">Instance</span><input class="input" data-inst placeholder="mastodon.social" value="${esc(inst)}"></div>` : ''}
          <textarea data-sh="${n.key}" rows="3" hidden></textarea>
        </div>`).join('')}</div>
    </div>`,
    footer: '<button class="btn" data-copy>📋 Copier le texte</button><button class="btn primary" data-close2>Fermer</button>'
  });
  const main = $('[data-sh=all]', m.el);
  const refresh = () => {
    for (const n of nets) {
      const box = $(`[data-net="${n.key}"]`, m.el);
      const t = texts[n.key];
      const len = shareLen(t, n);
      const cnt = $('[data-cnt]', box);
      cnt.textContent = `${len} / ${n.max}`;
      cnt.className = `share-cnt small ${len > n.max ? 'over' : len > n.max * 0.9 ? 'near' : ''}`;
      const go = $('[data-go]', box);
      const href = n.href(t, inst);
      const bad = !t.trim() || len > n.max || !href;
      go.classList.toggle('disabled', bad);
      if (bad) go.removeAttribute('href'); else go.href = href;
      go.title = !href ? 'Indique d\'abord ton instance Mastodon' : len > n.max ? `Trop long pour ${n.label} : raccourcis le texte` : `Ouvre ${n.label} avec ce texte`;
      $('[data-adapt]', box).textContent = own.has(n.key) ? 'Reprendre le texte commun' : 'Adapter';
    }
  };
  main.addEventListener('input', () => { for (const n of nets) if (!own.has(n.key)) texts[n.key] = main.value; refresh(); });
  m.el.addEventListener('input', e => {
    const k = e.target.dataset.sh;
    if (k && k !== 'all') { texts[k] = e.target.value; refresh(); }
    if (e.target.matches('[data-inst]')) { inst = cleanInstance(e.target.value); localStorageSet('share_mastodon', inst); refresh(); }
  });
  m.el.addEventListener('click', e => {
    const ad = e.target.closest('[data-adapt]');
    if (ad) {
      const box = ad.closest('[data-net]'), k = box.dataset.net, ta = $('textarea', box);
      if (own.has(k)) { own.delete(k); texts[k] = main.value; ta.hidden = true; }
      else { own.add(k); ta.value = texts[k]; ta.hidden = false; ta.focus(); }
      refresh();
      return;
    }
    const go = e.target.closest('[data-go]');
    if (go?.classList.contains('disabled')) { e.preventDefault(); toast(go.title, true); }
  });
  $('[data-copy]', m.el).onclick = async () => {
    try { await navigator.clipboard.writeText(main.value); toast('Texte copié ✓'); }
    catch { main.select(); toast('Sélectionné : Ctrl+C pour copier'); }
  };
  $('[data-close2]', m.el).onclick = m.close;
  refresh();
  main.focus();
  main.setSelectionRange(main.value.length, main.value.length);
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
  const cloud = (x = 0, y = 0, s = 1, fill = 'none') => `<path transform="translate(${x} ${y}) scale(${s})" d="M18 46h28a11 11 0 0 0 1-22 15 15 0 0 0-28-4 10 10 0 0 0-1 26z" fill="${fill}" stroke="var(--wx-cloud)" stroke-width="${3 / s}" stroke-linejoin="round"/>`;
  const sun = (x, y, r) => `<g stroke="#ffc94a" stroke-width="2.6" stroke-linecap="round" fill="none"><circle cx="${x}" cy="${y}" r="${r}"/>${[0, 45, 90, 135, 180, 225, 270, 315].map(a => {
    const rad = a * Math.PI / 180, r1 = r + 4, r2 = r + 8;
    return `<line x1="${x + r1 * Math.cos(rad)}" y1="${y + r1 * Math.sin(rad)}" x2="${x + r2 * Math.cos(rad)}" y2="${y + r2 * Math.sin(rad)}"/>`;
  }).join('')}</g>`;
  const moon = (x, y, r) => `<path d="M${x + r * 0.35} ${y - r} a${r} ${r} 0 1 0 ${r * 0.9} ${r * 1.55} a${r * 0.8} ${r * 0.8} 0 0 1 ${-r * 0.9} ${-r * 1.55}z" fill="#7cc4f0"/>`;
  const drops = n => [...Array(n)].map((_, i) => `<line x1="${24 + i * 8}" y1="50" x2="${21 + i * 8}" y2="58" stroke="#5aa9ff" stroke-width="2.6" stroke-linecap="round"/>`).join('');
  const flakes = `<g fill="var(--wx-cloud)">${[24, 34, 44].map(x => `<circle cx="${x}" cy="54" r="2.2"/>`).join('')}</g>`;
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
    bind(w, el) {
      // mises à jour Home Assistant : installer / ignorer depuis le widget
      el.addEventListener('click', async e => {
        const b = e.target.closest('[data-upd]');
        if (!b) return;
        e.preventDefault();
        const ask = (S.updAsk ||= {});
        const op = b.dataset.upd;
        if (op === 'apt-ask' || op === 'apt-cancel') {
          (S.aptAsk ||= {})[w.id] = op === 'apt-ask' ? b.dataset.apt : null;
          if (S.cache[w.id]) paintWidget(w, S.cache[w.id]);
          return;
        }
        if (op === 'apt-go') {
          S.aptAsk[w.id] = null;
          $$('[data-upd]', el).forEach(x => { x.disabled = true; });
          try {
            const r = await api(`/widgets/${pageOf(w)}/${w.id}/action`, { method: 'POST', body: { op: 'apt', aptOp: b.dataset.apt, integrationId: b.dataset.int || undefined } });
            toast(r.queued ? 'Mise à jour envoyée : l\'agent la lancera à son prochain contact' : 'Mise à jour apt lancée ✓');
          } catch (err) { toast(err.message, true); }
          setTimeout(() => loadWidget(w), 1500);
          return;
        }
        if (op === 'all-ask' || op === 'all-cancel') {
          (S.updAllAsk ||= {})[w.id] = op === 'all-ask';
          ask[w.id] = null;
          if (S.cache[w.id]) paintWidget(w, S.cache[w.id]);
          return;
        }
        if (op === 'all-go') {
          const picked = $$('[data-upd-pick]', el).filter(c => c.checked).map(c => c.dataset.updPick);
          const backup = !!$('[data-upd-backup]', el)?.checked;
          const all = (S.cache[w.id]?.updates || []).filter(u => picked.includes(u.entity));
          if (!all.length) { toast('Rien de coché', true); return; }
          // ordre : le reste, puis Supervisor, OS et enfin Core
          const rank = u => (!isHaSelf(u) ? 0 : /supervisor/.test(u.entity) ? 1 : /operating_system|_os_/.test(u.entity) ? 2 : 3);
          all.sort((a, c) => rank(a) - rank(c));
          S.updAllAsk[w.id] = false;
          $$('[data-upd]', el).forEach(x => { x.disabled = true; });
          let ok = 0; const fails = [];
          for (const u of all) {
            (S.updBusy ||= {})[u.entity] = Date.now();
            if (S.cache[w.id]) paintWidget(w, S.cache[w.id]);
            try {
              await api(`/widgets/${pageOf(w)}/${w.id}/action`, { method: 'POST', body: { op: 'install', backup: backup && isHaSelf(u) && u.canBackup, entity: u.entity, integrationId: b.dataset.int || undefined } });
              ok++;
            } catch (err) { fails.push(`${u.name} : ${err.message}`); delete S.updBusy[u.entity]; }
          }
          toast(fails.length ? `${ok} lancée(s), ${fails.length} échec(s) — ${fails[0]}` : `${ok} mise(s) à jour lancée(s) ✓`, !!fails.length);
          setTimeout(() => loadWidget(w), 1500);
          return;
        }
        if (op === 'ask' || op === 'cancel') {
          ask[w.id] = op === 'ask' ? b.dataset.entity : null;
          if (S.cache[w.id]) paintWidget(w, S.cache[w.id]);
          return;
        }
        ask[w.id] = null;
        $$('[data-upd]', el).forEach(x => { x.disabled = true; });
        try {
          await api(`/widgets/${pageOf(w)}/${w.id}/action`, { method: 'POST', body: { op: op === 'skip' ? 'skip' : 'install', backup: op === 'backup', entity: b.dataset.entity, integrationId: b.dataset.int || undefined } });
          toast(op === 'skip' ? 'Version ignorée' : 'Installation lancée ✓');
          (S.updBusy ||= {})[b.dataset.entity] = Date.now();
        } catch (err) { toast(err.message, true); }
        setTimeout(() => loadWidget(w), 1500);
      });
    },
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
        ${d.apt ? aptBar(d, w) : updAll(d, w)}<ul>${d.updates.map(u => updItem(u, w, d)).join('')}</ul></details>`
        : (d.updates ? '<div class="muted small" style="margin-top:10px">✓ Système à jour</div>' : '');
      upd = aptJobBox(d) + upd;
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
    query: w => (S.dockLive?.[w.id] ? '?live=1' : ''),
    static: w => `<div class="toolbar"><input class="input" data-filter placeholder="Filtrer (nom, image, hôte)…" style="flex:1;min-width:180px">
      <label class="small muted"><input type="checkbox" data-stopped ${w.config?.onlyStopped ? 'checked' : ''}> Arrêtés uniquement</label>
      <label class="small muted"><input type="checkbox" data-upd-only> Mises à jour uniquement</label></div>`,
    bind(w, el) {
      const f = S.filters[w.id] ||= { q: '', stopped: !!w.config?.onlyStopped, upd: false, ...dockSort(w) };
      const inp = $('[data-filter]', el), chk = $('[data-stopped]', el), upd = $('[data-upd-only]', el);
      inp.value = f.q; chk.checked = f.stopped; upd.checked = f.upd;
      const re = () => S.cache[w.id] && paintWidget(w, S.cache[w.id]);
      inp.addEventListener('input', () => { f.q = inp.value.toLowerCase(); re(); });
      chk.addEventListener('change', () => { f.stopped = chk.checked; re(); });
      upd.addEventListener('change', () => { f.upd = upd.checked; re(); });
      el.addEventListener('click', async e => {
        // tri par colonne (mémorisé sur l'appareil)
        const th = e.target.closest('[data-sort]');
        if (th) {
          const k = th.dataset.sort;
          f.dir = f.sort === k ? -f.dir : 1; f.sort = k;
          localStorageSet('hd_dsort_' + w.id, JSON.stringify({ sort: f.sort, dir: f.dir }));
          return re();
        }
        // mise à jour de l'image : un conteneur ou tous
        const u = e.target.closest('[data-cupd]');
        if (u) {
          const all = (S.cache[w.id]?.containers || []);
          const targets = u.dataset.cupd === 'all'
            ? all.filter(c => c.imageUpdate && c.canUpdate && !jobActive(c) && !/mondashboard-agent|homedash-agent/.test(c.image))
                .sort((a, b) => /mondashboard/.test(a.image) - /mondashboard/.test(b.image))
            : all.filter(c => c.id === u.dataset.cid);
          if (!targets.length) return;
          const msg = targets.length === 1
            ? `Mettre à jour « ${targets[0].name} » (${targets[0].host}) ?\n\nLa nouvelle image est téléchargée puis le conteneur est recréé avec la même configuration (volumes, ports, réseaux, variables). En cas d'échec, l'ancien est remis en place.`
            : `Mettre à jour ${targets.length} conteneurs ?\n\n${targets.map(c => `• ${c.name} (${c.host})`).join('\n')}\n\nChaque machine les traite un par un. En cas d'échec, l'ancien conteneur est remis en place.`;
          if (!confirm(msg)) return;
          u.disabled = true;
          let ok = 0; const fails = [];
          for (const c of targets) {
            try { await api(`/widgets/${pageOf(w)}/${w.id}/action`, { method: 'POST', body: { integrationId: c.integrationId, containerId: c.id, op: 'update' } }); ok++; c.job = { state: 'queued', at: new Date().toISOString() }; }
            catch (err) { fails.push(`${c.name} : ${err.message}`); }
          }
          toast(fails.length ? `${ok} lancée(s), ${fails.length} refusée(s) — ${fails[0]}` : `${ok} mise(s) à jour lancée(s) : suivi dans la colonne État`, !!fails.length);
          (S.dockLive ||= {})[w.id] = true;
          re();
          setTimeout(() => loadWidget(w), 2000);
          return;
        }
        const b = e.target.closest('[data-op]');
        if (!b) return;
        const verb = { start: 'Démarrer', stop: 'Arrêter', restart: 'Redémarrer' }[b.dataset.op];
        if (b.dataset.op !== 'start' && !confirm(`${verb} le conteneur « ${b.dataset.name} » ?`)) return;
        const row = b.closest('tr');
        $$('[data-op]', row).forEach(x => { x.disabled = true; });
        const st = $('.st-cell', row);
        if (st) st.innerHTML = `<span class="st-restarting">◌ <span class="small">${{ start: 'Démarrage', stop: 'Arrêt', restart: 'Redémarrage' }[b.dataset.op]} en cours…</span></span>`;
        try {
          await api(`/widgets/${pageOf(w)}/${w.id}/action`, { method: 'POST', body: { integrationId: b.dataset.int, containerId: b.dataset.cid, op: b.dataset.op } });
          toast(`${b.dataset.name} : ${{ start: 'démarré', stop: 'arrêté', restart: 'redémarré' }[b.dataset.op]} ✓`);
        } catch (err) { toast(err.message, true); }
        delete S.cache[w.id];
        loadWidget(w);
      });
    },
    dyn(d, w) {
      const f = S.filters[w.id] || { q: '', stopped: false, upd: false, ...dockSort(w) };
      const all = d.containers || [];
      const running = all.filter(c => c.state === 'running').length;
      const outdated = all.filter(c => c.imageUpdate).length;
      const updatable = all.filter(c => c.imageUpdate && c.canUpdate && !jobActive(c) && !/mondashboard-agent|homedash-agent/.test(c.image)).length;
      // tri : clé choisie, puis hôte, puis nom
      const ST = { running: 0, restarting: 1, paused: 2, created: 3, exited: 4, dead: 5 };
      const val = {
        host: c => c.host.toLowerCase(), name: c => c.name.toLowerCase(),
        update: c => (jobActive(c) ? 0 : c.imageUpdate ? 1 : c.imageUpdate === false ? 2 : 3),
        state: c => (jobActive(c) ? -1 : ST[c.state] ?? 9)
      }[f.sort] || (c => c.host);
      const cmp = (a, b) => { const x = val(a), y = val(b); return x < y ? -1 : x > y ? 1 : 0; };
      const list = all.filter(c => (!f.stopped || c.state !== 'running') && (!f.upd || c.imageUpdate || jobActive(c))
        && (!f.q || `${c.name} ${c.image} ${c.host}`.toLowerCase().includes(f.q)))
        .sort((a, b) => cmp(a, b) * f.dir || a.host.localeCompare(b.host) || a.name.localeCompare(b.name));
      const th = (k, label) => `<th data-sort="${k}" class="sortable ${f.sort === k ? 'on' : ''}" title="Trier">${label}${f.sort === k ? (f.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
      // suivi des mises à jour en cours : on rafraîchit vite tant qu'il y en a
      (S.dockLive ||= {})[w.id] = all.some(jobActive);
      if (S.dockLive[w.id]) { clearTimeout(S.dockPoll?.[w.id]); (S.dockPoll ||= {})[w.id] = setTimeout(() => loadWidget(w), 4000); }
      const jobCell = c => {
        const j = c.job; if (!j) return '';
        const age = Date.now() - Date.parse(j.at || 0);
        if (j.state === 'queued') return '<span class="st-restarting">◌ <span class="small">En attente de mise à jour…</span></span>';
        if (j.state === 'pulling') return '<span class="st-restarting">⬇ <span class="small">Téléchargement de l\'image…</span></span>';
        if (j.state === 'recreating') return '<span class="st-restarting">♻ <span class="small">Recréation du conteneur…</span></span>';
        if (j.state === 'error' && age < 30 * 60e3) return `<span class="st-exited" title="${esc(j.error || '')}">✗ <span class="small">Échec de la mise à jour</span></span><div class="small muted ellip" style="max-width:260px" title="${esc(j.error || '')}">${esc(j.error || '')}</div>`;
        if (j.state === 'done' && age < 15 * 60e3) return `<div class="small" style="color:var(--ok)">✓ ${j.note ? esc(j.note) : 'mis à jour'}</div>`;
        return '';
      };
      const updChip = c => {
        if (!c.imageUpdate || jobActive(c)) return '';
        return c.canUpdate && canEdit() && !/mondashboard-agent|homedash-agent/.test(c.image)
          ? `<button class="chip warn chip-btn" data-cupd="one" data-cid="${c.id}" title="Mettre à jour ce conteneur">⬆ MAJ</button>`
          : `<span class="chip warn" style="margin-right:6px" title="${/mondashboard-agent|homedash-agent/.test(c.image) ? 'Mets à jour l\'agent depuis sa stack (Dockhand)' : 'Nouvelle version disponible'}">⬆ MAJ</span>`;
      };
      const actions = c => (c.canAct && canEdit() && !jobActive(c) ? `
        <span style="white-space:nowrap">${c.state === 'running'
          ? `<button class="iconbtn" data-op="restart" data-cid="${c.id}" data-int="${c.integrationId}" data-name="${esc(c.name)}" title="Redémarrer">↻</button>
             <button class="iconbtn" data-op="stop" data-cid="${c.id}" data-int="${c.integrationId}" data-name="${esc(c.name)}" title="Arrêter">■</button>`
          : `<button class="iconbtn" data-op="start" data-cid="${c.id}" data-int="${c.integrationId}" data-name="${esc(c.name)}" title="Démarrer">▶</button>`}</span>` : '');
      const noActs = canEdit() && all.length && !all.some(c => c.canAct)
        ? '<div class="help" style="margin-bottom:8px">Actions indisponibles sur ces sources. Pour démarrer / arrêter / redémarrer, installe l\'agent Mon dashboard sur la machine (⚙ Administration → Intégrations → Agent Mon dashboard) avec « Autoriser start / stop / restart », puis sélectionne-le dans ce widget.</div>' : '';
      return `${noActs}
        <div class="dk-sum muted small"><span>${all.length} conteneur(s) · <span class="st-running">${running} actif(s)</span> · <span class="st-exited">${all.length - running} arrêté(s)</span>${outdated ? ` · <span style="color:var(--warn)">⬆ ${outdated} image(s) à mettre à jour</span>` : ''}</span>
          ${updatable > 1 && canEdit() ? `<button class="btn sm" data-cupd="all">⬆ Tout mettre à jour (${updatable})</button>` : ''}</div>
        <div style="overflow-x:auto"><table class="tbl">
          <thead><tr>${th('host', 'Hôte')}${th('name', 'Conteneur')}${th('update', 'Image / MAJ')}${th('state', 'État')}<th></th></tr></thead>
          <tbody>${list.map(c => `<tr>
            <td><span class="host-pill">${esc(c.host)}</span></td>
            <td><b>${esc(c.name)}</b></td>
            <td class="ellip muted mono" title="${esc(c.image)}${c.imageUpdate ? ' — nouvelle version disponible' : ''}">${updChip(c)}${esc(c.image)}</td>
            <td class="st-cell st-${esc(c.state)}">${jobActive(c) ? jobCell(c) : `● <span class="small">${esc(c.status)}</span>${jobCell(c)}`}</td>
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
        <button class="btn primary add-plus" type="submit" title="Ajouter le torrent" aria-label="Ajouter le torrent"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
      </form>` : ''),
    bind(w, el) {
      S.tor ||= {};
      el.addEventListener('click', async e => {
        const op = e.target.closest('[data-tor-op]');
        if (op) {
          e.stopPropagation();
          op.disabled = true;
          try {
            await api(`/widgets/${pageOf(w)}/${w.id}/action`, { method: 'POST', body: { op: op.dataset.torOp, hash: op.dataset.hash, integrationId: op.dataset.int || undefined } });
            toast(op.dataset.torOp === 'pause' ? 'Torrent mis en pause' : 'Torrent repris');
          } catch (err) { toast(err.message, true); }
          setTimeout(() => loadWidget(w), 600);
          return;
        }
        const ask = e.target.closest('[data-tor-ask]');
        if (ask) { (S.torDel ||= {})[w.id] = ask.dataset.torAsk; if (S.cache[w.id]) paintWidget(w, S.cache[w.id]); return; }
        const del = e.target.closest('[data-tor-del]');
        if (del) {
          (S.torDel ||= {})[w.id] = null;
          if (del.dataset.torDel === 'cancel') { if (S.cache[w.id]) paintWidget(w, S.cache[w.id]); return; }
          $$('[data-tor-del]', el).forEach(b => { b.disabled = true; });
          try {
            await api(`/widgets/${pageOf(w)}/${w.id}/action`, { method: 'POST', body: { op: 'delete', hash: del.dataset.hash, deleteFiles: del.dataset.torDel === 'files', integrationId: del.dataset.int || undefined } });
            toast(del.dataset.torDel === 'files' ? 'Torrent et fichiers supprimés' : 'Torrent retiré (fichiers conservés)');
            S.tor[w.id] = null;
          } catch (err) { toast(err.message, true); }
          setTimeout(() => loadWidget(w), 500);
          return;
        }
        const row = e.target.closest('[data-tor-toggle]');
        if (row) {
          (S.torDel ||= {})[w.id] = null;
          const h = row.dataset.torToggle;
          S.tor[w.id] = S.tor[w.id] === h ? null : h;
          if (S.cache[w.id]) paintWidget(w, S.cache[w.id]);
        }
      });
      const form = $('[data-add]', el);
      if (!form) return;
      const send = async body => {
        try {
          await api(`/widgets/${pageOf(w)}/${w.id}/action`, { method: 'POST', body: { op: 'add', ...body } });
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
        <div class="tor-list">${list.map(t => torRow(t, open === t.hash, d.integrationId, open === t.hash && S.torDel?.[w.id] === t.hash)).join('') || '<div class="empty">Aucun torrent</div>'}</div>`;
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

  reader: {
    query(w) {
      const st = rdState(w);
      return `?s=${encodeURIComponent(st.stream)}&f=${st.filter}`;
    },
    bind(w, el) {
      rdKeys();
      const st = rdState(w);
      el.addEventListener('input', e => {
        if (!e.target.matches('[data-rq]')) return;
        st.q = e.target.value;
        rdPaint(w, el, ['list']);
      });
      el.addEventListener('click', async e => {
        const t = e.target;
        const star = t.closest('[data-rstar]');
        if (star) { e.stopPropagation(); rdStar(w, el, st.items[Number(star.dataset.rstar)]); return; }
        const sh = t.closest('[data-rshare]');
        if (sh) { e.stopPropagation(); shareDialog(w, st.items[Number(sh.dataset.rshare)]); return; }
        const s = t.closest('[data-rs]');
        if (s) { if (s.dataset.rs !== st.stream || st.side) rdSwitch(w, el, { stream: s.dataset.rs }); return; }
        const tw = t.closest('[data-rtw]');
        if (tw) {
          const id = tw.dataset.rtw;
          if (st.collapsed.has(id)) st.collapsed.delete(id); else st.collapsed.add(id);
          rdSave(w);
          rdPaint(w, el, ['side']);
          return;
        }
        const f = t.closest('[data-rf]');
        if (f) { if (f.dataset.rf !== st.filter) rdSwitch(w, el, { filter: f.dataset.rf }); return; }
        const row = t.closest('.rd-item');
        if (row) { rdOpen(w, el, st.items[Number(row.dataset.rk)], false); return; }
        const b = t.closest('[data-rb]');
        if (!b) return;
        const it = st.items.find(i => i.id === st.sel);
        switch (b.dataset.rb) {
          case 'back': st.sel = null; $('.rd', el).classList.remove('reading'); rdPaint(w, el, ['view']); $$('.rd-item.sel', el).forEach(x => x.classList.remove('sel')); break;
          case 'star': rdStar(w, el, it); break;
          case 'toggle': if (it) { rdMark(w, el, [it], !it.read); rdPaint(w, el, ['view']); } break;
          case 'prev': rdStep(w, el, -1); break;
          case 'more': rdMore(w, el); break;
          case 'share': shareDialog(w, it); break;
          case 'next': rdStep(w, el, 1); break;
          case 'refresh': await rdFlush(w); loadWidget(w); break;
          case 'side': st.side = !st.side; $('.rd', el).classList.toggle('side-open', st.side); break;
          case 'readall': {
            const name = rdStreamName(st);
            if (!confirm(`Marquer comme lus tous les articles de « ${name} » ?`)) return;
            try {
              await api(`/widgets/${pageOf(w)}/${w.id}/action`, { method: 'POST', body: { op: 'readall', integrationId: st.intId, stream: st.stream, ts: st.loadedAt } });
              st.items.forEach(i => { i.read = true; });
              toast(`« ${name} » : tout est lu ✓`);
              loadWidget(w);
            } catch (err) { toast(`FreshRSS : ${err.message}`, true); }
            break;
          }
        }
      });
    },
    dyn(d, w, el) {
      const st = rdState(w);
      if (d.stream && (d.stream !== st.stream || d.filter !== st.filter)) return undefined; // réponse d'un ancien filtre
      if (d.offline) { $('.w-dyn', el).innerHTML = `<div class="w-err">FreshRSS injoignable</div>${errorsHtml(d.errors)}`; return undefined; }
      st.intId = d.integrationId;
      if (d.tree) st.tree = d.tree;
      st.loadedAt = d.loadedAt || st.loadedAt;
      const items = d.items || [];
      const first = !st.ready;
      if (first) {
        st.items = items; st.ids = new Set(items.map(i => i.id)); st.cont = d.continuation || null;
      } else {
        // rafraîchissement : les nouveaux articles arrivent en tête, ceux déjà chargés gardent leur état local
        const fresh = items.filter(i => !st.ids.has(i.id));
        fresh.forEach(i => st.ids.add(i.id));
        const desc = w.config?.order !== 'Plus anciens d\'abord';
        st.items = desc ? [...fresh, ...st.items] : [...st.items, ...fresh];
      }
      st.ready = true;
      rdPaint(w, el, first ? 'all' : ['bar', 'side', 'list']);
      const er = $('.rd-errs', el);
      if (er) er.innerHTML = errorsHtml(d.errors);
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

  umami: {
    dyn(d, w) {
      if (d.empty) return '<div class="empty">Choisis une intégration Umami dans ⚙.</div>';
      const cfg = w.config || {};
      let sites = (d.sites || []).slice();
      if (cfg.hideEmpty) sites = sites.filter(x => x.visitors || x.pageviews);
      const sort = cfg.sort || 'Visiteurs';
      sites.sort(sort === 'Nom' ? (a, b) => a.name.localeCompare(b.name, 'fr')
        : sort === 'Vues' ? (a, b) => b.pageviews - a.pageviews : (a, b) => b.visitors - a.visitors || b.pageviews - a.pageviews);
      if (!sites.length) return '<div class="empty">Aucun site.</div>';
      const sum = k => sites.reduce((t, x) => t + (x[k] || 0), 0);
      const hasPrev = sites.some(x => x.prevVisitors != null);
      const sumPrev = k => sites.reduce((t, x) => t + (x[k] || 0), 0);
      const delta = (now, prev) => {
        if (prev == null) return '';
        if (!prev) return now ? '<span class="um-d up">nouveau</span>' : '';
        const p = Math.round(((now - prev) / prev) * 100);
        return p ? `<span class="um-d ${p > 0 ? 'up' : 'down'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)} %</span>` : '<span class="um-d">=</span>';
      };
      const n = v => Number(v || 0).toLocaleString('fr-FR');
      const dur = s => s == null ? '–' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
      const spark = arr => {
        if (!arr || arr.length < 2) return '<span class="um-spark"></span>';
        const max = Math.max(1, ...arr), W = 100, H = 26;
        const pts = arr.map((v, i) => `${(i / (arr.length - 1) * W).toFixed(1)},${(H - 1 - v / max * (H - 3)).toFixed(1)}`);
        return `<svg class="um-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polygon points="0,${H} ${pts.join(' ')} ${W},${H}" fill="var(--accent-soft)"/><polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
      };
      const hue = str => [...str].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
      const online = sites.reduce((t, x) => t + (x.active || 0), 0);
      return `
        <div class="um-sum">
          <div><b>${n(sum('visitors'))}</b><span>visiteurs ${hasPrev ? delta(sum('visitors'), sumPrev('prevVisitors')) : ''}</span></div>
          <div><b>${n(sum('pageviews'))}</b><span>vues ${hasPrev ? delta(sum('pageviews'), sumPrev('prevPageviews')) : ''}</span></div>
          ${cfg.showActive !== false ? `<div><b class="um-live">${online ? '<i></i>' : ''}${n(online)}</b><span>en ligne</span></div>` : ''}
          <div class="um-per muted small">${esc((d.period || '24 heures').toLowerCase())} · ${sites.length} site(s)</div>
        </div>
        <div class="um-head"><span>Site</span>${cfg.showChart !== false ? '<span class="um-c-sp">Vues</span>' : ''}<span class="num">Visiteurs</span><span class="num">Vues</span><span class="num um-c-b">Rebond</span></div>
        <div class="um-list">${sites.map(x => `
          <a class="um-row" href="${esc(x.link)}" target="_blank" rel="noopener" title="Visites : ${n(x.visits)} · durée moyenne : ${dur(x.avgTime)}${x.error ? ' · ' + esc(x.error) : ''}">
            <span class="um-site">
              <span class="um-ava" style="background:hsl(${hue(x.domain || x.name)} 55% 45%)">${esc((x.name || '?').trim()[0]?.toUpperCase() || '?')}</span>
              <span class="um-nm"><b>${esc(x.name)}</b>${x.active ? `<span class="um-on" title="${x.active} visiteur(s) en ce moment"><i></i>${x.active}</span>` : ''}<small>${esc(x.domain)}</small></span>
            </span>
            ${cfg.showChart !== false ? spark(x.series) : ''}
            <span class="num"><b>${n(x.visitors)}</b>${delta(x.visitors, x.prevVisitors)}</span>
            <span class="num">${n(x.pageviews)}</span>
            <span class="num um-c-b">${x.bounce == null ? '–' : x.bounce + ' %'}</span>
          </a>`).join('')}</div>`;
    }
  },
  title: {
    static: w => {
      const c = { size: 'Moyenne', align: 'Gauche', line: true, ...(w.config || {}) };
      const cls = { Petite: 's', Moyenne: 'm', Grande: 'l' }[c.size] || 'm';
      const al = { Gauche: 'left', Centre: 'center', Droite: 'right' }[c.align] || 'left';
      return `<div class="tbar tsz-${cls} ${c.line ? 'tbar-line' : ''}" style="text-align:${al}">
        <div class="tbar-t">${c.icon ? `<span class="tbar-i">${esc(c.icon)}</span>` : ''}${esc(w.title)}</div>
        ${c.subtitle ? `<div class="tbar-s">${esc(c.subtitle)}</div>` : ''}</div>`;
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
          const r = await api(`/widgets/${pageOf(w)}/${w.id}/note`, { method: 'PUT', body: { content } });
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
      const layout = cfg.layout || 'Complète';
      const dayName = (x, i) => i === 0 ? 'Auj.' : esc(new Date(x.date + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short' }));
      const clockTxt = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const sub = `ressenti ${Math.round(c.feels)}° · 💧 ${c.humidity} % · 💨 ${Math.round(c.wind)} km/h`;
      const today = d.days?.[0];
      const minmax = today ? `<span class="wx-mm"><b style="color:${tempColor(today.max)}">↑ ${Math.round(today.max)}°</b> <span style="color:${tempColor(today.min)}">↓ ${Math.round(today.min)}°</span>${today.rain ? ` · 💧 ${today.rain} %` : ''}</span>` : '';
      const dayCols = n => `<div class="wx-cols">${(d.days || []).slice(0, n).map((x, i) => `
        <div class="wx-col" title="${esc(x.label)}${x.rain != null ? ` · pluie ${x.rain} %` : ''}">
          <span class="wx-ht">${dayName(x, i)}</span>${wxIcon(x.kind, true, 26)}
          <span><b>${Math.round(x.max)}°</b> <span class="muted">${Math.round(x.min)}°</span></span>
        </div>`).join('')}</div>`;
      const hourChips = () => `<div class="wx-hours wx-hours-s">${(d.hours || []).map(h => `
        <div class="wx-h" title="${esc(h.label)}${h.rain != null ? ` · pluie ${h.rain} %` : ''}">
          <span class="wx-ht">${esc(h.time.slice(0, 2))}h</span>${wxIcon(h.kind, h.day, 22)}<b>${Math.round(h.temp)}°</b>
          ${h.rain ? `<span class="wx-hr">${h.rain}%</span>` : '<span class="wx-hr"></span>'}
        </div>`).join('')}</div>`;

      if (layout === 'Mini') {
        return `<div class="wx-mini">${wxIcon(c.kind, c.day, 46)}
          <div class="wx-mini-t"><span class="wx-mini-deg">${Math.round(c.temp)}°</span>
          <div class="wx-mini-txt"><span>${esc(c.label)}</span>${minmax}</div></div>
          ${cfg.showClock !== false ? `<span class="wx-clock wx-clock-s">${clockTxt}</span>` : ''}</div>`;
      }
      if (layout === 'Bandeau') {
        return `<div class="wx-band">
          <div class="wx-band-now">${wxIcon(c.kind, c.day, 46)}
            <div><div class="wx-mini-deg">${Math.round(c.temp)}°</div><div class="small muted">${esc(c.label)}</div></div></div>
          ${cfg.showDaily !== false ? dayCols(Math.min(7, cfg.days || 5)) : cfg.showHourly !== false ? hourChips() : ''}
        </div>`;
      }
      if (layout === 'Compacte') {
        return `<div class="wx-cmp">
          <div class="wx-cmp-head">${wxIcon(c.kind, c.day, 52)}
            <div class="wx-cmp-main"><div><span class="wx-mini-deg">${Math.round(c.temp)}°</span> <span>${esc(c.label)}</span></div>
              <div class="wx-sub">${esc(d.city || '')}${d.city ? ' · ' : ''}${sub}</div></div>
            ${cfg.showClock !== false ? `<div class="wx-cmp-clock"><span class="wx-clock wx-clock-s">${clockTxt}</span><span class="small muted">${esc(now.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }))}</span></div>` : ''}
          </div>
          ${cfg.showHourly !== false && d.hours?.length ? hourChips() : ''}
          ${cfg.showDaily !== false && d.days?.length ? dayCols(cfg.days || 5) : ''}
        </div>`;
      }
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
      case 'mode': {
        // auto → clair → sombre → auto ; revenir au réglage par défaut efface le choix de l'appareil
        const order = ['auto', 'clair', 'sombre'];
        const next = order[(order.indexOf(currentMode()) + 1) % 3];
        localStorageSet('hd_mode', next === (S.session.themeMode || 'auto') ? '' : next);
        applyMode();
        t.innerHTML = MODE_ICON[currentMode()];
        t.title = `Mode : ${MODE_LABEL[currentMode()]}${deviceMode() ? ' (cet appareil)' : ''} — cliquer pour changer`;
        toast(`Mode ${MODE_LABEL[currentMode()].toLowerCase()}${deviceMode() ? ' sur cet appareil' : ''}`);
        break;
      }
      case 'add-tab': e.stopPropagation(); editTab(null); break;
      case 'edit-tab': e.stopPropagation(); editTab(page()); break;
      case 'place': {
        const pg = page();
        pg.free = t.dataset.free === '1';
        if (!pg.free) pg.widgets.forEach(w => { delete w.anchor; });
        await savePages(false);
        renderApp();
        break;
      }
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
    else if (Number(e.target.value) === -1) w.h = -1;
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
      <label>Icône (emoji, optionnel)<input name="icon" value="${esc(pg?.icon || '')}" maxlength="8" placeholder="🏠"></label></div>
      ${pg ? '' : `<label>Contenu de départ<select name="tpl">
        <option value="">Onglet vide</option>
        <option value="reader">Lecteur RSS (FreshRSS) en pleine page</option>
      </select></label>
      <div class="help" data-tplhelp hidden>${(() => {
        const n = S.integrations.filter(i => S.meta.integrations[i.type]?.provides.includes('reader')).length;
        return n ? 'Le lecteur sera branché sur ta première intégration FreshRSS (modifiable avec ⚙).' : 'Aucune intégration FreshRSS pour l\'instant : ajoute-la dans ⚙ Administration → Intégrations, puis choisis-la dans le ⚙ du lecteur.';
      })()}</div>`}</form>`,
    footer: `${pg ? '<button class="btn danger" data-del style="margin-right:auto">Supprimer l\'onglet</button>' : ''}
      <button class="btn" data-close2>Annuler</button><button class="btn primary" data-ok>Enregistrer</button>`
  });
  $('[data-close2]', m.el).onclick = m.close;
  const tpl = $('[name=tpl]', m.el);
  tpl?.addEventListener('change', () => {
    $('[data-tplhelp]', m.el).hidden = !tpl.value;
    const n = $('[name=name]', m.el), ic = $('[name=icon]', m.el);
    if (tpl.value === 'reader') { if (!n.value.trim()) n.value = 'Lecture'; if (!ic.value.trim()) ic.value = '📖'; }
  });
  $('[data-ok]', m.el).onclick = () => {
    const f = Object.fromEntries(new FormData($('#tabForm', m.el)));
    if (!f.name.trim()) return;
    if (pg) Object.assign(pg, { name: f.name.trim(), icon: f.icon.trim() });
    else {
      const np = { id: uid(), name: f.name.trim(), icon: f.icon.trim(), widgets: [] };
      if (f.tpl === 'reader') {
        const d = S.meta.widgets.reader;
        const src = S.integrations.find(i => i.type === 'freshrss') || S.integrations.find(i => S.meta.integrations[i.type]?.provides.includes('reader'));
        np.widgets.push({
          id: uid(), type: 'reader', title: 'Lecteur RSS', w: 12, x: 0, y: 0, refresh: d.refresh, integrations: src ? [src.id] : [],
          config: Object.fromEntries((d.options || []).filter(o => o.default !== undefined).map(o => [o.key, o.default]))
        });
      }
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
        <label>Hauteur en px (0 = automatique, -1 = aligner)<input type="number" name="h" min="-1" step="10" value="${Number(w.h) || 0}"></label>
        ${orig.id ? `<label>Onglet<select name="tab">${S.dash.pages.map(pg => `<option value="${pg.id}" ${pg.id === page().id ? 'selected' : ''}>${esc(pg.icon || '')} ${esc(pg.name)}</option>`).join('')}</select></label>` : '<div></div>'}
      </div>
      <label class="chk"><input type="checkbox" name="hideMobile" ${w.hideMobile ? 'checked' : ''}> Masquer sur téléphone (écran de moins de 760 px)</label>
      ${orig.id ? `<label>Aligner le haut sur
        <select name="anchor">
          <option value="">— position libre —</option>
          ${page().widgets.filter(x => x.id !== w.id).map(x => `
            <option value="${x.id}:top" ${w.anchor?.id === x.id && w.anchor.edge === 'top' ? 'selected' : ''}>le haut de « ${esc(x.title)} »</option>
            <option value="${x.id}:bottom" ${w.anchor?.id === x.id && w.anchor.edge === 'bottom' ? 'selected' : ''}>le bas de « ${esc(x.title)} »</option>`).join('')}
        </select></label>
      <div class="help">Le widget suit l'autre quand il bouge ou change de taille. Active le placement « Libre » de l'onglet (il s'active tout seul si besoin).</div>` : ''}
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
    w.hideMobile = fd.get('hideMobile') === 'on';
    const anc = String(fd.get('anchor') || '');
    if (anc) { const [id, edge] = anc.split(':'); w.anchor = { id, edge }; } else delete w.anchor;
    if (w.anchor && !page().free) { page().free = true; toast('Placement « Libre » activé pour cet onglet'); }
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
      delete w.x; delete w.y; delete w.anchor;
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
  const m = modal({ title: 'Administration', wide: true, body: '<div class="pills"><button class="btn" data-pill="int">🔌 Intégrations</button><button class="btn" data-pill="theme">🎨 Apparence</button><button class="btn" data-pill="set">⚙ Paramètres</button></div><div id="admBody"></div>' });
  const show = t => {
    $$('[data-pill]', m.el).forEach(b => b.classList.toggle('on', b.dataset.pill === t));
    ({ int: adminIntegrations, theme: adminTheme, set: adminSettings })[t]($('#admBody', m.el), m);
  };
  m.el.addEventListener('click', e => { const p = e.target.closest('[data-pill]'); if (p) show(p.dataset.pill); });
  show(tab);
}

function adminTheme(box) {
  const th = { mode: 'auto', dark: 'Ardoise', light: 'Clair', accentDark: '', accentLight: '', css: '', ...(S.dash.settings.theme || {}) };
  const P = S.meta.themes;
  const sw = (kind, name, p) => `<button type="button" class="theme-sw ${th[kind] === name ? 'on' : ''}" data-sw="${kind}" data-name="${esc(name)}">
      <span class="pv" style="background:${p.bg}"><i style="background:${p.card}"></i><i style="background:${p.card}"></i><i style="background:${p.accent};flex:.35"></i></span>
      <span class="nm">${esc(name)}</span></button>`;
  const accent = (kind, def) => `<div class="accent-row">
      <label class="chk" style="margin:0"><input type="checkbox" data-acc-on="${kind}" ${th[kind] ? 'checked' : ''}> Couleur d'accent personnalisée</label>
      <input type="color" data-acc="${kind}" value="${esc(th[kind] || def)}" ${th[kind] ? '' : 'disabled'}></div>`;
  box.innerHTML = `
    <form class="form" id="themeForm">
      <label>Mode par défaut
        <select name="mode">${Object.entries(MODE_LABEL).map(([k, v]) => `<option value="${k}" ${th.mode === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <div class="help">Le bouton ${MODE_ICON.auto} de l'en-tête change le mode sur un seul appareil, sans toucher à ce réglage.</div>
      <div class="section-lbl">Thème sombre</div>
      <div class="theme-grid">${Object.entries(P.dark).map(([n, p]) => sw('dark', n, p)).join('')}</div>
      ${accent('accentDark', P.dark[th.dark]?.accent || '#6ee2ff')}
      <div class="section-lbl">Thème clair</div>
      <div class="theme-grid">${Object.entries(P.light).map(([n, p]) => sw('light', n, p)).join('')}</div>
      ${accent('accentLight', P.light[th.light]?.accent || '#0a84c6')}
      <div class="section-lbl">CSS personnalisé</div>
      <div class="help">Ce CSS est ajouté après le thème, sur toutes les pages. Variables disponibles :
        <code>--bg --bg2 --card --card-h --line --text --muted --accent --ok --warn --bad --radius --font</code>.
        Cible un mode avec <code>:root.th-dark</code> ou <code>:root.th-light</code>.</div>
      <textarea class="input css-edit" name="css" spellcheck="false" placeholder="/* Exemple */
:root.th-dark { --bg: #101418; --accent: #ff79c6; }
.widget { border-radius: 18px; }
.greet h1 { font-size: 40px; }">${esc(th.css)}</textarea>
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <button class="btn" type="button" data-theme-reset>Thème par défaut</button>
        <button class="btn primary">Enregistrer</button>
      </div>
    </form>`;
  const f = $('#themeForm', box);
  f.addEventListener('click', e => {
    const b = e.target.closest('[data-sw]');
    if (!b) return;
    th[b.dataset.sw] = b.dataset.name;
    $$(`[data-sw="${b.dataset.sw}"]`, f).forEach(x => x.classList.toggle('on', x === b));
    const kind = b.dataset.sw === 'dark' ? 'accentDark' : 'accentLight';
    const inp = $(`[data-acc="${kind}"]`, f);
    if (inp.disabled) inp.value = P[b.dataset.sw][b.dataset.name].accent;
  });
  $$('[data-acc-on]', f).forEach(c => c.addEventListener('change', () => { $(`[data-acc="${c.dataset.accOn}"]`, f).disabled = !c.checked; }));
  const save = async theme => {
    try {
      const r = await api('/settings', { method: 'PUT', body: { theme } });
      S.dash.settings = r.settings;
      S.session.themeMode = r.settings.theme.mode;
      localStorageSet('hd_mode_default', S.session.themeMode);
      reloadThemeCss();
      applyMode();
      toast('Apparence enregistrée ✓');
      renderApp();
      adminTheme(box);
    } catch (err) { toast(err.message, true); }
  };
  $('[data-theme-reset]', f).onclick = () => { if (confirm('Revenir au thème par défaut ? Le CSS personnalisé sera effacé.')) save({}); };
  f.onsubmit = e => {
    e.preventDefault();
    const acc = k => ($(`[data-acc-on="${k}"]`, f).checked ? $(`[data-acc="${k}"]`, f).value : '');
    save({ mode: f.mode.value, dark: th.dark, light: th.light, accentDark: acc('accentDark'), accentLight: acc('accentLight'), css: f.css.value });
  };
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
      <div class="row2">
        <label>Session sans « Rester connecté » (heures)<input type="number" name="sessionHours" min="1" value="${st.sessionHours || 168}"></label>
        <label>Durée de « Rester connecté » (jours)<input type="number" name="rememberDays" min="1" max="365" value="${st.rememberDays || 30}"></label>
      </div>
      <div style="display:flex;justify-content:flex-end"><button class="btn primary">Enregistrer</button></div>
    </form>
    <div class="muted small" style="margin-top:14px">Version : <b class="mono">${esc(S.session.version || '?')}</b></div>
    <div class="section-lbl" style="margin-top:22px">Mot de passe</div>
    <form class="form" id="pwForm"><div class="row2">
      <label>Actuel<span class="pw-wrap"><input type="password" name="current" autocomplete="current-password">${PW_EYE}</span></label>
      <label>Nouveau (8 caractères min.)<span class="pw-wrap"><input type="password" name="next" autocomplete="new-password" minlength="8">${PW_EYE}</span></label></div>
      <div class="help">Changer le mot de passe déconnecte tous tes autres appareils.</div>
      <div style="display:flex;justify-content:space-between"><button class="btn danger" type="button" data-logout>Se déconnecter</button><button class="btn">Changer le mot de passe</button></div>
    </form>`;
  $('#setForm', box).onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('/settings', { method: 'PUT', body: { title: f.title.value, greeting: f.greeting.checked, publicView: f.publicView.checked, sessionHours: f.sessionHours.value, rememberDays: f.rememberDays.value } });
      S.dash.settings = r.settings; S.session.title = r.settings.title; document.title = r.settings.title;
      toast('Paramètres enregistrés ✓');
      renderApp();
    } catch (err) { toast(err.message, true); }
  };
  bindPwEyes(box);
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
