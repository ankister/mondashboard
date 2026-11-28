// Backrest (interface web de restic) : état des plans de sauvegarde (dernière sauvegarde, statut,
// prochaine exécution, historique, volume protégé) et lancement manuel d'un plan.
// API JSON (Connect) : POST /v1.Backrest/<méthode>, authentification basique si activée.
import { request, joinUrl } from '../http.js';

async function rpc(c, method, body = {}) {
  const res = await request(joinUrl(c.url, `/v1.Backrest/${method}`), {
    method: 'POST', insecure: !!c.insecure, timeout: 20000,
    basicAuth: c.username ? { username: c.username, password: c.password } : undefined,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.status === 401 || res.status === 403) throw new Error('Identifiants Backrest refusés');
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Backrest a répondu ${res.status} (${method})${t ? ' : ' + t.slice(0, 120) : ''}`);
  }
  return res.json();
}

// les entiers 64 bits arrivent en chaînes, les champs en camelCase (ou snake_case selon la version)
const n = v => (v == null || v === '' ? null : Number(v));
const pick = (o, ...k) => { for (const x of k) if (o?.[x] !== undefined) return o[x]; return undefined; };
const ST = { STATUS_SUCCESS: 'ok', STATUS_WARNING: 'warn', STATUS_ERROR: 'error', STATUS_INPROGRESS: 'running', STATUS_PENDING: 'running', STATUS_SYSTEM_CANCELLED: 'warn', STATUS_USER_CANCELLED: 'warn' };
const st = v => ST[v] || (typeof v === 'number' ? { 3: 'ok', 7: 'warn', 4: 'error', 2: 'running', 1: 'running', 5: 'warn', 6: 'warn' }[v] : null) || 'unknown';
// ne jamais afficher d'identifiants contenus dans l'adresse d'un dépôt
const cleanUri = u => String(u || '').replace(/\/\/[^/@\s]+@/, '//');

export default {
  label: 'Backrest',
  help: 'URL de Backrest (port 9898 par défaut). Si l\'authentification est activée dans Backrest, indique un utilisateur et son mot de passe.',
  provides: ['backup'],
  fields: [
    { key: 'url', label: 'URL de Backrest', placeholder: 'http://192.168.1.2:9898', required: true },
    { key: 'username', label: 'Utilisateur (si authentification activée)' },
    { key: 'password', label: 'Mot de passe', type: 'password', secret: true },
    { key: 'allowRun', label: 'Autoriser le lancement manuel d\'une sauvegarde depuis le dashboard', type: 'checkbox', default: true },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],

  async test(c) {
    const cfg = await rpc(c, 'GetConfig');
    return `Backrest joignable : ${(cfg.plans || []).length} plan(s), ${(cfg.repos || []).length} dépôt(s)`;
  },

  async fetch(_k, c, _w, integration) {
    const [cfg, sum] = await Promise.all([rpc(c, 'GetConfig'), rpc(c, 'GetSummaryDashboard')]);
    const plans = new Map((cfg.plans || []).map(p => [p.id, p]));
    const repos = new Map((cfg.repos || []).map(r => [r.id, r]));
    const summaries = pick(sum, 'planSummaries', 'plan_summaries') || [];
    const items = summaries.filter(s => plans.has(s.id) || !plans.size).map(s => {
      const plan = plans.get(s.id) || {};
      const ch = pick(s, 'recentBackups', 'recent_backups') || {};
      const ts = (pick(ch, 'timestampMs', 'timestamp_ms') || []).map(n);
      const sts = (ch.status || []).map(st);
      const dur = (pick(ch, 'durationMs', 'duration_ms') || []).map(n);
      const add = (pick(ch, 'bytesAdded', 'bytes_added') || []).map(n);
      // plus récente en dernier
      const recent = ts.map((t, i) => ({ t, status: sts[i], ms: dur[i], bytes: add[i] })).sort((a, b) => a.t - b.t).slice(-20);
      const last = recent.at(-1) || null;
      const lastGood = [...recent].reverse().find(r => r.status === 'ok' || r.status === 'warn') || null;
      const hist = (pick(s, 'historyLast30days', 'history_last_30days') || []).map(b => {
        const counts = (pick(b, 'statusCounts', 'status_counts') || []).map(x => [st(x.status), n(x.count)]);
        const has = k => counts.some(([k2, c2]) => k2 === k && c2 > 0);
        return { t: n(pick(b, 'timestampMs', 'timestamp_ms')), s: has('error') ? 'error' : has('warn') ? 'warn' : has('ok') ? 'ok' : b.overdue ? 'late' : null };
      });
      const repo = repos.get(plan.repo);
      return {
        integrationId: integration.id, source: 'Backrest', instance: integration.name,
        id: s.id, name: s.id, repo: plan.repo || '', repoUri: cleanUri(repo?.uri),
        status: last ? last.status : 'unknown', last: last?.t || null, lastOk: lastGood?.t || null, approx: false,
        next: n(pick(s, 'nextBackupTimeMs', 'next_backup_time_ms')) || null,
        snapshots: n(pick(s, 'totalSnapshots', 'total_snapshots')),
        size: n(pick(s, 'protectedBytes', 'protected_bytes')) || n(pick(s, 'bytesScannedAvg', 'bytes_scanned_avg')),
        added: last?.bytes ?? null, duration: last?.ms ?? null,
        counts: { ok: n(pick(s, 'backupsSuccessLast30days', 'backups_success_last_30days')) || 0, warn: n(pick(s, 'backupsWarningLast30days', 'backups_warning_last_30days')) || 0, error: n(pick(s, 'backupsFailed30days', 'backups_failed_30days')) || 0 },
        recent, history: hist,
        canRun: c.allowRun !== false
      };
    });
    return { items };
  },

  // lancer un plan maintenant
  async action(c, p) {
    if (p.op !== 'run') throw new Error('Action invalide');
    if (c.allowRun === false) throw new Error('Lancement manuel désactivé dans l\'intégration Backrest');
    if (!/^[\w .:-]{1,100}$/.test(String(p.plan || ''))) throw new Error('Plan invalide');
    await rpc(c, 'Backup', { value: String(p.plan) });
    return { ok: true };
  }
};
