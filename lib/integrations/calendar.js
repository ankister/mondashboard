// Calendrier CalDAV (Nextcloud, Infomaniak, etc.) ou abonnement .ics.
import ical from 'node-ical';
import { request } from '../http.js';

const o = c => ({ insecure: !!c.insecure, basicAuth: c.username ? { username: c.username, password: c.password } : null, timeout: 15000 });
const icsDate = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#13;/g, '\r').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function fetchIcs(c, start, end) {
  if (c.mode === 'ics') {
    const res = await request(c.url, o(c));
    if (!res.ok) throw new Error(`HTTP ${res.status} sur le calendrier`);
    return [await res.text()];
  }
  const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data><c:expand start="${icsDate(start)}" end="${icsDate(end)}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">
    <c:time-range start="${icsDate(start)}" end="${icsDate(end)}"/>
  </c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
  const res = await request(c.url, {
    ...o(c), method: 'REPORT', body,
    headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }
  });
  if (res.status === 401) throw new Error('CalDAV : identifiants refusés (utilise un mot de passe d\'application)');
  if (res.status !== 207 && !res.ok) throw new Error(`CalDAV a répondu ${res.status} (l'URL doit pointer sur un calendrier précis)`);
  const xmlText = await res.text();
  return [...xmlText.matchAll(/<(?:[\w-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/g)]
    .map(m => unxml(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')));
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
  help: 'Nextcloud : URL CalDAV du type https://cloud.exemple.fr/remote.php/dav/calendars/UTILISATEUR/personal/ avec un mot de passe d\'application. Infomaniak : copie l\'URL CalDAV du calendrier depuis ses paramètres. En mode .ics, colle une URL d\'abonnement ou d\'export.',
  provides: ['calendar'],
  fields: [
    { key: 'mode', label: 'Mode', type: 'select', options: ['caldav', 'ics'], default: 'caldav' },
    { key: 'url', label: 'URL du calendrier', placeholder: 'https://cloud.exemple.fr/remote.php/dav/calendars/utilisateur/personal/', required: true },
    { key: 'username', label: 'Utilisateur' },
    { key: 'password', label: 'Mot de passe (d\'application)', type: 'password', secret: true },
    { key: 'color', label: 'Couleur', type: 'color', default: '#6ee2ff' },
    { key: 'insecure', label: 'Accepter les certificats auto-signés', type: 'checkbox' }
  ],
  async test(c) {
    const start = new Date(), end = new Date(Date.now() + 30 * 864e5);
    const evs = expand(await fetchIcs(c, start, end), start, end, '', '');
    return `Calendrier lu : ${evs.length} événement(s) sur 30 jours`;
  },
  async fetch(_k, c, w, integration) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(+start + (w.days || 14) * 864e5);
    return { events: expand(await fetchIcs(c, start, end), start, end, integration.name, c.color || null) };
  }
};
