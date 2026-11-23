// Routes de l'agent : réception en mode push + génération de la commande d'installation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getIntegration } from './store.js';
import { verifySignature, receivePush } from './integrations/agent.js';

const AGENT_DIR = path.resolve('agent');
const installCodes = new Map(); // code -> { id, serverUrl, gpu, exp }

function agentEnv(it, serverUrl) {
  const c = it.config;
  const env = { HD_TOKEN: c.token, HD_MODE: c.mode || 'pull' };
  if (env.HD_MODE === 'pull') {
    let port = 9123;
    try { port = Number(new URL(c.url).port) || 9123; } catch { /* URL absente */ }
    env.HD_PORT = String(port);
  } else {
    env.HD_SERVER = serverUrl.replace(/\/+$/, '');
    env.HD_ID = it.id;
  }
  if (!c.allowActions) env.HD_ALLOW_DOCKER_ACTIONS = '0';
  return env;
}

function runCommand(env, gpu) {
  return [
    'docker run -d --name homedash-agent --restart unless-stopped',
    '  --network host --pid host --privileged',
    '  -v /:/host:ro -v /var/run/docker.sock:/var/run/docker.sock',
    ...(gpu ? ['  --runtime=nvidia -e NVIDIA_VISIBLE_DEVICES=all -e NVIDIA_DRIVER_CAPABILITIES=utility'] : []),
    ...Object.entries(env).map(([k, v]) => `  -e ${k}=${v}`),
    '  homedash-agent:local'
  ].join(' \\\n');
}

function composeFile(env, gpu) {
  return `services:
  homedash-agent:
    build: .
    image: homedash-agent:local
    container_name: homedash-agent
    restart: unless-stopped
    network_mode: host
    pid: host
    privileged: true${gpu ? '\n    runtime: nvidia' : ''}
    environment:
${Object.entries({ ...env, ...(gpu ? { NVIDIA_VISIBLE_DEVICES: 'all', NVIDIA_DRIVER_CAPABILITIES: 'utility' } : {}) })
    .map(([k, v]) => `      - ${k}=${v}`).join('\n')}
    volumes:
      - /:/host:ro
      - /var/run/docker.sock:/var/run/docker.sock
`;
}

function installScript(env, gpu) {
  const b64 = f => fs.readFileSync(path.join(AGENT_DIR, f)).toString('base64');
  return `#!/bin/sh
# Installation de l'agent Mon dashboard (script généré automatiquement)
set -e
if [ "$(id -u)" != "0" ]; then echo "Lance ce script en root (sudo)."; exit 1; fi
command -v docker >/dev/null 2>&1 || { echo "Docker est introuvable sur cette machine."; exit 1; }
DIR=/opt/homedash-agent
[ -f /etc/unraid-version ] && DIR=/mnt/user/appdata/homedash-agent
mkdir -p "$DIR" && cd "$DIR"
echo "${b64('agent.js')}" | base64 -d > agent.js
echo "${b64('Dockerfile')}" | base64 -d > Dockerfile
cat > docker-compose.yml <<'COMPOSE'
${composeFile(env, gpu)}COMPOSE
echo "==> Construction de l'image homedash-agent (1 à 2 min la première fois)…"
docker build -q -t homedash-agent:local . >/dev/null
docker rm -f homedash-agent >/dev/null 2>&1 || true
echo "==> Démarrage du conteneur…"
${runCommand(env, gpu)}
sleep 3
if docker ps --filter name=homedash-agent --filter status=running -q | grep -q .; then
  echo "==> Agent Mon dashboard installé dans $DIR et démarré (mode ${env.HD_MODE})."
  ${env.HD_MODE === 'pull' ? `echo "    Il écoute sur le port ${env.HD_PORT}."` : `echo "    Il envoie ses données à ${env.HD_SERVER}."`}
else
  echo "!! Le conteneur ne tourne pas. Journal :"; docker logs homedash-agent 2>&1 | tail -20; exit 1
fi
`;
}

export function agentRoutes(app, { requireAdmin, wrap, bad }) {
  // Réception des rapports en mode push (authentifiée par signature HMAC, pas par session)
  app.post('/api/agent/push', (req, res) => {
    const id = String(req.headers['x-hd-agent'] || '');
    const it = getIntegration(id);
    if (!it || it.type !== 'agent' || it.config.mode !== 'push') return res.status(404).json({ error: 'Agent inconnu ou pas en mode push' });
    const ok = verifySignature(it.config.token, 'POST', '/api/agent/push', req.rawBody || '',
      req.headers['x-hd-time'], req.headers['x-hd-sig']);
    if (!ok) return res.status(401).json({ error: 'Signature invalide (jeton ou horloge)' });
    res.json(receivePush(id, req.body || {}));
  });

  // Génère un code d'installation valable 1 h
  app.post('/api/integrations/:id/agent-setup', requireAdmin, wrap(req => {
    const it = getIntegration(req.params.id);
    if (!it || it.type !== 'agent') throw bad('Intégration agent introuvable', 404);
    const serverUrl = String(req.body?.serverUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(serverUrl)) throw bad('Adresse de Mon dashboard invalide');
    if (it.config.mode === 'pull' && !it.config.url) throw bad('Renseigne d\'abord l\'URL de l\'agent (mode pull) et enregistre.');
    const gpu = !!req.body?.gpu;
    const code = crypto.randomBytes(18).toString('base64url');
    installCodes.set(code, { id: it.id, serverUrl, gpu, exp: Date.now() + 3600e3 });
    const url = `${serverUrl}/api/agent/install/${code}`;
    const env = agentEnv(it, serverUrl);
    return {
      curl: `curl -fsSL "${url}" | sudo sh`,
      curlRoot: `curl -fsSL "${url}" | sh`,
      wget: `wget -qO- "${url}" | sudo sh`,
      run: `# depuis un dossier contenant agent.js et Dockerfile :\ndocker build -t homedash-agent:local .\n${runCommand(env, gpu)}`,
      compose: composeFile(env, gpu),
      expires: new Date(Date.now() + 3600e3).toISOString()
    };
  }));

  // Script d'installation (contient le jeton : protégé par le code à usage limité dans le temps)
  app.get('/api/agent/install/:code', (req, res) => {
    const c = installCodes.get(req.params.code);
    if (!c || c.exp < Date.now()) {
      res.status(404).type('text/plain').send('echo "Code d\'installation expiré : régénère la commande dans Mon dashboard."; exit 1\n');
      return;
    }
    const it = getIntegration(c.id);
    if (!it) { res.status(404).type('text/plain').send('echo "Intégration supprimée"; exit 1\n'); return; }
    res.type('text/x-shellscript').send(installScript(agentEnv(it, c.serverUrl), c.gpu));
  });

  setInterval(() => { for (const [k, v] of installCodes) if (v.exp < Date.now()) installCodes.delete(k); }, 600e3).unref();
}
