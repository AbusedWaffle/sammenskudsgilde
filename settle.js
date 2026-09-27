// Ren regnskabslogik (ingen DOM, ingen Firebase) – bruges af appen og af node-tests.
// Alle beløb håndteres som heltal i øre for at undgå afrundingsfejl.

/** Parse et dansk beløb ("1.234,50", "45", "45.5", "12,5 kr") til øre (heltal). Returnerer null ved ugyldigt/tomt. */
export function parseKr(input) {
  if (input == null) return null;
  let s = String(input).trim().replace(/kr\.?/i, '').replace(/\s/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');      // dansk: . = tusind, , = decimal
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');     // "1.234" = tusind-separator
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [kr, dec = ''] = s.split('.');
  const ore = Number(kr) * 100 + Number((dec + '00').slice(0, 2));
  return Number.isSafeInteger(ore) ? ore : null;
}

const fmt = typeof Intl !== 'undefined'
  ? new Intl.NumberFormat('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;

/** 12345 -> "123,45 kr." */
export function formatKr(ore) {
  const n = (ore || 0) / 100;
  return (fmt ? fmt.format(n) : n.toFixed(2).replace('.', ',')) + ' kr.';
}

/**
 * Fordel `amount` øre på `ids` så summen passer præcis. Resterende øre (efter lige deling)
 * gives én ad gangen til de første i den givne rækkefølge.
 */
export function splitAmount(amount, ids) {
  const out = {};
  const n = ids.length;
  if (!n) return out;
  const base = Math.floor(amount / n);
  let rest = amount - base * n;
  for (const id of ids) { out[id] = base + (rest > 0 ? 1 : 0); if (rest > 0) rest--; }
  return out;
}

/** Deltagerstatus: 'yes' (kommer – standard), 'maybe', 'no'. Gamle deltagere uden status kommer. */
export const statusOf = p => (p?.status === 'maybe' || p?.status === 'no') ? p.status : 'yes';

/**
 * Del deltagerne op i husstande ("enheder"). En deltager med householdId der peger på en kendt
 * husstand hører til den; alle andre er deres egen husstand (enheds-id = deltagerens id).
 * @returns [{id, name, household (doc|null), members: [participants]}] i deltagernes rækkefølge
 */
export function unitsOf(participants, households = []) {
  const hh = new Map(households.map(h => [h.id, h]));
  const units = new Map();
  for (const p of participants) {
    const h = p.householdId && hh.get(p.householdId);
    const id = h ? h.id : p.id;
    if (!units.has(id)) units.set(id, { id, name: h ? h.name : p.name, household: h || null, members: [] });
    units.get(id).members.push(p);
  }
  return [...units.values()];
}

/** Optælling til gæstelisten: { yes: {adults, children}, maybe: {...}, no: {...} } */
export function headcount(participants) {
  const out = { yes: { adults: 0, children: 0 }, maybe: { adults: 0, children: 0 }, no: { adults: 0, children: 0 } };
  for (const p of participants) out[statusOf(p)][p.isChild ? 'children' : 'adults']++;
  return out;
}

/**
 * Beregn regnskab – samlet pr. husstand.
 * @param participants [{id, name, householdId?, isChild?, status?}] – rækkefølgen bestemmer hvem der får ekstra øre
 * @param costs [{payer (deltager-id), amount (øre), split: 'all'|'selected'|'households'|'none', among: [ids]}]
 *   'all'        – deles pr. person mellem de voksne, der ikke har meldt "Kommer ikke". Børn betaler ikke med.
 *   'selected'   – deles pr. person mellem de valgte voksne (among = deltager-id'er; børn i listen ignoreres).
 *                  Er der KUN valgt børn (gamle poster), deles beløbet mellem de voksne i børnenes husstande;
 *                  har de ingen voksne, deles det som 'all'.
 *   'households' – lige stor andel pr. husstand, uanset antal børn; among = husstands-/enheds-id'er (tom = alle husstande med nogen der kommer)
 *   'none'       – deles ikke: betaleren betaler selv. Posten tæller slet ikke med (hverken betalt, andel eller total)
 *                  og ændrer ingens saldo; den returneres i `unshared` så den stadig kan vises.
 * Et barn, der har lagt ud, får stadig pengene tilbage (betaling tæller altid).
 * @param households [{id, name}] – husstands-dokumenter (valgfri; uden dem er alle deres egen husstand)
 * @returns {units, unitOf, paid, share, balance, total, entries, transfers, unshared, unsharedTotal} – nøgler er enheds-id'er.
 *   Uden husstande er enheds-id = deltager-id, så resultatet er det samme som et pr.-person-regnskab.
 *   balance > 0: skal have penge; balance < 0: skylder.
 */
export function settle(participants, costs, households = []) {
  const units = unitsOf(participants, households);
  const unitOf = {};
  for (const u of units) for (const m of u.members) unitOf[m.id] = u.id;
  const uids = units.map(u => u.id);
  const pids = participants.map(p => p.id);
  const known = new Set(pids);
  const byId = new Map(participants.map(p => [p.id, p]));
  const adult = id => !byId.get(id)?.isChild;
  const coming = participants.filter(p => statusOf(p) !== 'no').map(p => p.id);
  const comingAdults = coming.filter(adult);
  const adults = pids.filter(adult);
  // Hvem deler "alle – pr. person"? Voksne der kommer; ellers alle voksne; ellers (kun børn) dem der kommer; ellers alle.
  const allPeople = comingAdults.length ? comingAdults : adults.length ? adults : coming.length ? coming : pids.slice();
  const paid = {}, share = {};
  for (const id of uids) { paid[id] = 0; share[id] = 0; }
  let total = 0;
  const entries = [], unshared = [];
  let unsharedTotal = 0;
  for (const c of costs) {
    const amount = Math.round(c.amount || 0);
    if (!(amount > 0)) continue;
    if (c.split === 'none') { unshared.push({ ...c, amount }); unsharedTotal += amount; continue; }   // deles ikke
    if (!known.has(c.payer)) continue;
    let perUnit;
    let among;
    if (c.split === 'households') {
      const sel = Array.isArray(c.among) ? uids.filter(id => c.among.includes(id)) : [];
      among = sel.length ? sel : uids.filter(id => units.find(u => u.id === id).members.some(m => statusOf(m) !== 'no'));
      if (!among.length) among = uids.slice();
      perUnit = splitAmount(amount, among);
    } else {
      among = allPeople;
      if (c.split === 'selected' && Array.isArray(c.among)) {
        const sel = pids.filter(id => c.among.includes(id));
        among = sel.filter(adult);
        if (!among.length && sel.length) {         // kun børn valgt → de voksne i børnenes husstande
          const hs = new Set(sel.map(id => unitOf[id]));
          among = adults.filter(id => hs.has(unitOf[id]));
        }
        if (!among.length) among = allPeople;      // alle valgte er fjernet → som "alle"
      }
      const parts = splitAmount(amount, among);
      perUnit = {};
      for (const id in parts) perUnit[unitOf[id]] = (perUnit[unitOf[id]] || 0) + parts[id];
    }
    const payerUnit = unitOf[c.payer];
    paid[payerUnit] += amount;
    for (const id in perUnit) share[id] += perUnit[id];
    total += amount;
    entries.push({ ...c, amount, among, parts: perUnit, payerUnit });
  }
  const balance = {};
  for (const id of uids) balance[id] = paid[id] - share[id];
  return { units, unitOf, paid, share, balance, total, entries, transfers: minimalTransfers(balance, uids), unshared, unsharedTotal };
}

/**
 * Find et minimalt antal overførsler der udligner saldiene.
 * Minimum = (antal personer med saldo ≠ 0) − (maks. antal disjunkte grupper med sum 0).
 * For ≤ 16 personer med saldo findes det eksakte optimum via bitmaske-DP; ellers grådig metode.
 * @returns [{from, to, amount}]
 */
export function minimalTransfers(balance, order) {
  const ids = (order || Object.keys(balance)).filter(id => balance[id]);
  const n = ids.length;
  if (!n) return [];
  const groups = n <= 16 ? zeroSumGroups(ids.map(id => balance[id])) : [ids.map((_, i) => i)];
  const out = [];
  for (const g of groups) out.push(...greedy(g.map(i => ids[i]), balance));
  return out;
}

function zeroSumGroups(vals) {
  const n = vals.length, full = (1 << n) - 1;
  const sum = new Array(1 << n).fill(0);
  for (let m = 1; m <= full; m++) { const low = m & -m; sum[m] = sum[m ^ low] + vals[31 - Math.clz32(low)]; }
  // dp[m] = maks. antal nul-sum-grupper som m kan deles i (kun defineret når sum[m]==0)
  const dp = new Int8Array(1 << n).fill(-1), pick = new Int32Array(1 << n);
  dp[0] = 0;
  for (let m = 1; m <= full; m++) {
    if (sum[m] !== 0) continue;
    const low = m & -m; // gruppen der indeholder laveste bit – undgår dubletter
    const restAll = m ^ low;
    for (let s = restAll; ; s = (s - 1) & restAll) {
      const g = s | low;
      if (sum[g] === 0 && dp[m ^ g] >= 0 && dp[m ^ g] + 1 > dp[m]) { dp[m] = dp[m ^ g] + 1; pick[m] = g; }
      if (s === 0) break;
    }
  }
  const groups = [];
  for (let m = full; m; m ^= pick[m]) {
    const g = pick[m], idx = [];
    for (let i = 0; i < n; i++) if (g >> i & 1) idx.push(i);
    groups.push(idx);
  }
  return groups;
}

function greedy(ids, balance) {
  const cred = ids.filter(id => balance[id] > 0).map(id => ({ id, v: balance[id] }));
  const debt = ids.filter(id => balance[id] < 0).map(id => ({ id, v: -balance[id] }));
  const out = [];
  while (cred.length && debt.length) {
    cred.sort((a, b) => b.v - a.v); debt.sort((a, b) => b.v - a.v);
    const c = cred[0], d = debt[0], amt = Math.min(c.v, d.v);
    out.push({ from: d.id, to: c.id, amount: amt });
    c.v -= amt; d.v -= amt;
    if (!c.v) cred.shift();
    if (!d.v) debt.shift();
  }
  return out;
}
