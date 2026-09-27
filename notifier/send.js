// Sender web push-notifikationer. Køres af GitHub Actions hvert ~15. minut (se .github/workflows/notify.yml).
//
// Miljøvariabler:
//   FIREBASE_SERVICE_ACCOUNT  JSON for en service-konto (GitHub-secret). Udelades ved emulator.
//   FIRESTORE_EMULATOR_HOST   fx localhost:8080 (lokal test) – så bruges GCLOUD_PROJECT som projekt-id.
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (secret), VAPID_SUBJECT (https-URL eller mailto:)
//   APP_URL                   fx https://abusedwaffle.github.io/sammenskudsgilde/
// Flag:  --dry-run (send og skriv intet)   --mock-send=fil.json (kryptér, men gem i fil i stedet for at sende)
//
// Læsninger pr. kørsel ≈ antal abonnementer + antal gilder med abonnementer + 1 aktivitets-forespørgsel pr. gilde
// med abonnenter der skal have "med det samme" (eller hvis daglige opsamling er forfalden) + nye aktiviteter.

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { planForSub, needsActivities, sinceOf, partyStart } from './logic.js';

const TS_FIELDS = ['lastNotifiedAt', 'lastDigestAt', 'testSentAt'];
const toMs = o => { const r = { ...o }; for (const k in r) if (r[k] && typeof r[k].toMillis === 'function') r[k] = r[k].toMillis(); return r; };

/** Én kørsel. db = Admin Firestore, send(channel, payload) → {ok}|{gone}|{error}. */
export async function run({ db, Timestamp, send, now = Date.now(), appUrl, dryRun = false, log = console.log }) {
  const stats = { subs: 0, parties: 0, activityQueries: 0, activities: 0, sent: 0, failed: 0, removed: 0, orphaned: 0, updated: 0 };
  const snap = await db.collectionGroup('subs').get();
  stats.subs = snap.size;
  const byParty = new Map();
  for (const d of snap.docs) {
    const partyRef = d.ref.parent.parent;
    if (!partyRef || partyRef.parent.id !== 'parties') continue;
    if (!byParty.has(partyRef.id)) byParty.set(partyRef.id, []);
    byParty.get(partyRef.id).push({ ref: d.ref, uid: d.id, data: toMs(d.data()) });
  }
  for (const [pid, subs] of byParty) {
    stats.parties++;
    const ps = await db.doc(`parties/${pid}`).get();
    if (!ps.exists) {                                   // gildet er slettet → ryd abonnementer
      if (!dryRun) await Promise.all(subs.map(s => s.ref.delete()));
      stats.orphaned += subs.length; continue;
    }
    const party = ps.data();
    const active = subs.filter(s => s.data.enabled && s.data.channels?.push?.endpoint);
    if (!active.length) continue;
    const start = partyStart(party);
    const over = start != null && now > start + 7 * 86400000;   // en uge efter festen: ingen nyheder mere
    const need = over ? [] : active.filter(s => needsActivities(s.data, now));
    let activities = [];
    if (need.length) {
      const since = Math.min(...need.map(s => sinceOf(s.data)));
      const q = await db.collection(`parties/${pid}/activity`).where('createdAt', '>', Timestamp.fromMillis(since))
        .orderBy('createdAt').limit(500).get();
      stats.activityQueries++; stats.activities += q.size;
      activities = q.docs.map(d => toMs(d.data()));
    }
    for (const s of active) {
      const { messages, update } = planForSub({ sub: s.data, subUid: s.uid, party, activities: over ? [] : activities, now });
      let gone = false, failed = false;
      for (const m of messages) {
        const payload = { title: m.title, body: m.body, url: `${appUrl}#/p/${pid}`, tag: `sg-${pid}-${m.kind}`, kind: m.kind };
        if (dryRun) { log(`[dry-run] ${pid.slice(0, 6)}… ${m.kind}: ${m.title} – ${m.body}`); continue; }
        const res = await send(s.data.channels.push, payload);
        if (res.gone) { gone = true; break; }
        if (res.ok) stats.sent++; else { failed = true; stats.failed++; }
      }
      if (dryRun) continue;
      if (gone) { await s.ref.delete(); stats.removed++; continue; }
      if (failed || !Object.keys(update).length) continue;   // ved fejl prøves igen næste gang
      const u = { ...update };
      for (const k of TS_FIELDS) if (typeof u[k] === 'number') u[k] = Timestamp.fromMillis(u[k]);
      await s.ref.update(u); stats.updated++;
    }
  }
  return stats;
}

export function makeWebPushSender(webpush, { mockFile } = {}) {
  const captured = [];
  const send = async (ch, payload) => {
    const sub = { endpoint: ch.endpoint, keys: { p256dh: ch.keys?.p256dh, auth: ch.keys?.auth } };
    const body = JSON.stringify(payload);
    const opts = { TTL: 6 * 3600, urgency: payload.kind === 'reminder' ? 'high' : 'normal' };
    try {
      if (mockFile) {
        webpush.generateRequestDetails(sub, body, opts);          // kryptering + VAPID-signatur skal lykkes
        if (/gone/.test(ch.endpoint)) return { gone: true };
        captured.push({ endpoint: ch.endpoint, payload });
        return { ok: true };
      }
      await webpush.sendNotification(sub, body, opts);
      return { ok: true };
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) return { gone: true };
      console.warn(`Push fejlede (${e.statusCode || e.code || e.message})`);   // endpoint logges ikke
      return { error: e };
    }
  };
  send.flush = () => { if (mockFile) { const prev = existsSync(mockFile) ? JSON.parse(readFileSync(mockFile, 'utf8')) : []; writeFileSync(mockFile, JSON.stringify([...prev, ...captured], null, 1)); } };
  return send;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const mockFile = args.find(a => a.startsWith('--mock-send='))?.split('=')[1];
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
  const webpush = (await import('web-push')).default;
  if (process.env.FIRESTORE_EMULATOR_HOST) initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-sammenskudsgilde' });
  else {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT mangler');
    initializeApp({ credential: cert(JSON.parse(raw)) });
  }
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw new Error('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY mangler');
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://abusedwaffle.github.io/sammenskudsgilde/', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const send = makeWebPushSender(webpush, { mockFile });
  const t0 = Date.now();
  const stats = await run({ db: getFirestore(), Timestamp, send, appUrl: process.env.APP_URL || 'https://abusedwaffle.github.io/sammenskudsgilde/', dryRun });
  send.flush();
  console.log(`Færdig på ${Date.now() - t0} ms: ` + Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' '));
  if (stats.failed) process.exitCode = 0; // enkelte fejl skal ikke gøre workflowet rødt – de prøves igen
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
