// Datalag. Samme API uanset backend:
//   • "firebase"  – rigtig Firestore (+ anonym Firebase Auth), konfigureret i firebase-config.js
//   • "emulator"  – Firebase Local Emulator Suite:  ?emulator=localhost:8080[&authport=9099]
//   • "mock"      – localStorage + BroadcastChannel (kun denne browser):  ?backend=mock
// Uden gyldig konfiguration falder appen automatisk tilbage til "mock" (demotilstand).
//
// Datamodel (Firestore):
//   parties/{partyId}                     navn, dato, tid, sted, note, creatorUid, creatorHash
//   parties/{partyId}/events/{id}         programpunkt/ret: title, time, kind, order
//   parties/{partyId}/participants/{id}   name, phone, ownerUid ('' = uden egen bruger), householdId, isChild,
//                                         status ('yes'|'maybe'|'no', mangler = 'yes'), addedByUid
//   parties/{partyId}/households/{id}     name, memberUids [uid'er med bruger i husstanden], createdByUid
//   parties/{partyId}/items/{id}          eventId, participantId, ownerUid, title, kind, servings, note,
//                                         cost (øre), split ('all'|'selected'|'households'),
//                                         among [participantIds] eller [husstands-/enheds-id'er] ved 'households'
//   parties/{partyId}/claims/{uid}        { key } – bevis for opretter-nøgle (kan ikke læses af nogen)
//   parties/{partyId}/activity/{id}       type, text, actorUid, participantId, hasCost, createdAt – til notifikationer
//   parties/{partyId}/subs/{uid}          notifikations-indstillinger pr. enhed (kun ejeren kan læse/skrive):
//                                         enabled, participantId, channels.push{endpoint,keys}, topics{…},
//                                         frequency, digestHour, reminderBefore, tz, baselineAt, testRequestedAt,
//                                         + felter som kun senderen skriver: lastNotifiedAt, lastDigestAt,
//                                         reminderSentFor, testSentAt. (Senere: channels.email)

import { firebaseConfig, FIREBASE_SDK_VERSION, isConfigured } from './firebase-config.js';
import { randomId, randomToken, sha256Hex } from './util.js';

const params = new URLSearchParams(location.search);

export function chooseBackend() {
  if (params.get('backend') === 'mock') return { kind: 'mock', reason: 'url' };
  if (params.get('emulator')) return { kind: 'emulator' };
  if (isConfigured()) return { kind: 'firebase' };
  return { kind: 'mock', reason: 'unconfigured' };
}

const SUBS = ['events', 'participants', 'items', 'households'];

// ───────────────────────────── Firebase / emulator ─────────────────────────────
async function firebaseBackend(kind) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/`;
  const [appM, authM, fs] = await Promise.all([
    import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
  let cfg = firebaseConfig;
  if (kind === 'emulator') cfg = { apiKey: 'demo-key', projectId: params.get('project') || 'demo-sammenskudsgilde', authDomain: 'localhost' };
  const app = appM.initializeApp(cfg);
  const auth = authM.getAuth(app);
  let db;
  if (kind === 'emulator') {
    const [host, port] = params.get('emulator').split(':');
    db = fs.getFirestore(app);
    fs.connectFirestoreEmulator(db, host, Number(port || 8080));
    authM.connectAuthEmulator(auth, `http://${host}:${params.get('authport') || 9099}`, { disableWarnings: true });
  } else {
    try {
      db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
    } catch { db = fs.getFirestore(app); }
  }
  const user = await new Promise((resolve, reject) => {
    const off = authM.onAuthStateChanged(auth, u => {
      if (u) { off(); resolve(u); }
      else authM.signInAnonymously(auth).catch(e => { off(); reject(e); });
    }, reject);
  });
  const ref = path => fs.doc(db, ...path);
  const norm = d => {
    const o = { id: d.id, ...d.data({ serverTimestamps: 'estimate' }) };
    for (const k in o) if (o[k] && typeof o[k].toMillis === 'function') o[k] = o[k].toMillis();
    return o;
  };
  return {
    uid: user.uid,
    ts: () => fs.serverTimestamp(),
    set: (path, data, merge) => fs.setDoc(ref(path), data, merge ? { merge: true } : {}),
    get: async path => { const d = await fs.getDoc(ref(path)); return d.exists() ? norm(d) : null; },
    list: async path => (await fs.getDocs(fs.collection(db, ...path))).docs.map(norm),
    update: (path, data) => fs.updateDoc(ref(path), data),
    remove: path => fs.deleteDoc(ref(path)),
    watchDoc: (path, cb, err) => fs.onSnapshot(ref(path), s => cb(s.exists() ? norm(s) : null), err),
    watchColl: (path, cb, err) => fs.onSnapshot(fs.collection(db, ...path), s => cb(s.docs.map(norm)), err),
    union: v => fs.arrayUnion(v),
    unionRemove: v => fs.arrayRemove(v),
    /** Atomisk skrivning af flere dokumenter: [{op:'set'|'update'|'remove', path, data}] */
    batch: ops => {
      const w = fs.writeBatch(db);
      for (const o of ops) o.op === 'set' ? w.set(ref(o.path), o.data) : o.op === 'update' ? w.update(ref(o.path), o.data) : w.delete(ref(o.path));
      return w.commit();
    },
  };
}

// ───────────────────────────── Mock (localStorage) ─────────────────────────────
function mockBackend() {
  const KEY = 'sg:mockdb';
  let uid = localStorage.getItem('sg:mockuid');
  if (!uid) { uid = 'mock-' + randomId(12); localStorage.setItem('sg:mockuid', uid); }
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const listeners = new Set();
  const chan = 'BroadcastChannel' in globalThis ? new BroadcastChannel('sg-mock') : null;
  const notify = () => { const db = load(); for (const l of listeners) l(db); };
  const save = db => { localStorage.setItem(KEY, JSON.stringify(db)); chan?.postMessage(1); queueMicrotask(notify); };
  if (chan) chan.onmessage = notify;
  addEventListener('storage', e => { if (e.key === KEY) notify(); });
  const key = path => path.join('/');
  const denied = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
  const watch = fn => { listeners.add(fn); setTimeout(() => fn(load()), 0); return () => listeners.delete(fn); };
  // arrayUnion/arrayRemove-markører
  const apply = (old = {}, data) => {
    const out = { ...old };
    for (const [k, v] of Object.entries(structuredClone(data))) {
      if (v && v.__union !== undefined) out[k] = [...new Set([...(out[k] || []), v.__union])];
      else if (v && v.__remove !== undefined) out[k] = (out[k] || []).filter(x => x !== v.__remove);
      else out[k] = v;
    }
    return out;
  };
  return {
    uid,
    ts: () => Date.now(),
    union: v => ({ __union: v }),
    unionRemove: v => ({ __remove: v }),
    async batch(ops) {
      const db = load();
      for (const o of ops) {
        const k = key(o.path);
        if (o.op === 'update' && !db[k]) throw Object.assign(new Error('No document to update'), { code: 'not-found' });
        if (o.op === 'remove') delete db[k]; else db[k] = apply(o.op === 'update' ? db[k] : {}, o.data);
      }
      save(db);
    },
    async set(path, data, merge) { const db = load(); db[key(path)] = apply(merge ? db[key(path)] : {}, data); save(db); },
    async get(path) { const v = load()[key(path)]; return v ? { id: path.at(-1), ...v } : null; },
    async list(path) { const pre = key(path) + '/'; return Object.entries(load()).filter(([k]) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map(([k, v]) => ({ id: k.slice(pre.length), ...v })); },
    async update(path, data) {
      const db = load(); const k = key(path);
      if (!db[k]) throw Object.assign(new Error('No document to update'), { code: 'not-found' });
      db[k] = apply(db[k], data); save(db);
    },
    async remove(path) { const db = load(); delete db[key(path)]; save(db); },
    watchDoc(path, cb) {
      const k = key(path);
      if (path.length === 4 && path[2] === 'claims') return () => {};
      let last;
      return watch(db => { const j = JSON.stringify(db[k] ?? null); if (j !== last) { last = j; cb(db[k] ? { id: path.at(-1), ...db[k] } : null); } });
    },
    watchColl(path, cb) {
      const pre = key(path) + '/';
      let last;
      return watch(db => {
        const docs = Object.entries(db).filter(([k]) => k.startsWith(pre) && !k.slice(pre.length).includes('/'))
          .map(([k, v]) => ({ id: k.slice(pre.length), ...v }));
        const j = JSON.stringify(docs); if (j !== last) { last = j; cb(docs); }
      });
    },
    _denied: denied,
  };
}

// ───────────────────────────── Domæne-API ─────────────────────────────
export async function createStore() {
  const choice = chooseBackend();
  const b = choice.kind === 'mock' ? mockBackend() : await firebaseBackend(choice.kind);

  const tokenKey = pid => 'sg:creator:' + pid;
  // Forlad gammel husstand: fjern mig fra memberUids (medmindre en anden af mine deltagere stadig er der),
  // eller slet husstanden, hvis den bliver helt tom.
  const leaveOps = (pid, leave) => !leave?.hid ? [] : leave.remove
    ? [{ op: 'remove', path: ['parties', pid, 'households', leave.hid] }]
    : leave.keepMember ? [] : [{ op: 'update', path: ['parties', pid, 'households', leave.hid], data: { memberUids: b.unionRemove(b.uid) } }];
  const store = {
    backend: choice,
    uid: b.uid,

    async createParty({ name, date, time, place, note }) {
      const id = randomId(24);
      const token = randomToken();
      await b.set(['parties', id], {
        name, date, time, place, note: note || '',
        creatorUid: b.uid, creatorHash: await sha256Hex(token),
        createdAt: b.ts(), updatedAt: b.ts(),
      });
      localStorage.setItem(tokenKey(id), token);
      return { id, token };
    },
    creatorToken: pid => localStorage.getItem(tokenKey(pid)),
    /** Er denne enhed opretter/administrator af gildet? */
    async isAdmin(party) {
      if (!party) return false;
      if (party.creatorUid === b.uid) return true;
      const t = localStorage.getItem(tokenKey(party.id));
      return !!t && (await sha256Hex(t)) === party.creatorHash;
    },
    /** Brug et admin-link (hemmelig nøgle) på en ny enhed. */
    async claimAdmin(party, token) {
      if ((await sha256Hex(token)) !== party.creatorHash) return false;
      if (party.creatorUid !== b.uid) await b.set(['parties', party.id, 'claims', b.uid], { key: token, createdAt: b.ts() });
      localStorage.setItem(tokenKey(party.id), token);
      return true;
    },
    updateParty: (pid, fields) => b.update(['parties', pid], { ...fields, updatedAt: b.ts() }),
    async deleteParty(pid, lists) {
      for (const sub of SUBS) for (const d of lists[sub] || []) await b.remove(['parties', pid, sub, d.id]);
      for (const d of await b.list(['parties', pid, 'activity']).catch(() => [])) await b.remove(['parties', pid, 'activity', d.id]);
      await b.remove(['parties', pid, 'subs', b.uid]).catch(() => {});
      await b.remove(['parties', pid]);
      await b.remove(['parties', pid, 'claims', b.uid]).catch(() => {});
      localStorage.removeItem(tokenKey(pid));
    },

    watchParty: (pid, cb, err) => b.watchDoc(['parties', pid], cb, err),
    watchSub: (pid, sub, cb, err) => b.watchColl(['parties', pid, sub], cb, err),

    async add(pid, sub, data) {
      const id = randomId(20);
      await b.set(['parties', pid, sub, id], { ...data, ownerUid: b.uid, createdAt: b.ts() });
      return id;
    },
    update: (pid, sub, id, data) => b.update(['parties', pid, sub, id], data),

    // ── Husstande ──────────────────────────────────────────────────────────
    // Alle husstands-ændringer der rører både husstanden og en deltager sker i én batch, så reglerne
    // kan tjekke medlemskab "efter" skrivningen (getAfter).
    /** Opret husstand med mig som medlem, og flyt min deltager ind. leave = {hid, keepMember} for gammel husstand. */
    async createHousehold(pid, name, myPid, leave) {
      const hid = randomId(20);
      await b.batch([
        { op: 'set', path: ['parties', pid, 'households', hid], data: { name, memberUids: [b.uid], createdByUid: b.uid, createdAt: b.ts() } },
        { op: 'update', path: ['parties', pid, 'participants', myPid], data: { householdId: hid } },
        ...leaveOps(pid, leave),
      ]);
      return hid;
    },
    /** Meld min deltager ind i en eksisterende husstand (ingen godkendelse). */
    joinHousehold: (pid, hid, myPid, leave) => b.batch([
      { op: 'update', path: ['parties', pid, 'households', hid], data: { memberUids: b.union(b.uid) } },
      { op: 'update', path: ['parties', pid, 'participants', myPid], data: { householdId: hid } },
      ...leaveOps(pid, leave),
    ]),
    /** Meld min deltager ud af husstanden. */
    leaveHousehold: (pid, myPid, leave) => b.batch([
      { op: 'update', path: ['parties', pid, 'participants', myPid], data: { householdId: '' } },
      ...leaveOps(pid, leave),
    ]),
    renameHousehold: (pid, hid, name) => b.update(['parties', pid, 'households', hid], { name }),
    /** Tilføj en person uden egen bruger (barn, partner …) til husstanden. */
    async addMember(pid, hid, { name, phone = '', isChild = false, status = 'yes' }) {
      const id = randomId(20);
      await b.set(['parties', pid, 'participants', id], { name, phone, isChild, status, householdId: hid, ownerUid: '', addedByUid: b.uid, createdAt: b.ts() });
      return id;
    },
    /** "Det er mig": overtag en person uden bruger. Samme ID, så retter og udgifter følger med. */
    claim: (pid, person, { name, phone, status, isChild }) => b.batch([
      ...(person.householdId ? [{ op: 'update', path: ['parties', pid, 'households', person.householdId], data: { memberUids: b.union(b.uid) } }] : []),
      { op: 'update', path: ['parties', pid, 'participants', person.id], data: { ownerUid: b.uid, name, phone, status,
        ...(typeof isChild === 'boolean' && isChild !== !!person.isChild ? { isChild } : {}) } },   // kun sendt ved ændring
    ]),

    /** Aktivitetslog til notifikationer. Fejl her må aldrig stoppe selve handlingen. */
    logActivity(pid, type, text, extra = {}) {
      return b.set(['parties', pid, 'activity', randomId(20)], { type, text: String(text).slice(0, 200), actorUid: b.uid,
        participantId: extra.participantId || '', ...(extra.hasCost ? { hasCost: true } : {}), createdAt: b.ts() })
        .catch(e => console.warn('aktivitet ikke logget', e));
    },
    // Notifikations-abonnement for denne enhed i dette gilde
    getSub: pid => b.get(['parties', pid, 'subs', b.uid]),
    saveSub: (pid, data, isNew) => b.set(['parties', pid, 'subs', b.uid],
      { ...data, updatedAt: b.ts(), ...(isNew ? { createdAt: b.ts() } : {}) }, true),
    deleteSub: pid => b.remove(['parties', pid, 'subs', b.uid]),
    ts: () => b.ts(),
    remove: (pid, sub, id) => b.remove(['parties', pid, sub, id]),
  };
  return store;
}
