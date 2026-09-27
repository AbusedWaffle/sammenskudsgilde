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

/**
 * Beregn regnskab.
 * @param participants [{id, name}] – rækkefølgen bestemmer hvem der får ekstra øre ved skæv deling
 * @param costs [{payer, amount (øre), split: 'all'|'selected', among: [ids]}]
 * @returns {paid, share, balance, total, entries, transfers}
 *   balance > 0: skal have penge; balance < 0: skylder.
 */
export function settle(participants, costs) {
  const ids = participants.map(p => p.id);
  const known = new Set(ids);
  const paid = {}, share = {};
  for (const id of ids) { paid[id] = 0; share[id] = 0; }
  let total = 0;
  const entries = [];
  for (const c of costs) {
    const amount = Math.round(c.amount || 0);
    if (!(amount > 0) || !known.has(c.payer)) continue;
    let among = c.split === 'selected' && Array.isArray(c.among)
      ? ids.filter(id => c.among.includes(id)) : ids.slice();
    if (!among.length) among = ids.slice();   // alle valgte er meldt fra → fordel på alle
    const parts = splitAmount(amount, among);
    paid[c.payer] += amount;
    for (const id in parts) share[id] += parts[id];
    total += amount;
    entries.push({ ...c, amount, among, parts });
  }
  const balance = {};
  for (const id of ids) balance[id] = paid[id] - share[id];
  return { paid, share, balance, total, entries, transfers: minimalTransfers(balance, ids) };
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
