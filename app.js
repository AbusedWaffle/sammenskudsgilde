import { createStore } from './data.js';
import { settle, parseKr, formatKr, headcount, statusOf, unitsOf } from './settle.js';
import { cleanPhone, prettyPhone, mobilepayPhone, isValidPhone } from './util.js';
import { DIET, DISH_TAGS, cleanTags, dietOverview, dishConflicts, buildIcs, googleCalendarUrl, icsFileName, openSuggestions, isTaken, emptyCourses } from './features.js';
import { pushSupport, subscribePush, localNotification, registerServiceWorker, isIOS as isIOSDevice, isStandalone, deviceLabel } from './push.js';

const APP_VERSION = '1.5';
const DEFAULT_TOPICS = { guests: true, items: true, party: true, costs: true, payments: true, reminder: true };
const TOPIC_LABELS = [['guests', '👋 Nye gæster'], ['items', '🍲 Nye retter, forslag og aktiviteter'], ['party', '📅 Ændringer i gildet og programmet'], ['costs', '💰 Nye udgifter'], ['payments', '💸 Betalinger og påmindelser om betaling'], ['reminder', '⏰ Påmindelse før festen']];

// ───────────────────────────── Hjælpere ─────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: k => localStorage.removeItem(k),
};
const COLORS = ['#e2583e', '#6fa47f', '#4f8fb8', '#8a4f7d', '#d9912a', '#3f7f7a', '#b8577a', '#6c6fb8'];
const colorFor = id => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
const initials = n => String(n || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = p => `<span class="avatar" style="background:${colorFor(p?.id)}">${esc(initials(p?.name))}</span>`;

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
}
async function copy(text, msg = 'Kopieret') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {} ta.remove();
  }
  toast(msg);
}
function errMsg(e) {
  if (e?.code === 'permission-denied') return 'Det har du ikke lov til (kun opretteren/ejeren kan).';
  if (/auth\/(admin-restricted-operation|operation-not-allowed|configuration-not-found)/.test(e?.code || e?.message || ''))
    return 'Anonym login er ikke slået til i Firebase (Authentication → Sign-in method → Anonymous).';
  if (e?.code === 'unavailable') return 'Ingen forbindelse – prøv igen om lidt.';
  return 'Noget gik galt: ' + (e?.message || e);
}
function fail(e) { console.warn(e); toast(errMsg(e), 3500); }

const dateFmt = new Intl.DateTimeFormat('da-DK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
function prettyDate(d, short = false) {
  if (!d) return '';
  const dt = new Date(d + 'T12:00:00'); if (isNaN(dt)) return d;
  const s = (short ? shortDateFmt : dateFmt).format(dt); return s[0].toUpperCase() + s.slice(1);
}
const isApple = /iPhone|iPad|Macintosh/.test(navigator.userAgent);
const mapsUrl = place => isApple ? `https://maps.apple.com/?q=${encodeURIComponent(place)}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}`;

// Link til et gilde. Evt. ?emulator=… / ?backend=mock bevares, så test-links virker.
const baseUrl = () => location.origin + location.pathname + location.search;
const partyUrl = pid => `${baseUrl()}#/p/${pid}`;
const adminUrl = (pid, token) => `${baseUrl()}#/p/${pid}/admin/${token}`;

const EVENT_ICONS = [[/forret|starter|suppe/i, '🥗'], [/hovedret|middag|aftensmad|grill/i, '🍲'], [/kaffe|brunch|morgen/i, '☕'], [/dessert|kage|is\b/i, '🍰'],
  [/drink|velkomst|vin|øl|bobler/i, '🥂'], [/natmad|snack/i, '🌭'],
  [/leg|spil|aktivitet|quiz|lege/i, '🎲'], [/musik|dans|fest/i, '🎶'], [/tale|sang/i, '🎤']];
const eventIcon = ev => (EVENT_ICONS.find(([re]) => re.test(ev.title)) || [0, ev.kind === 'program' ? '⏰' : '🍽️'])[1];
const STATUS = { yes: ['✅', 'Kommer', 'kommer'], maybe: ['🤔', 'Kommer måske', 'kommer måske'], no: ['❌', 'Kommer ikke', 'kommer ikke'] };
const CHILD_HELP = 'Børn betaler ikke med, når en udgift deles pr. person. Deles den pr. husstand, betaler husstanden det samme uanset antal børn.';
/** "Barn"-afkrydsning med kort forklaring. */
const childBox = (label, checked, t = 'is-child') => `<div class="childbox"><label><input type="checkbox" name="isChild" data-t="${t}" ${checked ? 'checked' : ''}> 🧒 ${label}</label>
  <p class="small muted" data-t="child-help">${CHILD_HELP}</p></div>`;
const ITEM_KINDS = { ret: ['🍽️', 'Ret'], aktivitet: ['🎲', 'Aktivitet'], andet: ['🎁', 'Andet'], udgift: ['🧾', 'Udgift'] };

// ── Kost og allergier (v1.5) ─────────────────────────────────────────────
const DIET_HELP = 'Så kan de andre tage hensyn, når de laver mad. Alle med linket kan se det.';
const dietOrder = list => Object.keys(DIET).filter(k => (list || []).includes(k));
/** Afkrydsning af kost/allergier + fritekst (bruges ved tilmelding, „Ret min tilmelding“ og husstandens personer). */
const dietBox = (p, t = 'diet-box') => {
  const sel = new Set(cleanTags(p?.diet, DIET));
  return `<div class="dietbox" data-t="${t}"><span class="lbl">🥗 Kost og allergier (valgfrit)</span>
    <div class="tagpick">${Object.entries(DIET).map(([k, [ic, l]]) => `<label class="tagchip"><input type="checkbox" name="diet" value="${k}" ${sel.has(k) ? 'checked' : ''} data-t="diet-${k}"><span>${ic} ${l}</span></label>`).join('')}</div>
    <input type="text" name="dietNote" maxlength="120" value="${esc(p?.dietNote || '')}" placeholder="Andet – fx ingen svampe, skaldyrsallergi" data-t="diet-note">
    <p class="small muted" data-t="diet-help">${DIET_HELP}</p></div>`;
};
const readDiet = f => ({ diet: dietOrder($$('input[name=diet]:checked', f).map(x => x.value)), dietNote: (f.dietNote?.value || '').trim().slice(0, 120) });
/** Kun ændrede kost-felter (tomme felter skrives ikke på nye poster – så virker det også med ældre regler). */
function dietUpd(f, old) {
  if (!f.querySelector('[name=diet]')) return {};
  const d = readDiet(f), o = {};
  if (d.diet.join() !== dietOrder(cleanTags(old?.diet, DIET)).join()) o.diet = d.diet;
  if (d.dietNote !== (old?.dietNote || '')) o.dietNote = d.dietNote;
  return o;
}
const dietChips = p => cleanTags(p?.diet, DIET).map(k => `<span class="dchip">${DIET[k][0]} ${DIET[k][1]}</span>`).join('') + (p?.dietNote ? `<span class="dchip">📝 ${esc(p.dietNote)}</span>` : '');
const dishBadges = it => cleanTags(it?.tags, DISH_TAGS).map(k => `<span class="dchip">${DISH_TAGS[k][0]} ${DISH_TAGS[k][1]}</span>`).join('');
const DIET_VERB = { noedder: ['har nøddeallergi', 'har nøddeallergi'], glutenfri: ['spiser glutenfrit', 'spiser glutenfrit'], laktosefri: ['spiser laktosefrit', 'spiser laktosefrit'],
  vegetar: ['er vegetar', 'er vegetarer'], vegansk: ['er veganer', 'er veganere'] };
const andList = xs => xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' og ' + xs.at(-1);
/** Diskret advarsel, hvis retten ikke passer til nogen, der kommer. */
function conflictHtml(it) {
  const c = dishConflicts(it, S.participants);
  return c.length ? `<div class="dwarn" data-t="diet-warn">${c.map(x => `⚠️ ${DISH_TAGS[x.tag][1]} – ${esc(andList(x.people.map(p => firstName(p.name))))} ${DIET_VERB[x.diet][x.people.length === 1 ? 0 : 1]}`).join('<br>')}</div>` : '';
}
const dishTagBox = it => {
  const sel = new Set(cleanTags(it?.tags, DISH_TAGS));
  return `<div class="dietbox" id="tag-box" data-t="dish-tags"><span class="lbl">🏷️ Kost og allergener (valgfrit)</span>
    <div class="tagpick">${Object.entries(DISH_TAGS).map(([k, [ic, l]]) => `<label class="tagchip"><input type="checkbox" name="tags" value="${k}" ${sel.has(k) ? 'checked' : ''} data-t="tag-${k}"><span>${ic} ${l}</span></label>`).join('')}</div>
    <p class="small muted">Så kan gæster med allergi eller særlig kost se, hvad de kan spise. Appen advarer diskret, hvis retten ikke passer til nogen, der kommer.</p></div>`;
};
const sugById = id => S.suggestions.find(x => x.id === id);
const sugOn = () => !S.sugDenied;
const payOn = () => !S.payDenied;

// ───────────────────────────── Tilstand ─────────────────────────────
let store;
const S = {
  view: 'home', pid: null, party: undefined, events: [], participants: [], items: [], households: [], suggestions: [], payments: [],
  loaded: {}, admin: false, tab: 'program', unsubs: [], error: null, justCreated: false,
};
window.__sg = S; // til fejlsøgning/tests

const meKey = pid => 'sg:me:' + pid;
const myId = () => LS.get(meKey(S.pid));
const me = () => S.participants.find(p => p.id === myId()) || null;
const pById = id => S.participants.find(p => p.id === id);
const pName = id => pById(id)?.name || 'Ukendt';
const canEditItem = it => it.ownerUid === store.uid || S.admin;
// Husstande
const hhById = id => (id && S.households.find(h => h.id === id)) || null;
const hhOfP = p => hhById(p?.householdId);
const isMemberOf = hid => !!hhById(hid)?.memberUids?.includes(store.uid);
const unclaimed = p => !p.ownerUid;
/** Må jeg rette personen? Værten alt; ejeren sig selv; husstandsmedlemmer personer uden bruger. */
const canEditPerson = p => !!p && (S.admin || p.ownerUid === store.uid || (unclaimed(p) && isMemberOf(p.householdId)));
// Serverens regler kender endnu ikke husstande (gammel regelversion) → skjul husstande/status/„Det er mig“
const hhOn = () => !S.hhDenied;
const householdMembers = hid => sortedPeople().filter(p => p.householdId === hid);
const firstName = n => String(n || '').split(' ')[0];
const sortedEvents = () => [...S.events].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
const sortedPeople = () => [...S.participants].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));

function rememberParty() {
  if (!S.party) return;
  const list = LS.get('sg:parties', []).filter(p => p.id !== S.pid);
  list.unshift({ id: S.pid, name: S.party.name, date: S.party.date || '', admin: S.admin, seen: Date.now() });
  LS.set('sg:parties', list.slice(0, 30));
}

// ───────────────────────────── Routing ─────────────────────────────
async function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const m = h.match(/^p\/([A-Za-z0-9]{20,40})(?:\/admin\/([0-9a-f]{64})|\/mig\/([A-Za-z0-9]{10,40}))?$/);
  closeSheet();
  if (!m) { stopWatching(); S.view = 'home'; S.pid = null; render(); return; }
  const [, pid, token, meId] = m;
  if (meId) { LS.set(meKey(pid), meId); history.replaceState(null, '', '#/p/' + pid); }
  if (token) sessionStorage.setItem('sg:pendingAdmin', JSON.stringify({ pid, token }));
  if (token) { history.replaceState(null, '', '#/p/' + pid); }
  if (S.pid !== pid) startWatching(pid);
  S.view = 'party';
  render();
}

function stopWatching() { S.unsubs.forEach(u => u()); S.unsubs = []; }
function startWatching(pid) {
  stopWatching();
  Object.assign(S, { pid, party: undefined, events: [], participants: [], items: [], households: [], suggestions: [], payments: [], loaded: {}, admin: false, error: null, tab: 'program', hhDenied: false, sugDenied: false, payDenied: false, skipClaim: false });
  const onErr = what => e => { console.warn(what, e); S.error = errMsg(e); render(); };
  S.unsubs.push(store.watchParty(pid, async party => {
    if (party) party.id = pid;
    S.party = party; S.loaded.party = true;
    if (party) {
      const pending = JSON.parse(sessionStorage.getItem('sg:pendingAdmin') || 'null');
      if (pending?.pid === pid) {
        sessionStorage.removeItem('sg:pendingAdmin');
        try { toast((await store.claimAdmin(party, pending.token)) ? 'Du kan nu redigere gildet fra denne enhed 👑' : 'Admin-linket passer ikke til dette gilde'); }
        catch (e) { fail(e); }
      } else if (store.creatorToken(pid) && party.creatorUid !== store.uid && !S.claimTried) {
        S.claimTried = true; store.claimAdmin(party, store.creatorToken(pid)).catch(() => {});
      }
      S.admin = await store.isAdmin(party);
      rememberParty();
    }
    render();
  }, onErr('party')));
  for (const sub of ['events', 'participants', 'items']) {
    S.unsubs.push(store.watchSub(pid, sub, docs => { S[sub] = docs; S.loaded[sub] = true; render(); }, onErr(sub)));
  }
  // Husstande: fejler stille (fx hvis serverens regler endnu ikke kender husstande) – så er alle deres egen husstand.
  S.unsubs.push(store.watchSub(pid, 'households', docs => { S.households = docs; S.loaded.households = true; render(); },
    e => { console.warn('husstande', e?.code || e); S.households = []; S.hhDenied = true; S.loaded.households = true; render(); }));
  // Forslag og betalinger (v1.5): fejler stille, hvis serverens regler endnu ikke kender dem – så skjules funktionerne.
  for (const [sub, flag] of [['suggestions', 'sugDenied'], ['payments', 'payDenied']]) {
    S.unsubs.push(store.watchSub(pid, sub, docs => { S[sub] = docs; S.loaded[sub] = true; render(); },
      e => { console.warn(sub, e?.code || e); S[sub] = []; S[flag] = true; S.loaded[sub] = true; render(); }));
  }
}

// ───────────────────────────── Render ─────────────────────────────
function render() {
  const app = $('#app');
  const y = scrollY;
  // Bevar indtastning i formularer på siden, når live-opdateringer tegner siden igen.
  const kept = $$('form[id] input:not([type=hidden]), form[id] textarea', app).map(el => ({ f: el.form.id, n: el.name, v: el.value, c: el.checked, box: el.type === 'checkbox', focus: el === document.activeElement, sel: el.selectionStart }));
  const openDetails = $$('details[id][open]', app).map(d => d.id);
  app.innerHTML = S.view === 'home' ? homeView() : partyView();
  for (const id of openDetails) { const d = document.getElementById(id); if (d) d.open = true; }
  for (const k of kept) {
    const el = (k.box && $(`form#${k.f} [name="${k.n}"][value="${CSS.escape(k.v)}"]`, app)) || $(`form#${k.f} [name="${k.n}"]`, app); if (!el) continue;
    if (k.box) el.checked = k.c; else el.value = k.v;
    if (k.focus) { el.focus(); try { el.setSelectionRange(k.sel, k.sel); } catch {} }
  }
  if (S.view === 'party' && S.tab === 'del') drawQr();
  scrollTo(0, y);
  if (S.justCreated && S.party && S.loaded.participants) { S.justCreated = false; afterCreate(); }
  if (S.justReused && S.party && S.loaded.participants && S.loaded.events) { const info = S.justReused; S.justReused = null; afterReuse(info); }
}

function topbar(back) {
  return `<div class="top">
    ${back ? `<a class="iconbtn" href="#/" aria-label="Til forsiden" data-t="home">←</a>` : ''}
    <a class="brand" href="#/"><img src="icon-192.png" alt=""><b>Sammen<span>skud</span>sgilde</b></a>
    <button class="iconbtn" data-act="help" aria-label="Sådan virker det">?</button>
    <button class="iconbtn" data-act="settings" data-t="settings" aria-label="Indstillinger">⚙️</button>
  </div>`;
}
function demoBanner() {
  const b = store.backend;
  if (b.kind === 'mock' && b.reason === 'unconfigured')
    return `<div class="demo"><b>Demotilstand:</b> Firebase er ikke sat op endnu, så alt gemmes kun i denne browser. Links virker ikke på andre telefoner.</div>`;
  if (b.kind === 'mock') return `<div class="demo"><b>Testtilstand (mock):</b> data gemmes kun i denne browser.</div>`;
  if (b.kind === 'emulator') return `<div class="demo"><b>Emulator:</b> forbundet til lokal Firebase-emulator.</div>`;
  return '';
}

function homeView() {
  const mine = LS.get('sg:parties', []);
  return `<div class="wrap">${topbar(false)}${demoBanner()}
  <div class="card hero">
    <div class="eyebrow">Hvem tager hvad med?</div>
    <h1>Planlæg et sammenskudsgilde 🥘</h1>
    <p class="muted" style="margin:0">Opret gildet, send linket til gæsterne, og lad alle skrive på, hvad de tager med. Appen holder styr på program, udgifter og hvem der skylder hvem.</p>
  </div>
  ${mine.length ? `<div class="card"><h2>Dine gilder</h2><div class="list-parties" style="margin-top:6px">
    ${mine.map(p => `<a href="#/p/${esc(p.id)}"><span style="font-size:24px">${p.admin ? '👑' : '🎉'}</span><span class="grow"><b>${esc(p.name)}</b><br><span class="small muted">${esc(prettyDate(p.date, true) || 'Ingen dato')}${p.admin ? ' · du er vært' : ''}</span></span><span class="muted">›</span></a>`).join('')}
  </div></div>` : ''}
  <form class="card" id="create-form" autocomplete="off">
    <h2>Nyt gilde</h2>
    <label class="f"><span>Navn på gildet *</span><input type="text" name="name" maxlength="120" required placeholder="F.eks. Høstfest i gården"></label>
    <div class="two">
      <label class="f"><span>Dato</span><input type="date" name="date"></label>
      <label class="f"><span>Tidspunkt</span><input type="time" name="time" value="18:00"></label>
    </div>
    <label class="f"><span>Sted / adresse</span><input type="text" name="place" maxlength="300" placeholder="F.eks. Havnegade 12, 8000 Aarhus"></label>
    <label class="f"><span>Besked til gæsterne (valgfri)</span><textarea name="note" maxlength="2000" placeholder="Tag gerne en stol med 🙂"></textarea></label>
    <div class="err" id="create-err"></div>
    <button class="btn primary block" style="margin-top:14px" data-t="create">Opret gilde</button>
  </form>
  ${isStandalone() || isIOSDevice ? `<div class="card" data-t="paste-card"><h3>🔗 Har du fået et link til et gilde?</h3>
    <p class="small muted" style="margin:4px 0 8px">Indsæt det her for at åbne gildet i appen.</p>
    <input type="text" id="paste-link" placeholder="https://…#/p/…" inputmode="url">
    <div class="row-actions"><button class="btn sm primary" data-act="open-pasted">Åbn gildet</button>
    ${navigator.clipboard?.readText ? '<button class="btn sm" data-act="paste-clip">📋 Indsæt link</button>' : ''}</div></div>` : ''}
  <p class="center small muted">Lavet til venner – ingen reklamer, ingen konto. <button class="linkbtn" data-act="help">Sådan virker det</button></p>
  </div>`;
}

function partyView() {
  if (S.error && !S.party) return `<div class="wrap">${topbar(true)}<div class="card empty"><div class="big">😕</div><h2>Kunne ikke hente gildet</h2><p>${esc(S.error)}</p><a class="btn" href="#/">Til forsiden</a></div></div>`;
  if (!S.loaded.party) return `<div class="wrap">${topbar(true)}<div class="loading" style="padding-top:18vh"><div class="pot">🍲</div><p>Henter gildet …</p></div></div>`;
  if (!S.party) return `<div class="wrap">${topbar(true)}<div class="card empty"><div class="big">🔎</div><h2>Gildet findes ikke</h2><p>Linket er forkert, eller gildet er slettet.</p><a class="btn" href="#/">Til forsiden</a></div></div>`;
  const p = S.party;
  const tabs = [['program', '🍽️', 'Program'], ['gaester', '👥', 'Gæster'], ['regnskab', '💰', 'Regnskab'], ['del', '🔗', 'Del']];
  const body = { program: programTab, gaester: guestsTab, regnskab: moneyTab, del: shareTab }[S.tab]();
  return `<div class="wrap tabs">${topbar(true)}${demoBanner()}
  <div class="card hero" data-t="hero">
    <div class="eyebrow">Sammenskudsgilde${S.admin ? ' · du er vært 👑' : ''}</div>
    <h1>${esc(p.name)}</h1>
    <div class="meta">
      ${p.date || p.time ? `<div class="row"><span class="ic">📅</span><span>${esc(prettyDate(p.date))}${p.date && p.time ? ' · ' : ''}${p.time ? 'kl. ' + esc(p.time) : ''}</span></div>` : ''}
      ${p.place ? `<div class="row"><span class="ic">📍</span><span>${esc(p.place)} · <a href="${esc(mapsUrl(p.place))}" target="_blank" rel="noopener">Vis på kort</a></span></div>` : ''}
    </div>
    ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
    ${heroCount()}
    <div class="row-actions">
      <button class="btn sm yellow" data-act="tab" data-tab="del">🔗 Inviter gæster</button>
      ${p.date ? `<button class="btn sm" data-act="calendar" data-t="calendar">📅 Tilføj til kalender</button>` : ''}
      ${S.admin ? `<button class="btn sm" data-act="edit-party" data-t="edit-party">✏️ Ret gildet</button>` : ''}
    </div>
  </div>
  ${identityBar()}
  ${body}
  </div>
  <nav class="tabbar"><div class="tabbar-in">${tabs.map(([k, i, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}" data-t="tab-${k}"><i>${i}</i>${l}</button>`).join('')}</div></nav>`;
}

function heroCount() {
  if (!S.loaded.participants || !S.participants.length) return '';
  const c = headcount(S.participants);
  const n = o => o.adults + o.children;
  return `<div class="hc-line" data-t="hero-count"><span>👥 <b>${n(c.yes)}</b> kommer</span>${n(c.maybe) ? `<span>🤔 <b>${n(c.maybe)}</b> måske</span>` : ''}${n(c.no) ? `<span>❌ <b>${n(c.no)}</b> kommer ikke</span>` : ''}</div>`;
}

function rsvpSeg(p, small = false) {
  const st = statusOf(p);
  return `<div class="seg rsvp${small ? ' sm' : ''}" data-t="rsvp" data-id="${p.id}">${Object.entries(STATUS).map(([k, [ic, l]]) =>
    `<button type="button" data-act="rsvp" data-id="${p.id}" data-v="${k}" class="${st === k ? 'on' : ''}" data-t="rsvp-${k}" aria-pressed="${st === k}" aria-label="${l}">${ic} ${(small ? { yes: 'Ja', maybe: 'Måske', no: 'Nej' } : { yes: 'Kommer', maybe: 'Måske', no: 'Kommer ikke' })[k]}</button>`).join('')}</div>`;
}

function identityBar() {
  if (!S.loaded.participants) return '';
  const m = me();
  if (m) {
    const hh = hhOfP(m);
    return `<div class="me col" data-t="me"><div class="me-row">${avatar(m)}<div class="grow"><div class="small muted">Du er tilmeldt som</div><b>${esc(m.name)}</b>
    <div class="small">${!hhOn() ? '' : hh ? `🏠 <button class="linkbtn small" data-act="tab" data-tab="gaester" data-t="me-household">${esc(hh.name)}</button>` : `<button class="linkbtn small" data-act="household-sheet" data-t="me-no-household">🏠 Kommer du med nogen? Opret husstand</button>`}</div>
    <div><button class="linkbtn small" data-act="not-me" data-t="not-me">Jeg er ikke ${esc(firstName(m.name))}</button></div></div>
    ${m.ownerUid === store.uid ? '<button class="btn sm ghost" data-act="edit-me" aria-label="Ret mine oplysninger">✏️ Ret</button>' : ''}</div>
    ${hhOn() ? rsvpSeg(m) : ''}</div>`;
  }
  const prof = LS.get('sg:profile', {});
  const mineHere = S.participants.filter(p => p.ownerUid === store.uid);
  const claimable = claimablePeople();
  return `${claimable.length && !S.skipClaim ? claimCard(claimable) : ''}<form class="card join" id="join-form" autocomplete="on">
    <h2>${claimable.length && !S.skipClaim ? 'Ellers: tilmeld dig som ny' : 'Hvem er du? 👋'}</h2>
    <p class="small muted" style="margin:4px 0 0">Skriv dit navn og telefonnummer, så de andre kan se hvem du er (og betale dig tilbage via MobilePay).</p>
    ${mineHere.length ? `<div class="chips" style="margin-top:10px">${mineHere.map(p => `<button type="button" class="chip solid" data-act="be" data-id="${p.id}">Jeg er ${esc(p.name)}</button>`).join('')}</div>` : ''}
    <label class="f"><span>Navn</span><input type="text" name="name" maxlength="60" required autocomplete="name" value="${esc(prof.name || '')}" placeholder="Dit navn"></label>
    <label class="f"><span>Telefonnummer</span><input type="tel" name="phone" maxlength="20" autocomplete="tel" inputmode="tel" value="${esc(prof.phone || '')}" placeholder="12 34 56 78"></label>
    ${childBox('Jeg er barn', false, 'join-child')}
    <details class="dietdetails" id="join-diet"><summary data-t="join-diet-open">🥗 Allergier eller særlig kost? (valgfrit)</summary>${dietBox(null, 'join-diet-box')}</details>
    <div class="err" id="join-err"></div>
    <button class="btn primary block" style="margin-top:12px" data-t="join">Tilmeld mig</button>
  </form>`;
}

const claimablePeople = () => hhOn() ? sortedPeople().filter(unclaimed) : [];
function claimCard(list) {
  return `<div class="card claim" data-t="claim-card"><h2>Er du en af disse? 👋</h2>
    <p class="small muted" style="margin:4px 0 8px">Nogen har allerede skrevet dig på. Tryk „Det er mig“, så overtager du din plads – med det, der allerede står på dig.</p>
    <ul class="people">${list.map(p => `<li class="person" data-t="claim-person">${avatar(p)}<div class="grow"><div class="nm">${esc(p.name)}${p.isChild ? ' <span class="muted small" data-t="claim-child">(barn)</span>' : ''}</div>
      <div class="small muted">${hhOfP(p) ? '🏠 ' + esc(hhOfP(p).name) : ''}${p.addedByUid ? ` · skrevet på af ${esc(adderName(p))}` : ''}</div></div>
      <button class="btn sm green" data-act="claim" data-id="${p.id}" data-t="claim">Det er mig</button></li>`).join('')}</ul>
    <p class="small muted" style="margin:10px 0 0">Ikke dig? <button class="linkbtn small" data-act="skip-claim" data-t="skip-claim">Nej, jeg er ny</button></p></div>`;
}
const adderName = p => S.participants.find(x => x.ownerUid && x.ownerUid === p.addedByUid)?.name || 'en anden gæst';

function itemRow(it) {
  const [ic] = ITEM_KINDS[it.kind] || ITEM_KINDS.ret;
  const bits = [esc(pName(it.participantId))];
  if (it.servings) bits.push(`til ${it.servings} pers.`);
  if (it.cost) bits.push(`<span class="cost">${formatKr(it.cost)}</span> (${splitText(it, true)})`);   // "Ingen": (deles ikke – betaler selv)
  const mine = it.participantId === myId();
  const sug = it.suggestionId && sugById(it.suggestionId);
  const fromSug = sug && sug.takenItemId === it.id;
  const canUndo = fromSug && (sug.takenByUid === store.uid || S.admin);
  const badges = dishBadges(it);
  return `<li class="item${mine ? ' mine' : ''}" data-t="item" data-title="${esc(it.title)}"><span class="it-ic">${ic}</span><div class="grow">
    <div class="t">${esc(it.title)}${fromSug ? ' <span class="tag sugtag" data-t="from-suggestion">💡 fra forslag</span>' : ''}</div><div class="s">${bits.join(' · ')}</div>${it.note ? `<div class="n">${esc(it.note)}</div>` : ''}
    ${badges ? `<div class="dchips">${badges}</div>` : ''}${conflictHtml(it)}
    ${canUndo ? `<button class="linkbtn small" data-act="untake-suggestion" data-id="${sug.id}" data-t="untake">↩︎ Fortryd – gør det til et forslag igen</button>` : ''}</div>
    ${canEditItem(it) ? `<button class="btn sm ghost" data-act="edit-item" data-id="${it.id}" aria-label="Ret">✏️</button>` : ''}</li>`;
}

function programTab() {
  const evs = sortedEvents();
  const presets = S.admin ? `<div class="card" data-t="presets"><h3>${evs.length ? 'Tilføj flere punkter' : 'Del gildet op i retter eller programpunkter'}</h3>
    <p class="small muted" style="margin:4px 0 10px">Vælg en skabelon eller lav dit eget punkt.</p>
    <div class="chips">
      ${!['Forret', 'Hovedret', 'Dessert'].some(t => evs.find(e => e.title === t)) ? `<button class="chip solid" data-act="preset" data-p="menu" data-t="preset-menu">🍽️ Forret + hovedret + dessert</button>` : ''}
      <button class="chip" data-act="preset" data-p="Forret">🥗 Forret</button>
      <button class="chip" data-act="preset" data-p="Hovedret">🍲 Hovedret</button>
      <button class="chip" data-act="preset" data-p="Dessert">🍰 Dessert</button>
      <button class="chip" data-act="new-event" data-kind="program" data-t="preset-program">⏰ Programpunkt med tid</button>
      <button class="chip" data-act="new-event" data-kind="ret">✏️ Eget punkt</button>
    </div></div>` : '';
  if (!S.loaded.events) return '';
  const loose = S.items.filter(i => !i.eventId || !S.events.find(e => e.id === i.eventId));
  const empties = new Set(emptyCourses(evs, S.items).map(e => e.id));
  const openSug = sugOn() ? openSuggestions(S.suggestions, S.items) : [];
  const cards = evs.map((ev, idx) => {
    const its = S.items.filter(i => i.eventId === ev.id).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const serv = its.filter(i => i.kind !== 'aktivitet').reduce((s, i) => s + (i.servings || 0), 0);
    const evSug = openSug.filter(x => x.eventId === ev.id);
    const lower = ev.title.toLowerCase();
    return `<section class="card event" data-t="event" data-title="${esc(ev.title)}">
      <div class="ev-head"><span class="ev-ic">${eventIcon(ev)}</span>
        <div class="ev-title"><h3>${ev.time ? `<span class="time">${esc(ev.time)}</span>` : ''}${esc(ev.title)}</h3>
        <div class="ev-sum">${its.length ? `${its.length} ${its.length === 1 ? 'bidrag' : 'bidrag'}${serv ? ` · mad til ca. ${serv} pers.` : ''}` : empties.has(ev.id) ? 'Ingen bidrag endnu' : 'Ingen har skrevet sig på endnu'}</div></div>
        ${S.admin ? `<div class="admin-bar">${idx > 0 ? `<button class="btn sm ghost" data-act="move-event" data-id="${ev.id}" data-dir="-1" aria-label="Flyt op">↑</button>` : ''}<button class="btn sm ghost" data-act="edit-event" data-id="${ev.id}" aria-label="Ret punkt">⋯</button></div>` : ''}
      </div>
      ${its.length ? `<ul class="items">${its.map(itemRow).join('')}</ul>` : ''}
      ${empties.has(ev.id) && S.loaded.items ? `<div class="hint" data-t="course-hint">💡 Ingen har meldt ${esc(lower)} endnu. Tag noget med – eller foreslå noget, så en anden kan tage det.</div>` : ''}
      ${evSug.length ? `<div class="sugline" data-t="event-suggestions">💡 Forslag: ${evSug.map(x => `<button class="chip" data-act="take-suggestion" data-id="${x.id}">${esc(x.title)} · jeg tager den</button>`).join(' ')}</div>` : ''}
      <div class="ev-foot"><button class="addbtn" data-act="new-item" data-event="${ev.id}" data-t="add-item">+ Jeg tager noget med</button>
        ${sugOn() && ev.kind !== 'program' ? `<button class="linkbtn small" data-act="new-suggestion" data-event="${ev.id}" data-t="suggest-for-event">💡 Foreslå noget til ${esc(lower)}</button>` : ''}</div>
    </section>`;
  }).join('');
  const empty = !evs.length ? `<div class="card empty"><div class="big">🍽️</div><p>${S.admin ? 'Tilføj forret, hovedret, dessert eller programpunkter herover – så kan gæsterne skrive sig på.' : 'Værten har ikke lagt program eller retter ind endnu. Du kan stadig skrive, hvad du tager med:'}</p>
    ${!S.admin ? `<button class="btn" data-act="new-item" data-event="">+ Jeg tager noget med</button>` : ''}</div>` : '';
  const looseCard = loose.filter(i => i.kind !== 'udgift').length ? `<section class="card event"><div class="ev-head"><span class="ev-ic">🧺</span><div class="ev-title"><h3>Andet</h3></div></div>
    <ul class="items">${loose.filter(i => i.kind !== 'udgift').map(itemRow).join('')}</ul><div class="ev-foot"></div></section>` : '';
  return dietLine() + suggestionsCard() + (evs.length ? cards + presets : presets + empty) + looseCard;
}

/** Diskret påmindelse om kost/allergier øverst i programmet. */
function dietLine() {
  const d = dietOverview(S.participants);
  return d.text ? `<div class="dline" data-t="diet-line">🥗 Husk: <b>${esc(d.text)}</b> <button class="linkbtn small" data-act="tab" data-tab="gaester">Se mere</button></div>` : '';
}

/** "Det mangler vi": forslag som alle kan tilføje, og som en gæst kan tage. */
function suggestionsCard() {
  if (!sugOn() || !S.loaded.suggestions) return '';
  const open = openSuggestions(S.suggestions, S.items);
  const taken = S.suggestions.filter(x => isTaken(x, S.items));
  const evName = id => S.events.find(e => e.id === id)?.title;
  const canDel = x => x.ownerUid === store.uid || S.admin;
  return `<div class="card sug" data-t="suggestions"><div class="sug-head"><h2>💡 Det mangler vi</h2>
    <button class="btn sm primary" data-act="new-suggestion" data-event="" data-t="new-suggestion">+ Foreslå</button></div>
    <p class="small muted" style="margin:4px 0 0">${open.length ? 'Kan du tage noget af det her med? Tryk „Jeg tager den“ – så står det på dig.' : taken.length ? 'Alt er taget – tak! 🎉 Mangler der mere, så foreslå det.' : 'Mangler der noget – is, stole, isterninger? Foreslå det, så kan en anden trykke „Jeg tager den“.'}</p>
    ${open.length ? `<ul class="sugs">${open.map(x => `<li data-t="suggestion" data-title="${esc(x.title)}"><div class="grow"><b>${esc(x.title)}</b>
      <div class="small muted">${evName(x.eventId) ? `til ${esc(evName(x.eventId))} · ` : ''}foreslået af ${esc(x.byPid && pById(x.byPid) ? firstName(pName(x.byPid)) : 'en gæst')}</div>${x.note ? `<div class="small">${esc(x.note)}</div>` : ''}</div>
      <button class="btn sm green" data-act="take-suggestion" data-id="${x.id}" data-t="take">✋ Jeg tager den</button>
      ${canDel(x) ? `<button class="btn sm ghost" data-act="delete-suggestion" data-id="${x.id}" data-t="delete-suggestion" aria-label="Slet forslaget">🗑️</button>` : ''}</li>`).join('')}</ul>` : ''}
    ${taken.length ? `<details class="taken" id="sug-taken"><summary data-t="taken-summary">✔️ Taget (${taken.length})</summary><ul class="sugs">${taken.map(x => `<li data-t="taken-suggestion"><div class="grow"><b>${esc(x.title)}</b> <span class="small muted">– ${esc(firstName(pName(S.items.find(i => i.id === x.takenItemId)?.participantId)))} tager den</span></div>
      ${x.takenByUid === store.uid || S.admin ? `<button class="btn sm ghost" data-act="untake-suggestion" data-id="${x.id}">↩︎ Fortryd</button>` : ''}</li>`).join('')}</ul></details>` : ''}
  </div>`;
}

function guestsTab() {
  const ps = sortedPeople();
  if (!ps.length) return `<div class="card empty"><div class="big">👥</div><p>Ingen er tilmeldt endnu. Del linket med gæsterne!</p><button class="btn yellow" data-act="tab" data-tab="del">🔗 Inviter gæster</button></div>`;
  const c = headcount(ps);
  const cnt = o => `${o.adults} ${o.adults === 1 ? 'voksen' : 'voksne'}${o.children ? ` · ${o.children} ${o.children === 1 ? 'barn' : 'børn'}` : ''}`;
  const units = unitsOf(ps, S.households);
  const hhUnits = units.filter(u => u.household), solos = units.filter(u => !u.household);
  const m = me();
  return `<div class="card" data-t="headcount"><h2>Gæsteliste</h2>
    <div class="hc" style="margin-top:10px">
      <div class="hc-yes"><b data-t="hc-yes">${c.yes.adults + c.yes.children}</b><span>✅ Kommer</span><small>${cnt(c.yes)}</small></div>
      <div class="hc-maybe"><b data-t="hc-maybe">${c.maybe.adults + c.maybe.children}</b><span>🤔 Måske</span><small>${cnt(c.maybe)}</small></div>
      <div class="hc-no"><b data-t="hc-no">${c.no.adults + c.no.children}</b><span>❌ Kommer ikke</span><small>${cnt(c.no)}</small></div>
    </div></div>
  ${dietCard(ps, m)}
  ${m && hhOn() ? myHouseholdCard(m) : ''}
  ${hhUnits.map(u => householdCard(u)).join('')}
  ${solos.length ? `<div class="card" data-t="solo-card"><h3>${hhUnits.length ? 'Uden husstand' : `Gæster (${ps.length})`}</h3><ul class="people" style="margin-top:6px">${solos.map(u => personRow(u.members[0])).join('')}</ul></div>` : ''}`;
}

function dietCard(ps, m) {
  const d = dietOverview(ps);
  if (!d.text && !d.notes.length) return m ? `<div class="card slim" data-t="diet-overview"><p class="small muted" style="margin:0">🥗 Allergier eller særlig kost? Skriv det under <button class="linkbtn small" data-act="edit-me">Ret min tilmelding</button> – så kan de andre tage hensyn.</p></div>` : '';
  return `<div class="card" data-t="diet-overview"><h3>🥗 Kost og allergier</h3>
    ${d.text ? `<p style="margin:6px 0 4px" data-t="diet-summary"><b>${esc(d.text)}</b></p>` : ''}
    ${d.notes.map(n => `<div class="small">📝 <b>${esc(n.name)}</b>: ${esc(n.note)}</div>`).join('')}
    <p class="small muted" style="margin:8px 0 0">Tæller dem, der kommer eller måske kommer. Retter kan mærkes med fx „Indeholder nødder“ – så advarer appen diskret. Ret dit eget under ⚙️ → Ret min tilmelding.</p></div>`;
}

function personRow(p) {
  const its = S.items.filter(i => i.participantId === p.id && i.kind !== 'udgift');
  const host = p.ownerUid && p.ownerUid === S.party.creatorUid;
  const st = statusOf(p), edit = canEditPerson(p), mine = p.id === myId();
  const info = [p.phone ? `<a href="tel:${esc(cleanPhone(p.phone))}">${esc(prettyPhone(p.phone))}</a>` : (unclaimed(p) ? `skrevet på af ${esc(adderName(p))}` : 'Intet nummer')];
  if (its.length) info.push(its.map(i => esc(i.title)).join(', '));
  return `<li class="person${st === 'no' ? ' is-no' : ''}" data-t="person" data-name="${esc(p.name)}">${avatar(p)}<div class="grow"><div class="nm">${mine && p.ownerUid === store.uid ? `<button class="linkbtn nmbtn" data-act="edit-me" title="Ret min tilmelding">${esc(p.name)}</button>` : esc(p.name)}${mine ? '<span class="tag">dig</span>' : ''}${host ? '<span class="tag host">vært</span>' : ''}${p.isChild ? '<span class="tag kid">barn</span>' : ''}</div>
      <div class="small muted">${info.join(' · ')}</div>
      ${dietChips(p) ? `<div class="dchips" data-t="person-diet">${dietChips(p)}</div>` : ''}
      ${!hhOn() ? '' : edit && !mine ? rsvpSeg(p, true) : `<div class="st st-${st}" data-t="status">${STATUS[st][0]} ${STATUS[st][1]}</div>`}</div>
      ${mine && p.ownerUid === store.uid ? `<button class="btn sm ghost" data-act="edit-me" data-t="edit-me-row" aria-label="Ret min tilmelding">✏️</button>`
        : edit && !mine && hhOn() ? `<button class="btn sm ghost" data-act="edit-person" data-id="${p.id}" data-t="edit-person" aria-label="Ret ${esc(p.name)}">✏️</button>`
        : edit && !mine ? `<button class="btn sm ghost" data-act="remove-person" data-id="${p.id}" data-t="remove-person" aria-label="Fjern">✕</button>` : ''}</li>`;
}

function householdCard(u) {
  const h = u.household, m = me();
  const coming = u.members.filter(p => statusOf(p) !== 'no').length;
  const canJoin = m && m.householdId !== h.id && m.ownerUid === store.uid;
  return `<div class="card hh" data-t="household" data-name="${esc(h.name)}"><div class="hh-head"><span class="hh-ic">🏠</span><div class="grow"><h3>${esc(h.name)}</h3>
    <div class="small muted">${u.members.length} ${u.members.length === 1 ? 'person' : 'personer'} · ${coming} kommer</div></div>
    ${canJoin ? `<button class="btn sm" data-act="join-household" data-id="${h.id}" data-t="join-household">Tilføj mig</button>` : ''}</div>
    <ul class="people" style="margin-top:6px">${u.members.map(personRow).join('')}</ul>
    ${isMemberOf(h.id) || S.admin ? `<div class="ev-foot"><button class="addbtn" data-act="add-member" data-id="${h.id}" data-t="add-member">+ Tilføj person (partner, barn …)</button>
      <div class="hh-links"><button class="linkbtn small" data-act="rename-household" data-id="${h.id}" data-t="rename-household">✏️ Omdøb</button>
      ${m && m.householdId === h.id && m.ownerUid === store.uid ? `<button class="linkbtn small" data-act="leave-household" data-t="leave-household">Meld mig ud</button>` : ''}</div></div>` : ''}</div>`;
}

function myHouseholdCard(m) {
  const hh = hhOfP(m);
  if (hh) return '';   // vises som almindeligt husstandskort med knapper
  if (m.ownerUid !== store.uid) return '';
  const others = S.households;
  return `<div class="card" data-t="my-household"><h3>🏠 Kommer du med nogen?</h3>
    <p class="small muted" style="margin:4px 0 0">Lav en husstand, og skriv partner, børn eller andre på, som ikke selv har appen. Husstanden får ét samlet regnskab.</p>
    <div class="row-actions"><button class="btn sm primary" data-act="household-sheet" data-t="open-household">🏠 Opret husstand</button>
    ${others.length ? `<button class="btn sm" data-act="household-sheet" data-t="open-join">Tilføj mig til en husstand</button>` : ''}</div></div>`;
}

function splitText(it, short = false) {
  if (it.split === 'none') return short ? 'deles ikke – betaler selv' : '<span class="tag none" data-t="split-none-tag">deles ikke – betaler selv</span>';
  if (it.split === 'households') {
    const n = (it.among || []).length;
    return n ? `deles pr. husstand mellem ${n}` : 'deles pr. husstand';
  }
  if (it.split === 'selected') {
    const ids = (it.among || []).filter(id => pById(id) && !pById(id).isChild);
    return short ? `deles af ${ids.length}` : 'deles af ' + ids.map(pName).map(esc).join(', ');
  }
  return 'deles af alle';
}

function computeSettlement() {
  const ps = sortedPeople();
  const costs = S.items.filter(i => i.cost > 0).map(i => ({ id: i.id, title: i.title, payer: i.participantId, amount: i.cost, split: i.split || 'all', among: i.among || [] }));
  return { ps, r: settle(ps, costs, S.households, payOn() ? S.payments : []) };
}
/** Må jeg handle på vegne af enheden (husstand: medlem; enlig: ejeren)? */
function unitCanAct(u) {
  if (!u) return false;
  return u.household ? isMemberOf(u.id) : u.members.some(m => m.ownerUid && m.ownerUid === store.uid);
}
const unitPids = u => (u?.members || []).map(m => m.id);
/** Hvem i enheden betaler (mig, hvis jeg er med – ellers en med bruger)? */
const payerOf = u => u.members.find(m => m.id === myId()) || u.members.find(m => m.ownerUid) || u.members[0];
const remindKey = (from, to) => `sg:remind:${S.pid}:${from}>${to}`;
const hhmm = ms => new Date(ms).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
/** Navn på en husstand/enhed i regnskabet: "Familien Wriedt" + dem med bruger; enkeltpersoner med navn. */
function unitLabel(u) {
  if (!u) return { name: 'Ukendt', sub: '' };
  if (!u.household) return { name: u.members[0]?.name || u.name, sub: '' };
  const users = u.members.filter(m => m.ownerUid);
  return { name: u.household.name, sub: (users.length ? users : u.members).map(m => firstName(m.name)).join(', ') };
}
/** Hvem i husstanden skal have pengene? Den, der har lagt mest ud (med telefon), ellers en med bruger og telefon. */
function payeeOf(u, r) {
  const paid = {};
  for (const e of r.entries) if (e.payerUnit === u.id) paid[e.payer] = (paid[e.payer] || 0) + e.amount;
  const withPhone = u.members.filter(m => m.phone);
  return withPhone.sort((a, b) => (paid[b.id] || 0) - (paid[a.id] || 0) || (b.ownerUid ? 1 : 0) - (a.ownerUid ? 1 : 0))[0] || u.members.find(m => m.ownerUid) || u.members[0];
}

function moneyTab() {
  const { ps, r } = computeSettlement();
  const meId = myId();
  const meUnit = meId ? r.unitOf[meId] : null;
  const party = S.party;
  const unit = id => r.units.find(u => u.id === id);
  const costItems = S.items.filter(i => i.cost > 0).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const addBtn = `<button class="btn block" data-act="new-item" data-event="" data-kind="udgift" data-t="add-expense">🧾 Tilføj en udgift (vin, leje, indkøb …)</button>`;
  const unsharedCard = r.unshared.length ? `<p class="small muted" style="margin:10px 0 0" data-t="unshared-note">${formatKr(r.unsharedTotal)} er markeret „Ingen“ (deles ikke) – den, der har betalt, betaler selv, og det er ikke med i regnskabet.</p>` : '';
  const costList = () => `<div class="card"><h2>Udgifter</h2><ul class="items" style="padding:0;margin-top:6px">
    ${costItems.map(i => `<li class="item${i.split === 'none' ? ' unshared' : ''}" data-t="cost-item"><span class="it-ic">${(ITEM_KINDS[i.kind] || ITEM_KINDS.ret)[0]}</span><div class="grow"><div class="t">${esc(i.title)}</div>
      <div class="s">Betalt af ${esc(pName(i.participantId))} · ${splitText(i)}</div></div>
      <span class="cost">${formatKr(i.cost)}</span>${canEditItem(i) ? `<button class="btn sm ghost" data-act="edit-item" data-id="${i.id}" aria-label="Ret">✏️</button>` : ''}</li>`).join('')}
  </ul>${unsharedCard}<div style="margin-top:12px">${addBtn}</div></div>`;
  if (!r.total && costItems.length) return `<div class="card" data-t="summary"><h2>Regnskab</h2><p class="muted" style="margin:8px 0 0">Alle er kvit – ingen skylder noget. 🎉</p></div>${costList()}`;
  if (!r.total) return `<div class="card empty"><div class="big">💰</div><p>Ingen udgifter endnu. Når nogen skriver en pris på det, de tager med, eller tilføjer en udgift, regner appen ud hvem der skylder hvem – samlet pr. husstand.</p>${addBtn}</div>`;
  const hasHh = r.units.some(u => u.household);
  const transfers = r.transfers.map(t => {
    const fromU = unit(t.from), toU = unit(t.to);
    const fl = unitLabel(fromU), tl = unitLabel(toU);
    const to = payeeOf(toU, r);
    const cls = t.from === meUnit ? 'me-pay' : t.to === meUnit ? 'me-get' : '';
    const kr = (t.amount / 100).toFixed(2);
    const mpPhone = mobilepayPhone(to?.phone);
    const comment = `Sammenskud: ${party.name}`.slice(0, 60);
    const mp = `mobilepay://send?phone=${encodeURIComponent(mpPhone)}&amount=${kr}&comment=${encodeURIComponent(comment)}&lock=1`;
    const sms = `sms:${cleanPhone(to?.phone)}${isApple ? '&' : '?'}body=${encodeURIComponent(`Hej ${firstName(to?.name)}! Jeg har sendt ${formatKr(t.amount)} for ${party.name} 🙂`)}`;
    const who = (u, l) => `<span class="tr-party">${avatar({ id: u.id, name: l.name })}<span><b>${esc(l.name)}</b>${l.sub ? `<small>${esc(l.sub)}</small>` : ''}</span></span>`;
    const pdata = `data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amount="${t.amount}"`;
    const reminded = LS.get(remindKey(t.from, t.to));
    const canRemind = (unitCanAct(toU) || S.admin) && fromU.members.some(m => m.ownerUid);
    const payBtns = payOn() ? `<div class="pay-row"><span class="pstat miss" data-t="pay-status">⏳ Mangler</span>
      ${unitCanAct(fromU) ? `<button class="btn sm green" data-act="pay-mark" ${pdata} data-t="pay-mark">✅ ${fromU.household ? 'Vi har' : 'Jeg har'} betalt</button>` : ''}
      ${unitCanAct(toU) || S.admin ? `<button class="btn sm" data-act="pay-receive" ${pdata} data-t="pay-receive">💰 Modtaget</button>` : ''}
      ${canRemind ? `<button class="btn sm ghost" data-act="pay-remind" ${pdata} data-t="pay-remind">🔔 Send påmindelse</button>` : ''}
      ${reminded && canRemind ? `<span class="small muted" data-t="reminded">Påmindelse sendt ${new Date(reminded).toDateString() === new Date().toDateString() ? 'i dag' : prettyDate(new Date(reminded).toISOString().slice(0, 10), true)} kl. ${hhmm(reminded)}</span>` : ''}</div>` : '';
    return `<div class="transfer ${cls}" data-t="transfer" data-from="${esc(t.from)}" data-to="${esc(t.to)}">
      ${cls === 'me-pay' ? `<div class="tr-who">${fromU.household ? 'I skal betale' : 'Du skal betale'}</div>` : cls === 'me-get' ? `<div class="tr-who">${toU.household ? 'I skal have' : 'Du skal have'}</div>` : ''}
      <div class="tr-line">${who(fromU, fl)} <span class="muted">→</span> ${who(toU, tl)}<span class="tr-amt mono">${formatKr(t.amount)}</span></div>
      ${to?.phone ? `<div class="small muted" style="margin-top:6px">MobilePay til <b style="color:var(--ink)">${esc(firstName(to.name))}</b> på <b class="mono" style="color:var(--ink)">${esc(prettyPhone(to.phone))}</b> · beløb <b class="mono" style="color:var(--ink)">${formatKr(t.amount)}</b></div>
      <div class="tr-actions">
        <button class="btn sm" data-act="copy" data-text="${esc(mpPhone)}" data-msg="Nummeret ${esc(prettyPhone(to.phone))} er kopieret">📋 Kopiér nr.</button>
        <button class="btn sm" data-act="copy" data-text="${esc(kr.replace('.', ','))}" data-msg="Beløbet ${esc(formatKr(t.amount))} er kopieret">📋 Kopiér beløb</button>
        ${t.from === meUnit || !meId ? `<a class="btn sm mp full" href="${esc(mp)}" data-act="mobilepay">Åbn MobilePay</a>` : ''}
        ${t.from === meUnit ? `<a class="btn sm ghost full" href="${esc(sms)}">💬 Send SMS til ${esc(firstName(to.name))}</a>` : ''}
      </div>` : '<div class="small muted" style="margin-top:6px">Ingen i den husstand har skrevet et telefonnummer.</div>'}
      ${payBtns}
    </div>`;
  }).join('');
  const hasPay = r.settled.length > 0;
  const coming = ps.filter(p => statusOf(p) !== 'no' && !p.isChild).length || ps.length;
  return `<div class="card" data-t="summary"><h2>Regnskab</h2>
    <div class="bigsum" style="margin-top:10px"><div><b class="mono" data-t="total">${formatKr(r.total)}</b><span>i alt</span></div><div><b>${r.units.length}</b><span>${hasHh ? 'husstande' : 'deltagere'}</span></div><div><b class="mono">${formatKr(Math.round(r.total / Math.max(1, coming)))}</b><span>gns. pr. voksen</span></div></div>
  </div>
  ${S.admin && payOn() ? hostOverview(r, unit) : ''}
  <div class="card"><h2>Hvem skylder hvem</h2>
    ${hasHh ? '<p class="small muted" style="margin:4px 0 8px">Samlet pr. husstand – én overførsel pr. husstand.</p>' : ''}
    ${payOn() && r.transfers.length ? '<p class="small muted" style="margin:4px 0 8px">Har I betalt, så tryk „Jeg har betalt“ – modtageren bekræfter „Modtaget“. Betalinger tæller med, også hvis udgifterne ændres bagefter.</p>' : ''}
    ${r.transfers.length ? transfers + `<p class="small muted" style="margin:12px 0 0">„Åbn MobilePay“ forsøger at åbne appen med nummer og beløb udfyldt. MobilePay understøtter ikke dette officielt – sker der ikke noget, så kopiér nummeret og beløbet.</p>` : `<p class="muted" data-t="all-settled">${hasPay ? 'Alt er betalt – ingen skylder noget. 🎉' : 'Alle er kvit – ingen skylder noget. 🎉'}</p>`}
  </div>
  ${hasPay ? paymentsCard(r, unit) : ''}
  <div class="card"><h2>${hasHh ? 'Pr. husstand' : 'Pr. person'}</h2>
    <table class="tbl" style="margin-top:6px" data-t="table"><thead><tr><th>${hasHh ? 'Husstand' : 'Navn'}</th><th>Betalt</th><th>Andel</th><th>${hasPay ? 'Rest' : 'Saldo'}</th></tr></thead><tbody>
    ${r.units.map(u => { const b = r.balance[u.id], l = unitLabel(u); const moved = r.sent[u.id] - r.received[u.id]; return `<tr data-t="unit-row" data-unit="${esc(u.id)}"><td>${esc(l.name)}${u.id === meUnit ? ' <span class="tag">dig</span>' : ''}${u.household ? `<div class="small muted">${u.members.length} pers.</div>` : ''}${moved ? `<div class="small muted" data-t="moved">${moved > 0 ? 'har overført' : 'har modtaget'} ${formatKr(Math.abs(moved))}</div>` : ''}</td><td>${formatKr(r.paid[u.id])}</td><td>${formatKr(r.share[u.id])}</td><td class="${b > 0 ? 'pos' : b < 0 ? 'neg' : ''}">${b > 0 ? '+' : ''}${formatKr(b)}</td></tr>`; }).join('')}
    </tbody></table>
    <p class="small muted" style="margin:10px 0 0">Plus = skal have penge tilbage. Minus = skylder. „Deles af alle“ og „udvalgte“ er pr. voksen: børn og dem, der har meldt „Kommer ikke“, betaler ikke med. „Pr. husstand“ er lige meget pr. husstand, uanset antal børn. Har et barn lagt ud, får det pengene tilbage. Udgifter med „Ingen“ er ikke med – den, der har betalt, betaler selv.${hasPay ? ' Registrerede betalinger er trukket fra: „Rest“ er det, der mangler.' : ''} Deles et beløb ikke lige op, fordeles de sidste ører på de første tilmeldte.</p>
  </div>
  ${costList()}`;
}

/** Registrerede betalinger med status og knapper. */
function paymentsCard(r, unit) {
  const list = [...r.settled].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return `<div class="card" data-t="payments"><h2>Betalinger</h2><ul class="pays">${list.map(pm => {
    const fu = unit(pm.from), tu = unit(pm.to), fl = unitLabel(fu), tl = unitLabel(tu);
    const conf = pm.status === 'confirmed';
    const canConfirm = !conf && (unitCanAct(tu) || S.admin);
    const canUndo = (!conf && pm.ownerUid === store.uid) || (conf && (pm.confirmedByUid === store.uid || S.admin));
    const who = uid => { const p = S.participants.find(x => x.ownerUid === uid); return p ? firstName(p.name) : ''; };
    return `<li data-t="payment" data-status="${pm.status}"><div class="grow"><b>${esc(fl.name)} → ${esc(tl.name)}</b> <span class="mono">${formatKr(pm.amount)}</span>
      <div class="small ${conf ? 'ok' : 'wait'}" data-t="payment-status">${conf ? `✔️ Bekræftet modtaget${who(pm.confirmedByUid) ? ' af ' + esc(who(pm.confirmedByUid)) : ''}` : `🕓 Markeret betalt${who(pm.ownerUid) ? ' af ' + esc(who(pm.ownerUid)) : ''} – venter på, at ${esc(tl.name)} bekræfter`}</div>
      <div class="row-actions">${canConfirm ? `<button class="btn sm green" data-act="pay-confirm" data-id="${pm.id}" data-t="pay-confirm">✔️ Modtaget</button><button class="btn sm ghost" data-act="pay-reject" data-id="${pm.id}" data-t="pay-reject">Ikke modtaget</button>` : ''}
      ${canUndo && !canConfirm ? `<button class="btn sm ghost" data-act="pay-undo" data-id="${pm.id}" data-t="pay-undo">↩︎ Fortryd</button>` : ''}</div></div></li>`;
  }).join('')}</ul>
  <p class="small muted" style="margin:8px 0 0">„Markeret betalt“ tæller med med det samme. Siger modtageren „Ikke modtaget“, forsvinder markeringen, og beløbet mangler igen.</p></div>`;
}

/** Værtens overblik: hvem mangler at betale, hvad venter på bekræftelse. */
function hostOverview(r, unit) {
  if (!r.transfers.length && !r.settled.length) return '';
  const miss = r.transfers, wait = r.settled.filter(x => x.status !== 'confirmed'), done = r.settled.filter(x => x.status === 'confirmed');
  const sum = xs => formatKr(xs.reduce((a, x) => a + x.amount, 0));
  const remindable = miss.filter(t => unit(t.from).members.some(m => m.ownerUid));
  return `<div class="card host" data-t="host-overview"><h2>👑 Overblik for værten</h2>
    <div class="bigsum" style="margin-top:8px"><div><b data-t="ov-miss">${miss.length}</b><span>mangler (${sum(miss)})</span></div><div><b data-t="ov-wait">${wait.length}</b><span>venter på bekræftelse</span></div><div><b data-t="ov-done">${done.length}</b><span>bekræftet</span></div></div>
    ${miss.length ? `<ul class="pays">${miss.map(t => { const fu = unit(t.from), tu = unit(t.to); return `<li data-t="ov-row"><div class="grow"><b>${esc(unitLabel(fu).name)}</b> mangler ${formatKr(t.amount)} <span class="small muted">til ${esc(unitLabel(tu).name)}</span></div>
      ${fu.members.some(m => m.ownerUid) ? `<button class="btn sm ghost" data-act="pay-remind" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amount="${t.amount}" data-t="ov-remind">🔔</button>` : '<span class="small muted">ingen app</span>'}</li>`; }).join('')}</ul>` : '<p class="muted" style="margin:8px 0 0">Alle har betalt 🎉</p>'}
    ${remindable.length > 1 ? `<div class="actions"><button class="btn sm" data-act="pay-remind-all" data-t="pay-remind-all">🔔 Send påmindelse til alle, der mangler (${remindable.length})</button></div>` : ''}
    <p class="small muted" style="margin:8px 0 0">Påmindelser kommer som notifikation hos dem, der har slået notifikationer (og „Betalinger“) til.</p></div>`;
}

/** "Jeg har betalt" / "Modtaget": registrér en betaling (beløbet kan rettes ved delbetaling). */
function paySheet(mode, fromId, toId, amount) {
  const { r } = computeSettlement();
  const fu = r.units.find(u => u.id === fromId), tu = r.units.find(u => u.id === toId);
  if (!fu || !tu) return;
  const fl = unitLabel(fu).name, tl = unitLabel(tu).name;
  openSheet(mode === 'mark' ? 'Jeg har betalt' : 'Modtaget', `<form id="pay-form" data-mode="${mode}" data-from="${esc(fromId)}" data-to="${esc(toId)}" autocomplete="off">
    <p style="margin:0"><b>${esc(fl)}</b> → <b>${esc(tl)}</b></p>
    <p class="small muted" style="margin:4px 0 0">${mode === 'mark' ? `Registrér, at ${fu.household ? 'I' : 'du'} har betalt. ${esc(tl)} får besked og kan bekræfte „Modtaget“.` : `Registrér, at ${esc(tl)} har fået pengene – fx kontant. Så er betalingen bekræftet med det samme.`}</p>
    <label class="f"><span>Beløb i kr.</span><input type="text" name="amount" inputmode="decimal" value="${esc((amount / 100).toFixed(2).replace('.', ','))}" data-t="pay-amount"></label>
    <p class="small muted" style="margin:4px 0 0">Er der kun betalt en del, så ret beløbet – resten står stadig som „mangler“.</p>
    <div class="err"></div>
    <div class="actions"><button class="btn green" data-t="pay-save">${mode === 'mark' ? '✅ Ja, betalt' : '💰 Ja, modtaget'}</button></div></form>`);
}

async function sendReminder(fromId, toId, amount, quiet = false) {
  const { r } = computeSettlement();
  const fu = r.units.find(u => u.id === fromId), tu = r.units.find(u => u.id === toId);
  if (!fu || !tu) return false;
  const to = payeeOf(tu, r);
  await store.logActivity(S.pid, 'payment', `Påmindelse: ${unitLabel(fu).name} mangler at betale ${formatKr(amount)} til ${firstName(to?.name) || unitLabel(tu).name}${to?.phone ? ' (MobilePay ' + prettyPhone(to.phone) + ')' : ''}`,
    { participantId: myId() || '', targetPids: unitPids(fu), strict: true });
  LS.set(remindKey(fromId, toId), Date.now());
  if (!quiet) toast(`Påmindelse sendt til ${unitLabel(fu).name} 🔔 – den kommer som notifikation, hvis de har slået det til`, 4000);
  return true;
}

function shareTab() {
  const url = partyUrl(S.pid);
  const token = S.admin && store.creatorToken(S.pid);
  return `<div class="card center" data-t="share"><h2>Inviter gæster</h2>
    <p class="small muted" style="margin:6px 0 0">Send linket eller lad gæsterne scanne QR-koden. Alle med linket kan se gildet og skrive sig på.</p>
    <div class="qr" id="qr" aria-label="QR-kode til gildet"></div>
    <div class="linkbox" data-t="share-link">${esc(url)}</div>
    <div class="row-actions" style="justify-content:center">
      <button class="btn primary" data-act="share">📤 Del link</button>
      <button class="btn" data-act="copy" data-text="${esc(url)}" data-msg="Linket er kopieret">📋 Kopiér</button>
      <a class="btn ghost" href="sms:${isApple ? '&' : '?'}body=${encodeURIComponent(`Du er inviteret til ${S.party.name}! Skriv dig på her: ${url}`)}">💬 SMS</a>
    </div></div>
  ${token ? `<div class="card"><h3>👑 Dit værts-link</h3>
    <div class="warnbox" style="margin-top:8px">Denne telefon er husket som vært. Vil du kunne rette gildet fra en <b>anden</b> enhed, så gem dette hemmelige link (f.eks. i en note til dig selv). <b>Send det ikke til gæsterne.</b></div>
    <div class="row-actions"><button class="btn sm" data-act="copy" data-text="${esc(adminUrl(S.pid, token))}" data-msg="Værts-linket er kopieret – gem det et sikkert sted">📋 Kopiér værts-link</button></div></div>` : ''}`;
}

function drawQr() {
  const el = $('#qr'); if (!el || !window.qrcode) return;
  try { const q = qrcode(0, 'M'); q.addData(partyUrl(S.pid)); q.make(); el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch (e) { console.warn(e); }
}

// ───────────────────────────── Ark (bottom sheets) ─────────────────────────────
function openSheet(title, html, onMount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="overlay" data-act="close-sheet-bg"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="grab"></div><div class="sheet-head"><h2>${esc(title)}</h2><button class="iconbtn" data-act="close-sheet" aria-label="Luk">✕</button></div>${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  onMount?.($('.sheet', root));
  const f = $('.sheet input:not([type=hidden]):not([type=checkbox])', root);
  if (f && !f.value && matchMedia('(pointer:fine)').matches) f.focus();
}
function closeSheet() { $('#sheet-root').innerHTML = ''; document.body.style.overflow = ''; }

function helpSheet() {
  openSheet('Sådan virker det', `<div class="help">
    <ol>
      <li><b>Opret et gilde</b> med navn, dato, tid og sted. Du bliver vært 👑 på denne telefon.</li>
      <li><b>Del linket</b> (eller QR-koden) med gæsterne. Linket er langt og hemmeligt – kun dem, der har det, kan finde gildet.</li>
      <li><b>Del gildet op</b> i retter (forret, hovedret, dessert) eller programpunkter med tid (14:00 Kaffe, 18:00 Middag).</li>
      <li><b>Gæsterne tilmelder sig</b> med navn og telefonnummer og skriver på, hvad de tager med – hvor mange det rækker til, en note og evt. hvad det kostede.</li>
      <li><b>Kommer du?</b> Tryk ✅ Kommer, 🤔 Måske eller ❌ Kommer ikke. Under 👥 Gæster ses hvor mange voksne og børn der kommer.</li>
      <li><b>Husstand:</b> Kommer du med partner, børn eller søskende, så tryk „🏠 Kommer du med nogen?“ og opret en husstand (fx „Familien Hansen“). Skriv dem på, selvom de ikke selv har appen – med navn, evt. telefon, og om det er et barn. Er din familie allerede skrevet på, så tryk „Tilføj mig“ ved deres husstand.</li>
      <li><b>„Det er mig“:</b> Har en anden skrevet dig på, så åbn linket og tryk „Det er mig“ ved dit navn – det gælder også børn. Så overtager du pladsen, og det der står på dig følger med.</li>
      <li><b>Er du barn?</b> Sæt flueben ved „Jeg er barn“, når du tilmelder dig. Så behøver du ikke skrive telefonnummer, og du betaler ikke med, når en udgift deles pr. person.</li>
      <li><b>Ret din tilmelding</b> (navn, telefon, barn, om du kommer) under ⚙️ → „Ret min tilmelding“, eller tryk på dit navn på gæstelisten.</li>
      <li><b>Regnskab:</b> Hver udgift kan deles mellem alle voksne (pr. person), pr. husstand (lige meget hver) eller mellem udvalgte voksne – eller <b>Ingen</b>, hvis du betaler selv: så står prisen på retten, men den er slet ikke med i regnskabet. <b>Børn betaler ikke med</b>, når der deles pr. person, og heller ikke dem, der har meldt „Kommer ikke“. Deles der pr. husstand, betaler husstanden det samme uanset antal børn. Har et barn lagt ud, får det pengene tilbage. Regnskabet samles pr. husstand, så hver husstand højst skal lave få overførsler.</li>
      <li><b>Betal med MobilePay:</b> Ved hver gæld står modtagerens nummer og beløbet, med knapper til at kopiere og til at forsøge at åbne MobilePay.</li>
      <li><b>Hvem har betalt:</b> Har du betalt, så tryk „✅ Jeg har betalt“ – modtageren får besked og trykker „Modtaget“. Hver overførsel viser ⏳ mangler, 🕓 markeret betalt eller ✔️ bekræftet. Betalinger tæller med i regnskabet, også hvis udgifterne ændres bagefter – så står kun resten tilbage. Modtageren og værten kan sende en påmindelse (🔔) til den, der mangler.</li>
      <li><b>💡 Det mangler vi:</b> Alle kan foreslå ting, som nogen skal tage med (is, stole, isterninger …). Tryk „Jeg tager den“, så står det på dig – evt. med pris og deling. „Fortryd“ gør det til et forslag igen. Har ingen meldt noget til en ret (fx dessert), står det i programmet.</li>
      <li><b>🥗 Kost og allergier:</b> Sæt fx vegetar, glutenfri eller nøddeallergi under „Ret min tilmelding“ (også for husstandens børn). Retter kan mærkes med fx „Indeholder nødder“ – så advarer appen diskret, og under 👥 Gæster ses et overblik.</li>
      <li><b>📅 Tilføj til kalender:</b> Tryk på knappen øverst i gildet for at hente en kalenderfil (iPhone, Android, Outlook) eller åbne Google Kalender.</li>
      <li><b>♻️ Genbrug en fest:</b> Værten kan under ⚙️ lave en ny fest ud fra en gammel – med sted, retter/programpunkter og husstande. Retter, udgifter, betalinger og svar kopieres ikke. Gæster med egen bruger tilmelder sig selv via det nye link.</li>
    </ol>
    <h3>Godt at vide</h3>
    <ul>
      <li>Alt opdateres live for alle, og gemmes online – også når appen er lukket.</li>
      <li>Telefonen husker, hvem du er. Er det ikke dig, så tryk „Jeg er ikke …“.</li>
      <li>Du kan rette og slette dine egne ting. Kun værten kan rette gildet og programmet.</li>
      <li>Alle med bruger i en husstand kan rette og fjerne husstandens personer uden egen bruger og melde dem til og fra. Ingen kan rette en anden, der har sin egen bruger (undtagen værten).</li>
      <li>Fjerner du en person, der har skrevet noget på, flyttes det over til dig, så regnskabet stadig passer.</li>
      <li>Værten kan gemme sit hemmelige værts-link under „Del“ for at kunne rette fra en anden enhed.</li>
      <li>Alle med linket kan se navne og telefonnumre – del det kun med gæsterne.</li>
      <li>Tip: Tryk „Føj til hjemmeskærm“ i browseren for at få appen som et ikon.</li>
    </ul>
    <h3>Notifikationer 🔔</h3>
    ${notifGuideHtml()}
    <div class="actions"><button class="btn primary" data-act="close-sheet">Forstået</button></div></div>`);
}

function partySheet() {
  const p = S.party;
  openSheet('Ret gildet', `<form id="party-form" autocomplete="off">
    <label class="f"><span>Navn på gildet *</span><input type="text" name="name" maxlength="120" required value="${esc(p.name)}"></label>
    <div class="two"><label class="f"><span>Dato</span><input type="date" name="date" value="${esc(p.date)}"></label>
    <label class="f"><span>Tidspunkt</span><input type="time" name="time" value="${esc(p.time)}"></label></div>
    <label class="f"><span>Sted / adresse</span><input type="text" name="place" maxlength="300" value="${esc(p.place)}"></label>
    <label class="f"><span>Besked til gæsterne</span><textarea name="note" maxlength="2000">${esc(p.note)}</textarea></label>
    <div class="actions"><button class="btn primary">Gem</button></div>
    <div class="actions"><button type="button" class="btn" data-act="reuse" data-t="reuse-from-edit">♻️ Genbrug til en ny fest</button></div>
    <div class="actions"><button type="button" class="btn danger" data-act="delete-party">🗑️ Slet hele gildet</button></div>
  </form>`);
}

const PROGRAM_SUGGESTIONS = ['Velkomstdrink', 'Kaffe og kage', 'Frokost', 'Middag', 'Lege og aktiviteter', 'Taler og sange', 'Natmad'];
function eventSheet(ev, kind = 'ret') {
  kind = ev?.kind || kind;
  openSheet(ev ? 'Ret punkt' : (kind === 'program' ? 'Nyt programpunkt' : 'Nyt punkt'), `<form id="event-form" autocomplete="off" data-id="${ev?.id || ''}">
    <div class="seg" data-seg="kind"><button type="button" data-v="ret" class="${kind === 'ret' ? 'on' : ''}">🍽️ Ret / servering</button><button type="button" data-v="program" class="${kind === 'program' ? 'on' : ''}">⏰ Programpunkt</button></div>
    <input type="hidden" name="kind" value="${kind}">
    <label class="f"><span>Titel *</span><input type="text" name="title" maxlength="80" required value="${esc(ev?.title || '')}" placeholder="${kind === 'program' ? 'F.eks. Kaffe og kage' : 'F.eks. Tapas'}"></label>
    ${!ev ? `<div class="chips" style="margin-top:8px">${PROGRAM_SUGGESTIONS.map(s => `<button type="button" class="chip" data-act="fill-title" data-v="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : ''}
    <label class="f"><span>Tidspunkt (valgfrit)</span><input type="time" name="time" value="${esc(ev?.time || '')}"></label>
    <div class="err"></div>
    <div class="actions"><button class="btn primary" data-t="save-event">${ev ? 'Gem' : 'Tilføj'}</button></div>
    ${ev ? `<div class="actions"><button type="button" class="btn danger" data-act="delete-event" data-id="${ev.id}">🗑️ Slet punktet</button></div>` : ''}
  </form>`);
}

function itemSheet(it, eventId = '', kind = 'ret', sug = null) {
  const m = me();
  if (!m && !it) { toast('Tilmeld dig først – skriv dit navn og nummer'); S.tab = 'program'; render(); $('#join-form input')?.focus(); scrollTo(0, ($('#join-form')?.offsetTop || 0) - 10); return; }
  kind = it?.kind || kind;
  const isExpense = kind === 'udgift';
  const ev = S.events.find(e => e.id === (it?.eventId ?? eventId));
  const split = it?.split || 'all';
  const among = new Set(it?.split === 'selected' && it.among?.length ? it.among : S.participants.filter(p => statusOf(p) !== 'no' && !p.isChild).map(p => p.id));
  const units = unitsOf(sortedPeople(), S.households);
  const amongU = new Set(it?.split === 'households' && it.among?.length ? it.among : units.filter(u => u.members.some(p => statusOf(p) !== 'no')).map(u => u.id));
  // Hvem tager det med / har betalt? Mig eller en i min husstand uden egen bruger.
  const whoOpts = !it && m && isMemberOf(m.householdId) ? householdMembers(m.householdId).filter(p => p.id === m.id || unclaimed(p)) : [];
  openSheet(it ? (isExpense ? 'Ret udgift' : 'Ret bidrag') : sug ? `Jeg tager ${sug.title}` : (isExpense ? 'Ny udgift' : 'Jeg tager med …'), `<form id="item-form" autocomplete="off" data-id="${it?.id || ''}" data-event="${esc(it?.eventId ?? eventId)}" data-sug="${sug?.id || ''}">
    ${sug ? `<p class="small muted" style="margin:0 0 6px" data-t="take-info">💡 Fra forslagene. Når du gemmer, står det på dig og forsvinder fra „Det mangler vi“. Du kan fortryde bagefter.</p>` : ''}
    ${ev ? `<p class="muted small" style="margin:0 0 4px">Til: <b>${eventIcon(ev)} ${esc(ev.title)}</b></p>` : ''}
    ${it && it.participantId !== myId() ? `<p class="muted small" style="margin:0 0 4px">Tilhører: <b>${esc(pName(it.participantId))}</b></p>` : ''}
    ${whoOpts.length > 1 ? `<label class="f"><span>${isExpense ? 'Hvem har betalt?' : 'Hvem tager det med?'}</span><select name="who" data-t="item-who">${whoOpts.map(p => `<option value="${p.id}" ${p.id === m.id ? 'selected' : ''}>${esc(p.name)}${p.id === m.id ? ' (mig)' : ''}</option>`).join('')}</select></label>` : ''}
    ${!isExpense ? `<div class="seg" data-seg="kind">${['ret', 'aktivitet', 'andet'].map(k => `<button type="button" data-v="${k}" class="${kind === k ? 'on' : ''}">${ITEM_KINDS[k][0]} ${ITEM_KINDS[k][1]}</button>`).join('')}</div>` : ''}
    <input type="hidden" name="kind" value="${kind}">
    <label class="f"><span>${isExpense ? 'Hvad er udgiften? *' : 'Hvad tager du med? *'}</span><input type="text" name="title" maxlength="100" required value="${esc(it?.title || sug?.title || '')}" placeholder="${isExpense ? 'F.eks. Vin og øl' : 'F.eks. Lasagne'}"></label>
    ${!isExpense ? `<label class="f"><span>Til hvor mange personer?</span><input type="number" name="servings" min="0" max="1000" inputmode="numeric" value="${it?.servings || ''}" placeholder="${S.participants.length || ''}"></label>` : ''}
    <label class="f"><span>Note (valgfri)</span><input type="text" name="note" maxlength="500" value="${esc(it?.note || sug?.note || '')}" placeholder="${isExpense ? 'F.eks. købt i Netto' : 'F.eks. vegetarisk, indeholder nødder'}"></label>
    <label class="f"><span>${isExpense ? 'Beløb i kr. *' : 'Udgift i kr. (valgfri)'}</span><input type="text" name="cost" inputmode="decimal" value="${it?.cost ? esc((it.cost / 100).toFixed(2).replace('.', ',')) : ''}" placeholder="F.eks. 149,95"></label>
    <div id="split-box" style="${it?.cost || isExpense ? '' : 'display:none'}">
      <label class="f"><span>Hvem skal dele udgiften?</span></label>
      <div class="seg seg3 seg4" data-seg="split"><button type="button" data-v="all" class="${split === 'all' ? 'on' : ''}" data-t="split-all">Alle<small>pr. person</small></button><button type="button" data-v="households" class="${split === 'households' ? 'on' : ''}" data-t="split-households">Pr. husstand<small>lige meget hver</small></button><button type="button" data-v="selected" class="${split === 'selected' ? 'on' : ''}" data-t="split-selected">Udvalgte<small>personer</small></button><button type="button" data-v="none" class="${split === 'none' ? 'on' : ''}" data-t="split-none">Ingen<small>betaler selv</small></button></div>
      <input type="hidden" name="split" value="${split}">
      <p class="small muted split-help" style="margin:6px 0 0" data-t="split-help">${SPLIT_HELP[split] || SPLIT_HELP.all}</p>
      <div class="checks" id="among" style="${split === 'selected' ? '' : 'display:none'}">
        ${sortedPeople().filter(p => !p.isChild).map(p => `<label><input type="checkbox" name="among" value="${p.id}" ${among.has(p.id) ? 'checked' : ''}> ${esc(p.name)}${statusOf(p) === 'no' ? ' <span class="small muted">(kommer ikke)</span>' : ''}</label>`).join('')}
        ${S.participants.some(p => p.isChild) ? '<p class="small muted" style="margin:2px 4px">Børn er ikke med på listen – de betaler ikke med ved deling pr. person.</p>' : ''}
      </div>
      <div class="checks" id="among-hh" style="${split === 'households' ? '' : 'display:none'}">
        ${units.map(u => `<label><input type="checkbox" name="amongHh" value="${esc(u.id)}" ${amongU.has(u.id) ? 'checked' : ''}> ${u.household ? '🏠 ' : ''}${esc(unitLabel(u).name)} <span class="small muted">(${u.members.length} pers.)</span></label>`).join('')}
      </div>
    </div>
    ${!isExpense ? dishTagBox(it) : ''}
    <div class="err"></div>
    <div class="actions"><button class="btn primary" data-t="save-item">${it ? 'Gem' : sug ? '✋ Jeg tager den' : 'Tilføj'}</button></div>
    ${it ? `<div class="actions"><button type="button" class="btn danger" data-act="delete-item" data-id="${it.id}">🗑️ Slet</button></div>` : ''}
  </form>`, sheet => {
    const cost = $('[name=cost]', sheet);
    cost.addEventListener('input', () => { $('#split-box', sheet).style.display = cost.value.trim() || isExpense ? '' : 'none'; });
  });
}

const SPLIT_HELP = {
  all: 'Deles lige mellem de voksne, der kommer. Børn og dem, der har meldt „Kommer ikke“, betaler ikke med.',
  households: 'Hver husstand betaler lige meget, uanset hvor mange de er, og uanset antal børn. Enlige tæller som en husstand.',
  selected: 'Deles lige mellem de voksne, du vælger. Børn betaler ikke med.',
  none: 'Deles ikke: prisen står på retten, men kommer ikke med i regnskabet. Den, der har betalt, betaler selv, og ingen skylder noget for den.',
};

// ── Kalender ─────────────────────────────────────────────────────────────
function calendarSheet() {
  const p = { ...S.party, id: S.pid };
  const g = googleCalendarUrl(p, partyUrl(S.pid));
  openSheet('Tilføj til kalender', `<p class="small muted" style="margin:0">Få ${esc(p.name)} ind i din kalender – med tid, sted og link til gildet.</p>
    <div class="actions"><button class="btn primary" data-act="ics" data-t="ics">📥 Hent kalenderfil</button></div>
    ${g ? `<div class="actions"><a class="btn" href="${esc(g)}" target="_blank" rel="noopener" data-t="gcal">🗓️ Åbn i Google Kalender</a></div>` : ''}
    <div class="guide small" style="margin-top:12px">
      <p><b>🍎 iPhone:</b> Tryk „Hent kalenderfil“ og vælg <b>Tilføj alle</b> (eller åbn filen fra Overførsler).</p>
      <p><b>🤖 Android:</b> Åbn den hentede fil med din kalender-app – eller brug Google Kalender-knappen.</p>
      <p><b>💻 Computer:</b> Filen virker også i Outlook og Apple Kalender.</p>
      ${p.time ? `<p class="muted">Begivenheden varer ${4} timer fra kl. ${esc(p.time)} – ret det bagefter i kalenderen, hvis det passer bedre.</p>` : '<p class="muted">Gildet har intet tidspunkt, så det bliver en heldagsbegivenhed.</p>'}
      <p class="muted">Ændrer værten dato eller tid senere, skal du tilføje det igen.</p>
    </div>`);
}
function downloadIcs() {
  let ics;
  try { ics = buildIcs({ ...S.party, id: S.pid }, partyUrl(S.pid)); } catch { toast('Gildet har ingen dato endnu'); return; }
  if (isIOSDevice) { location.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics); return; }   // iPhone: åbner „Tilføj til kalender“
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = icsFileName(S.party); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('Kalenderfilen er hentet – åbn den for at tilføje gildet 📅', 3500);
}

// ── Genbrug en fest ──────────────────────────────────────────────────────
function reuseSheet() {
  if (!S.admin) return;
  const p = S.party, m = me();
  const hhN = S.households.filter(h => S.participants.some(x => x.householdId === h.id)).length;
  const freeN = S.participants.filter(x => !x.ownerUid).length;
  const userN = S.participants.filter(x => x.ownerUid && x.id !== m?.id).length;
  openSheet('Genbrug til en ny fest', `<form id="reuse-form" autocomplete="off">
    <p class="small muted" style="margin:0">Laver en <b>ny</b> fest ud fra „${esc(p.name)}“. Den gamle fest røres ikke.</p>
    <label class="f"><span>Navn på den nye fest *</span><input type="text" name="name" maxlength="120" required value="${esc(p.name)}"></label>
    <div class="two"><label class="f"><span>Dato</span><input type="date" name="date"></label>
    <label class="f"><span>Tidspunkt</span><input type="time" name="time" value="${esc(p.time || '')}"></label></div>
    <label class="f"><span>Sted / adresse</span><input type="text" name="place" maxlength="300" value="${esc(p.place || '')}"></label>
    <label class="f"><span>Besked til gæsterne</span><textarea name="note" maxlength="2000">${esc(p.note || '')}</textarea></label>
    <label class="f"><span>Hvad skal med?</span></label>
    <div class="checks" style="max-height:none">
      <label><input type="checkbox" name="events" ${S.events.length ? 'checked' : 'disabled'} data-t="reuse-events"> 🍽️ Retter og programpunkter (${S.events.length})</label>
      <label><input type="checkbox" name="households" ${hhN || freeN ? 'checked' : 'disabled'} data-t="reuse-households"> 🏠 Husstande og personer uden egen bruger (${hhN} husstande, ${freeN} personer)</label>
      <label><input type="checkbox" name="placeholders" ${userN ? '' : 'disabled'} data-t="reuse-placeholders"> 👥 Gæster med egen bruger som pladsholdere (${userN}) – kun navn, de trykker selv „Det er mig“</label>
      ${m && m.ownerUid === store.uid ? `<label><input type="checkbox" name="me" checked data-t="reuse-me"> 🙋 Skriv mig (${esc(m.name)}) på som gæst</label>` : ''}
    </div>
    <div class="guide small" style="margin-top:10px" data-t="reuse-help">
      <p><b>Kopieres ikke:</b> retter/bidrag, udgifter, betalinger, forslag og svar (kommer/kommer ikke). Kopierede personer står som „🤔 Kommer måske“, indtil de selv eller husstanden svarer.</p>
      <p><b>Gæster med egen bruger</b> kan ikke tilmeldes af andre. Del det nye link – så tilmelder de sig selv, eller trykker „Det er mig“ ved deres navn, hvis du har valgt pladsholdere.</p>
    </div>
    <div class="err"></div>
    <div class="actions"><button class="btn primary" data-t="reuse-save">♻️ Opret den nye fest</button></div></form>`);
}

// ── Forslag: ark ─────────────────────────────────────────────────────────
function suggestionSheet(eventId = '') {
  if (!me()) { toast('Tilmeld dig først – skriv dit navn og nummer'); S.tab = 'program'; closeSheet(); render(); scrollTo(0, ($('#join-form')?.offsetTop || 0) - 10); return; }
  const evs = sortedEvents();
  openSheet('Foreslå noget', `<form id="suggestion-form" autocomplete="off">
    <p class="small muted" style="margin:0">Noget, som nogen skal tage med – fx is, stole, isterninger eller en dessert. Alle kan se forslaget og trykke „Jeg tager den“.</p>
    <label class="f"><span>Hvad mangler vi? *</span><input type="text" name="title" maxlength="100" required placeholder="F.eks. Isterninger"></label>
    <div class="chips" style="margin-top:8px">${['Is', 'Isterninger', 'Stole', 'Dessert', 'Brød', 'Salat', 'Sodavand'].map(x => `<button type="button" class="chip" data-act="fill-sug" data-v="${x}">${x}</button>`).join('')}</div>
    ${evs.length ? `<label class="f"><span>Til (valgfrit)</span><select name="eventId" data-t="sug-event"><option value="">Ikke noget bestemt</option>${evs.map(e => `<option value="${e.id}" ${e.id === eventId ? 'selected' : ''}>${esc(e.title)}</option>`).join('')}</select></label>` : '<input type="hidden" name="eventId" value="">'}
    <label class="f"><span>Note (valgfri)</span><input type="text" name="note" maxlength="200" placeholder="F.eks. til 20 personer"></label>
    <div class="err"></div>
    <div class="actions"><button class="btn primary" data-t="save-suggestion">💡 Foreslå</button></div></form>`);
}

// ── Husstande: ark ───────────────────────────────────────────────────────
function householdSheet() {
  const m = me(); if (!m) { toast('Tilmeld dig først'); return; }
  const last = m.name.trim().split(/\s+/).slice(1).join(' ');
  const others = S.households.filter(h => h.id !== m.householdId);
  openSheet('Kommer du med nogen?', `
    <p class="small muted" style="margin:0">En husstand er dig og dem, du kommer med – partner, børn, søskende. Du kan skrive dem på, selvom de ikke selv har appen, og I får ét samlet regnskab.</p>
    <form id="household-form" autocomplete="off"><label class="f"><span>Navn på husstanden</span><input type="text" name="name" maxlength="60" required value="${last ? 'Familien ' + esc(last) : ''}" placeholder="F.eks. Familien Hansen"></label>
    <div class="err"></div><div class="actions"><button class="btn primary" data-t="create-household">🏠 Opret husstand</button></div></form>
    ${others.length ? `<h3 style="margin-top:18px">…eller tilføj dig til en husstand</h3><p class="small muted" style="margin:4px 0 8px">Er din partner eller familie allerede skrevet på? Så meld dig ind i deres.</p>
      <div class="list-parties">${others.map(h => `<button class="rowbtn" data-act="join-household" data-id="${h.id}" data-t="join-household-row"><span style="font-size:22px">🏠</span><span class="grow"><b>${esc(h.name)}</b><br><span class="small muted">${householdMembers(h.id).map(p => esc(firstName(p.name))).join(', ') || 'ingen endnu'}</span></span><span class="chip solid">Tilføj mig</span></button>`).join('')}</div>` : ''}
    <div class="actions"><button class="btn ghost" data-act="close-sheet">Nej, det er kun mig</button></div>`);
}
function renameSheet(hid) {
  const h = hhById(hid);
  openSheet('Omdøb husstand', `<form id="household-form" data-id="${hid}" autocomplete="off"><label class="f"><span>Navn</span><input type="text" name="name" maxlength="60" required value="${esc(h?.name || '')}"></label>
    <div class="err"></div><div class="actions"><button class="btn primary">Gem</button></div></form>`);
}
/** Tilføj/ret en person i en husstand (eller ret en person som vært). */
function personSheet(hid, p) {
  const h = hhById(hid || p?.householdId);
  const st = p ? statusOf(p) : 'yes';
  const canChild = !p || unclaimed(p) || S.admin;
  openSheet(p ? `Ret ${p.name}` : `Tilføj til ${h?.name || 'husstanden'}`, `<form id="person-form" data-id="${p?.id || ''}" data-hid="${esc(hid || '')}" autocomplete="off">
    ${!p ? '<p class="small muted" style="margin:0">Til personer der ikke selv har appen – fx partner, børn eller søskende. Har de selv en telefon, kan de senere åbne linket og trykke „Det er mig“.</p>' : ''}
    <label class="f"><span>Navn *</span><input type="text" name="name" maxlength="60" required value="${esc(p?.name || '')}" placeholder="F.eks. Sofie"></label>
    <label class="f"><span>Telefonnummer (valgfrit)</span><input type="tel" name="phone" maxlength="20" inputmode="tel" value="${esc(p?.phone || '')}" placeholder="12 34 56 78"></label>
    ${canChild ? childBox('Barn', !!p?.isChild) : ''}
    ${dietBox(p, 'person-diet')}
    <label class="f"><span>Kommer ${p ? esc(firstName(p.name)) : 'personen'}?</span></label>
    <div class="seg seg3" data-seg="status">${Object.entries(STATUS).map(([k, [ic, l]]) => `<button type="button" data-v="${k}" class="${st === k ? 'on' : ''}" data-t="person-status-${k}">${ic} ${l}</button>`).join('')}</div>
    <input type="hidden" name="status" value="${st}">
    <div class="err"></div>
    <div class="actions"><button class="btn primary" data-t="save-person">${p ? 'Gem' : 'Tilføj'}</button></div>
    ${p && p.id !== myId() ? `<div class="actions"><button type="button" class="btn danger" data-act="remove-person" data-id="${p.id}" data-t="remove-person">🗑️ Fjern fra gildet</button></div>` : ''}
  </form>`);
}
function claimSheet(p) {
  const prof = LS.get('sg:profile', {});
  const hh = hhOfP(p);
  openSheet(`Er du ${p.name}?`, `<form id="claim-form" data-id="${p.id}" autocomplete="on">
    <p class="small muted" style="margin:0">Så overtager du pladsen${hh ? ` i <b>${esc(hh.name)}</b>` : ''}. Alt der allerede står på ${esc(firstName(p.name))}, følger med. Skriv dit nummer, så de andre kan betale dig via MobilePay.</p>
    <label class="f"><span>Navn</span><input type="text" name="name" maxlength="60" required autocomplete="name" value="${esc(p.name)}"></label>
    <label class="f"><span>Telefonnummer</span><input type="tel" name="phone" maxlength="20" autocomplete="tel" inputmode="tel" value="${esc(p.phone || (p.isChild ? '' : prof.phone) || '')}" placeholder="12 34 56 78"></label>
    <label class="f"><span>Kommer du?</span></label>
    <div class="seg seg3" data-seg="status">${Object.entries(STATUS).map(([k, [ic, l]]) => `<button type="button" data-v="${k}" class="${statusOf(p) === k ? 'on' : ''}">${ic} ${l}</button>`).join('')}</div>
    <input type="hidden" name="status" value="${statusOf(p)}">
    ${childBox('Jeg er barn', !!p.isChild, 'claim-child-box')}
    <div class="err"></div><div class="actions"><button class="btn green" data-t="claim-save">✋ Ja, det er mig</button></div></form>`);
}

function meSheet(edit) {
  const m = me();
  const others = S.participants.filter(p => p.ownerUid === store.uid && p.id !== m?.id);
  if (edit) {
    const st = statusOf(m);
    openSheet('Ret min tilmelding', `<form id="me-form" autocomplete="on"><label class="f"><span>Navn</span><input type="text" name="name" maxlength="60" required value="${esc(m.name)}"></label>
      <label class="f"><span>Telefonnummer</span><input type="tel" name="phone" maxlength="20" inputmode="tel" value="${esc(m.phone)}" placeholder="12 34 56 78"></label>
      ${childBox('Jeg er barn', !!m.isChild, 'me-child')}
      ${dietBox(m, 'me-diet')}
      ${hhOn() ? `<label class="f"><span>Kommer du?</span></label>
      <div class="seg seg3" data-seg="status">${Object.entries(STATUS).map(([k, [ic, l]]) => `<button type="button" data-v="${k}" class="${st === k ? 'on' : ''}" data-t="me-status-${k}">${ic} ${l}</button>`).join('')}</div>
      <input type="hidden" name="status" value="${st}">` : ''}
      <div class="err"></div>
      <div class="actions"><button class="btn primary" data-t="save-me">💾 Gem min tilmelding</button></div></form>`);
    return;
  }
  openSheet('Er du ikke ' + m.name + '?', `
    ${others.length ? `<p class="muted small">Personer tilmeldt fra denne telefon:</p><div class="chips">${others.map(p => `<button class="chip solid" data-act="be" data-id="${p.id}">Jeg er ${esc(p.name)}</button>`).join('')}</div>` : ''}
    ${claimablePeople().length ? `<p class="muted small" style="margin-top:14px">Skrevet på af andre (uden egen bruger):</p><div class="chips">${claimablePeople().map(p => `<button class="chip" data-act="claim" data-id="${p.id}">Det er mig: ${esc(p.name)}${p.isChild ? ' (barn)' : ''}</button>`).join('')}</div>` : ''}
    <p class="muted small" style="margin-top:14px">Er du en ny gæst på denne telefon, så tilmeld dig her:</p>
    <form id="switch-form"><label class="f"><span>Navn</span><input type="text" name="name" maxlength="60" required></label>
    <label class="f"><span>Telefonnummer</span><input type="tel" name="phone" maxlength="20" inputmode="tel"></label>
    ${childBox('Jeg er barn', false, 'switch-child')}<div class="err"></div>
    <div class="actions"><button class="btn primary" data-t="switch-join">Tilmeld ny person</button></div></form>
    <div class="actions"><button class="btn ghost" data-act="be" data-id="">Bare kig med (ikke tilmeldt)</button></div>`);
}

function afterReuse(info) {
  S.tab = 'program'; render();
  const n = (k, now) => info[k] ?? now, ev = n('events', S.events.length), hh = n('households', S.households.length), ppl = n('people', S.participants.filter(p => !p.ownerUid).length);
  openSheet('Den nye fest er klar ♻️', `<p style="margin:0">Kopieret fra „${esc(info.from)}“: ${ev} ${ev === 1 ? 'ret/programpunkt' : 'retter/programpunkter'}, ${hh} ${hh === 1 ? 'husstand' : 'husstande'} og ${ppl} ${ppl === 1 ? 'person' : 'personer'} uden egen bruger${ppl ? ' (står som „kommer måske“)' : ''}.</p>
    <p class="small muted">Send det nye link til gæsterne. De tilmelder sig selv – eller trykker „Det er mig“ ved deres navn.</p>
    <div class="linkbox" data-t="reuse-link">${esc(partyUrl(S.pid))}</div>
    <div class="actions"><button class="btn primary" data-act="share">📤 Del link</button><button class="btn" data-act="copy" data-text="${esc(partyUrl(S.pid))}" data-msg="Linket er kopieret">📋 Kopiér</button></div>
    ${!S.party.date ? '<p class="small muted">Husk at sætte en dato under ✏️ Ret gildet.</p>' : ''}
    <div class="actions"><button class="btn green" data-act="close-sheet" data-t="reuse-continue">Videre</button></div>`);
}

async function afterCreate() {
  S.tab = 'program'; render();
  openSheet('Gildet er oprettet! 🎉', `<p>Send linket til dine gæster. Du finder det altid igen under <b>🔗 Del</b>.</p>
    <div class="qr" id="qr2"></div><div class="linkbox">${esc(partyUrl(S.pid))}</div>
    <div class="actions"><button class="btn primary" data-act="share">📤 Del link</button><button class="btn" data-act="copy" data-text="${esc(partyUrl(S.pid))}" data-msg="Linket er kopieret">📋 Kopiér</button></div>
    <p class="small muted" style="margin-top:14px">Næste skridt: skriv dig selv på som gæst, og del gildet op i retter eller programpunkter.</p>
    <div class="actions"><button class="btn green" data-act="close-sheet" data-t="continue">Videre</button></div>`, sheet => {
    try { const q = qrcode(0, 'M'); q.addData(partyUrl(S.pid)); q.make(); $('#qr2', sheet).innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch {}
  });
}

// ───────────────────────────── Indstillinger & notifikationer ─────────────────────────────
const appLink = () => partyUrl(S.pid).replace(/#\/p\/(\w+)$/, `#/p/$1${myId() ? '/mig/' + myId() : ''}`);

function notifGuideHtml() {
  return `<div class="guide">
    <p><b>Slå til:</b> Åbn gildet, tryk ⚙️ <b>Indstillinger</b> → <b>Slå notifikationer til</b>, og tryk <b>Tillad</b>, når telefonen spørger.</p>
    <p><b>🤖 Android:</b> Virker direkte i Chrome. Tryk Tillad, når du bliver spurgt.</p>
    <p><b>🍎 iPhone:</b> Kræver iOS 16.4 eller nyere, og det virker kun fra hjemmeskærmen – ikke i en almindelig Safari-fane:</p>
    <ol class="steps"><li>Åbn gildet i <b>Safari</b>.</li><li>Tryk <b>Del</b> <span class="ios-share">⬆︎</span> og vælg <b>Føj til hjemmeskærm</b>.</li>
      <li>Åbn appen fra <b>ikonet på hjemmeskærmen</b>.</li><li>Tryk ⚙️ og slå notifikationer til dér.</li></ol>
    <p><b>⏱️ Hvornår:</b> Beskederne kommer inden for ca. 15–30 minutter – ikke med det samme. Du får aldrig besked om det, du selv gør.</p>
    <p><b>Slå fra:</b> ⚙️ → <b>Slå notifikationer fra</b>. Det gælder kun denne telefon og dette gilde.</p>
    <p><b>Pr. telefon:</b> Indstillingerne gælder kun for den telefon, du slår dem til på – og for ét gilde ad gangen.</p>
  </div>`;
}
function notifGuideSheet() { openSheet('Sådan får du notifikationer', notifGuideHtml() + '<div class="actions"><button class="btn primary" data-act="settings">Tilbage</button></div>'); }

function iosHintHtml() {
  return `<div class="warnbox" data-t="ios-hint"><b>📱 På iPhone skal appen på hjemmeskærmen først</b>
    <ol class="steps"><li>Tryk på <b>Del</b>-knappen <span class="ios-share">⬆︎</span> nederst i Safari.</li>
      <li>Vælg <b>Føj til hjemmeskærm</b> og tryk <b>Tilføj</b>.</li>
      <li>Åbn <b>Sammenskud</b> fra ikonet på hjemmeskærmen.</li>
      <li>Åbner appen ikke gildet af sig selv, så tryk <b>Indsæt link</b> på forsiden og indsæt app-linket herunder.</li>
      <li>Tryk ⚙️ og slå notifikationer til dér.</li></ol>
    <div class="row-actions" style="margin-top:6px"><button class="btn sm" data-act="copy-app-link">📋 Kopiér app-link</button>
    <button class="btn sm ghost" data-act="notif-guide">Sådan virker det</button></div>
    <p class="small muted" style="margin:8px 0 0">Kræver iOS 16.4 eller nyere. Hjemmeskærm-appen har sin egen hukommelse, så app-linket husker hvem du er. Dine egne ting retter du, hvor du oprettede dem.</p></div>`;
}

let settingsState = { sub: undefined, busy: false, msg: '' };
async function settingsSheet() {
  settingsState = { sub: undefined, busy: false, msg: '' };
  openSheet('Indstillinger', '<div id="settings-body"></div>');
  renderSettings();
  if (S.view === 'party' && S.party && store.backend.kind !== 'mock') {
    try { settingsState.sub = await store.getSub(S.pid); } catch (e) { console.warn(e); settingsState.sub = null; }
    renderSettings();
  } else settingsState.sub = null;
}

function renderSettings() {
  const box = $('#settings-body'); if (!box) return;
  const y = box.closest('.sheet')?.scrollTop || 0;
  box.innerHTML = S.view === 'party' && S.party ? partySettingsHtml() : homeSettingsHtml();
  const sh = box.closest('.sheet'); if (sh) sh.scrollTop = y;
}

function homeSettingsHtml() {
  const prof = LS.get('sg:profile', {});
  return `<section class="set"><h3>👤 Standard-oplysninger</h3>
    <p class="small muted">Bruges til at udfylde tilmeldingen, næste gang du bliver inviteret.</p>
    <form id="profile-form"><div class="two"><label class="f"><span>Navn</span><input type="text" name="name" maxlength="60" value="${esc(prof.name || '')}"></label>
    <label class="f"><span>Telefon</span><input type="tel" name="phone" maxlength="20" inputmode="tel" value="${esc(prof.phone || '')}"></label></div>
    <div class="err"></div><div class="actions"><button class="btn sm primary">Gem</button></div></form></section>
  <section class="set"><h3>🔗 Åbn et gilde fra et link</h3>
    <p class="small muted">Fx i hjemmeskærm-appen på iPhone: indsæt linket, du har fået.</p>
    <input type="text" id="paste-link" placeholder="https://…#/p/…" inputmode="url"><div class="actions"><button class="btn sm" data-act="open-pasted">Åbn gildet</button></div></section>
  <section class="set"><h3>🔔 Notifikationer</h3><p class="small muted">Slås til inde i det enkelte gilde (⚙️ dér).</p>
    <button class="btn sm ghost" data-act="notif-guide">Sådan får du notifikationer</button></section>
  <section class="set"><h3>🧹 Andet</h3><div class="row-actions" style="margin-top:4px">
    <button class="btn sm ghost" data-act="help">❓ Sådan virker det</button>
    <button class="btn sm ghost" data-act="clear-parties">Ryd „Dine gilder“</button></div>
    <p class="small muted">Version ${APP_VERSION} · ${esc(deviceLabel())}${isStandalone() ? ' · hjemmeskærm-app' : ''}</p></section>`;
}

function partySettingsHtml() {
  const m = me(), token = S.admin && store.creatorToken(S.pid);
  const st = statusOf(m);
  const you = m ? `<div class="me" style="margin:6px 0 0">${avatar(m)}<div class="grow"><b>${esc(m.name)}</b>${m.isChild ? ' <span class="tag kid">barn</span>' : ''}<div class="small muted">${m.phone ? esc(prettyPhone(m.phone)) : 'Intet nummer'}${hhOn() ? ` · ${STATUS[st][0]} ${STATUS[st][1]}` : ''}</div></div></div>
      ${m.ownerUid === store.uid ? '<button class="btn primary block" style="margin-top:10px" data-act="edit-me" data-t="settings-edit-me">✏️ Ret min tilmelding</button><p class="small muted" style="margin:6px 0 0">Navn, telefon, om du er barn, kost/allergier, og om du kommer.</p>' : ''}
      <div class="row-actions"><button class="btn sm ghost" data-act="not-me">Jeg er ikke ${esc(m.name.split(' ')[0])}</button></div>`
    : `<p class="small muted">Du er ikke tilmeldt dette gilde endnu.</p><button class="btn sm primary" data-act="close-sheet">Tilmeld mig</button>`;
  return `<section class="set"><h3>👤 Dig i dette gilde</h3>${you}</section>
    ${S.admin ? `<section class="set" data-t="reuse-section"><h3>♻️ Genbrug til en ny fest</h3>
      <p class="small muted">Lav en ny fest med samme sted, retter/programpunkter og husstande – fx næste års julefrokost.</p>
      <button class="btn sm" data-act="reuse" data-t="reuse">♻️ Genbrug festen</button></section>` : ''}
    <section class="set" data-t="notif-section"><h3>🔔 Notifikationer</h3>${notifHtml()}</section>
    <section class="set"><h3>🧹 Andet</h3><div class="row-actions" style="margin-top:4px">
      ${token ? `<button class="btn sm" data-act="copy" data-text="${esc(adminUrl(S.pid, token))}" data-msg="Værts-linket er kopieret – gem det et sikkert sted">👑 Kopiér værts-link</button>` : ''}
      <button class="btn sm ghost" data-act="copy-app-link">📋 Kopiér app-link</button>
      <button class="btn sm ghost" data-act="help">❓ Sådan virker det</button>
      <button class="btn sm ghost" data-act="forget-party">Glem gildet på denne telefon</button></div>
      <p class="small muted">Version ${APP_VERSION} · ${esc(deviceLabel())}${isStandalone() ? ' · hjemmeskærm-app' : ''}</p></section>`;
}

function notifHtml() {
  if (store.backend.kind === 'mock') return '<p class="small muted">Notifikationer kræver den rigtige server (ikke demotilstand).</p>';
  const support = pushSupport();
  const sub = settingsState.sub;
  const guideBtn = '<button class="linkbtn small" data-act="notif-guide">Sådan virker det</button>';
  if (support === 'ios-browser') return iosHintHtml();
  if (support === 'insecure') return `<p class="small muted">Notifikationer kræver en sikker forbindelse (https).</p>`;
  if (support === 'unsupported') return `<p class="small muted">Denne browser understøtter ikke notifikationer. Prøv Chrome på Android eller hjemmeskærm-appen på iPhone. ${guideBtn}</p>`;
  if (sub === undefined) return '<p class="small muted">Henter …</p>';
  const on = !!(sub?.enabled && sub.channels?.push);
  const denied = support === 'denied';
  if (!on) return `<p class="small">Få besked på denne telefon, når der sker noget i gildet. Beskederne kommer inden for ca. 15–30 minutter.</p>
    ${denied ? '<div class="warnbox" style="margin:8px 0">Du har blokeret notifikationer for siden. Tillad dem igen i browserens/telefonens indstillinger for siden, og prøv så igen.</div>' : ''}
    <button class="btn primary block" data-act="notif-toggle" data-t="notif-on" ${settingsState.busy || denied ? 'disabled' : ''}>🔔 Slå notifikationer til</button>
    ${settingsState.msg ? `<div class="err">${esc(settingsState.msg)}</div>` : ''}<p style="margin:8px 0 0">${guideBtn}</p>`;
  const t = { ...DEFAULT_TOPICS, ...(sub.topics || {}) };
  const freq = sub.frequency || 'instant';
  const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === (sub.digestHour ?? 18) ? 'selected' : ''}>kl. ${String(h).padStart(2, '0')}:00</option>`).join('');
  return `<form id="notif-form" data-t="notif-form">
    <div class="onrow"><span class="dot-on"></span><b>Slået til på denne telefon</b></div>
    ${freq !== 'reminderOnly' ? `<label class="f"><span>Giv mig besked om</span></label>
    <div class="checks" style="max-height:none">${TOPIC_LABELS.map(([k, l]) => `<label><input type="checkbox" name="topic" value="${k}" ${t[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>` : ''}
    <label class="f"><span>Hvor tit?</span></label>
    <div class="seg seg3" data-seg="frequency"><button type="button" data-v="instant" class="${freq === 'instant' ? 'on' : ''}">Med det samme</button><button type="button" data-v="daily" class="${freq === 'daily' ? 'on' : ''}" data-t="freq-daily">Daglig opsamling</button><button type="button" data-v="reminderOnly" class="${freq === 'reminderOnly' ? 'on' : ''}">Kun påmindelse</button></div>
    <input type="hidden" name="frequency" value="${freq}">
    <p class="small muted" style="margin:6px 0 0">${freq === 'instant' ? 'Inden for ca. 15–30 minutter efter en ændring.' : freq === 'daily' ? 'Én besked om dagen med alt nyt – kun hvis der er nyt.' : 'Kun én påmindelse før festen.'}</p>
    ${freq === 'daily' ? `<label class="f"><span>Tidspunkt for opsamling</span><select name="digestHour" data-t="digest-hour">${hours}</select></label>` : ''}
    ${freq === 'reminderOnly' || t.reminder ? `<label class="f"><span>Påmindelse</span><select name="reminderBefore"><option value="1d" ${sub.reminderBefore !== '3h' ? 'selected' : ''}>1 dag før</option><option value="3h" ${sub.reminderBefore === '3h' ? 'selected' : ''}>3 timer før</option></select></label>
      ${!S.party.date ? '<p class="small muted">Gildet har ingen dato endnu, så der kommer ingen påmindelse.</p>' : ''}` : ''}
    <div class="row-actions">
      <button type="button" class="btn sm" data-act="notif-test" data-t="notif-test">📨 Send testbesked</button>
      <button type="button" class="btn sm danger" data-act="notif-toggle" data-t="notif-off">🔕 Slå notifikationer fra</button>
    </div>
    ${settingsState.msg ? `<p class="small" style="margin:8px 0 0">${esc(settingsState.msg)}</p>` : ''}
    <p style="margin:8px 0 0">${guideBtn}</p></form>`;
}

function subPrefsFrom(sub) {
  return { topics: { ...DEFAULT_TOPICS, ...(sub?.topics || {}) }, frequency: sub?.frequency || 'instant',
    digestHour: Number.isInteger(sub?.digestHour) ? sub.digestHour : 18, reminderBefore: sub?.reminderBefore === '3h' ? '3h' : '1d' };
}
/** Gem abonnement. Afviser (ældre) regler emnet „payments“, gemmes uden – notifieren regner et manglende emne som „til“. */
async function saveSubSafe(data, isNew) {
  try { return await store.saveSub(S.pid, data, isNew); }
  catch (e) {
    if (!/permission|insufficient/i.test(e.code + ' ' + e.message) || !data.topics || !('payments' in data.topics)) throw e;
    const { payments, ...topics } = data.topics;
    return store.saveSub(S.pid, { ...data, topics }, isNew);
  }
}
async function toggleNotifications() {
  const sub = settingsState.sub;
  const on = !!(sub?.enabled && sub.channels?.push);
  settingsState.busy = true; settingsState.msg = ''; renderSettings();
  try {
    if (on) {
      await store.saveSub(S.pid, { enabled: false });
      settingsState.sub = { ...sub, enabled: false }; toast('Notifikationer er slået fra');
    } else {
      const push = await subscribePush();
      const data = { enabled: true, participantId: myId() || '', tz: 'Europe/Copenhagen', channels: { push: { ...push, ua: deviceLabel() } },
        ...subPrefsFrom(sub), baselineAt: store.ts() };
      await saveSubSafe(data, !sub);
      settingsState.sub = { ...(sub || {}), ...data }; toast('Notifikationer er slået til 🔔');
    }
  } catch (e) {
    console.warn(e);
    settingsState.msg = e.code === 'denied' ? 'Du sagde nej til notifikationer. Tillad dem i browserens indstillinger for siden.'
      : e.code === 'dismissed' ? 'Tryk „Tillad“, når telefonen spørger.' : errMsg(e);
  }
  settingsState.busy = false; renderSettings();
}
async function saveNotifPrefs(form) {
  const sub = settingsState.sub; if (!sub) return;
  const topics = { ...subPrefsFrom(sub).topics };
  const boxes = $$('input[name=topic]', form);
  if (boxes.length) for (const k of Object.keys(DEFAULT_TOPICS)) topics[k] = boxes.some(b => b.value === k && b.checked);
  const frequency = form.frequency.value;
  const upd = { topics, frequency, digestHour: form.digestHour ? Number(form.digestHour.value) : subPrefsFrom(sub).digestHour,
    reminderBefore: form.reminderBefore ? form.reminderBefore.value : subPrefsFrom(sub).reminderBefore };
  if (frequency !== sub.frequency) upd.baselineAt = store.ts();   // ingen gammel ophobning ved skift
  try { await saveSubSafe(upd); settingsState.sub = { ...sub, ...upd }; settingsState.msg = 'Gemt ✓'; renderSettings(); }
  catch (e) { fail(e); }
}
async function testNotification() {
  try {
    await localNotification('Testbesked 🔔', `Notifikationer virker på denne telefon (${S.party.name}).`, partyUrl(S.pid));
    await store.saveSub(S.pid, { testRequestedAt: store.ts() });
    settingsState.msg = 'Du burde lige have fået en lokal testbesked. En test fra serveren kommer inden for ca. 15–30 minutter.';
  } catch (e) { settingsState.msg = errMsg(e); }
  renderSettings();
}
function syncSubParticipant() {
  if (store.backend.kind === 'mock' || !S.pid) return;
  store.getSub(S.pid).then(sub => { if (sub && sub.participantId !== (myId() || '')) return store.saveSub(S.pid, { participantId: myId() || '' }); }).catch(() => {});
}

// ───────────────────────────── Handlinger ─────────────────────────────
function readPerson(form) {
  const name = form.name.value.trim(), phone = cleanPhone(form.phone.value);
  const child = !!form.isChild?.checked;
  if (!name) return { err: 'Skriv dit navn.' };
  if (child && !phone) return { name, phone: '' };             // børn behøver ikke telefonnummer
  if (!isValidPhone(phone)) return { err: child ? 'Telefonnummeret ser forkert ud (8 cifre) – eller lad feltet stå tomt.' : 'Skriv et gyldigt telefonnummer (8 cifre).' };
  return { name, phone };
}
async function register(form) {
  const p = readPerson(form);
  const errEl = $('.err', form) || $('#join-err');
  if (p.err) { errEl.textContent = p.err; return; }
  const btn = $('button:not([type=button])', form); btn.disabled = true;
  try {
    const child = !!form.isChild?.checked;
    const d = form.querySelector('[name=diet]') ? readDiet(form) : { diet: [], dietNote: '' };
    const id = await store.add(S.pid, 'participants', { name: p.name, phone: p.phone, ...(child ? { isChild: true } : {}),
      ...(d.diet.length ? { diet: d.diet } : {}), ...(d.dietNote ? { dietNote: d.dietNote } : {}) });
    LS.set(meKey(S.pid), id); if (!child) LS.set('sg:profile', { name: p.name, phone: p.phone });
    store.logActivity(S.pid, 'guest', `${p.name} er tilmeldt${child ? ' (barn)' : ''}`, { participantId: id });
    syncSubParticipant();
    closeSheet(); toast(`Velkommen, ${p.name}! 🎉`); render();
  } catch (e) { btn.disabled = false; fail(e); }
}

async function presetEvents(which) {
  const maxOrder = Math.max(0, ...S.events.map(e => e.order ?? 0));
  const titles = which === 'menu' ? ['Forret', 'Hovedret', 'Dessert'] : [which];
  try {
    for (const [i, t] of titles.entries()) await store.add(S.pid, 'events', { title: t, kind: 'ret', time: '', order: maxOrder + i + 1 });
    store.logActivity(S.pid, 'party', `Nyt i programmet: ${titles.join(', ')}`, { participantId: myId() || '' });
    toast(titles.join(', ') + ' tilføjet');
  }
  catch (e) { fail(e); }
}

// ── Husstande & status: handlinger ─────────────────────────────────────────
const statusText = (name, st) => `${name} ${STATUS[st][2]}`;
async function setStatus(p, st) {
  if (!p || !STATUS[st] || statusOf(p) === st) return;
  if (!canEditPerson(p)) { toast('Det kan kun personen selv, husstanden eller værten ændre'); return; }
  try {
    await store.update(S.pid, 'participants', p.id, { status: st });
    const m = me();
    store.logActivity(S.pid, 'guest', p.id === m?.id || !m ? statusText(p.name, st) : `${statusText(p.name, st)} (meldt af ${firstName(m.name)})`, { participantId: myId() || '' });
    toast(`${p.id === myId() ? 'Du' : firstName(p.name)}: ${STATUS[st][1].toLowerCase()} ${STATUS[st][0]}`);
  } catch (e) { fail(e); }
}
/** Hvad skal der ske med min gamle husstand, når jeg forlader den? */
function leaveInfo(m, newHid) {
  const old = m.householdId && hhById(m.householdId);
  if (!old || old.id === newHid) return null;
  const keepMember = S.participants.some(p => p.id !== m.id && p.ownerUid === store.uid && p.householdId === old.id);
  const othersLeft = S.participants.some(p => p.id !== m.id && p.householdId === old.id);
  const onlyMe = (old.memberUids || []).every(u => u === store.uid);
  return { hid: old.id, keepMember, remove: !othersLeft && onlyMe && !keepMember };
}
async function joinHousehold(hid) {
  const m = me(), h = hhById(hid); if (!m || !h) return;
  if (m.ownerUid !== store.uid) { toast('Du kan kun melde dig selv ind'); return; }
  const old = hhOfP(m);
  if (old && !confirm(`Flyt dig fra ${old.name} til ${h.name}?`)) return;
  try {
    await store.joinHousehold(S.pid, hid, m.id, leaveInfo(m, hid));
    store.logActivity(S.pid, 'guest', `${m.name} er med i ${h.name}`, { participantId: m.id });
    closeSheet(); S.tab = 'gaester'; render(); toast(`Du er nu med i ${h.name} 🏠`);
  } catch (e) { fail(e); }
}
async function leaveHousehold() {
  const m = me(), h = hhOfP(m); if (!m || !h) return;
  const rest = householdMembers(h.id).filter(p => p.id !== m.id);
  const orphans = rest.length && rest.every(unclaimed) && (h.memberUids || []).every(u => u === store.uid);
  if (!confirm(`Meld dig ud af ${h.name}?${orphans ? ` ${rest.map(p => firstName(p.name)).join(', ')} bliver stående, men så kan kun værten (eller en der melder sig ind) rette dem.` : ''}`)) return;
  try { await store.leaveHousehold(S.pid, m.id, leaveInfo(m, '')); toast(`Du er meldt ud af ${h.name}`); } catch (e) { fail(e); }
}
/** Fjern en person. Har personen bidrag/udgifter, flyttes de over til mig (hvis jeg må), ellers stoppes der. */
async function removePerson(p) {
  if (!p) return;
  if (!canEditPerson(p) || p.id === myId()) { toast('Det har du ikke lov til'); return; }
  const its = S.items.filter(i => i.participantId === p.id);
  const m = me();
  if (its.length) {
    const stuck = its.filter(i => !canEditItem(i));
    if (stuck.length || !m) { alert(`${p.name} har ${its.length} ${its.length === 1 ? 'bidrag' : 'bidrag'} på listen${stuck.length ? `, som kun den, der skrev dem, eller værten kan flytte` : ''}. Flyt eller slet ${its.length === 1 ? 'det' : 'dem'} først.`); return; }
    if (!confirm(`Fjern ${p.name}? ${firstName(p.name)} har ${its.length} ${its.length === 1 ? 'bidrag' : 'bidrag'} (${its.map(i => i.title).join(', ')}), som flyttes over til dig, så regnskabet stadig passer.`)) return;
  } else if (!confirm(`Fjern ${p.name} fra gildet?`)) return;
  try {
    for (const i of its) await store.update(S.pid, 'items', i.id, { participantId: m.id });
    await store.remove(S.pid, 'participants', p.id);
    closeSheet(); toast(`${p.name} er fjernet`);
  } catch (e) { fail(e); }
}

async function paymentAction(act, pm) {
  if (!pm) return;
  const { r } = computeSettlement();
  const e = r.settled.find(x => x.id === pm.id);
  const fu = e && r.units.find(u => u.id === e.from), tu = e && r.units.find(u => u.id === e.to);
  const amt = formatKr(pm.amount), myName = me()?.name || 'Værten';
  try {
    if (act === 'pay-confirm') {
      await store.confirmPayment(S.pid, pm.id);
      store.logActivity(S.pid, 'payment', `${myName} har bekræftet at have modtaget ${amt}${fu ? ' fra ' + unitLabel(fu).name : ''} ✔️`, { participantId: myId() || '', targetPids: unitPids(fu) });
      toast('Bekræftet – tak! ✔️');
    } else if (act === 'pay-reject') {
      if (!confirm(`Har ${tu ? unitLabel(tu).name : 'I'} ikke modtaget ${amt}? Markeringen fjernes, og beløbet står som „mangler“ igen.`)) return;
      await store.remove(S.pid, 'payments', pm.id);
      store.logActivity(S.pid, 'payment', `${myName} har ikke modtaget ${amt}${fu ? ' fra ' + unitLabel(fu).name : ''} – tjek betalingen`, { participantId: myId() || '', targetPids: unitPids(fu) });
      toast('Markeringen er fjernet');
    } else {
      if (!confirm(`Fortryd betalingen på ${amt}?`)) return;
      await store.remove(S.pid, 'payments', pm.id);
      toast('Betalingen er fortrudt');
    }
  } catch (err) { fail(err); }
}

async function untakeSuggestion(x) {
  if (!x) return;
  const it = S.items.find(i => i.id === x.takenItemId);
  if (!confirm(`Fortryd „${x.title}“? Det bliver et forslag igen${it ? ', og det, der står på ' + firstName(pName(it.participantId)) + ', slettes' : ''}.`)) return;
  try {
    await store.untakeSuggestion(S.pid, x.id, it && canEditItem(it) ? it.id : null);
    store.logActivity(S.pid, 'item', `${x.title} er et forslag igen – hvem tager den?`, { participantId: myId() || '' });
    closeSheet(); toast(`${x.title} er et forslag igen`);
  } catch (e) { fail(e); }
}

async function onClick(e) {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  if (act === 'close-sheet-bg') { if (e.target === el) closeSheet(); return; }
  if (act === 'mobilepay') {
    // Deep link. Åbnes appen ikke inden for ~1,5 s, vises en hjælpetekst (appen er ikke officielt understøttet).
    setTimeout(() => { if (document.visibilityState === 'visible') toast('Åbnede MobilePay ikke? Kopiér nummer og beløb i stedet.', 4000); }, 1500);
    return; // lad linket virke normalt
  }
  e.preventDefault();
  switch (act) {
    case 'help': return helpSheet();
    case 'close-sheet': return closeSheet();
    case 'tab': S.tab = el.dataset.tab; closeSheet(); render(); scrollTo(0, 0); return;
    case 'copy': return copy(el.dataset.text, el.dataset.msg);
    case 'share': {
      const url = partyUrl(S.pid);
      if (navigator.share) { try { await navigator.share({ title: S.party.name, text: `Du er inviteret til ${S.party.name}! Skriv dig på her:`, url }); } catch {} }
      else copy(url, 'Linket er kopieret');
      return;
    }
    case 'edit-party': return partySheet();
    case 'calendar': return calendarSheet();
    case 'ics': return downloadIcs();
    case 'reuse': return reuseSheet();
    case 'pay-mark': return paySheet('mark', el.dataset.from, el.dataset.to, Number(el.dataset.amount));
    case 'pay-receive': return paySheet('receive', el.dataset.from, el.dataset.to, Number(el.dataset.amount));
    case 'pay-remind': {
      const last = LS.get(remindKey(el.dataset.from, el.dataset.to));
      if (last && Date.now() - last < 10 * 60000 && !confirm(`Du sendte en påmindelse kl. ${hhmm(last)}. Send en til?`)) return;
      try { await sendReminder(el.dataset.from, el.dataset.to, Number(el.dataset.amount)); render(); } catch (err) { fail(err); }
      return;
    }
    case 'pay-remind-all': {
      const { r } = computeSettlement();
      const list = r.transfers.filter(t => r.units.find(u => u.id === t.from)?.members.some(m => m.ownerUid));
      if (!confirm(`Send påmindelse til ${list.length} husstande/gæster, der mangler at betale?`)) return;
      try { for (const t of list) await sendReminder(t.from, t.to, t.amount, true); toast(`Påmindelse sendt til ${list.length} 🔔`, 3500); render(); } catch (err) { fail(err); }
      return;
    }
    case 'pay-confirm': case 'pay-reject': case 'pay-undo': return paymentAction(act, S.payments.find(x => x.id === id));
    case 'delete-party':
      if (!confirm(`Slet "${S.party.name}" med alle retter, gæster og udgifter? Det kan ikke fortrydes.`)) return;
      try {
        const lists = { events: S.events, participants: S.participants, items: S.items, households: S.households, suggestions: S.suggestions, payments: S.payments }, pid = S.pid;
        stopWatching(); closeSheet();
        await store.deleteParty(pid, lists);
        LS.set('sg:parties', LS.get('sg:parties', []).filter(p => p.id !== pid)); LS.del(meKey(pid));
        S.pid = null; location.hash = '#/'; toast('Gildet er slettet');
      } catch (err) { fail(err); }
      return;
    case 'preset': return presetEvents(el.dataset.p);
    case 'new-event': return eventSheet(null, el.dataset.kind);
    case 'edit-event': return eventSheet(S.events.find(x => x.id === id));
    case 'fill-title': $('#event-form').title.value = el.dataset.v; return;
    case 'move-event': {
      const evs = sortedEvents(), i = evs.findIndex(x => x.id === id), j = i + Number(el.dataset.dir);
      if (j < 0 || j >= evs.length) return;
      // normalisér rækkefølge og byt
      const order = evs.map((x, k) => k + 1); [order[i], order[j]] = [order[j], order[i]];
      try { await Promise.all(evs.map((x, k) => x.order !== order[k] ? store.update(S.pid, 'events', x.id, { order: order[k] }) : null)); } catch (err) { fail(err); }
      return;
    }
    case 'delete-event': {
      const ev = S.events.find(x => x.id === id); const n = S.items.filter(i => i.eventId === id).length;
      if (!confirm(`Slet "${ev.title}"?${n ? ` De ${n} bidrag flyttes til "Andet".` : ''}`)) return;
      try { await store.remove(S.pid, 'events', id); store.logActivity(S.pid, 'party', `Programpunkt aflyst: ${ev.title}`, { participantId: myId() || '' }); closeSheet(); toast('Punktet er slettet'); } catch (err) { fail(err); }
      return;
    }
    case 'new-item': return itemSheet(null, el.dataset.event || '', el.dataset.kind || 'ret');
    case 'new-suggestion': return suggestionSheet(el.dataset.event || '');
    case 'fill-sug': $('#suggestion-form').title.value = el.dataset.v; return;
    case 'take-suggestion': {
      const x = sugById(id); if (!x) return;
      if (isTaken(x, S.items)) { toast('Den er allerede taget'); return; }
      return itemSheet(null, x.eventId && S.events.some(e => e.id === x.eventId) ? x.eventId : '', 'ret', x);
    }
    case 'untake-suggestion': return untakeSuggestion(sugById(id));
    case 'delete-suggestion': {
      const x = sugById(id); if (!x) return;
      if (!confirm(`Slet forslaget „${x.title}“?`)) return;
      try { await store.remove(S.pid, 'suggestions', id); toast('Forslaget er slettet'); } catch (err) { fail(err); }
      return;
    }
    case 'edit-item': return itemSheet(S.items.find(x => x.id === id));
    case 'delete-item': {
      if (!confirm('Slet denne post?')) return;
      const it = S.items.find(x => x.id === id), x = it?.suggestionId && sugById(it.suggestionId);
      try {
        // Kom retten fra et forslag, bliver forslaget ledigt igen
        if (x && x.takenItemId === id && (x.takenByUid === store.uid || S.admin)) await store.untakeSuggestion(S.pid, x.id, id);
        else await store.remove(S.pid, 'items', id);
        closeSheet(); toast(x ? 'Slettet – det er et forslag igen' : 'Slettet');
      } catch (err) { fail(err); }
      return;
    }
    case 'edit-me': return meSheet(true);
    case 'not-me': return meSheet(false);
    case 'be': if (id) LS.set(meKey(S.pid), id); else LS.del(meKey(S.pid)); syncSubParticipant(); closeSheet(); render(); if (id) toast(`Hej ${pName(id)}!`); return;
    case 'settings': return settingsSheet();
    case 'notif-toggle': return toggleNotifications();
    case 'notif-test': return testNotification();
    case 'notif-guide': return notifGuideSheet();
    case 'copy-app-link': return copy(appLink(), 'App-linket er kopieret');
    case 'forget-party':
      if (!confirm('Glem gildet på denne telefon? (Det slettes ikke for de andre.)')) return;
      LS.set('sg:parties', LS.get('sg:parties', []).filter(p => p.id !== S.pid)); LS.del(meKey(S.pid));
      store.deleteSub(S.pid).catch(() => {}); location.hash = '#/'; toast('Gildet er glemt på denne telefon'); return;
    case 'clear-parties': if (confirm('Ryd listen over dine gilder på denne telefon?')) { LS.set('sg:parties', []); closeSheet(); render(); } return;
    case 'paste-clip': try { $('#paste-link').value = await navigator.clipboard.readText(); } catch { toast('Tryk i feltet og vælg Indsæt'); } return;
    case 'open-pasted': {
      const v = ($('#paste-link')?.value || '').trim(); const mm = v.match(/#\/p\/[A-Za-z0-9\/]+/);
      if (!mm) { toast('Det ligner ikke et link til et gilde'); return; }
      closeSheet(); location.hash = mm[0].slice(1); return;
    }
    case 'remove-person': return removePerson(pById(id));
    case 'rsvp': return setStatus(pById(id), el.dataset.v);
    case 'claim': { const p = pById(id); if (p && unclaimed(p)) claimSheet(p); return; }
    case 'skip-claim': S.skipClaim = true; render(); $('#join-form input')?.focus(); return;
    case 'household-sheet': return householdSheet();
    case 'join-household': return joinHousehold(id);
    case 'leave-household': return leaveHousehold();
    case 'rename-household': return renameSheet(id);
    case 'add-member': return personSheet(id, null);
    case 'edit-person': { const p = pById(id); if (p && canEditPerson(p)) personSheet(p.householdId, p); return; }
  }
}

function onSegClick(e) {
  const b = e.target.closest('.seg button'); if (!b || b.dataset.act) return false;
  const seg = b.parentElement, form = seg.closest('form');
  $$('button', seg).forEach(x => x.classList.toggle('on', x === b));
  form[seg.dataset.seg].value = b.dataset.v;
  if (seg.dataset.seg === 'split') {
    $('#among', form).style.display = b.dataset.v === 'selected' ? '' : 'none';
    $('#among-hh', form).style.display = b.dataset.v === 'households' ? '' : 'none';
    $('.split-help', form).textContent = SPLIT_HELP[b.dataset.v];
  }
  if (form.id === 'notif-form') { saveNotifPrefs(form); return true; }
  if (form.id === 'event-form' && seg.dataset.seg === 'kind') form.title.placeholder = b.dataset.v === 'program' ? 'F.eks. Kaffe og kage' : 'F.eks. Tapas';
  return true;
}

async function onSubmit(e) {
  const f = e.target; e.preventDefault();
  const err = m => { const el = $('.err', f); if (el) el.textContent = m; };
  const btn = $('button:not([type=button])', f);
  const busy = async fn => { btn.disabled = true; try { await fn(); } catch (x) { fail(x); } finally { btn.disabled = false; } };
  if (f.id === 'create-form') {
    const name = f.name.value.trim(); if (!name) return err('Giv gildet et navn.');
    return busy(async () => {
      const { id } = await store.createParty({ name, date: f.date.value, time: f.time.value, place: f.place.value.trim(), note: f.note.value.trim() });
      S.justCreated = true; location.hash = '#/p/' + id;
    });
  }
  if (f.id === 'join-form' || f.id === 'switch-form') return register(f);
  if (f.id === 'household-form') {
    const name = f.name.value.trim(); if (!name) return err('Giv husstanden et navn.');
    const m = me(); if (!m) return err('Tilmeld dig først.');
    return busy(async () => {
      if (f.dataset.id) { await store.renameHousehold(S.pid, f.dataset.id, name); closeSheet(); toast('Gemt'); return; }
      await store.createHousehold(S.pid, name, m.id, leaveInfo(m, 'ny'));
      store.logActivity(S.pid, 'guest', `${m.name} har oprettet husstanden ${name}`, { participantId: m.id });
      closeSheet(); S.tab = 'gaester'; render(); toast(`${name} er oprettet – tilføj dem, du kommer med 🏠`);
    });
  }
  if (f.id === 'person-form') {
    const name = f.name.value.trim(), phone = cleanPhone(f.phone.value);
    if (!name) return err('Skriv et navn.');
    if (phone && !isValidPhone(phone)) return err('Telefonnummeret ser forkert ud (8 cifre) – eller lad feltet stå tomt.');
    const status = f.status.value, isChild = f.isChild ? f.isChild.checked : undefined;
    return busy(async () => {
      const who = me()?.name || 'Værten';
      if (f.dataset.id) {
        const old = pById(f.dataset.id);
        await store.update(S.pid, 'participants', f.dataset.id, { name, phone, status, ...(isChild !== undefined ? { isChild } : {}), ...dietUpd(f, old) });
        if (old && statusOf(old) !== status) store.logActivity(S.pid, 'guest', f.dataset.id === myId() ? statusText(name, status) : `${statusText(name, status)} (meldt af ${firstName(who)})`, { participantId: myId() || '' });
        closeSheet(); toast('Gemt');
      } else {
        const h = hhById(f.dataset.hid);
        await store.addMember(S.pid, f.dataset.hid, { name, phone, isChild: !!isChild, status, ...readDiet(f) });
        store.logActivity(S.pid, 'guest', `${firstName(who)} har tilføjet ${name}${isChild ? ' (barn)' : ''} til ${h?.name || 'husstanden'}${status !== 'yes' ? ' – ' + STATUS[status][2] : ''}`, { participantId: myId() || '' });
        closeSheet(); toast(`${name} er tilføjet`);
      }
    });
  }
  if (f.id === 'claim-form') {
    const p = pById(f.dataset.id); if (!p || !unclaimed(p)) return err('Personen er allerede overtaget af en anden.');
    const pr = readPerson(f); if (pr.err) return err(pr.err);
    return busy(async () => {
      const isChild = !!f.isChild?.checked;
      await store.claim(S.pid, p, { ...pr, status: f.status.value, isChild });
      LS.set(meKey(S.pid), p.id); if (!isChild) LS.set('sg:profile', pr);
      const hh = hhOfP(p);
      store.logActivity(S.pid, 'guest', `${pr.name} er tilmeldt${hh ? ' (' + hh.name + ')' : ''}${f.status.value !== 'yes' ? ' – ' + STATUS[f.status.value][2] : ''}`, { participantId: p.id });
      syncSubParticipant();
      closeSheet(); toast(`Velkommen, ${firstName(pr.name)}! 🎉`); render();
    });
  }
  if (f.id === 'profile-form') {
    const p = readPerson(f); if (p.err) return err(p.err);
    LS.set('sg:profile', p); toast('Gemt'); closeSheet(); return;
  }
  if (f.id === 'me-form') {
    const p = readPerson(f); if (p.err) return err(p.err);
    const m = me(); if (!m) return err('Du er ikke tilmeldt.');
    const isChild = !!f.isChild?.checked, status = f.status ? f.status.value : statusOf(m);
    const upd = { ...p, isChild, ...(f.status ? { status } : {}), ...dietUpd(f, m) };
    return busy(async () => {
      await store.update(S.pid, 'participants', m.id, upd);
      if (!isChild) LS.set('sg:profile', p);
      if (statusOf(m) !== status) store.logActivity(S.pid, 'guest', statusText(p.name, status), { participantId: m.id });
      closeSheet(); toast('Din tilmelding er gemt ✓', 3500);
      if ($('#settings-body')) renderSettings();
    });
  }
  if (f.id === 'party-form') {
    const name = f.name.value.trim(); if (!name) return err('Giv gildet et navn.');
    return busy(async () => {
      const old = S.party, nu = { name, date: f.date.value, time: f.time.value, place: f.place.value.trim(), note: f.note.value.trim() };
      await store.updateParty(S.pid, nu);
      const what = [];
      if (old.date !== nu.date || old.time !== nu.time) what.push(`nyt tidspunkt: ${prettyDate(nu.date, true)}${nu.time ? ' kl. ' + nu.time : ''}`);
      if (old.place !== nu.place) what.push(`nyt sted: ${nu.place || '(intet)'}`);
      if (old.name !== nu.name) what.push(`nyt navn: ${nu.name}`);
      if (old.note !== nu.note) what.push('ny besked fra værten');
      if (what.length) store.logActivity(S.pid, 'party', `Gildet er ændret – ${what.join(', ')}`, { participantId: myId() || '' });
      closeSheet(); toast('Gildet er opdateret');
    });
  }
  if (f.id === 'event-form') {
    const title = f.title.value.trim(); if (!title) return err('Skriv en titel.');
    const data = { title, kind: f.kind.value, time: f.time.value };
    return busy(async () => {
      if (f.dataset.id) await store.update(S.pid, 'events', f.dataset.id, data);
      else await store.add(S.pid, 'events', { ...data, order: Math.max(0, ...S.events.map(x => x.order ?? 0)) + 1 });
      store.logActivity(S.pid, 'party', `${f.dataset.id ? 'Programpunkt ændret' : 'Nyt programpunkt'}: ${data.time ? data.time + ' ' : ''}${title}`, { participantId: myId() || '' });
      closeSheet(); toast(f.dataset.id ? 'Gemt' : `${title} er tilføjet`);
    });
  }
  if (f.id === 'pay-form') {
    const amount = parseKr(f.amount.value);
    if (!amount) return err('Skriv beløbet, f.eks. 150,00');
    const { r } = computeSettlement();
    const fu = r.units.find(u => u.id === f.dataset.from), tu = r.units.find(u => u.id === f.dataset.to);
    if (!fu || !tu) return err('Regnskabet er ændret – luk og prøv igen.');
    const confirmed = f.dataset.mode === 'receive';
    return busy(async () => {
      const to = payeeOf(tu, r);
      await store.addPayment(S.pid, { fromUnit: fu.id, toUnit: tu.id, fromPid: payerOf(fu)?.id, toPid: to?.id, amount }, confirmed);
      const myName = me()?.name || 'Værten';
      store.logActivity(S.pid, 'payment', confirmed ? `${myName} har registreret, at ${unitLabel(tu).name} har modtaget ${formatKr(amount)} fra ${unitLabel(fu).name} ✔️`
        : `${myName} har betalt ${formatKr(amount)} til ${unitLabel(tu).name} – bekræft, når pengene er modtaget`,
        { participantId: myId() || '', targetPids: unitPids(confirmed ? fu : tu) });
      closeSheet(); toast(confirmed ? 'Registreret som modtaget ✔️' : `Markeret som betalt ✅ ${unitLabel(tu).name} får besked`, 3500);
    });
  }
  if (f.id === 'reuse-form') {
    const name = f.name.value.trim(); if (!name) return err('Giv den nye fest et navn.');
    return busy(async () => {
      const src = { events: sortedEvents(), households: S.households, participants: sortedPeople() };
      const m = me();
      const res = await store.copyParty(src, { fields: { name, date: f.date.value, time: f.time.value, place: f.place.value.trim(), note: f.note.value.trim() },
        events: !!f.events?.checked, households: !!f.households?.checked, placeholders: !!f.placeholders?.checked, me: f.me?.checked && m?.ownerUid === store.uid ? m : null });
      if (res.myPid) LS.set(meKey(res.id), res.myPid);
      S.justReused = { from: S.party.name, ...res.counts };
      closeSheet(); location.hash = '#/p/' + res.id; toast('Den nye fest er oprettet ♻️');
    });
  }
  if (f.id === 'suggestion-form') {
    const title = f.title.value.trim(); if (!title) return err('Skriv hvad der mangler.');
    const eventId = f.eventId?.value || '', note = f.note.value.trim();
    return busy(async () => {
      await store.add(S.pid, 'suggestions', { title, eventId, note, byPid: myId() || '' });
      const ev = S.events.find(x => x.id === eventId);
      store.logActivity(S.pid, 'item', `${me()?.name || 'En gæst'} foreslår: ${title}${ev ? ' (til ' + ev.title.toLowerCase() + ')' : ''} – hvem tager den?`, { participantId: myId() || '' });
      closeSheet(); toast('Forslaget er tilføjet 💡');
    });
  }
  if (f.id === 'item-form') {
    const title = f.title.value.trim(); if (!title) return err('Skriv hvad det er.');
    const kind = f.kind.value;
    const costStr = f.cost.value.trim();
    const cost = costStr ? parseKr(costStr) : 0;
    if (cost == null) return err('Beløbet forstås ikke – skriv f.eks. 149,95');
    if (kind === 'udgift' && !cost) return err('Skriv beløbet.');
    const servings = f.servings ? parseInt(f.servings.value, 10) || 0 : 0;
    const split = f.split.value;
    let among = split === 'selected' ? $$('input[name=among]:checked', f).map(x => x.value) : [];
    if (split === 'households') {
      const boxes = $$('input[name=amongHh]', f), on = boxes.filter(x => x.checked).map(x => x.value);
      if (cost && !on.length) return err('Vælg mindst én husstand.');
      among = on.length === boxes.length ? [] : on;   // alle valgt = alle husstande (også nye)
    }
    if (cost && split === 'selected' && !among.length) return err('Vælg mindst én voksen – børn betaler ikke med ved deling pr. person.');
    const data = { title, kind, servings, note: f.note.value.trim(), cost, split: cost ? split : 'all', among: cost && split !== 'none' ? among : [] };
    const unsharedNow = cost > 0 && split === 'none';
    // Mærker: kun skrevet, når der er nogen (eller de fjernes) – så nye poster også virker med ældre regler
    const tags = $$('input[name=tags]:checked', f).map(x => x.value);
    const oldIt = f.dataset.id && S.items.find(x => x.id === f.dataset.id);
    if (kind !== 'udgift' && (tags.length || cleanTags(oldIt?.tags, DISH_TAGS).length)) data.tags = cleanTags(tags, DISH_TAGS);
    return busy(async () => {
      const who = (f.who && f.who.value !== myId() ? pName(f.who.value) : me()?.name) || 'Nogen';
      if (f.dataset.id) {
        const old = S.items.find(x => x.id === f.dataset.id);
        await store.update(S.pid, 'items', f.dataset.id, data);
        const wasUnshared = (old?.cost || 0) > 0 && old.split === 'none';
        if (old && ((old.cost || 0) !== cost || wasUnshared !== unsharedNow)) {
          const t = unsharedNow ? `${pName(old.participantId)}: ${title} (${formatKr(cost)}) deles ikke længere – betaler selv`
            : wasUnshared && cost ? `${pName(old.participantId)}: ${title} (${formatKr(cost)}) deles nu i regnskabet`
            : `${pName(old.participantId)}: udgiften for ${title} er nu ${formatKr(cost)}`;
          store.logActivity(S.pid, 'cost', t, { participantId: myId() || '' });
        }
      } else if (f.dataset.sug) {
        const sug = sugById(f.dataset.sug);
        if (!sug || isTaken(sug, S.items)) { closeSheet(); toast('Nogen har lige taget den 🙂', 3000); return; }
        const forId = f.who?.value || myId();
        try { await store.takeSuggestion(S.pid, sug.id, { ...data, eventId: f.dataset.event || '', participantId: forId }, forId); }
        catch (x) { if (x?.code === 'permission-denied') { closeSheet(); toast('Nogen har lige taget den 🙂', 3000); return; } throw x; }
        store.logActivity(S.pid, 'item', `${who} tager ${title} med (fra forslagene)${cost ? ' (' + formatKr(cost) + (unsharedNow ? ', betaler selv' : '') + ')' : ''}`, { participantId: myId() || '', hasCost: cost > 0 && !unsharedNow });
        closeSheet(); toast(`Tak! ${title} står nu på ${forId === myId() ? 'dig' : firstName(pName(forId))} 🙌`); return;
      } else {
        const forId = f.who?.value || myId();
        await store.add(S.pid, 'items', { ...data, eventId: f.dataset.event || '', participantId: forId });
        const ev = S.events.find(x => x.id === f.dataset.event);
        const costTxt = cost ? ' (' + formatKr(cost) + (unsharedNow ? ', betaler selv' : '') + ')' : '';
        const text = kind === 'udgift' ? (unsharedNow ? `${who} har betalt ${title} selv (${formatKr(cost)} – deles ikke)` : `${who} har lagt ud for ${title} (${formatKr(cost)})`)
          : kind === 'aktivitet' ? `${who} står for ${title}${ev ? ' (' + ev.title + ')' : ''}${costTxt}`
          : `${who} tager ${title} med${ev ? ' til ' + ev.title.toLowerCase() : ''}${costTxt}`;
        // "Ingen" påvirker ikke regnskabet → ikke en udgifts-notifikation
        store.logActivity(S.pid, kind === 'udgift' && !unsharedNow ? 'cost' : 'item', text, { participantId: myId() || '', hasCost: kind !== 'udgift' && cost > 0 && !unsharedNow });
      }
      closeSheet(); toast(f.dataset.id ? 'Gemt' : 'Tilføjet – tak! 🙌');
    });
  }
}

// ───────────────────────────── Start ─────────────────────────────
document.addEventListener('click', e => { if (onSegClick(e)) return; onClick(e); });
document.addEventListener('submit', onSubmit);
document.addEventListener('change', e => { const f = e.target.closest('#notif-form'); if (f) saveNotifPrefs(f); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

(async () => {
  try { store = await createStore(); if (store.backend.kind !== 'firebase') window.__sgStore = store; }   // kun i emulator/mock (tests)
  catch (e) {
    console.error(e);
    $('#app').innerHTML = `<div class="wrap"><div class="card empty"><div class="big">🔌</div><h2>Kunne ikke forbinde</h2><p>${esc(errMsg(e))}</p><button class="btn" onclick="location.reload()">Prøv igen</button></div></div>`;
    return;
  }
  addEventListener('hashchange', route);
  route();
  if (store.backend.kind !== 'mock') registerServiceWorker();
  navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'open' && e.data.url) location.href = e.data.url; });
})();
