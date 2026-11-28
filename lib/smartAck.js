// Acquittement des alertes SMART (comme « Acknowledge » dans Unraid).
// On mémorise les compteurs d'un disque au moment de l'acquittement ; ses alertes sont ensuite
// masquées tant qu'aucun compteur n'augmente. Un compteur qui augmente fait réapparaître l'alerte
// avec l'écart (« +3 depuis le 28/11 »). Les alertes graves (test SMART en échec, disque qui ne
// répond plus, alerte critique NVMe…) ne sont jamais masquées.
import { load, save } from './store.js';

// compteurs reconnus : clé -> motif dans le texte de l'alerte produit par l'agent
const PATTERNS = {
  crc: /^(\d+) erreur\(s\) CRC/,
  realloc: /^(\d+) secteur\(s\) réalloué\(s\)/,
  pending: /^(\d+) secteur\(s\) en attente/,
  uncorr: /^(\d+) secteur\(s\) non corrigible\(s\)/,
  media: /^(\d+) erreur\(s\) média/,
  errlog: /^Erreurs dans le journal SMART/
};

const diskKey = d => (d.serial ? `sn:${d.serial}` : `nm:${d.name}`);

// compteurs d'un disque : ceux de l'agent s'il les fournit (1.3.1+), sinon tirés des messages
export function countersOf(d) {
  const c = {};
  for (const n of d.notes || []) {
    for (const [k, re] of Object.entries(PATTERNS)) {
      const m = n.match(re);
      if (m) c[k] = k === 'errlog' ? (d.counters?.errlog ?? 1) : Number(m[1]);
    }
  }
  return c;
}

export function applySmartAck(data, integrationId) {
  if (!data || !Array.isArray(data.disks) || !integrationId) return data;
  const acks = load().smartAck?.[integrationId] || {};
  let hidden = 0;
  const disks = data.disks.map(d => {
    const now = countersOf(d);
    const ack = acks[diskKey(d)];
    const out = { ...d, counters: now, ackKey: diskKey(d) };
    if (!ack) return out;
    const date = new Date(ack.at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
    const notes = [];
    let still = false;
    for (const n of d.notes || []) {
      const k = Object.keys(PATTERNS).find(key => PATTERNS[key].test(n));
      if (!k) { notes.push(n); still = true; continue; }        // alerte non acquittable
      const before = ack.c?.[k] ?? 0;
      if (now[k] > before) { notes.push(k === 'errlog' ? `${n} (nouvelles depuis le ${date})` : `${n} (+${now[k] - before} depuis le ${date})`); still = true; }
    }
    if (!still) hidden++;
    return {
      ...out, notes, acked: true, ackAt: ack.at,
      // plus rien de nouveau : la pastille repasse au vert si seules des alertes acquittées la coloraient
      health: !still && d.health === 'warn' ? 'ok' : d.health
    };
  });
  return { ...data, disks, smartAcked: hidden };
}

export function setSmartAck(integrationId, disks, clear) {
  const st = load();
  st.smartAck ||= {};
  if (clear) { delete st.smartAck[integrationId]; save(); return; }
  const cur = st.smartAck[integrationId] ||= {};
  const at = new Date().toISOString();
  for (const d of disks || []) {
    if (typeof d.key !== 'string' || !/^(sn|nm):[\w .:/-]{1,80}$/.test(d.key)) continue;
    const c = {};
    for (const k of Object.keys(PATTERNS)) if (Number.isFinite(Number(d.counters?.[k]))) c[k] = Math.max(0, Math.round(Number(d.counters[k])));
    cur[d.key] = { c, at };
  }
  save();
}
