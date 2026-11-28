// rest-server (serveur de dépôts restic) : pour chaque dépôt, nombre de snapshots, taille des données,
// sauvegarde en cours (verrou présent). Les snapshots sont chiffrés et le serveur ne donne pas leur date :
// l'heure de la dernière sauvegarde est celle où un nouveau snapshot a été vu (à l'intervalle de rafraîchissement près).
import fs from 'node:fs';
import path from 'node:path';
import { request, joinUrl } from '../http.js';

const V2 = 'application/vnd.x.restic.rest.v2';
const SEEN_FILE = path.join(process.env.DATA_DIR || path.resolve('data'), 'backup-seen.json');
// dépôt → { names: { nomSnapshot: vuLe }, first: date du premier passage }
let seen = {};
try { seen = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { seen = {}; }
const saveSeen = () => { try { fs.writeFileSync(SEEN_FILE + '.tmp', JSON.stringify(seen)); fs.renameSync(SEEN_FILE + '.tmp', SEEN_FILE); } catch { /* best effort */ } };
const sizeCache = new Map(); // dépôt → { at, bytes }

async function list(c, repo, type) {
  const res = await request(joinUrl(c.url, `/${repo}/${type}/`), {
    insecure: !!c.insecure, timeout: 30000, headers: { Accept: V2 },
    basicAuth: c.username ? { username: c.username, password: c.password } : undefined
  });
  if (res.status === 401 || res.status === 403) throw new Error(`accès refusé au dépôt « ${repo} »`);
  if (res.status === 404) throw new Error(`dépôt « ${repo} » introuvable`);
  if (!res.ok) throw new Error(`rest-server a répondu ${res.status} pour « ${repo} »`);
  const j = await res.json();
  return Array.isArray(j) ? j.map(x => (typeof x === 'string' ? { name: x, size: 0 } : x)) : [];
}

const repoList = c => String(c.repos || c.username || '').split(/[\s,]+/).map(r => r.trim().replace(/^\/+|\/+$/g, '')).filter(r => /^[\w.\-/]{1,200}$/.test(r) && !r.includes('..'));

export default {
  label: 'rest-server (restic)',
  help: 'URL du rest-server et un utilisateur du fichier .htpasswd. Indique les dépôts à suivre (chemins après l\'URL, ex. « antoine/nas antoine/pc ») ; vide = le dépôt portant le nom de l\'utilisateur (--private-repos). L\'heure de la dernière sauvegarde est déduite de l\'apparition des nouveaux snapshots.',
  provides: ['backup'],
  fields: [
    { key: 'url', label: 'URL du rest-server', placeholder: 'http://192.168.1.2:8000', required: true },
    { key: 'username', label: 'Utilisateur (.htpasswd)' },
    { key: 'password', label: 'Mot de passe', type: 'password', secret: true },
    { key: 'repos', label: 'Dépôts à suivre (séparés par des espaces)', placeholder: 'antoine/nas antoine/pc' },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],

  async test(c) {
    const repos = repoList(c);
    if (!repos.length) throw new Error('Indique au moins un dépôt (ou l\'utilisateur, avec --private-repos)');
    const out = await Promise.all(repos.map(async r => `${r} : ${(await list(c, r, 'snapshots')).length} snapshot(s)`));
    return `rest-server joignable · ${out.join(' · ')}`;
  },

  async fetch(_k, c, _w, integration) {
    const now = Date.now();
    let dirty = false;
    const items = await Promise.all(repoList(c).map(async repo => {
      const key = `${integration.id}|${repo}`;
      const base = { integrationId: integration.id, source: 'rest-server', instance: integration.name, id: repo, name: repo.split('/').pop(), repo, repoUri: repo, approx: true, canRun: false };
      try {
        const [snaps, locks] = await Promise.all([list(c, repo, 'snapshots'), list(c, repo, 'locks').catch(() => [])]);
        const s = seen[key] ||= { first: now, names: {} };
        const names = new Set(snaps.map(x => x.name));
        for (const nm of names) if (!s.names[nm]) { s.names[nm] = s.first === now ? 0 : now; dirty = true; } // 0 = déjà là au premier passage
        for (const nm of Object.keys(s.names)) if (!names.has(nm)) { delete s.names[nm]; dirty = true; }
        const times = Object.values(s.names).filter(Boolean).sort((a, b) => a - b);
        // taille des données (liste potentiellement longue) : au plus toutes les 30 min
        let sz = sizeCache.get(key);
        if (!sz || now - sz.at > 30 * 60e3) {
          const data = await list(c, repo, 'data').catch(() => null);
          if (data) { sz = { at: now, bytes: data.reduce((a, x) => a + (Number(x.size) || 0), 0) }; sizeCache.set(key, sz); }
        }
        return {
          ...base, status: locks.length ? 'running' : snaps.length ? 'ok' : 'unknown',
          last: times.at(-1) || null, lastOk: times.at(-1) || null, since: s.first,
          snapshots: snaps.length, size: sz?.bytes ?? null, locks: locks.length,
          recent: times.slice(-20).map(t => ({ t, status: 'ok' })), history: [], counts: null
        };
      } catch (e) {
        return { ...base, status: 'error', error: e.message, last: null, snapshots: null, recent: [], history: [] };
      }
    }));
    if (dirty) saveSeen();
    return { items };
  }
};
