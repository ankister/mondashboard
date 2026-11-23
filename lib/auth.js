// Authentification admin : mot de passe haché en scrypt, cookie HttpOnly aléatoire,
// limitation des tentatives de connexion. Les sessions sont gardées dans data/sessions.json
// (empreinte SHA-256 du jeton, jamais le jeton lui-même) pour survivre aux redémarrages.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { load, save } from './store.js';

const SESSIONS_FILE = path.join(process.env.DATA_DIR || path.resolve('data'), 'sessions.json');
const digest = t => crypto.createHash('sha256').update(t).digest('hex');
const sessions = new Map(); // empreinte -> { user, expires, remember }
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')))) {
    if (v && v.expires > Date.now()) sessions.set(k, v);
  }
} catch { /* pas encore de sessions */ }
function persist() {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
  try {
    const tmp = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (e) { console.error('Sessions non enregistrées :', e.message); }
}
const attempts = new Map(); // ip -> { count, until }

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verify(password, { salt, hash }) {
  const h = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

export function currentUser(req) {
  const token = parseCookies(req).hd_session;
  const key = token && digest(token);
  const s = key && sessions.get(key);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(key); persist(); return null; }
  return s.user;
}

// maxAgeSec = null : cookie de session, effacé à la fermeture du navigateur
function setCookie(req, res, token, maxAgeSec) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `hd_session=${token}; Path=/; HttpOnly; SameSite=Strict${maxAgeSec === null ? '' : `; Max-Age=${maxAgeSec}`}${secure ? '; Secure' : ''}`);
}

export function setup(req, res) {
  const st = load();
  if (st.auth) return res.status(409).json({ error: 'Compte déjà créé' });
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Identifiant requis et mot de passe de 8 caractères minimum' });
  }
  st.auth = { username, ...hashPassword(password) };
  save();
  startSession(req, res, username, !!req.body.remember);
  res.json({ ok: true });
}

// « Rester connecté » : cookie persistant (rememberDays, 30 j par défaut).
// Sinon : cookie effacé à la fermeture du navigateur, et session limitée à sessionHours.
function startSession(req, res, user, remember) {
  const token = crypto.randomBytes(32).toString('hex');
  const st = load().settings;
  const sec = remember ? (st.rememberDays || 30) * 86400 : (st.sessionHours || 168) * 3600;
  sessions.set(digest(token), { user, expires: Date.now() + sec * 1000, remember });
  persist();
  setCookie(req, res, token, remember ? sec : null);
}

export function login(req, res) {
  const ip = req.ip;
  const a = attempts.get(ip);
  if (a && a.until > Date.now()) {
    return res.status(429).json({ error: 'Trop de tentatives, réessaie dans quelques minutes' });
  }
  const st = load();
  const { username, password } = req.body || {};
  if (st.auth && username === st.auth.username && password && verify(password, st.auth)) {
    attempts.delete(ip);
    startSession(req, res, username, !!req.body.remember);
    return res.json({ ok: true });
  }
  const n = (a?.count || 0) + 1;
  attempts.set(ip, { count: n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
  res.status(401).json({ error: 'Identifiants incorrects' });
}

export function logout(req, res) {
  const token = parseCookies(req).hd_session;
  if (token) { sessions.delete(digest(token)); persist(); }
  setCookie(req, res, '', 0);
  res.json({ ok: true });
}

export function changePassword(req, res) {
  const st = load();
  const { current, next } = req.body || {};
  if (!current || !verify(current, st.auth)) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  if (!next || next.length < 8) return res.status(400).json({ error: '8 caractères minimum' });
  st.auth = { username: st.auth.username, ...hashPassword(next) };
  save();
  // nouveau mot de passe : déconnecte tous les autres appareils
  const mine = digest(parseCookies(req).hd_session || '');
  for (const k of [...sessions.keys()]) if (k !== mine) sessions.delete(k);
  persist();
  res.json({ ok: true });
}

export const requireAdmin = (req, res, next) =>
  currentUser(req) ? next() : res.status(401).json({ error: 'Connexion requise' });

export const requireView = (req, res, next) =>
  (load().settings.publicView || currentUser(req)) ? next() : res.status(401).json({ error: 'Connexion requise' });
