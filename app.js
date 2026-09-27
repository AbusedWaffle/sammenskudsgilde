import { createStore } from './data.js';
import { settle, parseKr, formatKr } from './settle.js';
import { cleanPhone, prettyPhone, mobilepayPhone, isValidPhone } from './util.js';

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
const ITEM_KINDS = { ret: ['🍽️', 'Ret'], aktivitet: ['🎲', 'Aktivitet'], andet: ['🎁', 'Andet'], udgift: ['🧾', 'Udgift'] };

// ───────────────────────────── Tilstand ─────────────────────────────
let store;
const S = {
  view: 'home', pid: null, party: undefined, events: [], participants: [], items: [],
  loaded: {}, admin: false, tab: 'program', unsubs: [], error: null, justCreated: false,
};
window.__sg = S; // til fejlsøgning/tests

const meKey = pid => 'sg:me:' + pid;
const myId = () => LS.get(meKey(S.pid));
const me = () => S.participants.find(p => p.id === myId()) || null;
const pById = id => S.participants.find(p => p.id === id);
const pName = id => pById(id)?.name || 'Ukendt';
const canEditItem = it => it.ownerUid === store.uid || S.admin;
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
  const m = h.match(/^p\/([A-Za-z0-9]{20,40})(?:\/admin\/([0-9a-f]{64}))?$/);
  closeSheet();
  if (!m) { stopWatching(); S.view = 'home'; S.pid = null; render(); return; }
  const [, pid, token] = m;
  if (token) sessionStorage.setItem('sg:pendingAdmin', JSON.stringify({ pid, token }));
  if (token) { history.replaceState(null, '', '#/p/' + pid); }
  if (S.pid !== pid) startWatching(pid);
  S.view = 'party';
  render();
}

function stopWatching() { S.unsubs.forEach(u => u()); S.unsubs = []; }
function startWatching(pid) {
  stopWatching();
  Object.assign(S, { pid, party: undefined, events: [], participants: [], items: [], loaded: {}, admin: false, error: null, tab: 'program' });
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
}

// ───────────────────────────── Render ─────────────────────────────
function render() {
  const app = $('#app');
  const y = scrollY;
  // Bevar indtastning i formularer på siden, når live-opdateringer tegner siden igen.
  const kept = $$('form[id] input:not([type=hidden]), form[id] textarea', app).map(el => ({ f: el.form.id, n: el.name, v: el.value, focus: el === document.activeElement, sel: el.selectionStart }));
  app.innerHTML = S.view === 'home' ? homeView() : partyView();
  for (const k of kept) {
    const el = $(`form#${k.f} [name="${k.n}"]`, app); if (!el) continue;
    el.value = k.v;
    if (k.focus) { el.focus(); try { el.setSelectionRange(k.sel, k.sel); } catch {} }
  }
  if (S.view === 'party' && S.tab === 'del') drawQr();
  scrollTo(0, y);
  if (S.justCreated && S.party && S.loaded.participants) { S.justCreated = false; afterCreate(); }
}

function topbar(back) {
  return `<div class="top">
    ${back ? `<a class="iconbtn" href="#/" aria-label="Til forsiden" data-t="home">←</a>` : ''}
    <a class="brand" href="#/"><img src="icon-192.png" alt=""><b>Sammen<span>skud</span>sgilde</b></a>
    <button class="iconbtn" data-act="help" aria-label="Sådan virker det">?</button>
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
    <div class="row-actions">
      <button class="btn sm yellow" data-act="tab" data-tab="del">🔗 Inviter gæster</button>
      ${S.admin ? `<button class="btn sm" data-act="edit-party" data-t="edit-party">✏️ Ret gildet</button>` : ''}
    </div>
  </div>
  ${identityBar()}
  ${body}
  </div>
  <nav class="tabbar"><div class="tabbar-in">${tabs.map(([k, i, l]) => `<button class="${S.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}" data-t="tab-${k}"><i>${i}</i>${l}</button>`).join('')}</div></nav>`;
}

function identityBar() {
  if (!S.loaded.participants) return '';
  const m = me();
  if (m) return `<div class="me" data-t="me">${avatar(m)}<div class="grow"><div class="small muted">Du er tilmeldt som</div><b>${esc(m.name)}</b>
    <div><button class="linkbtn small" data-act="not-me" data-t="not-me">Jeg er ikke ${esc(m.name.split(' ')[0])}</button></div></div>
    <button class="btn sm ghost" data-act="edit-me" aria-label="Ret mine oplysninger">✏️ Ret</button></div>`;
  const prof = LS.get('sg:profile', {});
  const mineHere = S.participants.filter(p => p.ownerUid === store.uid);
  return `<form class="card join" id="join-form" autocomplete="on">
    <h2>Hvem er du? 👋</h2>
    <p class="small muted" style="margin:4px 0 0">Skriv dit navn og telefonnummer, så de andre kan se hvem du er (og betale dig tilbage via MobilePay).</p>
    ${mineHere.length ? `<div class="chips" style="margin-top:10px">${mineHere.map(p => `<button type="button" class="chip solid" data-act="be" data-id="${p.id}">Jeg er ${esc(p.name)}</button>`).join('')}</div>` : ''}
    <label class="f"><span>Navn</span><input type="text" name="name" maxlength="60" required autocomplete="name" value="${esc(prof.name || '')}" placeholder="Dit navn"></label>
    <label class="f"><span>Telefonnummer</span><input type="tel" name="phone" maxlength="20" required autocomplete="tel" inputmode="tel" value="${esc(prof.phone || '')}" placeholder="12 34 56 78"></label>
    <div class="err" id="join-err"></div>
    <button class="btn primary block" style="margin-top:12px" data-t="join">Tilmeld mig</button>
  </form>`;
}

function itemRow(it) {
  const [ic] = ITEM_KINDS[it.kind] || ITEM_KINDS.ret;
  const bits = [esc(pName(it.participantId))];
  if (it.servings) bits.push(`til ${it.servings} pers.`);
  if (it.cost) bits.push(`<span class="cost">${formatKr(it.cost)}</span> ${it.split === 'selected' ? `(deles af ${(it.among || []).filter(pById).length})` : '(deles af alle)'}`);
  const mine = it.participantId === myId();
  return `<li class="item${mine ? ' mine' : ''}" data-t="item"><span class="it-ic">${ic}</span><div class="grow">
    <div class="t">${esc(it.title)}</div><div class="s">${bits.join(' · ')}</div>${it.note ? `<div class="n">${esc(it.note)}</div>` : ''}</div>
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
  const cards = evs.map((ev, idx) => {
    const its = S.items.filter(i => i.eventId === ev.id).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const serv = its.filter(i => i.kind !== 'aktivitet').reduce((s, i) => s + (i.servings || 0), 0);
    return `<section class="card event" data-t="event" data-title="${esc(ev.title)}">
      <div class="ev-head"><span class="ev-ic">${eventIcon(ev)}</span>
        <div class="ev-title"><h3>${ev.time ? `<span class="time">${esc(ev.time)}</span>` : ''}${esc(ev.title)}</h3>
        <div class="ev-sum">${its.length ? `${its.length} ${its.length === 1 ? 'bidrag' : 'bidrag'}${serv ? ` · mad til ca. ${serv} pers.` : ''}` : 'Ingen har skrevet sig på endnu'}</div></div>
        ${S.admin ? `<div class="admin-bar">${idx > 0 ? `<button class="btn sm ghost" data-act="move-event" data-id="${ev.id}" data-dir="-1" aria-label="Flyt op">↑</button>` : ''}<button class="btn sm ghost" data-act="edit-event" data-id="${ev.id}" aria-label="Ret punkt">⋯</button></div>` : ''}
      </div>
      ${its.length ? `<ul class="items">${its.map(itemRow).join('')}</ul>` : ''}
      <div class="ev-foot"><button class="addbtn" data-act="new-item" data-event="${ev.id}" data-t="add-item">+ Jeg tager noget med</button></div>
    </section>`;
  }).join('');
  const empty = !evs.length ? `<div class="card empty"><div class="big">🍽️</div><p>${S.admin ? 'Tilføj forret, hovedret, dessert eller programpunkter herover – så kan gæsterne skrive sig på.' : 'Værten har ikke lagt program eller retter ind endnu. Du kan stadig skrive, hvad du tager med:'}</p>
    ${!S.admin ? `<button class="btn" data-act="new-item" data-event="">+ Jeg tager noget med</button>` : ''}</div>` : '';
  const looseCard = loose.filter(i => i.kind !== 'udgift').length ? `<section class="card event"><div class="ev-head"><span class="ev-ic">🧺</span><div class="ev-title"><h3>Andet</h3></div></div>
    <ul class="items">${loose.filter(i => i.kind !== 'udgift').map(itemRow).join('')}</ul><div class="ev-foot"></div></section>` : '';
  return (evs.length ? cards + presets : presets + empty) + looseCard;
}

function guestsTab() {
  const ps = sortedPeople();
  if (!ps.length) return `<div class="card empty"><div class="big">👥</div><p>Ingen er tilmeldt endnu. Del linket med gæsterne!</p><button class="btn yellow" data-act="tab" data-tab="del">🔗 Inviter gæster</button></div>`;
  return `<div class="card"><h2>Gæster (${ps.length})</h2><ul class="people" style="margin-top:8px">
    ${ps.map(p => {
      const its = S.items.filter(i => i.participantId === p.id && i.kind !== 'udgift');
      const host = p.ownerUid === S.party.creatorUid;
      return `<li class="person" data-t="person">${avatar(p)}<div class="grow"><div class="nm">${esc(p.name)}${p.id === myId() ? '<span class="tag">dig</span>' : ''}${host ? '<span class="tag host">vært</span>' : ''}</div>
        <div class="small muted">${p.phone ? `<a href="tel:${esc(cleanPhone(p.phone))}">${esc(prettyPhone(p.phone))}</a>` : 'Intet nummer'}${its.length ? ' · ' + its.map(i => esc(i.title)).join(', ') : ''}</div></div>
        ${S.admin && p.id !== myId() ? `<button class="btn sm ghost" data-act="remove-person" data-id="${p.id}" aria-label="Fjern">✕</button>` : ''}</li>`;
    }).join('')}</ul></div>`;
}

function computeSettlement() {
  const ps = sortedPeople();
  const costs = S.items.filter(i => i.cost > 0).map(i => ({ id: i.id, title: i.title, payer: i.participantId, amount: i.cost, split: i.split || 'all', among: i.among || [] }));
  return { ps, r: settle(ps, costs) };
}

function moneyTab() {
  const { ps, r } = computeSettlement();
  const meId = myId();
  const party = S.party;
  const costItems = S.items.filter(i => i.cost > 0).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const addBtn = `<button class="btn block" data-act="new-item" data-event="" data-kind="udgift" data-t="add-expense">🧾 Tilføj en udgift (vin, leje, indkøb …)</button>`;
  if (!r.total) return `<div class="card empty"><div class="big">💰</div><p>Ingen udgifter endnu. Når nogen skriver en pris på det, de tager med, eller tilføjer en udgift, regner appen ud hvem der skylder hvem.</p>${addBtn}</div>`;
  const transfers = r.transfers.map(t => {
    const to = pById(t.to), from = pById(t.from);
    const cls = t.from === meId ? 'me-pay' : t.to === meId ? 'me-get' : '';
    const kr = (t.amount / 100).toFixed(2);
    const mpPhone = mobilepayPhone(to?.phone);
    const comment = `Sammenskud: ${party.name}`.slice(0, 60);
    const mp = `mobilepay://send?phone=${encodeURIComponent(mpPhone)}&amount=${kr}&comment=${encodeURIComponent(comment)}&lock=1`;
    const sms = `sms:${cleanPhone(to?.phone)}${isApple ? '&' : '?'}body=${encodeURIComponent(`Hej ${to?.name}! Jeg har sendt ${formatKr(t.amount)} for ${party.name} 🙂`)}`;
    return `<div class="transfer ${cls}" data-t="transfer">
      ${cls === 'me-pay' ? '<div class="tr-who">Du skal betale</div>' : cls === 'me-get' ? '<div class="tr-who">Du skal have</div>' : ''}
      <div class="tr-line">${avatar(from)} ${esc(from?.name)} <span class="muted">→</span> ${avatar(to)} ${esc(to?.name)}<span class="tr-amt mono">${formatKr(t.amount)}</span></div>
      ${to?.phone ? `<div class="small muted" style="margin-top:6px">MobilePay til <b class="mono" style="color:var(--ink)">${esc(prettyPhone(to.phone))}</b> · beløb <b class="mono" style="color:var(--ink)">${formatKr(t.amount)}</b></div>
      <div class="tr-actions">
        <button class="btn sm" data-act="copy" data-text="${esc(mpPhone)}" data-msg="Nummeret ${esc(prettyPhone(to.phone))} er kopieret">📋 Kopiér nr.</button>
        <button class="btn sm" data-act="copy" data-text="${esc(kr.replace('.', ','))}" data-msg="Beløbet ${esc(formatKr(t.amount))} er kopieret">📋 Kopiér beløb</button>
        ${t.from === meId || !meId ? `<a class="btn sm mp full" href="${esc(mp)}" data-act="mobilepay">Åbn MobilePay</a>` : ''}
        ${t.from === meId ? `<a class="btn sm ghost full" href="${esc(sms)}">💬 Send SMS til ${esc(to.name.split(' ')[0])}</a>` : ''}
      </div>` : '<div class="small muted" style="margin-top:6px">Modtageren har ikke skrevet et telefonnummer.</div>'}
    </div>`;
  }).join('');
  return `<div class="card" data-t="summary"><h2>Regnskab</h2>
    <div class="bigsum" style="margin-top:10px"><div><b class="mono" data-t="total">${formatKr(r.total)}</b><span>i alt</span></div><div><b>${ps.length}</b><span>deltagere</span></div><div><b class="mono">${formatKr(Math.round(r.total / Math.max(1, ps.length)))}</b><span>gns. pr. person</span></div></div>
  </div>
  <div class="card"><h2>Hvem skylder hvem</h2>
    ${r.transfers.length ? transfers + `<p class="small muted" style="margin:12px 0 0">„Åbn MobilePay“ forsøger at åbne appen med nummer og beløb udfyldt. MobilePay understøtter ikke dette officielt – sker der ikke noget, så kopiér nummeret og beløbet.</p>` : '<p class="muted">Alle er kvit – ingen skylder noget. 🎉</p>'}
  </div>
  <div class="card"><h2>Pr. person</h2>
    <table class="tbl" style="margin-top:6px" data-t="table"><thead><tr><th>Navn</th><th>Betalt</th><th>Andel</th><th>Saldo</th></tr></thead><tbody>
    ${ps.map(p => { const b = r.balance[p.id]; return `<tr><td>${esc(p.name)}${p.id === meId ? ' <span class="tag">dig</span>' : ''}</td><td>${formatKr(r.paid[p.id])}</td><td>${formatKr(r.share[p.id])}</td><td class="${b > 0 ? 'pos' : b < 0 ? 'neg' : ''}">${b > 0 ? '+' : ''}${formatKr(b)}</td></tr>`; }).join('')}
    </tbody></table>
    <p class="small muted" style="margin:10px 0 0">Plus = skal have penge tilbage. Minus = skylder. Deles et beløb ikke lige op, fordeles de sidste ører på de første tilmeldte.</p>
  </div>
  <div class="card"><h2>Udgifter</h2><ul class="items" style="padding:0;margin-top:6px">
    ${costItems.map(i => `<li class="item"><span class="it-ic">${(ITEM_KINDS[i.kind] || ITEM_KINDS.ret)[0]}</span><div class="grow"><div class="t">${esc(i.title)}</div>
      <div class="s">Betalt af ${esc(pName(i.participantId))} · ${i.split === 'selected' ? 'deles af ' + (i.among || []).filter(pById).map(pName).map(esc).join(', ') : 'deles af alle'}</div></div>
      <span class="cost">${formatKr(i.cost)}</span>${canEditItem(i) ? `<button class="btn sm ghost" data-act="edit-item" data-id="${i.id}" aria-label="Ret">✏️</button>` : ''}</li>`).join('')}
  </ul><div style="margin-top:12px">${addBtn}</div></div>`;
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
      <li><b>Regnskab:</b> Hver udgift kan deles mellem alle eller udvalgte. Appen viser hvem der har betalt hvad, hver persons andel, og det mindst mulige antal overførsler.</li>
      <li><b>Betal med MobilePay:</b> Ved hver gæld står modtagerens nummer og beløbet, med knapper til at kopiere og til at forsøge at åbne MobilePay.</li>
    </ol>
    <h3>Godt at vide</h3>
    <ul>
      <li>Alt opdateres live for alle, og gemmes online – også når appen er lukket.</li>
      <li>Telefonen husker, hvem du er. Er det ikke dig, så tryk „Jeg er ikke …“.</li>
      <li>Du kan rette og slette dine egne ting. Kun værten kan rette gildet og programmet.</li>
      <li>Værten kan gemme sit hemmelige værts-link under „Del“ for at kunne rette fra en anden enhed.</li>
      <li>Alle med linket kan se navne og telefonnumre – del det kun med gæsterne.</li>
      <li>Tip: Tryk „Føj til hjemmeskærm“ i browseren for at få appen som et ikon.</li>
    </ul>
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

function itemSheet(it, eventId = '', kind = 'ret') {
  const m = me();
  if (!m && !it) { toast('Tilmeld dig først – skriv dit navn og nummer'); S.tab = 'program'; render(); $('#join-form input')?.focus(); scrollTo(0, ($('#join-form')?.offsetTop || 0) - 10); return; }
  kind = it?.kind || kind;
  const isExpense = kind === 'udgift';
  const ev = S.events.find(e => e.id === (it?.eventId ?? eventId));
  const split = it?.split || 'all';
  const among = new Set(it?.among?.length ? it.among : S.participants.map(p => p.id));
  openSheet(it ? (isExpense ? 'Ret udgift' : 'Ret bidrag') : (isExpense ? 'Ny udgift' : 'Jeg tager med …'), `<form id="item-form" autocomplete="off" data-id="${it?.id || ''}" data-event="${esc(it?.eventId ?? eventId)}">
    ${ev ? `<p class="muted small" style="margin:0 0 4px">Til: <b>${eventIcon(ev)} ${esc(ev.title)}</b></p>` : ''}
    ${it && it.participantId !== myId() ? `<p class="muted small" style="margin:0 0 4px">Tilhører: <b>${esc(pName(it.participantId))}</b></p>` : ''}
    ${!isExpense ? `<div class="seg" data-seg="kind">${['ret', 'aktivitet', 'andet'].map(k => `<button type="button" data-v="${k}" class="${kind === k ? 'on' : ''}">${ITEM_KINDS[k][0]} ${ITEM_KINDS[k][1]}</button>`).join('')}</div>` : ''}
    <input type="hidden" name="kind" value="${kind}">
    <label class="f"><span>${isExpense ? 'Hvad er udgiften? *' : 'Hvad tager du med? *'}</span><input type="text" name="title" maxlength="100" required value="${esc(it?.title || '')}" placeholder="${isExpense ? 'F.eks. Vin og øl' : 'F.eks. Lasagne'}"></label>
    ${!isExpense ? `<label class="f"><span>Til hvor mange personer?</span><input type="number" name="servings" min="0" max="1000" inputmode="numeric" value="${it?.servings || ''}" placeholder="${S.participants.length || ''}"></label>` : ''}
    <label class="f"><span>Note (valgfri)</span><input type="text" name="note" maxlength="500" value="${esc(it?.note || '')}" placeholder="${isExpense ? 'F.eks. købt i Netto' : 'F.eks. vegetarisk, indeholder nødder'}"></label>
    <label class="f"><span>${isExpense ? 'Beløb i kr. *' : 'Udgift i kr. (valgfri)'}</span><input type="text" name="cost" inputmode="decimal" value="${it?.cost ? esc((it.cost / 100).toFixed(2).replace('.', ',')) : ''}" placeholder="F.eks. 149,95"></label>
    <div id="split-box" style="${it?.cost || isExpense ? '' : 'display:none'}">
      <label class="f"><span>Hvem skal dele udgiften?</span></label>
      <div class="seg" data-seg="split"><button type="button" data-v="all" class="${split === 'all' ? 'on' : ''}">Alle deltagere</button><button type="button" data-v="selected" class="${split === 'selected' ? 'on' : ''}" data-t="split-selected">Udvalgte</button></div>
      <input type="hidden" name="split" value="${split}">
      <div class="checks" id="among" style="${split === 'selected' ? '' : 'display:none'}">
        ${sortedPeople().map(p => `<label><input type="checkbox" name="among" value="${p.id}" ${among.has(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}
      </div>
    </div>
    <div class="err"></div>
    <div class="actions"><button class="btn primary" data-t="save-item">${it ? 'Gem' : 'Tilføj'}</button></div>
    ${it ? `<div class="actions"><button type="button" class="btn danger" data-act="delete-item" data-id="${it.id}">🗑️ Slet</button></div>` : ''}
  </form>`, sheet => {
    const cost = $('[name=cost]', sheet);
    cost.addEventListener('input', () => { $('#split-box', sheet).style.display = cost.value.trim() || isExpense ? '' : 'none'; });
  });
}

function meSheet(edit) {
  const m = me();
  const others = S.participants.filter(p => p.ownerUid === store.uid && p.id !== m?.id);
  if (edit) {
    openSheet('Mine oplysninger', `<form id="me-form"><label class="f"><span>Navn</span><input type="text" name="name" maxlength="60" required value="${esc(m.name)}"></label>
      <label class="f"><span>Telefonnummer</span><input type="tel" name="phone" maxlength="20" required inputmode="tel" value="${esc(m.phone)}"></label><div class="err"></div>
      <div class="actions"><button class="btn primary">Gem</button></div></form>`);
    return;
  }
  openSheet('Er du ikke ' + m.name + '?', `
    ${others.length ? `<p class="muted small">Personer tilmeldt fra denne telefon:</p><div class="chips">${others.map(p => `<button class="chip solid" data-act="be" data-id="${p.id}">Jeg er ${esc(p.name)}</button>`).join('')}</div>` : ''}
    <p class="muted small" style="margin-top:14px">Er du en ny gæst på denne telefon, så tilmeld dig her:</p>
    <form id="switch-form"><label class="f"><span>Navn</span><input type="text" name="name" maxlength="60" required></label>
    <label class="f"><span>Telefonnummer</span><input type="tel" name="phone" maxlength="20" required inputmode="tel"></label><div class="err"></div>
    <div class="actions"><button class="btn primary" data-t="switch-join">Tilmeld ny person</button></div></form>
    <div class="actions"><button class="btn ghost" data-act="be" data-id="">Bare kig med (ikke tilmeldt)</button></div>`);
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

// ───────────────────────────── Handlinger ─────────────────────────────
function readPerson(form) {
  const name = form.name.value.trim(), phone = cleanPhone(form.phone.value);
  if (!name) return { err: 'Skriv dit navn.' };
  if (!isValidPhone(phone)) return { err: 'Skriv et gyldigt telefonnummer (8 cifre).' };
  return { name, phone };
}
async function register(form) {
  const p = readPerson(form);
  const errEl = $('.err', form) || $('#join-err');
  if (p.err) { errEl.textContent = p.err; return; }
  const btn = $('button:not([type=button])', form); btn.disabled = true;
  try {
    const id = await store.add(S.pid, 'participants', { name: p.name, phone: p.phone });
    LS.set(meKey(S.pid), id); LS.set('sg:profile', { name: p.name, phone: p.phone });
    closeSheet(); toast(`Velkommen, ${p.name}! 🎉`); render();
  } catch (e) { btn.disabled = false; fail(e); }
}

async function presetEvents(which) {
  const maxOrder = Math.max(0, ...S.events.map(e => e.order ?? 0));
  const titles = which === 'menu' ? ['Forret', 'Hovedret', 'Dessert'] : [which];
  try { for (const [i, t] of titles.entries()) await store.add(S.pid, 'events', { title: t, kind: 'ret', time: '', order: maxOrder + i + 1 }); toast(titles.join(', ') + ' tilføjet'); }
  catch (e) { fail(e); }
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
    case 'delete-party':
      if (!confirm(`Slet "${S.party.name}" med alle retter, gæster og udgifter? Det kan ikke fortrydes.`)) return;
      try {
        const lists = { events: S.events, participants: S.participants, items: S.items }, pid = S.pid;
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
      try { await store.remove(S.pid, 'events', id); closeSheet(); toast('Punktet er slettet'); } catch (err) { fail(err); }
      return;
    }
    case 'new-item': return itemSheet(null, el.dataset.event || '', el.dataset.kind || 'ret');
    case 'edit-item': return itemSheet(S.items.find(x => x.id === id));
    case 'delete-item':
      if (!confirm('Slet denne post?')) return;
      try { await store.remove(S.pid, 'items', id); closeSheet(); toast('Slettet'); } catch (err) { fail(err); }
      return;
    case 'edit-me': return meSheet(true);
    case 'not-me': return meSheet(false);
    case 'be': if (id) LS.set(meKey(S.pid), id); else LS.del(meKey(S.pid)); closeSheet(); render(); if (id) toast(`Hej ${pName(id)}!`); return;
    case 'remove-person': {
      const p = pById(id); if (!confirm(`Fjern ${p.name} fra gildet? Deres bidrag bliver stående.`)) return;
      try { await store.remove(S.pid, 'participants', id); toast(`${p.name} er fjernet`); } catch (err) { fail(err); }
      return;
    }
  }
}

function onSegClick(e) {
  const b = e.target.closest('.seg button'); if (!b) return false;
  const seg = b.parentElement, form = seg.closest('form');
  $$('button', seg).forEach(x => x.classList.toggle('on', x === b));
  form[seg.dataset.seg].value = b.dataset.v;
  if (seg.dataset.seg === 'split') $('#among', form).style.display = b.dataset.v === 'selected' ? '' : 'none';
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
  if (f.id === 'me-form') {
    const p = readPerson(f); if (p.err) return err(p.err);
    return busy(async () => { await store.update(S.pid, 'participants', myId(), p); LS.set('sg:profile', p); closeSheet(); toast('Gemt'); });
  }
  if (f.id === 'party-form') {
    const name = f.name.value.trim(); if (!name) return err('Giv gildet et navn.');
    return busy(async () => { await store.updateParty(S.pid, { name, date: f.date.value, time: f.time.value, place: f.place.value.trim(), note: f.note.value.trim() }); closeSheet(); toast('Gildet er opdateret'); });
  }
  if (f.id === 'event-form') {
    const title = f.title.value.trim(); if (!title) return err('Skriv en titel.');
    const data = { title, kind: f.kind.value, time: f.time.value };
    return busy(async () => {
      if (f.dataset.id) await store.update(S.pid, 'events', f.dataset.id, data);
      else await store.add(S.pid, 'events', { ...data, order: Math.max(0, ...S.events.map(x => x.order ?? 0)) + 1 });
      closeSheet(); toast(f.dataset.id ? 'Gemt' : `${title} er tilføjet`);
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
    const among = split === 'selected' ? $$('input[name=among]:checked', f).map(x => x.value) : [];
    if (cost && split === 'selected' && !among.length) return err('Vælg mindst én person.');
    const data = { title, kind, servings, note: f.note.value.trim(), cost, split: cost ? split : 'all', among: cost ? among : [] };
    return busy(async () => {
      if (f.dataset.id) await store.update(S.pid, 'items', f.dataset.id, data);
      else await store.add(S.pid, 'items', { ...data, eventId: f.dataset.event || '', participantId: myId() });
      closeSheet(); toast(f.dataset.id ? 'Gemt' : 'Tilføjet – tak! 🙌');
    });
  }
}

// ───────────────────────────── Start ─────────────────────────────
document.addEventListener('click', e => { if (onSegClick(e)) return; onClick(e); });
document.addEventListener('submit', onSubmit);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

(async () => {
  try { store = await createStore(); }
  catch (e) {
    console.error(e);
    $('#app').innerHTML = `<div class="wrap"><div class="card empty"><div class="big">🔌</div><h2>Kunne ikke forbinde</h2><p>${esc(errMsg(e))}</p><button class="btn" onclick="location.reload()">Prøv igen</button></div></div>`;
    return;
  }
  addEventListener('hashchange', route);
  route();
})();
