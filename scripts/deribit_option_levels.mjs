/**
 * Ports the level calculations from the user's "BTC Options Intelligence
 * Institutional Pro v6.5.1" report.py (Deribit-based) to Node.
 * Run: node scripts/deribit_option_levels.mjs
 * Fetches live from Deribit's public API — no auth needed.
 */

const DEFAULT_IV = 60.0;
const STRIKE_STEP_FOR_PROFILE = 1000;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

function bsGamma(S, K, vol, T, r = 0.0) {
  if (S <= 0 || K <= 0 || vol <= 0 || T <= 0) return 0.0;
  const d1 = (Math.log(S / K) + (r + 0.5 * vol * vol) * T) / (vol * Math.sqrt(T));
  return normPdf(d1) / (S * vol * Math.sqrt(T));
}

// next Friday in Europe/Warsaw local time; if already Friday past 09:00 local, roll +7d
function resolveExpiryDate() {
  const nowPl = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Warsaw' }));
  const pyDow = (nowPl.getDay() + 6) % 7; // 0=Mon..6=Sun
  const daysToFriday = (4 - pyDow + 7) % 7;
  const expiryDate = new Date(nowPl);
  expiryDate.setDate(expiryDate.getDate() + daysToFriday);
  if (pyDow === 4 && nowPl.getHours() >= 9) expiryDate.setDate(expiryDate.getDate() + 7);
  return expiryDate.toISOString().slice(0, 10);
}

function topN(list, n) {
  const m = new Map();
  for (const r of list) m.set(r.strike, (m.get(r.strike) || 0) + r.open_interest);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function gammaFlip(profile) {
  for (let i = 1; i < profile.length; i++) {
    const [x1, y1] = profile[i - 1];
    const [x2, y2] = profile[i];
    if (y1 === 0) return x1;
    if (y2 === 0) return x2;
    if ((y1 < 0 && y2 > 0) || (y1 > 0 && y2 < 0)) {
      return y2 !== y1 ? Math.round(x1 + (0 - y1) * (x2 - x1) / (y2 - y1)) : x2;
    }
  }
  return null;
}

export async function computeLevels() {
  const [instrumentsResp, bookResp, indexResp] = await Promise.all([
    fetchJson('https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false'),
    fetchJson('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option'),
    fetchJson('https://www.deribit.com/api/v2/public/get_index_price?index_name=btc_usd'),
  ]);

  const instrumentsData = instrumentsResp.result;
  const bookSummary = bookResp.result;
  const spot = indexResp.result.index_price;

  const EXPIRY = resolveExpiryDate();
  const expiryTs = Date.parse(EXPIRY + 'T08:00:00Z');
  const targetInstruments = instrumentsData.filter(i => i.expiration_timestamp === expiryTs);

  const oiByInstrument = new Map(bookSummary.map(b => [b.instrument_name, b]));

  const now = Date.now();
  const t = Math.max((expiryTs - now) / (365.0 * 24 * 3600 * 1000), 1 / (365.0 * 24));

  const rows = targetInstruments.map(inst => {
    const book = oiByInstrument.get(inst.instrument_name) || {};
    const type = inst.option_type === 'call' ? 'C' : 'P';
    const markIv = (book.mark_iv != null && !Number.isNaN(book.mark_iv)) ? book.mark_iv : DEFAULT_IV;
    const ivDecimal = markIv / 100.0;
    const oi = book.open_interest || 0.0;
    const gamma = bsGamma(spot, inst.strike, ivDecimal, t, 0.0);
    const sign = type === 'C' ? 1.0 : -1.0;
    return { instrument_name: inst.instrument_name, strike: inst.strike, type, open_interest: oi, mark_iv: markIv, iv_decimal: ivDecimal, gamma, gex_proxy: sign * gamma * oi * (spot ** 2) };
  });

  const gexProxyTotal = rows.reduce((s, r) => s + r.gex_proxy, 0);

  const gexByStrike = new Map();
  for (const r of rows) gexByStrike.set(r.strike, (gexByStrike.get(r.strike) || 0) + r.gex_proxy);
  let gammaWall = null, maxAbs = -Infinity;
  for (const [strike, val] of gexByStrike) if (Math.abs(val) > maxAbs) { maxAbs = Math.abs(val); gammaWall = strike; }

  const strikes = rows.map(r => r.strike);
  const strikeMin = Math.min(...strikes), strikeMax = Math.max(...strikes);
  let low = Math.floor(Math.min(strikeMin, spot * 0.85) / STRIKE_STEP_FOR_PROFILE) * STRIKE_STEP_FOR_PROFILE;
  let high = Math.ceil(Math.max(strikeMax, spot * 1.15) / STRIKE_STEP_FOR_PROFILE) * STRIKE_STEP_FOR_PROFILE;

  const profile = [];
  for (let level = low; level <= high; level += STRIKE_STEP_FOR_PROFILE) {
    let total = 0;
    for (const r of rows) {
      const g = bsGamma(level, r.strike, r.iv_decimal, t, 0.0);
      total += (r.type === 'C' ? 1 : -1) * g * r.open_interest * (level ** 2);
    }
    profile.push([level, total]);
  }
  const gFlip = gammaFlip(profile);

  const uniqStrikes = [...new Set(strikes)].sort((a, b) => a - b);
  const calls = rows.filter(r => r.type === 'C');
  const puts = rows.filter(r => r.type === 'P');
  function payoutAt(S) {
    let callLoss = 0, putLoss = 0;
    for (const c of calls) callLoss += Math.max(0, S - c.strike) * c.open_interest;
    for (const p of puts) putLoss += Math.max(0, p.strike - S) * p.open_interest;
    return callLoss + putLoss;
  }
  let maxPain = null, minLoss = Infinity;
  for (const S of uniqStrikes) { const loss = payoutAt(S); if (loss < minLoss) { minLoss = loss; maxPain = S; } }

  const callWalls = topN(calls, 5);
  const putWalls = topN(puts, 5);
  const liq = topN(rows, 10);
  const operational = new Set([...callWalls.map(x => x[0]), ...putWalls.map(x => x[0]), ...liq.map(x => x[0])]);
  const below = [...operational].filter(x => x < spot);
  const above = [...operational].filter(x => x > spot);

  // --- IV skew (ported from report.py iv_metrics / weighted_skew_near_atm) ---
  const byAtmDistance = [...rows].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const atmIv = byAtmDistance[0]?.mark_iv ?? null;

  const otmCalls = calls.filter(r => r.strike > spot);
  const otmPuts = puts.filter(r => r.strike < spot);
  const mean = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
  const callWingIv = mean(otmCalls.map(r => r.mark_iv));
  const putWingIv = mean(otmPuts.map(r => r.mark_iv));
  const skew = (callWingIv != null && putWingIv != null) ? putWingIv - callWingIv : null;

  function weightedAvg(arr, valueFn, weightFn) {
    let num = 0, den = 0;
    for (const r of arr) { const w = weightFn(r); num += valueFn(r) * w; den += w; }
    return den > 0 ? num / den : null;
  }
  const distPct = r => Math.abs((r.strike - spot) / spot) * 100;
  const weightFn = r => 1 / (distPct(r) + 0.25);
  const callIvW = otmCalls.length ? weightedAvg(otmCalls, r => r.mark_iv, weightFn) : null;
  const putIvW = otmPuts.length ? weightedAvg(otmPuts, r => r.mark_iv, weightFn) : null;
  const weightedSkew = (callIvW != null && putIvW != null) ? putIvW - callIvW : null;

  return {
    spot,
    expiry: EXPIRY,
    gex_proxy_total: gexProxyTotal,
    gamma_wall: gammaWall,
    gamma_flip: gFlip,
    max_pain: maxPain,
    strongest_call_wall: callWalls[0]?.[0] ?? null,
    strongest_put_wall: putWalls[0]?.[0] ?? null,
    call_walls_top5: callWalls,
    put_walls_top5: putWalls,
    liquidity_top10: liq,
    nearest_support_operational: below.length ? Math.max(...below) : null,
    nearest_resistance_operational: above.length ? Math.min(...above) : null,
    atm_iv: atmIv,
    call_wing_iv: callWingIv,
    put_wing_iv: putWingIv,
    iv_skew: skew,
    iv_skew_weighted_near_atm: weightedSkew,
  };
}

import { fileURLToPath } from 'url';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  computeLevels().then(r => console.log(JSON.stringify(r, null, 2)));
}
