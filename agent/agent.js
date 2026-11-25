// HomeDash Agent — collecte les métriques d'une machine Linux (Debian, Unraid…)
// et les met à disposition de HomeDash, en mode "pull" (HomeDash l'interroge)
// ou "push" (l'agent envoie ses données à HomeDash, utile hors du réseau local).
// Aucune dépendance externe : Node.js 20+ uniquement (+ smartctl / nvidia-smi si présents).
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const VERSION = '1.2.0';
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const CFG = {
  token: env('HD_TOKEN', ''),
  mode: env('HD_MODE', 'pull'),
  port: Number(env('HD_PORT', 9123)),
  server: env('HD_SERVER', '').replace(/\/+$/, ''),
  id: env('HD_ID', ''),
  insecure: env('HD_INSECURE', '0') === '1',
  root: env('HD_HOST_ROOT', '/host'),
  allowActions: env('HD_ALLOW_DOCKER_ACTIONS', '1') === '1',
  // mises à jour apt lancées depuis Mon dashboard (désactivables ici, et à autoriser aussi dans l'intégration)
  allowSystem: env('HD_ALLOW_SYSTEM_UPDATES', '1') === '1',
  pushInterval: Number(env('HD_PUSH_INTERVAL', 10)),
  smartInterval: Number(env('HD_SMART_INTERVAL', 600)),
  updatesInterval: Number(env('HD_UPDATES_INTERVAL', 3600)),
  imagesInterval: Number(env('HD_IMAGES_INTERVAL', 21600)),
  dockerSock: env('HD_DOCKER_SOCK', '/var/run/docker.sock')
};
if (!CFG.token) {
  // Pas de jeton : on attend sans planter (évite une boucle de redémarrage Docker)
  console.error('HD_TOKEN manquant : renseigne le jeton fourni par Mon dashboard puis recrée le conteneur. En attente…');
  setInterval(() => {}, 3600e3);
  return;
}
if (CFG.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const H = p => path.join(CFG.root, p); // chemin sur l'hôte
const read = p => fsp.readFile(p, 'utf8').catch(() => null);
const exists = p => fs.existsSync(p);
const run = (cmd, args, timeout = 15000) => new Promise(resolve => {
  execFile(cmd, args, { timeout, maxBuffer: 20e6 }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.killed ? 'TIMEOUT' : (typeof err.code === 'number' ? err.code : 'ERR')) : 0, stdout, stderr, missing: err?.code === 'ENOENT' }));
});

// ---------------------------------------------------------------- signature HMAC
const sha = b => crypto.createHash('sha256').update(b || '').digest('hex');
function sign(method, p, body, ts = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', CFG.token).update(`${ts}.${method}.${p}.${sha(body)}`).digest('hex');
  return { ts: String(ts), sig };
}
function verify(req, body) {
  const ts = Number(req.headers['x-hd-time']), sig = String(req.headers['x-hd-sig'] || '');
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 90) return false;
  const exp = sign(req.method, req.url, body, ts).sig;
  return sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
}

// ---------------------------------------------------------------- système
const state = { cpuPrev: null, netPrev: null, cpu: null, net: { rx: 0, tx: 0 }, gpus: [], disks: [], smartAt: null,
  apt: null, unraidPlugins: null, updatesAt: null, imageUpdates: {}, imagesAt: null, staticInfo: null };

async function staticInfo() {
  if (state.staticInfo) return state.staticInfo;
  const osr = (await read(H('/etc/os-release'))) || (await read('/etc/os-release')) || '';
  const pretty = (osr.match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || 'Linux';
  const unraidRaw = await read(H('/etc/unraid-version'));
  const unraid = unraidRaw ? (unraidRaw.match(/version="?([^"\n]+)"?/) || [])[1] : null;
  const cpuinfo = (await read('/proc/cpuinfo')) || '';
  const model = (cpuinfo.match(/^model name\s*:\s*(.+)$/m) || [])[1] || '';
  const hostname = ((await read(H('/etc/hostname'))) || os.hostname()).trim();
  state.staticInfo = { hostname, os: unraid ? `Unraid ${unraid}` : pretty, unraid, kernel: os.release(), cpuModel: model.trim(), cores: os.cpus().length };
  return state.staticInfo;
}

async function sampleCpu() {
  const line = ((await read('/proc/stat')) || '').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = line[3] + (line[4] || 0), total = line.reduce((a, b) => a + b, 0);
  if (state.cpuPrev) {
    const dt = total - state.cpuPrev.total, di = idle - state.cpuPrev.idle;
    state.cpu = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : state.cpu;
  }
  state.cpuPrev = { idle, total };
}

function physicalIface(name) {
  if (/^(lo|veth|docker|br-|virbr|vnet|tun|tap|wg|tailscale|shim|dummy|vhost)/.test(name)) return false;
  return exists(`/sys/class/net/${name}/device`);
}
async function sampleNet() {
  const lines = ((await read('/proc/net/dev')) || '').split('\n').slice(2).filter(Boolean);
  const all = lines.map(l => {
    const [n, rest] = l.split(':');
    const f = rest.trim().split(/\s+/).map(Number);
    return { name: n.trim(), rx: f[0], tx: f[8] };
  });
  let ifs = all.filter(i => physicalIface(i.name));
  if (!ifs.length) ifs = all.filter(i => !/^(lo|veth|docker|br-)/.test(i.name));
  const rx = ifs.reduce((a, i) => a + i.rx, 0), tx = ifs.reduce((a, i) => a + i.tx, 0), t = Date.now();
  if (state.netPrev) {
    const dt = (t - state.netPrev.t) / 1000;
    if (dt > 0) state.net = { rx: Math.max(0, (rx - state.netPrev.rx) / dt), tx: Math.max(0, (tx - state.netPrev.tx) / dt), ifaces: ifs.map(i => i.name) };
  }
  state.netPrev = { rx, tx, t };
}

async function meminfo() {
  const m = {};
  ((await read('/proc/meminfo')) || '').split('\n').forEach(l => {
    const [k, v] = l.split(':');
    if (v) m[k.trim()] = parseInt(v, 10) * 1024;
  });
  const total = m.MemTotal || 0, avail = m.MemAvailable ?? m.MemFree ?? 0;
  return {
    mem: { total, used: total - avail, percent: total ? ((total - avail) / total) * 100 : null },
    swap: m.SwapTotal ? { total: m.SwapTotal, used: m.SwapTotal - (m.SwapFree || 0) } : null
  };
}

async function temps() {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir('/sys/class/hwmon'); } catch { return out; }
  for (const d of dirs) {
    const base = `/sys/class/hwmon/${d}`;
    const name = ((await read(`${base}/name`)) || '').trim();
    if (/nvme|drivetemp|nouveau|amdgpu|iwlwifi/.test(name)) continue;
    let files = [];
    try { files = (await fsp.readdir(base)).filter(f => /^temp\d+_input$/.test(f)); } catch { continue; }
    for (const f of files) {
      const v = parseInt((await read(`${base}/${f}`)) || '', 10) / 1000;
      if (!v || v < 1 || v > 150) continue;
      const label = ((await read(`${base}/${f.replace('_input', '_label')}`)) || '').trim() || name;
      out.push({ label: label === 'Tctl' || label === 'Tdie' || /^Package/.test(label) ? 'CPU' : label, value: v, chip: name });
    }
  }
  // priorité au capteur CPU, puis le reste, sans doublons
  const seen = new Set();
  return out.sort((a, b) => (b.label === 'CPU') - (a.label === 'CPU'))
    .filter(t => (seen.has(t.label) ? false : seen.add(t.label))).slice(0, 4);
}

async function sampleGpu() {
  const r = await run('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], 8000);
  if (r.code !== 0) { state.gpus = []; return; }
  const gpus = r.stdout.trim().split('\n').filter(Boolean).map(l => {
    const [idx, name, util, mu, mt, temp] = l.split(',').map(s => s.trim());
    const n = v => (isNaN(Number(v)) ? null : Number(v));
    return { index: idx, name, util: n(util), memUsed: n(mu) * 1048576, memTotal: n(mt) * 1048576, memPercent: n(mt) ? (n(mu) / n(mt)) * 100 : null, temp: n(temp) };
  });
  const e = await run('nvidia-smi', ['--query-gpu=index,utilization.encoder,utilization.decoder', '--format=csv,noheader,nounits'], 8000);
  if (e.code === 0) {
    e.stdout.trim().split('\n').forEach(l => {
      const [idx, enc, dec] = l.split(',').map(s => s.trim());
      const g = gpus.find(x => x.index === idx);
      if (g) { g.enc = isNaN(Number(enc)) ? null : Number(enc); g.dec = isNaN(Number(dec)) ? null : Number(dec); }
    });
  }
  state.gpus = gpus;
}

// Systèmes de fichiers de l'hôte (lus via la table de montage du PID 1 de l'hôte)
const FS_TYPES = /^(ext[234]|xfs|btrfs|zfs|fuse\.shfs|vfat|f2fs|ntfs3?|exfat)$/;
async function filesystems() {
  const mounts = ((await read('/proc/1/mounts')) || '').split('\n').map(l => l.split(' ')).filter(m => m.length > 3);
  const seen = new Set(), out = [];
  for (const [dev, mnt0, type] of mounts) {
    const mnt = mnt0.replace(/\\040/g, ' ');
    if (!FS_TYPES.test(type) || /^\/(proc|sys|run|dev|var\/lib\/docker|snap|etc)\b/.test(mnt) || mnt.startsWith('/host')) continue;
    if (type === 'vfat' && mnt !== '/boot' && mnt !== '/boot/efi') continue;
    if (type === 'vfat' && mnt === '/boot/efi') continue;
    if (seen.has(dev + type) && type !== 'fuse.shfs') continue;
    seen.add(dev + type);
    try {
      const s = await fsp.statfs(path.join(CFG.root, mnt));
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      if (total < 1e8) continue;
      out.push({ mount: mnt, type, total, used: total - free, percent: total ? ((total - free) / total) * 100 : 0 });
    } catch { /* point de montage non visible dans le conteneur */ }
  }
  return out.slice(0, 24);
}

// ---------------------------------------------------------------- SMART
const smartInflight = new Set();
async function scanSmart() {
  const sc = await run('smartctl', ['--scan-open', '-j'], 30000);
  if (sc.missing) { state.disks = null; return; }
  let devices = [];
  try { devices = JSON.parse(sc.stdout).devices || []; } catch { devices = []; }
  const prev = Object.fromEntries((state.disks || []).map(d => [d.dev, d]));
  const result = [];
  for (const d of devices) {
    if (smartInflight.has(d.name)) {
      result.push({ ...(prev[d.name] || { dev: d.name, name: path.basename(d.name) }), health: 'fail', notes: ['Le disque ne répond plus (requête SMART bloquée)'] });
      continue;
    }
    smartInflight.add(d.name);
    const r = await run('smartctl', ['-a', '-j', '-n', 'standby', '-d', d.type || 'auto', d.name], 30000);
    if (r.code !== 'TIMEOUT') smartInflight.delete(d.name);
    else setTimeout(() => smartInflight.delete(d.name), 3600e3); // nouvel essai dans 1 h
    let j = {};
    try { j = JSON.parse(r.stdout); } catch { /* sortie non JSON */ }
    const exit = j.smartctl?.exit_status ?? (typeof r.code === 'number' ? r.code : 0);
    const name = path.basename(d.name);
    if (r.code === 'TIMEOUT') {
      result.push({ ...(prev[d.name] || {}), dev: d.name, name, health: 'fail', notes: ['Le disque ne répond plus (délai SMART dépassé)'] });
      continue;
    }
    const standby = /STANDBY|SLEEP/i.test(JSON.stringify(j.smartctl?.messages || '')) || (exit & 2 && /standby/i.test(r.stdout + r.stderr));
    if (standby) {
      result.push({ ...(prev[d.name] || { dev: d.name, name, health: 'unknown', notes: [] }), standby: true });
      continue;
    }
    const notes = [];
    let health = 'ok';
    const passed = j.smart_status ? j.smart_status.passed : null;
    if (passed === false) { health = 'fail'; notes.push('SMART : ÉCHEC du test de santé'); }
    const attr = id => j.ata_smart_attributes?.table?.find(a => a.id === id)?.raw?.value ?? 0;
    const realloc = attr(5), pending = attr(197), uncorr = attr(198), crc = attr(199);
    if (realloc > 0) { notes.push(`${realloc} secteur(s) réalloué(s)`); if (health === 'ok') health = 'warn'; }
    if (pending > 0) { notes.push(`${pending} secteur(s) en attente`); if (health === 'ok') health = 'warn'; }
    if (uncorr > 0) { notes.push(`${uncorr} secteur(s) non corrigible(s)`); health = 'fail'; }
    if (crc > 0) notes.push(`${crc} erreur(s) CRC (câble ?)`);
    const nv = j.nvme_smart_health_information_log;
    if (nv) {
      if (nv.critical_warning) { notes.push(`Alerte critique NVMe (${nv.critical_warning})`); health = 'fail'; }
      if (nv.media_errors > 0) { notes.push(`${nv.media_errors} erreur(s) média`); if (health === 'ok') health = 'warn'; }
      if (nv.percentage_used >= 90) { notes.push(`Usure ${nv.percentage_used} %`); if (health === 'ok') health = 'warn'; }
    }
    if (exit & 8 && health === 'ok') { health = 'fail'; notes.push('smartctl signale un disque défaillant'); }
    if (exit & 64) notes.push('Erreurs dans le journal SMART');
    if (j.ata_smart_attributes === undefined && !nv && passed === null) health = 'unknown';
    result.push({
      dev: d.name, name, model: j.model_name || j.model_family || '', serial: j.serial_number || '',
      type: nv ? 'nvme' : (j.rotation_rate === 0 ? 'ssd' : 'hdd'),
      temp: j.temperature?.current ?? nv?.temperature ?? null,
      hours: j.power_on_time?.hours ?? null, wear: nv?.percentage_used ?? null,
      passed, health, notes, standby: false
    });
  }
  state.disks = result;
  state.smartAt = new Date().toISOString();
}

// ---------------------------------------------------------------- mises à jour apt (Debian)
// Compare /var/lib/dpkg/status aux listes /var/lib/apt/lists (mises à jour par apt-daily).
function dpkgOrder(c) {
  if (c === '~') return -1;
  if (/\d/.test(c)) return 0;
  if (!c) return 0;
  if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
  return c.charCodeAt(0) + 256;
}
function verrevcmp(a, b) {
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    let firstDiff = 0;
    while ((i < a.length && !/\d/.test(a[i])) || (j < b.length && !/\d/.test(b[j]))) {
      const ac = dpkgOrder(a[i]), bc = dpkgOrder(b[j]);
      if (ac !== bc) return ac - bc;
      i++; j++;
    }
    while (a[i] === '0') i++;
    while (b[j] === '0') j++;
    while (i < a.length && /\d/.test(a[i]) && j < b.length && /\d/.test(b[j])) {
      if (!firstDiff) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
      i++; j++;
    }
    if (i < a.length && /\d/.test(a[i])) return 1;
    if (j < b.length && /\d/.test(b[j])) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}
function parseVer(v) {
  const m = v.match(/^(?:(\d+):)?(.*?)(?:-([^-]*))?$/);
  return { epoch: Number(m[1] || 0), up: m[2], rev: m[3] || '' };
}
function dpkgCompare(x, y) {
  const a = parseVer(x), b = parseVer(y);
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  return verrevcmp(a.up, b.up) || verrevcmp(a.rev, b.rev);
}
function stanzas(text, fields) {
  const out = [];
  for (const block of text.split(/\n\n+/)) {
    const o = {};
    for (const line of block.split('\n')) {
      const k = line.slice(0, line.indexOf(':'));
      if (fields.includes(k)) o[k] = line.slice(k.length + 1).trim();
    }
    if (o.Package) out.push(o);
  }
  return out;
}
async function aptUpdates() {
  const status = await read(H('/var/lib/dpkg/status'));
  if (!status) return null;
  const installed = new Map();
  for (const s of stanzas(status, ['Package', 'Status', 'Version', 'Architecture'])) {
    if (/ ok installed$/.test(s.Status || '')) installed.set(s.Package, { v: s.Version, arch: s.Architecture, held: /^hold /.test(s.Status) });
  }
  const dir = H('/var/lib/apt/lists');
  let files = [];
  try { files = (await fsp.readdir(dir)).filter(f => /_Packages(\.gz)?$/.test(f) && !/backports|experimental/.test(f)); } catch { return []; }
  const best = new Map();
  for (const f of files) {
    let buf;
    try { buf = await fsp.readFile(path.join(dir, f)); } catch { continue; }
    if (f.endsWith('.gz')) buf = zlib.gunzipSync(buf);
    const security = /security/.test(f);
    for (const p of stanzas(buf.toString('utf8'), ['Package', 'Version', 'Architecture'])) {
      const inst = installed.get(p.Package);
      if (!inst || (p.Architecture !== inst.arch && p.Architecture !== 'all')) continue;
      const cur = best.get(p.Package);
      if (!cur || dpkgCompare(p.Version, cur.v) > 0) best.set(p.Package, { v: p.Version, security });
      else if (cur && dpkgCompare(p.Version, cur.v) === 0 && security) cur.security = true;
    }
  }
  const ups = [];
  for (const [name, b] of best) {
    const inst = installed.get(name);
    if (dpkgCompare(b.v, inst.v) > 0) ups.push({ name, from: inst.v, to: b.v, security: b.security, held: inst.held });
  }
  return ups.sort((a, b) => b.security - a.security || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- mises à jour apt (Debian / Ubuntu)
// L'agent tourne avec --pid host --privileged : nsenter entre dans les espaces de noms de l'hôte
// (PID 1), apt s'exécute donc sur la machine elle-même, pas dans le conteneur.
let aptJob = null; // { op, packages, startedAt, finishedAt, code, log: [] }
const PKG = /^[a-z0-9][a-z0-9+.-]*(:[a-z0-9]+)?$/;
function aptStart(op, packages = []) {
  if (!CFG.allowSystem) throw new Error('Mises à jour système désactivées sur cet agent (HD_ALLOW_SYSTEM_UPDATES=0)');
  if (state.apt === null) throw new Error('Pas de gestionnaire apt sur cette machine');
  if (aptJob && !aptJob.finishedAt) throw new Error('Une mise à jour apt est déjà en cours');
  let pkgs = [];
  if (op === 'security') pkgs = (state.apt || []).filter(u => u.security && !u.held).map(u => u.name);
  else if (op === 'install') pkgs = packages.filter(x => PKG.test(x));
  else if (op !== 'upgrade') throw new Error('Opération apt inconnue');
  if (op !== 'upgrade' && !pkgs.length) throw new Error('Aucun paquet à mettre à jour');
  const opts = '-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold';
  const cmd = `export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a; apt-get update -q && ` +
    (op === 'upgrade' ? `apt-get ${opts} --with-new-pkgs upgrade` : `apt-get ${opts} install --only-upgrade ${pkgs.join(' ')}`);
  const job = { op, packages: pkgs, startedAt: new Date().toISOString(), finishedAt: null, code: null, log: [] };
  aptJob = job;
  const push = chunk => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) job.log.push(line.slice(0, 300));
    if (job.log.length > 80) job.log.splice(0, job.log.length - 80);
  };
  log('apt', op, pkgs.join(' '));
  const child = spawn('nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  const killer = setTimeout(() => child.kill('SIGTERM'), 3600e3);
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  const done = code => {
    if (job.finishedAt) return;
    clearTimeout(killer);
    job.code = code; job.finishedAt = new Date().toISOString();
    log('apt terminé, code', code);
    checkUpdates().catch(() => {});
  };
  child.on('error', e => { push(e.code === 'ENOENT' ? 'nsenter introuvable dans le conteneur de l\'agent' : e.message); done('ERR'); });
  child.on('close', code => done(code));
  return { ok: true, started: true, packages: pkgs.length };
}

// ---------------------------------------------------------------- Unraid (plugins / OS)
async function plgVersion(file) {
  const t = await read(file);
  if (!t) return null;
  const ent = t.match(/<!ENTITY\s+version\s+"([^"]+)"/);
  if (ent) return ent[1];
  const at = t.match(/<PLUGIN[^>]*\sversion="([^"&]+)"/);
  return at ? at[1] : null;
}
async function unraidUpdates() {
  const info = await staticInfo();
  if (!info.unraid) return null;
  const out = [];
  let files = [];
  try { files = (await fsp.readdir(H('/boot/config/plugins'))).filter(f => f.endsWith('.plg')); } catch { /* */ }
  for (const f of files) {
    const cur = await plgVersion(H(`/boot/config/plugins/${f}`));
    const latest = await plgVersion(H(`/tmp/plugins/${f}`));
    if (cur && latest && cur !== latest && latest > cur) out.push({ name: `Plugin ${f.replace('.plg', '')}`, from: cur, to: latest });
  }
  const osLatest = await plgVersion(H('/tmp/plugins/unRAIDServer.plg'));
  if (osLatest && osLatest !== info.unraid && osLatest > info.unraid) out.unshift({ name: 'Unraid OS', from: info.unraid, to: osLatest });
  return out;
}

async function checkUpdates() {
  try { state.apt = await aptUpdates(); } catch (e) { log('apt', e.message); }
  try { state.unraidPlugins = await unraidUpdates(); } catch (e) { log('unraid', e.message); }
  state.updatesAt = new Date().toISOString();
}

// ---------------------------------------------------------------- Docker
function docker(method, p, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: CFG.dockerSock, path: p, method, timeout, headers: body ? { 'Content-Type': 'application/json' } : {} }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Docker ${res.statusCode} : ${d.slice(0, 200)}`));
        try { resolve(d ? JSON.parse(d) : null); } catch { resolve(d); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker : délai dépassé')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function containers() {
  if (!exists(CFG.dockerSock)) return { list: null, error: 'Socket Docker non monté' };
  try {
    const list = await docker('GET', '/containers/json?all=1');
    return {
      list: list.map(c => ({
        id: c.Id, name: (c.Names?.[0] || '').replace(/^\//, ''), image: c.Image, imageId: c.ImageID,
        state: c.State, status: c.Status, created: c.Created,
        imageUpdate: state.imageUpdates[c.Image]?.update ?? null,
        job: ctJobs.get((c.Names?.[0] || '').replace(/^\//, '')) || null
      }))
    };
  } catch (e) { return { list: null, error: e.message }; }
}
async function dockerAction(id, op) {
  if (!CFG.allowActions) throw new Error('Actions Docker désactivées sur cet agent (HD_ALLOW_DOCKER_ACTIONS=0)');
  if (!['start', 'stop', 'restart'].includes(op) || !/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Action invalide');
  await docker('POST', `/containers/${id}/${op}`, null, 60000);
  return { ok: true };
}

// ---------------------------------------------------------------- mise à jour d'un conteneur
// Comme Watchtower : télécharge la nouvelle image puis recrée le conteneur avec la même
// configuration (volumes, ports, réseaux, variables, labels compose…). En cas d'échec au
// démarrage, l'ancien conteneur est remis en place.
const ctJobs = new Map(); // nom -> { state: queued|pulling|recreating|done|error, error, at, image }
const ctQueue = [];
let ctBusy = false;
function dockerPull(ref) {
  return new Promise((resolve, reject) => {
    const r = parseRef(ref);
    const from = encodeURIComponent(ref.replace(/:[^:/@]+$/, '').replace(/@.*$/, ''));
    const tag = encodeURIComponent(r?.tag || 'latest');
    const req = http.request({ socketPath: CFG.dockerSock, path: `/images/create?fromImage=${from}&tag=${tag}`, method: 'POST', timeout: 1800e3 }, res => {
      let last = '', err = null;
      res.on('data', c => {
        for (const line of String(c).split('\n')) {
          if (!line.trim()) continue;
          try { const j = JSON.parse(line); if (j.error) err = j.error; last = j.status || last; } catch { /* morceau incomplet */ }
        }
      });
      res.on('end', () => (res.statusCode >= 400 || err ? reject(new Error(`Téléchargement de l'image impossible : ${err || res.statusCode}`)) : resolve(last)));
    });
    req.on('timeout', () => req.destroy(new Error('Téléchargement trop long')));
    req.on('error', reject);
    req.end();
  });
}
// retire de la config du conteneur ce qui venait de l'ancienne image, pour que la nouvelle s'applique
function ownConfig(cfg, imgCfg, oldId) {
  const c = { ...cfg };
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const imgEnv = new Set(imgCfg?.Env || []);
  c.Env = (cfg.Env || []).filter(e => !imgEnv.has(e));
  const imgLabels = imgCfg?.Labels || {};
  c.Labels = Object.fromEntries(Object.entries(cfg.Labels || {}).filter(([k, v]) => imgLabels[k] !== v));
  for (const k of ['Cmd', 'Entrypoint', 'WorkingDir', 'User', 'Healthcheck', 'StopSignal']) if (same(cfg[k], imgCfg?.[k])) delete c[k];
  if (imgCfg?.ExposedPorts && c.ExposedPorts) for (const p of Object.keys(imgCfg.ExposedPorts)) delete c.ExposedPorts[p];
  if (imgCfg?.Volumes && c.Volumes) for (const v of Object.keys(imgCfg.Volumes)) delete c.Volumes[v];
  if (c.Hostname && oldId.startsWith(c.Hostname)) delete c.Hostname; // nom d'hôte automatique = id court
  return c;
}
async function recreate(name) {
  const job = ctJobs.get(name);
  const old = await docker('GET', `/containers/${encodeURIComponent(name)}/json`);
  const ref = old.Config.Image;
  if (/^sha256:|^[a-f0-9]{64}$/.test(ref)) throw new Error('Image sans nom : impossible de savoir quoi télécharger');
  if (/mondashboard-agent|homedash-agent/.test(ref)) throw new Error('L\'agent ne peut pas se mettre à jour lui-même : mets sa stack à jour dans Dockhand');
  job.state = 'pulling'; job.image = ref;
  if (process.env.HD_TEST_NOPULL !== '1') await dockerPull(ref); // tests sans registre
  const fresh = await docker('GET', `/images/${encodeURIComponent(ref)}/json`);
  if (fresh.Id === old.Image) { job.state = 'done'; job.note = 'déjà à jour'; return; }
  job.state = 'recreating';
  const oldImg = await docker('GET', `/images/${old.Image}/json`).catch(() => null);
  const wasRunning = old.State?.Running;
  const hc = old.HostConfig;
  const nets = Object.entries(old.NetworkSettings?.Networks || {});
  const netMode = hc.NetworkMode || '';
  const shared = /^(host|none|container:)/.test(netMode);
  const endpoint = ([, n]) => ({
    IPAMConfig: n.IPAMConfig || undefined, Links: n.Links || undefined, MacAddress: n.MacAddress || undefined,
    Aliases: (n.Aliases || []).filter(a => !old.Id.startsWith(a))
  });
  const body = {
    ...ownConfig(old.Config, oldImg?.Config, old.Id), Image: ref, HostConfig: hc,
    NetworkingConfig: shared || !nets.length ? undefined : { EndpointsConfig: { [nets[0][0]]: endpoint(nets[0]) } }
  };
  const backup = `${name}-ancien-${Date.now().toString(36)}`;
  if (wasRunning) await docker('POST', `/containers/${old.Id}/stop?t=30`, null, 90000);
  await docker('POST', `/containers/${old.Id}/rename?name=${encodeURIComponent(backup)}`);
  let created = null;
  try {
    created = await docker('POST', `/containers/create?name=${encodeURIComponent(name)}`, body, 60000);
    if (!shared) for (const n of nets.slice(1)) await docker('POST', `/networks/${encodeURIComponent(n[0])}/connect`, { Container: created.Id, EndpointConfig: endpoint(n) });
    if (wasRunning) await docker('POST', `/containers/${created.Id}/start`, null, 60000);
  } catch (e) {
    // retour à l'ancien conteneur
    if (created) await docker('DELETE', `/containers/${created.Id}?force=1`).catch(() => {});
    await docker('POST', `/containers/${old.Id}/rename?name=${encodeURIComponent(name)}`).catch(() => {});
    if (wasRunning) await docker('POST', `/containers/${old.Id}/start`).catch(() => {});
    throw new Error(`Recréation impossible, ancien conteneur remis en place : ${e.message}`);
  }
  await docker('DELETE', `/containers/${old.Id}?v=0`).catch(e => log('suppression de l\'ancien conteneur', e.message));
  if (state.imageUpdates[ref]) state.imageUpdates[ref] = { update: false, checkedAt: new Date().toISOString() };
  job.state = 'done';
}
async function ctWorker() {
  if (ctBusy) return;
  ctBusy = true;
  while (ctQueue.length) {
    const name = ctQueue.shift();
    const job = ctJobs.get(name);
    try { log('mise à jour du conteneur', name); await recreate(name); log('conteneur à jour', name); }
    catch (e) { job.state = 'error'; job.error = e.message; log('échec mise à jour', name, e.message); }
    job.at = new Date().toISOString();
  }
  ctBusy = false;
}
function containerUpdate(id) {
  if (!CFG.allowActions) throw new Error('Actions Docker désactivées sur cet agent (HD_ALLOW_DOCKER_ACTIONS=0)');
  if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Conteneur invalide');
  return docker('GET', `/containers/${id}/json`).then(c => {
    const name = c.Name.replace(/^\//, '');
    const cur = ctJobs.get(name);
    if (cur && ['queued', 'pulling', 'recreating'].includes(cur.state)) throw new Error('Mise à jour déjà en cours');
    ctJobs.set(name, { state: 'queued', at: new Date().toISOString() });
    ctQueue.push(name);
    ctWorker();
    return { ok: true, queued: true };
  });
}

// Détection des images obsolètes : digest local (RepoDigests) vs digest distant (registre)
function parseRef(ref) {
  if (!ref || ref.startsWith('sha256:') || ref.includes('@')) return null;
  let registry = 'registry-1.docker.io', rest = ref;
  const first = ref.split('/')[0];
  if (ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first === 'docker.io' ? 'registry-1.docker.io' : first;
    rest = ref.slice(first.length + 1);
  }
  let tag = 'latest';
  const c = rest.lastIndexOf(':');
  if (c > rest.lastIndexOf('/')) { tag = rest.slice(c + 1); rest = rest.slice(0, c); }
  if (registry === 'registry-1.docker.io' && !rest.includes('/')) rest = `library/${rest}`;
  return { registry, repo: rest, tag };
}
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json'
].join(', ');
async function remoteDigest(url, depth = 0) {
  if (depth > 3) throw new Error('trop de redirections');
  let res = await fetch(url, { method: 'HEAD', headers: { Accept: ACCEPT }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (res.status === 401) {
    const h = res.headers.get('www-authenticate') || '';
    const p = Object.fromEntries([...h.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    if (!p.realm) throw new Error('authentification registre inconnue');
    const tu = new URL(p.realm);
    if (p.service) tu.searchParams.set('service', p.service);
    if (p.scope) tu.searchParams.set('scope', p.scope);
    const tok = await (await fetch(tu, { signal: AbortSignal.timeout(15000) })).json();
    res = await fetch(url, { method: 'HEAD', headers: { Accept: ACCEPT, Authorization: `Bearer ${tok.token || tok.access_token}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  }
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    return remoteDigest(new URL(res.headers.get('location'), url).toString(), depth + 1);
  }
  if (!res.ok) throw new Error(`registre ${res.status}`);
  return res.headers.get('docker-content-digest');
}
async function checkImages() {
  const c = await containers();
  if (!c.list) return;
  const images = [...new Set(c.list.map(x => x.image))];
  const out = {};
  for (const img of images) {
    const ref = parseRef(img);
    if (!ref) continue;
    try {
      const info = await docker('GET', `/images/${encodeURIComponent(img)}/json`);
      const local = (info.RepoDigests || []).map(d => d.split('@')[1]);
      if (!local.length) continue; // image construite localement
      const remote = await remoteDigest(`https://${ref.registry}/v2/${ref.repo}/manifests/${ref.tag}`);
      out[img] = { update: !!remote && !local.includes(remote), checkedAt: new Date().toISOString() };
    } catch (e) {
      out[img] = { update: null, error: e.message };
    }
    await new Promise(r => setTimeout(r, 300));
  }
  state.imageUpdates = out;
  state.imagesAt = new Date().toISOString();
}

// ---------------------------------------------------------------- rapport
async function report() {
  const [info, m, t, fsys, ct] = await Promise.all([staticInfo(), meminfo(), temps(), filesystems(), containers()]);
  const up = parseFloat(((await read('/proc/uptime')) || '0').split(' ')[0]);
  const load = ((await read('/proc/loadavg')) || '').split(' ').slice(0, 3).map(Number);
  return {
    agentVersion: VERSION, collectedAt: new Date().toISOString(),
    ...info, uptime: up, load,
    cpu: { percent: state.cpu, cores: info.cores, model: info.cpuModel },
    mem: m.mem, swap: m.swap, net: state.net, temps: t, gpus: state.gpus,
    fs: fsys, disks: state.disks, smartAt: state.smartAt, smartAvailable: state.disks !== null,
    updates: { apt: state.apt, unraid: state.unraidPlugins, checkedAt: state.updatesAt },
    aptJob, canSystem: CFG.allowSystem && state.apt !== null,
    rebootRequired: exists(H('/run/reboot-required')) || exists(H('/var/run/reboot-required')),
    containers: ct.list, dockerError: ct.error || null, imagesAt: state.imagesAt,
    actionsEnabled: CFG.allowActions
  };
}

// ---------------------------------------------------------------- boucles
function every(sec, fn, delay = 0) {
  const tick = async () => { try { await fn(); } catch (e) { log('erreur', fn.name, e.message); } };
  setTimeout(() => { tick(); setInterval(tick, sec * 1000); }, delay);
}
every(3, sampleCpu);
every(3, sampleNet);
every(10, sampleGpu);
every(CFG.smartInterval, scanSmart, 2000);
every(CFG.updatesInterval, checkUpdates, 4000);
every(CFG.imagesInterval, checkImages, 15000);

// ---------------------------------------------------------------- mode pull : serveur HTTP
if (CFG.mode === 'pull') {
  http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', async () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/health') return send(200, { ok: true, version: VERSION });
      if (!verify(req, body)) return send(401, { error: 'Signature invalide (jeton ou horloge ?)' });
      try {
        if (req.method === 'GET' && req.url === '/v1/report') return send(200, await report());
        const m = req.url.match(/^\/v1\/docker\/([a-f0-9]{12,64})\/(start|stop|restart|update)$/);
        if (req.method === 'POST' && m) return send(200, m[2] === 'update' ? await containerUpdate(m[1]) : await dockerAction(m[1], m[2]));
        if (req.method === 'POST' && req.url === '/v1/refresh') { scanSmart(); checkUpdates(); checkImages(); return send(200, { ok: true }); }
        const a = req.url.match(/^\/v1\/apt\/(upgrade|security|install)(?:\?pkgs=([^&]*))?$/);
        if (req.method === 'POST' && a) return send(200, aptStart(a[1], decodeURIComponent(a[2] || '').split(',').filter(Boolean)));
        send(404, { error: 'Inconnu' });
      } catch (e) { send(500, { error: e.message }); }
    });
  }).listen(CFG.port, () => log(`HomeDash Agent ${VERSION} en écoute sur le port ${CFG.port} (mode pull)`));
}

// ---------------------------------------------------------------- mode push : envoi périodique
if (CFG.mode === 'push') {
  if (!CFG.server || !CFG.id) { console.error('HD_SERVER et HD_ID sont requis en mode push'); process.exit(1); }
  let results = [];
  const push = async () => {
    const p = '/api/agent/push';
    const body = JSON.stringify({ report: await report(), results });
    const { ts, sig } = sign('POST', p, body);
    try {
      const res = await fetch(CFG.server + p, {
        method: 'POST', body, signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', 'X-HD-Agent': CFG.id, 'X-HD-Time': ts, 'X-HD-Sig': sig }
      });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { log('push refusé', res.status, r.error || ''); return; }
      results = [];
      for (const c of r.commands || []) {
        try {
          if (c.op === 'refresh') { scanSmart(); checkUpdates(); checkImages(); results.push({ id: c.id, ok: true }); }
          else if (c.op === 'apt') { aptStart(c.aptOp, c.packages || []); results.push({ id: c.id, ok: true }); }
          else if (c.op === 'update') { await containerUpdate(c.containerId); results.push({ id: c.id, ok: true }); }
          else { await dockerAction(c.containerId, c.op); results.push({ id: c.id, ok: true }); }
        } catch (e) { results.push({ id: c.id, ok: false, error: e.message }); }
      }
      if (results.length) setTimeout(push, 500);
    } catch (e) { log('push impossible', e.message); }
  };
  log(`HomeDash Agent ${VERSION} en mode push vers ${CFG.server} toutes les ${CFG.pushInterval} s`);
  every(CFG.pushInterval, push, 3500);
}

// exports pour les tests
if (process.env.HD_TEST) module.exports = { dpkgCompare, parseRef, report, scanSmart, checkUpdates, aptUpdates, checkImages, state, sign, containerUpdate, ctJobs };
process.on('SIGTERM', () => process.exit(0));
