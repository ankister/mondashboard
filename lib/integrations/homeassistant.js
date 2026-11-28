// Home Assistant (HAOS) via l'API REST et un jeton longue durée.
// Fournit : supervision machine (capteurs "System Monitor") + mises à jour (entités update.*)
// + calendriers HA + entités à afficher et piloter (lumières, prises, volets, thermostats, capteurs…).
import { getJson, joinUrl, request } from '../http.js';

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

const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
// domaines sans intérêt dans le sélecteur
const HIDDEN = /^(update|zone|tts|stt|conversation|event|image|wake_word|assist_satellite|ai_task|todo|tag|notify)\./;
// services autorisés par domaine, et données acceptées
const SERVICES = {
  light: ['turn_on', 'turn_off', 'toggle'], switch: ['turn_on', 'turn_off', 'toggle'], input_boolean: ['turn_on', 'turn_off', 'toggle'],
  fan: ['turn_on', 'turn_off', 'toggle'], automation: ['turn_on', 'turn_off', 'toggle', 'trigger'], siren: ['turn_on', 'turn_off'],
  script: ['turn_on'], scene: ['turn_on'], button: ['press'], input_button: ['press'],
  lock: ['lock', 'unlock'], cover: ['open_cover', 'close_cover', 'stop_cover', 'set_cover_position'],
  climate: ['set_temperature', 'set_hvac_mode', 'turn_on', 'turn_off'], water_heater: ['set_temperature'],
  media_player: ['media_play_pause', 'media_next_track', 'media_previous_track', 'volume_up', 'volume_down', 'turn_on', 'turn_off'],
  vacuum: ['start', 'pause', 'return_to_base'], humidifier: ['turn_on', 'turn_off', 'toggle']
};
const DATA_KEYS = { brightness_pct: [1, 100], temperature: [-50, 100], position: [0, 100] };

export function entityInfo(e, s) {
  const base = { id: e.id, domain: e.id.split('.')[0], name: e.name || '', icon: e.icon || '' };
  if (!s) return { ...base, name: base.name || e.id, state: 'missing' };
  const a = s.attributes || {};
  const modes = a.supported_color_modes || [];
  return {
    ...base, name: base.name || a.friendly_name || e.id, state: s.state, unit: a.unit_of_measurement || '',
    deviceClass: a.device_class || '', changed: s.last_changed || null,
    brightness: typeof a.brightness === 'number' ? Math.round(a.brightness / 255 * 100) : null,
    dimmable: modes.some(m => m !== 'onoff') || typeof a.brightness === 'number',
    rgb: Array.isArray(a.rgb_color) ? a.rgb_color : null,
    current: typeof a.current_temperature === 'number' ? a.current_temperature : null,
    target: typeof a.temperature === 'number' ? a.temperature : null,
    step: a.target_temp_step || (a.temperature_unit === '°F' || a.unit_of_measurement === '°F' ? 1 : 0.5),
    min: a.min_temp ?? null, max: a.max_temp ?? null, hvacAction: a.hvac_action || '',
    position: typeof a.current_position === 'number' ? a.current_position : null,
    media: [a.media_artist, a.media_title].filter(Boolean).join(' — ') || a.app_name || ''
  };
}

async function callService(c, p) {
  const entity = String(p.entity || '');
  if (!ENTITY.test(entity)) throw new Error('Entité invalide');
  const domain = entity.split('.')[0];
  if (!SERVICES[domain]?.includes(p.service)) throw new Error(`Action « ${p.service} » non autorisée pour ${domain}`);
  const body = { entity_id: entity };
  for (const [k, [lo, hi]] of Object.entries(DATA_KEYS)) {
    if (p.data?.[k] !== undefined) body[k] = Math.min(hi, Math.max(lo, Number(p.data[k])));
  }
  if (typeof p.data?.hvac_mode === 'string' && /^[a-z_]{2,20}$/.test(p.data.hvac_mode)) body.hvac_mode = p.data.hvac_mode;
  const res = await request(joinUrl(c.url, `/api/services/${domain}/${p.service}`), {
    method: 'POST', timeout: 15000, insecure: !!c.insecure,
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.status === 401 || res.status === 403) throw new Error('Jeton Home Assistant refusé');
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Home Assistant a refusé (${res.status})${txt ? ' : ' + txt.slice(0, 160) : ''}`);
  }
  return { ok: true };
}

export default {
  label: 'Home Assistant',
  help: 'Profil utilisateur HA → Sécurité → Jetons d\'accès longue durée. Pour CPU/RAM, ajoute l\'intégration « System Monitor » dans HA.',
  provides: ['machine', 'calendar', 'ha'],
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

  // liste des entités (sélecteur du widget « Home Assistant »)
  async list(c) {
    const states = await getJson(joinUrl(c.url, '/api/states'), { ...o(c), timeout: 15000 });
    return states.filter(s => !HIDDEN.test(s.entity_id)).map(s => ({
      id: s.entity_id, domain: s.entity_id.split('.')[0], name: s.attributes.friendly_name || s.entity_id,
      state: s.state, unit: s.attributes.unit_of_measurement || '', deviceClass: s.attributes.device_class || ''
    })).sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
  },

  async fetch(kind, c, w, integration) {
    if (kind === 'ha') {
      const wanted = Array.isArray(w.entities) ? w.entities.filter(e => ENTITY.test(e?.id || '')) : [];
      if (!wanted.length) return { entities: [], integrationId: integration.id };
      const states = await getJson(joinUrl(c.url, '/api/states'), o(c));
      const byId = new Map(states.map(s => [s.entity_id, s]));
      return { integrationId: integration.id, entities: wanted.map(e => entityInfo(e, byId.get(e.id))) };
    }
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
      .map(s => {
        const f = s.attributes.supported_features || 0; // 1 = installer, 8 = sauvegarde avant installation
        return {
          name: s.attributes.title || s.attributes.friendly_name || s.entity_id,
          from: s.attributes.installed_version, to: s.attributes.latest_version,
          entity: s.entity_id, canInstall: !!(f & 1), canBackup: !!(f & 8),
          inProgress: s.attributes.in_progress === true || typeof s.attributes.in_progress === 'number',
          percent: typeof s.attributes.update_percentage === 'number' ? s.attributes.update_percentage
            : typeof s.attributes.in_progress === 'number' ? s.attributes.in_progress : null,
          url: s.attributes.release_url || null
        };
      });
    return {
      name: cfg.location_name || integration.name,
      os: cfg.version ? `Home Assistant ${cfg.version}` : 'Home Assistant',
      uptime: null,
      cpu: { percent: num(cpu) },
      mem: num(mem) !== null ? { percent: num(mem) } : null,
      net: null,
      temps: temp ? [{ label: 'CPU', value: num(temp) }] : [],
      gpus: [], fs: [], disks: [],
      updates, integrationId: integration.id
    };
  },

  // installer ou ignorer une mise à jour (services update.install / update.skip)
  // ou piloter une entité (op « service »)
  async action(c, payload) {
    if (payload.op === 'service') return callService(c, payload);
    const entity = String(payload.entity || '');
    if (!/^update\.[a-z0-9_]+$/.test(entity)) throw new Error('Entité de mise à jour invalide');
    if (!['install', 'skip'].includes(payload.op)) throw new Error('Action inconnue');
    const body = { entity_id: entity };
    if (payload.op === 'install' && payload.backup) body.backup = true;
    // HA rend la main au bout de 10 s environ ; l'installation continue ensuite en arrière-plan
    const res = await request(joinUrl(c.url, `/api/services/update/${payload.op}`), {
      method: 'POST', timeout: 30000, insecure: !!c.insecure,
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.status === 401 || res.status === 403) throw new Error('Jeton refusé : il faut le jeton d\'un utilisateur administrateur de HA');
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Home Assistant a refusé (${res.status})${txt ? ' : ' + txt.slice(0, 160) : ''}`);
    }
    return { ok: true };
  }
};
