// Client HTTP commun à toutes les intégrations : timeout, auth basique,
// certificats auto-signés optionnels (fréquents en auto-hébergement).
import { fetch, Agent, EnvHttpProxyAgent } from 'undici';

// Respecte HTTP(S)_PROXY / NO_PROXY s'ils sont définis
const useProxy = !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy);
const insecureAgent = useProxy
  ? new EnvHttpProxyAgent({ connect: { rejectUnauthorized: false } })
  : new Agent({ connect: { rejectUnauthorized: false } });
const secureAgent = useProxy ? new EnvHttpProxyAgent() : new Agent();

export function joinUrl(base, path) {
  return String(base || '').replace(/\/+$/, '') + path;
}

export async function request(url, opts = {}) {
  const {
    method = 'GET', headers = {}, body, timeout = 8000,
    insecure = false, basicAuth, redirect = 'follow'
  } = opts;
  const h = { 'User-Agent': 'HomeDash/1.0', ...headers };
  if (basicAuth && basicAuth.username) {
    h.Authorization = 'Basic ' + Buffer.from(`${basicAuth.username}:${basicAuth.password || ''}`).toString('base64');
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method, headers: h, body, redirect, signal: ctrl.signal,
      dispatcher: insecure ? insecureAgent : secureAgent
    });
    return res;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Délai dépassé (${timeout / 1000}s) : ${url}`);
    const cause = e.cause?.code || e.cause?.message || e.message;
    throw new Error(`Connexion impossible à ${url} (${cause})`);
  } finally {
    clearTimeout(t);
  }
}

export async function getJson(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} sur ${url}${txt ? ' : ' + txt.slice(0, 150) : ''}`);
  }
  return res.json();
}

export async function getText(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} sur ${url}`);
  return res.text();
}

// Ping pour les favoris : en ligne si le serveur répond (même 401/403),
// hors ligne si timeout, refus de connexion ou erreur 5xx.
export async function ping(url, { timeout = 5000, insecure = true } = {}) {
  const start = Date.now();
  try {
    let res = await request(url, { method: 'HEAD', timeout, insecure, redirect: 'manual' });
    if (res.status === 405 || res.status === 501) {
      res = await request(url, { method: 'GET', timeout, insecure, redirect: 'manual' });
    }
    res.body?.cancel?.().catch(() => {});
    const ms = Date.now() - start;
    return { online: res.status < 500, status: res.status, ms };
  } catch (e) {
    return { online: false, status: 0, ms: Date.now() - start, error: e.message };
  }
}
