// Home Assistant (HAOS) via l'API REST et un jeton longue durée.
// Fournit : supervision machine (capteurs "System Monitor") + mises à jour (entités update.*)
// + calendriers HA.
import { getJson, joinUrl } from '../http.js';

const o = c => ({ insecure: !!c.insecure, headers: { Authorization: `Bearer ${c.token}` } });

function pick(states, entityId, patterns) {
  if (entityId) return states.find(s => s.entity_id === entityId.trim());
  for (const re of patterns) {
    const s = states.find(x => re.test(x.entity_id) && !isNaN(parseFloat(x.state)));
    if (s) return s;
  }
  return null;
}
const num = s => (s && !isNaN(parseFloat(s.state)) ? parseFloat(s.state) : null);

export default {
  label: 'Home Assistant',
  help: 'Profil utilisateur HA → Sécurité → Jetons d\'accès longue durée. Pour CPU/RAM, ajoute l\'intégration « System Monitor » dans HA.',
  provides: ['machine', 'calendar'],
  fields: [
    { key: 'url', label: 'URL', placeholder: 'http://homeassistant.local:8123', required: true },
    { key: 'token', label: 'Jeton longue durée', type: 'password', secret: true, required: true },
    { key: 'cpuEntity', label: 'Entité CPU (optionnel)', placeholder: 'sensor.system_monitor_processor_use' },
    { key: 'memEntity', label: 'Entité RAM % (optionnel)', placeholder: 'sensor.system_monitor_memory_usage' },
    { key: 'tempEntity', label: 'Entité température (optionnel)', placeholder: 'sensor.system_monitor_processor_temperature' },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],

  async test(c) {
    const cfg = await getJson(joinUrl(c.url, '/api/config'), o(c));
    return `Connecté à « ${cfg.location_name} » (HA ${cfg.version})`;
  },

  async fetch(kind, c, w, integration) {
    if (kind === 'calendar') {
      const days = w.days || 14;
      const start = w._from ? new Date(w._from) : new Date();
      const end = w._to ? new Date(w._to) : new Date(Date.now() + days * 864e5);
      const cals = await getJson(joinUrl(c.url, '/api/calendars'), o(c));
      const out = [];
      await Promise.all(cals.map(async cal => {
        const evs = await getJson(joinUrl(c.url,
          `/api/calendars/${cal.entity_id}?start=${start.toISOString()}&end=${end.toISOString()}`), o(c)).catch(() => []);
        for (const e of evs) {
          const allDay = !!e.start.date;
          out.push({
            title: e.summary, location: e.location || '', calendar: cal.name, color: integration.config.color || null,
            allDay,
            start: allDay ? e.start.date : new Date(e.start.dateTime).toISOString(),
            end: allDay ? e.end.date : new Date(e.end.dateTime).toISOString()
          });
        }
      }));
      return { events: out };
    }

    const [states, cfg] = await Promise.all([
      getJson(joinUrl(c.url, '/api/states'), o(c)),
      getJson(joinUrl(c.url, '/api/config'), o(c)).catch(() => ({}))
    ]);
    const cpu = pick(states, c.cpuEntity, [/^sensor\..*processor_use/, /^sensor\..*cpu_(usage|percent|use)/]);
    const mem = pick(states, c.memEntity, [/^sensor\..*memory_(use_percent|usage)$/, /^sensor\..*memory_use_percent/]);
    const temp = pick(states, c.tempEntity, [/^sensor\..*processor_temperature/, /^sensor\..*cpu_temp/]);
    const updates = states
      .filter(s => s.entity_id.startsWith('update.') && s.state === 'on')
      .map(s => ({
        name: s.attributes.title || s.attributes.friendly_name || s.entity_id,
        from: s.attributes.installed_version, to: s.attributes.latest_version
      }));
    return {
      name: cfg.location_name || integration.name,
      os: cfg.version ? `Home Assistant ${cfg.version}` : 'Home Assistant',
      uptime: null,
      cpu: { percent: num(cpu) },
      mem: num(mem) !== null ? { percent: num(mem) } : null,
      net: null,
      temps: temp ? [{ label: 'CPU', value: num(temp) }] : [],
      gpus: [], fs: [], disks: [],
      updates
    };
  }
};
