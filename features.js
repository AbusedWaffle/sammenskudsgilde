// Ren logik til v1.5-funktioner (ingen DOM, ingen Firebase) – bruges af appen og af node-tests:
// kost/allergier, kalenderfil (.ics) + Google Kalender-link og forslag ("Det mangler vi").

// ── Kost og allergier ────────────────────────────────────────────────────────
/** Personens kost/allergier: nøgle → [ikon, etiket, ental, flertal] */
export const DIET = {
  vegetar: ['🥕', 'Vegetar', 'vegetar', 'vegetarer'],
  vegansk: ['🌱', 'Vegansk', 'veganer', 'veganere'],
  glutenfri: ['🌾', 'Glutenfri', 'glutenfri', 'glutenfri'],
  laktosefri: ['🥛', 'Laktosefri', 'laktosefri', 'laktosefri'],
  noedder: ['🥜', 'Nøddeallergi', 'nøddeallergi', 'nøddeallergier'],
};
/** Rettens mærker: nøgle → [ikon, etiket] */
export const DISH_TAGS = {
  vegetar: ['🥕', 'Vegetar'],
  vegansk: ['🌱', 'Vegansk'],
  noedder: ['🥜', 'Indeholder nødder'],
  gluten: ['🌾', 'Indeholder gluten'],
  laktose: ['🥛', 'Indeholder laktose'],
  koed: ['🍖', 'Indeholder kød/fisk'],
};
/** Hvilke rettens mærker passer IKKE til personens kost/allergi? */
export const CONFLICTS = {
  noedder: ['noedder'],
  glutenfri: ['gluten'],
  laktosefri: ['laktose'],
  vegetar: ['koed'],
  vegansk: ['koed', 'laktose'],
};
export const cleanTags = (list, allowed) => [...new Set((Array.isArray(list) ? list : []).filter(t => Object.hasOwn(allowed, t)))];

const coming = p => p?.status !== 'no';

/** Overblik: { counts: {tag: n}, notes: [{id, name, note}], text: "3 vegetarer · 1 nøddeallergi" } – kun dem, der ikke har meldt fra. */
export function dietOverview(participants) {
  const counts = {}, notes = [];
  for (const p of participants || []) {
    if (!coming(p)) continue;
    for (const t of cleanTags(p.diet, DIET)) counts[t] = (counts[t] || 0) + 1;
    if (p.dietNote && String(p.dietNote).trim()) notes.push({ id: p.id, name: p.name, note: String(p.dietNote).trim() });
  }
  const text = Object.keys(DIET).filter(t => counts[t]).map(t => `${counts[t]} ${counts[t] === 1 ? DIET[t][2] : DIET[t][3]}`).join(' · ');
  return { counts, notes, text };
}

/** Konflikter for en ret: [{tag (rettens mærke), diet (personens), people: [participants]}] – kun dem, der kommer. */
export function dishConflicts(item, participants) {
  const tags = cleanTags(item?.tags, DISH_TAGS);
  if (!tags.length) return [];
  const out = [];
  for (const [diet, bad] of Object.entries(CONFLICTS)) {
    const hit = bad.filter(t => tags.includes(t));
    if (!hit.length) continue;
    const people = (participants || []).filter(p => coming(p) && cleanTags(p.diet, DIET).includes(diet));
    if (people.length) out.push({ tag: hit[0], diet, people });
  }
  return out;
}

// ── Kalender ────────────────────────────────────────────────────────────────
const TZ = 'Europe/Copenhagen';
function zonedParts(ms, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const o = {}; for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}
/** UTC-ms for lokal tid i Europe/Copenhagen (håndterer sommertid). */
export function localToUtc(y, m, d, h = 0, min = 0, tz = TZ) {
  const want = Date.UTC(y, m - 1, d, h, min);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const diff = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - want;
    if (!diff) break;
    guess -= diff;
  }
  return guess;
}
const pad = n => String(n).padStart(2, '0');
const utcStamp = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`; };
const dateStamp = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`; };
export const EVENT_HOURS = 4;

/** Start/slut for gildet: {allDay, start, end} (start/end = UTC-stempler eller datoer). null uden (gyldig) dato. */
export function partyTimes(party) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(party?.date || '');
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = /^(\d{2}):(\d{2})$/.exec(party.time || '');
  if (!t) return { allDay: true, start: dateStamp(y, mo, d), end: dateStamp(y, mo, d + 1) };
  const s = localToUtc(y, mo, d, +t[1], +t[2]);
  return { allDay: false, start: utcStamp(s), end: utcStamp(s + EVENT_HOURS * 3600000) };
}
const icsEsc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Fold linjer til maks. 75 bytes (RFC 5545), uden at dele UTF-8-tegn. */
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = []; let cur = '', size = 0, limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (size + b > limit) { out.push(cur); cur = ''; size = 0; limit = 74; }
    cur += ch; size += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
/** Kalenderfil (.ics) for gildet. Kaster, hvis gildet ikke har en dato. */
export function buildIcs(party, url, now = Date.now()) {
  const t = partyTimes(party);
  if (!t) throw new Error('Gildet har ingen dato');
  const desc = [party.note, url ? `Gildet: ${url}` : ''].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sammenskudsgilde//DA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${party.id || 'gilde'}@sammenskudsgilde`,
    `DTSTAMP:${utcStamp(now)}`,
    t.allDay ? `DTSTART;VALUE=DATE:${t.start}` : `DTSTART:${t.start}`,
    t.allDay ? `DTEND;VALUE=DATE:${t.end}` : `DTEND:${t.end}`,
    `SUMMARY:${icsEsc(party.name)}`,
    ...(party.place ? [`LOCATION:${icsEsc(party.place)}`] : []),
    ...(desc ? [`DESCRIPTION:${icsEsc(desc)}`] : []),
    ...(url ? [`URL:${url}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
/** Google Kalender-link (åbner "opret begivenhed" udfyldt). null uden dato. */
export function googleCalendarUrl(party, url) {
  const t = partyTimes(party);
  if (!t) return null;
  const q = new URLSearchParams({ action: 'TEMPLATE', text: party.name || 'Sammenskudsgilde', dates: `${t.start}/${t.end}`,
    details: [party.note, url ? `Gildet: ${url}` : ''].filter(Boolean).join('\n\n'), location: party.place || '', ctz: TZ });
  return 'https://calendar.google.com/calendar/render?' + q.toString();
}
export const icsFileName = party => (String(party?.name || 'gilde').replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa').replace(/Æ/g, 'Ae').replace(/Ø/g, 'Oe').replace(/Å/g, 'Aa').normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'gilde') + '.ics';

// ── Forslag ("Det mangler vi") ─────────────────────────────────────────────────
/** Er forslaget taget (af en ret, der stadig findes)? Peger det på en slettet ret, er det ledigt igen. */
export const isTaken = (s, items) => !!s?.takenItemId && (items || []).some(i => i.id === s.takenItemId);
/** Ledige forslag (ikke taget), ældste først. */
export const openSuggestions = (suggestions, items) => (suggestions || []).filter(s => !isTaken(s, items))
  .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
/** Retter/serveringer (kind 'ret'-punkter) som ingen har meldt noget til endnu. */
export function emptyCourses(events, items) {
  return (events || []).filter(e => (e.kind || 'ret') === 'ret' && !(items || []).some(i => i.eventId === e.id && i.kind !== 'aktivitet' && i.kind !== 'udgift'));
}
