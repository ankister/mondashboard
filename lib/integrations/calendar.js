// Calendrier CalDAV (Nextcloud, Infomaniak, etc.) ou abonnement .ics.
// En CalDAV, les calendriers sont découverts automatiquement à partir de l'adresse
// du serveur (principal → calendar-home-set → liste des calendriers).
import ical from 'node-ical';
import { XMLParser } from 'fast-xml-parser';
import { request } from '../http.js';

const o = c => ({ insecure: !!c.insecure, basicAuth: c.username ? { username: c.username, password: c.password } : null, timeout: 15000 });
const icsDate = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#13;/g, '\r').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, attributeNamePrefix: '@' });
const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const txt = v => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();

// ---- PROPFIND ----
async function propfind(c, url, depth, props) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop>${props}</d:prop></d:propfind>`;
  const res = await request(url, { ...o(c), method: 'PROPFIND', body, headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' } });
  if (res.status === 401) throw Object.assign(new Error('CalDAV : identifiants refusés (sur Nextcloud, utilise un mot de passe d\'application)'), { auth: true });
  if (res.status !== 207) return null;
  const doc = xml.parse(await res.text());
  return arr(doc.multistatus?.response).map(r => {
    const ok = arr(r.propstat).find(p => /\s200\s/.test(txt(p.status))) || arr(r.propstat)[0] || {};
    return { href: new URL(txt(r.href), url).toString(), prop: ok.prop || {} };
  });
}
const hrefOf = v => txt(arr(v?.href)[0] ?? v);

// ---- découverte des calendriers ----
const discovered = new Map(); // clé -> { at, list }
async function discover(c) {
  const key = `${c.url}|${c.username}`;
  const hit = discovered.get(key);
  if (hit && Date.now() - hit.at < 3600e3) return hit.list;

  const base = c.url.trim().replace(/\/+$/, '');
  const candidates = /\/(remote\.php\/dav|dav|caldav)(\/|$)/i.test(base) || /\/calendars\//i.test(base)
    ? [base + '/']
    : [base + '/remote.php/dav/', base + '/.well-known/caldav', base + '/'];

  for (const start of candidates) {
    let r;
    try { r = await propfind(c, start, 0, '<d:resourcetype/><d:displayname/><a:calendar-color/><d:current-user-principal/>'); }
    catch (e) { if (e.auth) throw e; continue; }
    if (!r?.length) continue;
    const me = r[0];
    // l'URL désigne déjà un calendrier précis
    if (me.prop.resourcetype && 'calendar' in me.prop.resourcetype) {
      const list = [{ url: me.href, name: txt(me.prop.displayname) || 'Calendrier', color: txt(me.prop['calendar-color']).slice(0, 7) || null }];
      discovered.set(key, { at: Date.now(), list });
      return list;
    }
    // sinon : principal → calendar-home-set → calendriers
    let home = null;
    const principal = hrefOf(me.prop['current-user-principal']);
    if (principal) {
      const p = await propfind(c, new URL(principal, start).toString(), 0, '<c:calendar-home-set/>');
      const h = p && hrefOf(p[0]?.prop['calendar-home-set']);
      if (h) home = new URL(h, start).toString();
    }
    home ||= me.href; // l'URL est peut-être déjà le dossier des calendriers
    const items = await propfind(c, home, 1, '<d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/>');
    const list = (items || []).filter(i => {
      if (!i.prop.resourcetype || !('calendar' in i.prop.resourcetype)) return false;
      const comps = arr(i.prop['supported-calendar-component-set']?.comp).map(x => x['@name']);
      return !comps.length || comps.includes('VEVENT');
    }).map(i => ({
      url: i.href,
      name: txt(i.prop.displayname) || decodeURIComponent(i.href.replace(/\/+$/, '').split('/').pop()),
      color: txt(i.prop['calendar-color']).slice(0, 7) || null
    }));
    if (list.length) { discovered.set(key, { at: Date.now(), list }); return list; }
  }
  throw new Error('Aucun calendrier trouvé à cette adresse. Indique l\'adresse de ton Nextcloud (ex. https://cloud.exemple.fr) ou l\'URL CalDAV d\'un calendrier.');
}

async function reportCalendar(c, url, start, end) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data><c:expand start="${icsDate(start)}" end="${icsDate(end)}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${icsDate(start)}" end="${icsDate(end)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
  const res = await request(url, { ...o(c), method: 'REPORT', body, headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' } });
  if (res.status === 401) throw new Error('CalDAV : identifiants refusés (sur Nextcloud, utilise un mot de passe d\'application)');
  if (res.status !== 207 && !res.ok) throw new Error(`CalDAV a répondu ${res.status} sur ${url}`);
  const xmlText = await res.text();
  return [...xmlText.matchAll(/<(?:[\w-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/g)]
    .map(m => unxml(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')));
}

// Renvoie [{ name, color, ics: [textes] }]
async function fetchCalendars(c, start, end) {
  if (c.mode === 'ics') {
    const res = await request(c.url, o(c));
    if (!res.ok) throw new Error(`HTTP ${res.status} sur le calendrier`);
    return [{ name: null, color: null, ics: [await res.text()] }];
  }
  let cals = await discover(c);
  const wanted = String(c.calendars || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (wanted.length) cals = cals.filter(k => wanted.includes(k.name.toLowerCase()));
  return Promise.all(cals.map(async k => ({ ...k, ics: await reportCalendar(c, k.url, start, end) })));
}

function expand(icsTexts, start, end, calendarName, color) {
  const out = [];
  for (const t of icsTexts) {
    let data;
    try { data = ical.sync.parseICS(t); } catch { continue; }
    for (const ev of Object.values(data)) {
      if (ev.type !== 'VEVENT' || !ev.start) continue;
      const allDay = ev.datetype === 'date';
      const dur = (ev.end ? +ev.end : +ev.start + (allDay ? 864e5 : 36e5)) - +ev.start;
      const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const push = s => out.push({
        title: ev.summary?.val ?? ev.summary ?? '(sans titre)', location: ev.location?.val ?? ev.location ?? '',
        calendar: calendarName, color, allDay,
        // journée entière : date locale « AAAA-MM-JJ » ; sinon instant ISO
        start: allDay ? ymd(new Date(s)) : new Date(s).toISOString(),
        end: allDay ? ymd(new Date(+s + dur)) : new Date(+s + dur).toISOString()
      });
      if (ev.rrule) {
        // rrule calcule en heure « flottante » : on recale sur le vrai DTSTART (fuseau de l'événement)
        const shift = +ev.start - +ev.rrule.options.dtstart;
        const ex = new Set(Object.values(ev.exdate || {}).map(d => ymd(new Date(d))));
        const overridden = new Set(Object.values(ev.recurrences || {}).map(r => ymd(new Date(r.recurrenceid || r.start))));
        for (const d0 of ev.rrule.between(new Date(+start - dur - 864e5), new Date(+end + 864e5), true)) {
          const d = new Date(+d0 + shift);
          if (+d + dur < +start || +d > +end) continue;
          if (!ex.has(ymd(d)) && !overridden.has(ymd(d))) push(d);
        }
        for (const r of Object.values(ev.recurrences || {})) {
          if (r.start && +r.start <= +end && +r.start + dur >= +start) push(r.start);
        }
      } else if (+ev.start + dur >= +start && +ev.start <= +end) {
        push(ev.start);
      }
    }
  }
  return out;
}

export default {
  label: 'Calendrier (CalDAV / .ics)',
  help: 'CalDAV : indique simplement l\'adresse de ton serveur (Nextcloud : https://cloud.exemple.fr, avec un mot de passe d\'application créé dans Paramètres → Sécurité). Tous tes calendriers sont trouvés automatiquement ; tu peux n\'en garder que certains. Infomaniak : adresse CalDAV indiquée dans les paramètres du calendrier. Mode .ics : URL d\'abonnement ou d\'export.',
  provides: ['calendar'],
  fields: [
    { key: 'mode', label: 'Mode', type: 'select', options: ['caldav', 'ics'], default: 'caldav' },
    { key: 'url', label: 'Adresse du serveur ou du calendrier', placeholder: 'https://cloud.exemple.fr', required: true },
    { key: 'username', label: 'Utilisateur' },
    { key: 'password', label: 'Mot de passe (d\'application)', type: 'password', secret: true },
    { key: 'calendars', label: 'Calendriers à afficher (noms séparés par des virgules, vide = tous)', placeholder: 'Personnel, Travail' },
    { key: 'color', label: 'Couleur (si le calendrier n\'en a pas)', type: 'color', default: '#6ee2ff' },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],
  async test(c) {
    discovered.delete(`${c.url}|${c.username}`);
    const start = new Date(), end = new Date(Date.now() + 30 * 864e5);
    const cals = await fetchCalendars(c, start, end);
    const n = cals.reduce((a, k) => a + expand(k.ics, start, end, '', '').length, 0);
    if (c.mode === 'ics') return `Calendrier lu : ${n} événement(s) sur 30 jours`;
    return `${cals.length} calendrier(s) : ${cals.map(k => k.name).join(', ')} — ${n} événement(s) sur 30 jours`;
  },
  async fetch(_k, c, w, integration) {
    let start = new Date(); start.setHours(0, 0, 0, 0);
    let end = new Date(+start + (w.days || 14) * 864e5);
    if (w._from && w._to) { start = new Date(w._from); end = new Date(w._to); }
    const cals = await fetchCalendars(c, start, end);
    return { events: cals.flatMap(k => expand(k.ics, start, end, k.name || integration.name, k.color || c.color || null)) };
  }
};
