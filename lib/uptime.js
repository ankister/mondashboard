// Surveillance de disponibilité : vérifie en tâche de fond les services listés dans les widgets
// « Disponibilité » (HTTP(S) ou port TCP), garde 24 h de mesures et 90 jours de taux de disponibilité,
// et la date d'expiration des certificats HTTPS. Historique conservé dans data/uptime.json.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { ping } from './http.js';
import { load } from './store.js';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const FILE = path.join(DATA_DIR, 'uptime.json');
const DAY = 864e5;

// clé (adresse normalisée) → { samples: [[tSec, ms | -1, code]], days: { 'AAAA-MM-JJ': [ok, total] }, last, since, cert }
let db = {};
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = {}; }
let dirty = false;

function persist() {
  if (!dirty) return;
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(FILE + '.tmp', FILE);
    dirty = false;
  } catch (e) { console.error('Disponibilité : sauvegarde impossible', e.message); }
}
setInterval(persist, 120e3).unref();
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { persist(); process.exit(0); });

// « https://… », « http://… » ou « hôte:port » (TCP)
export function parseTarget(addr) {
  const a = String(addr || '').trim();
  if (/^https?:\/\/[^\s/]+/i.test(a)) return { kind: 'http', url: a, key: a.toLowerCase().replace(/\/+$/, '') };
  const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(a);
  if (m && Number(m[2]) > 0 && Number(m[2]) < 65536) return { kind: 'tcp', host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]), key: `tcp://${a.toLowerCase()}` };
  return null;
}

function tcpProbe(host, port, timeout) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const done = (ok, error) => { s.destroy(); resolve({ online: ok, ms: Date.now() - t0, status: 0, error }); };
    s.setTimeout(timeout, () => done(false, 'délai dépassé'));
    s.once('connect', () => done(true));
    s.once('error', e => done(false, e.code || e.message));
  });
}

async function probe(t, timeout) {
  return t.kind === 'http' ? ping(t.url, { timeout }) : tcpProbe(t.host, t.port, timeout);
}

function certInfo(url) {
  return new Promise(resolve => {
    let u; try { u = new URL(url); } catch { return resolve(null); }
    if (u.protocol !== 'https:') return resolve(null);
    const s = tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: /^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false });
    const end = v => { s.destroy(); resolve(v); };
    s.setTimeout(8000, () => end(null));
    s.once('secureConnect', () => {
      const c = s.getPeerCertificate();
      end(c?.valid_to ? { until: Date.parse(c.valid_to), issuer: c.issuer?.O || c.issuer?.CN || '', selfSigned: !s.authorized } : null);
    });
    s.once('error', () => end(null));
  });
}

const dayKey = ms => new Date(ms).toISOString().slice(0, 10);

function record(key, r) {
  const e = db[key] ||= { samples: [], days: {} };
  const now = Date.now();
  e.samples.push([Math.round(now / 1000), r.online ? r.ms : -1, r.status || 0]);
  const cut = (now - DAY) / 1000;
  while (e.samples.length && e.samples[0][0] < cut) e.samples.shift();
  const d = e.days[dayKey(now)] ||= [0, 0];
  d[1]++; if (r.online) d[0]++;
  const keys = Object.keys(e.days);
  if (keys.length > 90) for (const k of keys.sort().slice(0, keys.length - 90)) delete e.days[k];
  if (!e.last || e.last.ok !== r.online) e.since = now;
  e.last = { t: now, ok: r.online, ms: r.ms, code: r.status || 0, err: r.online ? '' : (r.error || (r.status ? `HTTP ${r.status}` : 'injoignable')) };
  dirty = true;
}

const running = new Map(); // clé → promesse de la vérification en cours
function check(t) {
  if (!running.has(t.key)) running.set(t.key, doCheck(t).finally(() => running.delete(t.key)));
  return running.get(t.key);
}
async function doCheck(t) {
  {
    let r = await probe(t, 10000);
    if (!r.online) { await new Promise(res => setTimeout(res, 3000)); r = await probe(t, 10000); } // une seconde chance avant de déclarer la panne
    record(t.key, r);
    const e = db[t.key];
    if (t.kind === 'http' && /^https:/i.test(t.url) && (!e.cert || Date.now() - (e.cert.at || 0) > 6 * 3600e3)) {
      const c = await certInfo(t.url);
      e.cert = { ...(c || {}), at: Date.now() };
    }
  }
}

// cibles de tous les widgets « Disponibilité » : intervalle le plus court si une cible est dans plusieurs widgets
function targets() {
  const out = new Map();
  for (const p of load().pages || []) {
    for (const w of p.widgets || []) {
      if (w.type !== 'uptime') continue;
      const every = Math.max(20, Number(w.config?.interval) || 60) * 1000;
      for (const x of w.config?.targets || []) {
        const t = parseTarget(x.url);
        if (!t) continue;
        const cur = out.get(t.key);
        if (!cur || every < cur.every) out.set(t.key, { ...t, every });
      }
    }
  }
  return out;
}

const lastRun = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, t] of targets()) {
    if (now - (lastRun.get(key) || 0) < t.every) continue;
    lastRun.set(key, now);
    check(t).catch(() => {});
  }
}, 5000).unref();

// données d'un widget
export async function uptimeData(cfg) {
  const list = (cfg.targets || []).map(x => ({ ...x, t: parseTarget(x.url) })).filter(x => x.t);
  // première mesure immédiate pour une cible jamais vérifiée
  // (attente limitée à 4 s : un service injoignable sera affiché au rafraîchissement suivant)
  const first = list.filter(x => !db[x.t.key]?.last).map(x => { lastRun.set(x.t.key, Date.now()); return check(x.t).catch(() => {}); });
  if (first.length) await Promise.race([Promise.all(first), new Promise(r => setTimeout(r, 4000))]);
  const now = Date.now();
  const nb = Math.min(96, Math.max(12, Number(cfg.buckets) || 48));
  const size = DAY / nb;
  return {
    slowMs: Math.max(50, Number(cfg.slowMs) || 1000),
    targets: list.map(x => {
      const e = db[x.t.key] || { samples: [], days: {} };
      const s = e.samples;
      const ok = s.filter(v => v[1] >= 0);
      const buckets = Array.from({ length: nb }, () => [0, 0, 0]); // [ok, total, somme ms]
      for (const [ts, ms] of s) {
        const i = Math.floor((ts * 1000 - (now - DAY)) / size);
        if (i < 0 || i >= nb) continue;
        buckets[i][1]++;
        if (ms >= 0) { buckets[i][0]++; buckets[i][2] += ms; }
      }
      const sumDays = n => {
        let a = 0, b = 0;
        for (let i = 0; i < n; i++) { const d = e.days[dayKey(now - i * DAY)]; if (d) { a += d[0]; b += d[1]; } }
        return b ? a / b * 100 : null;
      };
      return {
        id: x.id, name: x.name || x.url, url: x.url, kind: x.t.kind,
        up: e.last ? e.last.ok : null, ms: e.last?.ms ?? null, code: e.last?.code || 0, error: e.last?.err || '',
        checked: e.last?.t || null, since: e.since || null,
        uptime24: s.length ? ok.length / s.length * 100 : null, uptime7: sumDays(7), uptime30: sumDays(30),
        avgMs: ok.length ? Math.round(ok.reduce((a, v) => a + v[1], 0) / ok.length) : null,
        buckets: buckets.map(([a, b, m]) => (b ? [Math.round(a / b * 100), a ? Math.round(m / a) : null] : null)),
        spark: s.slice(-60).map(v => v[1]),
        cert: e.cert?.until ? { days: Math.floor((e.cert.until - now) / DAY), issuer: e.cert.issuer, selfSigned: !!e.cert.selfSigned } : null
      };
    })
  };
}
