// Stockage : un fichier JSON (data/config.json) écrit de façon atomique.
// Les secrets des intégrations sont chiffrés en AES-256-GCM avec une clé
// fournie par SECRET_KEY ou générée dans data/.secret_key au premier lancement.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const KEY_FILE = path.join(DATA_DIR, '.secret_key');

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadKey() {
  if (process.env.SECRET_KEY) {
    return crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  }
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}

export function decrypt(str) {
  if (!str) return {};
  try {
    const [iv, tag, enc] = str.split('.').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
  } catch {
    console.warn('[store] Impossible de déchiffrer un secret (clé changée ?)');
    return {};
  }
}

export const id = () => crypto.randomBytes(6).toString('hex');

const DEFAULT = {
  version: 1,
  settings: { title: 'Mon dashboard', publicView: false, greeting: true, sessionHours: 168 },
  auth: null,
  integrations: [],
  pages: []
};

let state;
export function load() {
  if (!state) {
    state = fs.existsSync(CONFIG_FILE)
      ? { ...structuredClone(DEFAULT), ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
      : structuredClone(DEFAULT);
    // ancien nom par défaut du site
    if (state.settings.title === 'HomeDash') state.settings.title = 'Mon dashboard';
  }
  return state;
}

export function save() {
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
}

export function isFresh() {
  return !fs.existsSync(CONFIG_FILE);
}

// Intégration avec ses secrets déchiffrés (usage serveur uniquement)
export function getIntegration(intId) {
  const it = load().integrations.find(i => i.id === intId);
  if (!it) return null;
  return { ...it, config: { ...it.config, ...decrypt(it.secret) } };
}

export function findWidget(pageId, widgetId) {
  const page = load().pages.find(p => p.id === pageId);
  return page?.widgets.find(w => w.id === widgetId) || null;
}
