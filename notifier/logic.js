// Ren beslutningslogik for notifikationer (ingen Firestore, ingen netværk) – unit-testet.
// Alle tider er millisekunder (UTC epoch). Tidszone for daglig opsamling og påmindelser: Europe/Copenhagen.

export const TZ = 'Europe/Copenhagen';
export const TOPICS = ['guests', 'items', 'party', 'costs', 'payments', 'reminder'];
export const DEFAULT_TOPICS = { guests: true, items: true, party: true, costs: true, payments: true, reminder: true };
export const REMINDER_MINUTES = { '1d': 24 * 60, '3h': 3 * 60 };
const MAX_LINES = 4;

// ── Tidszone-hjælpere (Intl, ingen afhængigheder) ──────────────────────────
const fmtCache = new Map();
function partsFmt(tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return fmtCache.get(tz);
}
/** Lokale dele {y,m,d,h,min} af et tidspunkt i tidszonen. */
export function zonedParts(ms, tz = TZ) {
  const o = {};
  for (const p of partsFmt(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour, min: o.minute, s: o.second };
}
/** UTC-ms for en lokal vægur-tid i tidszonen (håndterer sommertid). */
export function zonedToUtc(y, m, d, h = 0, min = 0, tz = TZ) {
  const want = Date.UTC(y, m - 1, d, h, min);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - want;
    if (!diff) break;
    guess -= diff;
  }
  return guess;
}
export const localDateKey = (ms, tz = TZ) => { const p = zonedParts(ms, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };

/** Gildets start (UTC-ms) ud fra dato "YYYY-MM-DD" og evt. tid "HH:MM" (lokal tid). null hvis ingen dato. */
export function partyStart(party, tz = TZ) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(party?.date || '');
  if (!m) return null;
  const t = /^(\d{2}):(\d{2})$/.exec(party.time || '') || [0, '12', '00'];
  return zonedToUtc(+m[1], +m[2], +m[3], +t[1], +t[2], tz);
}

// ── Emner ────────────────────────────────────────────────────────────────
/** Hvilket emne hører en aktivitet til? (aktivitet.type sættes af appen) */
export function topicsOf(a) {
  switch (a.type) {
    case 'guest': return ['guests'];
    case 'item': return a.hasCost ? ['items', 'costs'] : ['items'];
    case 'cost': return ['costs'];
    case 'party': return ['party'];
    case 'payment': return ['payments'];        // betalinger: markeret betalt, bekræftet, påmindelser
    default: return [];
  }
}
export function wants(sub, a, subUid) {
  if (a.actorUid && a.actorUid === subUid) return false;                       // egen handling
  // Målrettet besked (fx betalingspåmindelse): kun til de nævnte deltagere
  if (Array.isArray(a.targetPids) && a.targetPids.length && !(sub.participantId && a.targetPids.includes(sub.participantId))) return false;
  if (a.participantId && sub.participantId && a.participantId === sub.participantId) return false;
  const topics = { ...DEFAULT_TOPICS, ...(sub.topics || {}) };
  return topicsOf(a).some(t => topics[t]);
}

/** Hvorfra skal der ledes efter nyheder for dette abonnement? */
export const sinceOf = sub => Math.max(sub.lastNotifiedAt || 0, sub.baselineAt || 0, sub.createdAt || 0);

/** Er dagens opsamling forfalden? Returnerer tidspunktet for opsamlingen (ms) eller null. */
export function digestDue(sub, now, tz = TZ) {
  const hour = Number.isInteger(sub.digestHour) ? sub.digestHour : 18;
  const p = zonedParts(now, tz);
  const moment = zonedToUtc(p.y, p.m, p.d, hour, 0, tz);
  if (now < moment) return null;
  if ((sub.lastDigestAt || 0) >= moment) return null;                            // allerede sendt i dag
  if (Math.max(sub.baselineAt || 0, sub.createdAt || 0) >= moment) return null;  // slået til efter dagens tidspunkt
  return moment;
}

/** Påmindelse forfalden? Returnerer nøgle (til reminderSentFor) eller null. */
export function reminderDue(sub, party, now, tz = TZ) {
  const topics = { ...DEFAULT_TOPICS, ...(sub.topics || {}) };
  if (sub.frequency !== 'reminderOnly' && !topics.reminder) return null;
  const start = partyStart(party, tz);
  if (start == null || now >= start) return null;
  const before = REMINDER_MINUTES[sub.reminderBefore] ? sub.reminderBefore : '1d';
  if (now < start - REMINDER_MINUTES[before] * 60000) return null;
  const key = `${party.date}T${party.time || ''}|${before}`;
  return sub.reminderSentFor === key ? null : key;
}

// ── Tekster ──────────────────────────────────────────────────────────────
function listBody(texts) {
  const shown = texts.slice(0, MAX_LINES).join(' · ');
  return texts.length > MAX_LINES ? `${shown} · og ${texts.length - MAX_LINES} mere` : shown;
}
export function reminderText(party, now, tz = TZ) {
  const start = partyStart(party, tz);
  const today = localDateKey(now, tz), day = localDateKey(start, tz);
  const tomorrow = localDateKey(now + 86400000, tz);
  const when = day === today ? 'i dag' : day === tomorrow ? 'i morgen' : `d. ${Number(party.date.slice(8))}/${Number(party.date.slice(5, 7))}`;
  return `${party.name} er ${when}${party.time ? ' kl. ' + party.time : ''}${party.place ? ' · ' + party.place : ''}`;
}

/**
 * Planlæg hvad der skal sendes til ét abonnement.
 * @param sub       abonnement (tider i ms)
 * @param subUid    abonnementets id (= brugerens uid)
 * @param party     {name, date, time, place}
 * @param activities aktiviteter sorteret efter createdAt (kan indeholde ældre – filtreres her)
 * @param now       ms
 * @returns {messages: [{kind,title,body}], update: {…felter der skal skrives på abonnementet}}
 */
export function planForSub({ sub, subUid, party, activities = [], now, tz = TZ }) {
  const messages = [], update = {};
  if (!sub?.enabled) return { messages, update };
  const freq = ['instant', 'daily', 'reminderOnly'].includes(sub.frequency) ? sub.frequency : 'instant';

  // Testbesked
  if (sub.testRequestedAt && (!sub.testSentAt || sub.testRequestedAt > sub.testSentAt)) {
    messages.push({ kind: 'test', title: 'Testbesked 🔔', body: `Notifikationer virker for ${party.name}.` });
    update.testSentAt = now;
  }

  const since = sinceOf(sub);
  const fresh = activities.filter(a => (a.createdAt || 0) > since && (a.createdAt || 0) <= now);
  const maxSeen = fresh.reduce((m, a) => Math.max(m, a.createdAt), 0);
  const relevant = fresh.filter(a => wants(sub, a, subUid));

  if (freq === 'instant') {
    if (relevant.length) {
      const texts = relevant.map(a => a.text).filter(Boolean);
      messages.push({ kind: 'instant', title: party.name, body: texts.length === 1 ? texts[0] : `${texts.length} nyheder: ${listBody(texts)}` });
    }
    if (maxSeen) update.lastNotifiedAt = maxSeen;
  } else if (freq === 'daily') {
    const moment = digestDue(sub, now, tz);
    if (moment != null) {
      if (relevant.length) {
        const texts = relevant.map(a => a.text).filter(Boolean);
        messages.push({ kind: 'digest', title: `${party.name}: dagens nyt (${texts.length})`, body: listBody(texts) });
      }
      update.lastDigestAt = now;
      if (maxSeen) update.lastNotifiedAt = maxSeen;
    }
  }

  const rKey = reminderDue({ ...sub, frequency: freq }, party, now, tz);
  if (rKey) {
    messages.push({ kind: 'reminder', title: 'Påmindelse 🎉', body: reminderText(party, now, tz) });
    update.reminderSentFor = rKey;
  }
  return { messages, update };
}

/** Skal der overhovedet hentes aktiviteter for dette abonnement nu? (sparer læsninger) */
export function needsActivities(sub, now, tz = TZ) {
  if (!sub?.enabled) return false;
  const freq = sub.frequency || 'instant';
  if (freq === 'instant') return true;
  if (freq === 'daily') return digestDue(sub, now, tz) != null;
  return false;
}
