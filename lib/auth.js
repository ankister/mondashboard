// Authentification admin : mot de passe haché en scrypt, sessions en mémoire
// via cookie HttpOnly signé aléatoire, limitation des tentatives de connexion.
import crypto from 'node:crypto';
import { load, save } from './store.js';

const sessions = new Map(); // token -> { user, expires }
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
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s.user;
}

function setCookie(req, res, token, maxAgeSec) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `hd_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`);
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
  startSession(req, res, username);
  res.json({ ok: true });
}

function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const hours = load().settings.sessionHours || 168;
  sessions.set(token, { user, expires: Date.now() + hours * 3600e3 });
  setCookie(req, res, token, hours * 3600);
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
    startSession(req, res, username);
    return res.json({ ok: true });
  }
  const n = (a?.count || 0) + 1;
  attempts.set(ip, { count: n, until: n >= 5 ? Date.now() + 5 * 60e3 : 0 });
  res.status(401).json({ error: 'Identifiants incorrects' });
}

export function logout(req, res) {
  const token = parseCookies(req).hd_session;
  if (token) sessions.delete(token);
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
  res.json({ ok: true });
}

export const requireAdmin = (req, res, next) =>
  currentUser(req) ? next() : res.status(401).json({ error: 'Connexion requise' });

export const requireView = (req, res, next) =>
  (load().settings.publicView || currentUser(req)) ? next() : res.status(401).json({ error: 'Connexion requise' });
