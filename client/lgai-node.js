#!/usr/bin/env node
/**
 * LGAI Node — cross-platform node client (Phase 02)
 * Raspberry Pi / Mac / PC / server / cloud. Requires Node >= 18, zero dependencies.
 *
 *   node client/lgai-node.js --coordinator http://<host>:18402 [--name myPi] [--mock] [--once]
 *
 * Roles (matching the four node roles on the website):
 *   Data Compute   market_data    fetch public market data, join multi-node consensus
 *   AI Inference   ai_infer       run local models on consensus OHLCV, produce a score
 *   Verification   signal_verify  independently verify matured network predictions
 *   Contribution   every valid contribution is recorded in the coordinator ledger
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = '0.10.0';

// ---------------- args ----------------
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
if (flag('--help') || flag('-h')) {
  console.log(`LGAI Node v${VERSION}
Usage: node lgai-node.js [options]
  --coordinator, -c <url>  coordinator URL (default $LGAI_COORDINATOR or http://127.0.0.1:18402)
  --name <name>            node name (default: hostname)
  --mock                   use mock market data source (offline/testing)
  --once                   run one task cycle then exit (self-check)
  --market                 list AI data marketplace items, then exit
  --buy <listingId>        buy a dataset/signal feed with points, then exit
  --intel <symbol>         fetch agent intel (oracle + signal + predictions), then exit
  --vote <SYM=LONG|SHORT>  submit human market sentiment (PoI feedback), then exit
  --help                   show this help`);
  process.exit(0);
}
const COORD = (opt('--coordinator', opt('-c', process.env.LGAI_COORDINATOR || 'http://127.0.0.1:18402'))).replace(/\/+$/, '');
const NAME = opt('--name', os.hostname().split('.')[0]);
const MOCK = flag('--mock');
const ONCE = flag('--once');

// ---------------- ui ----------------
const tty = process.stdout.isTTY;
const c = (code, s) => tty ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = s => c(90, s), green = s => c(32, s), amber = s => c(33, s), red = s => c(31, s), violet = s => c(35, s), bold = s => c(1, s);
const ts = () => dim(new Date().toISOString().slice(11, 19));
const log = (...a) => console.log(ts(), ...a);

// ---------------- state ----------------
const stateDir = path.join(os.homedir(), '.lgai');
const stateFile = path.join(stateDir, 'node-' + crypto.createHash('sha1').update(COORD).digest('hex').slice(0, 10) + '.json');
let cred = null;
try { cred = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { }

// ---------------- api ----------------
async function api(pathname, { method = 'GET', body, authd = true, timeout = 10_000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(COORD + pathname, {
      method,
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        ...(authd && cred ? { 'x-node-id': cred.nodeId, 'x-node-token': cred.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${data.error || ''}`.trim());
    return data;
  } finally { clearTimeout(t); }
}

// ---------------- market data sources ----------------
const toOkx = sym => sym.replace(/USDT$/, '-USDT');
async function fetchJson(url, timeout = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}
// Deterministic OHLCV random walk (mock): identical network-wide within a 15s window, so it passes consensus
function mockCandles(symbol, n) {
  const bucket = Math.floor(Date.now() / 15_000);
  const hash = s => parseInt(crypto.createHash('sha1').update(s).digest('hex').slice(0, 8), 16);
  const base = 1000 + (hash(symbol) % 90_000);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const h = hash(symbol + (bucket - i)), h2 = hash(symbol + 'x' + (bucket - i));
    const c = +(base * (1 + ((h % 2001) - 1000) / 40_000)).toFixed(2);
    const spread = c * (0.0005 + (h2 % 100) / 100_000);
    out.push({
      c, h: +(c + spread * ((h2 >> 8) % 100) / 100).toFixed(2),
      l: +(c - spread * ((h2 >> 16) % 100) / 100).toFixed(2),
      v: +(10 + (h2 % 990)).toFixed(1),
    });
  }
  return out;
}
async function getCandles(symbol, limit = 40, interval = '5m') {
  if (MOCK) return { candles: mockCandles(symbol, limit), source: 'mock' };
  try {
    const k = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return { candles: k.map(r => ({ c: +r[4], h: +r[2], l: +r[3], v: +r[5] })), source: 'binance' };
  } catch { }
  try {
    const okxBar = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' }[interval] || interval;
    const k = await fetchJson(`https://www.okx.com/api/v5/market/candles?instId=${toOkx(symbol)}&bar=${okxBar}&limit=${limit}`);
    return { candles: k.data.map(r => ({ c: +r[4], h: +r[2], l: +r[3], v: +r[5] })).reverse(), source: 'okx' };
  } catch { }
  throw new Error('all market data sources unavailable (use --mock for testing)');
}
async function getPrice(symbol) {
  const { candles, source } = await getCandles(symbol, 2, '1m');
  return { price: candles[candles.length - 1].c, source };
}

// ---------------- market context sources (v0.8.0) ----------------
// Deterministic mock (15s bucket): identical network-wide so mock nodes pass consensus
function mockCtx(key, base, spread) {
  const bucket = Math.floor(Date.now() / 15_000);
  const h = parseInt(crypto.createHash('sha1').update(key + bucket).digest('hex').slice(0, 8), 16);
  return base + (h % 10_000) / 10_000 * spread;
}
// Chain TVL: DeFiLlama public API (no key) — total across all chains + top 5
async function getChainTvl() {
  if (MOCK) return { totalB: +mockCtx('tvl', 95, 10).toFixed(2), top: [{ name: 'Ethereum', tvlB: 52.1 }, { name: 'Solana', tvlB: 9.3 }, { name: 'BSC', tvlB: 7.2 }], source: 'mock' };
  const chains = await fetchJson('https://api.llama.fi/v2/chains', 12_000);
  const totalB = chains.reduce((a, c) => a + (+c.tvl || 0), 0) / 1e9;
  const top = [...chains].sort((a, b) => (+b.tvl || 0) - (+a.tvl || 0)).slice(0, 5)
    .map(c => ({ name: c.name, tvlB: +((+c.tvl || 0) / 1e9).toFixed(1) }));
  return { totalB: +totalB.toFixed(2), top, source: 'defillama' };
}
// Funding rate (per 8h): Binance futures premiumIndex -> OKX fallback
async function getFundingRate(symbol) {
  if (MOCK) return { rate: +mockCtx('fund' + symbol, -0.0002, 0.0006).toFixed(6), source: 'mock' };
  try {
    const r = await fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
    if (Number.isFinite(+r.lastFundingRate)) return { rate: +(+r.lastFundingRate).toFixed(6), source: 'binance' };
  } catch { }
  const r = await fetchJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${symbol.replace(/USDT$/, '-USDT-SWAP')}`);
  return { rate: +(+r.data[0].fundingRate).toFixed(6), source: 'okx' };
}
// Liquidations: OKX public liquidation orders (no key). Notional = sz × bankruptcy px —
// contract-multiplier approximation, but every node computes identically so consensus holds.
async function getLiquidations(symbol, windowMin = 60) {
  if (MOCK) {
    return {
      longUsd: Math.round(mockCtx('liqL' + symbol, 2e6, 6e6)),
      shortUsd: Math.round(mockCtx('liqS' + symbol, 2e6, 6e6)),
      count: Math.round(mockCtx('liqN' + symbol, 20, 80)), source: 'mock',
    };
  }
  const fam = symbol.replace(/USDT$/, '-USDT');
  const r = await fetchJson(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&state=filled&instFamily=${fam}`, 12_000);
  const cutoff = Date.now() - windowMin * 60_000;
  let longUsd = 0, shortUsd = 0, count = 0;
  for (const it of r.data || []) {
    for (const d of it.details || []) {
      if (+d.ts < cutoff) continue;
      const usd = (+d.sz || 0) * (+d.bkPx || 0);
      if (d.posSide === 'long') longUsd += usd;        // longs flushed (forced sells)
      else if (d.posSide === 'short') shortUsd += usd; // shorts squeezed (forced buys)
      count++;
    }
  }
  return { longUsd: Math.round(longUsd), shortUsd: Math.round(shortUsd), count, source: 'okx' };
}

// ---------------- local inference ----------------
// Three base models (price-volume proxy implementation):
//   🚜 Bulldozer Trend      >=70% one-directional closes in the window set the direction,
//                           plus a structural anchor (trend invalidated if the anchor breaks)
//   📉 Whale Distribution   stalling highs + heavy volume on down candles + closes near lows + lower highs
//   🧲 Whale Accumulation   low-zone consolidation + rising volume + closes near highs + higher lows
// Extended features: momentum / RSI / volatility -> composite trend score in [-1, 1]
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function rsi(closes, n = 14) {
  n = Math.min(n, closes.length - 1);
  if (n < 2) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? g += d : l -= d;
  }
  return g + l === 0 ? 50 : (l === 0 ? 100 : 100 - 100 / (1 + g / l));
}
function inferScore(candles) {
  // Accepts plain closes arrays too (without volume, accumulation/distribution models degrade to 0)
  const ks = candles.map(k => typeof k === 'number' ? { c: k, h: k, l: k, v: 0 } : { c: +k.c ?? +k.close, h: +k.h || +k.c, l: +k.l || +k.c, v: +k.v || 0 });
  const closes = ks.map(k => k.c);
  const last = closes[closes.length - 1];
  const hasVol = ks.some(k => k.v > 0);

  // --- 🚜 Bulldozer Trend ---
  const W = Math.min(14, closes.length - 1);
  let ups = 0;
  for (let i = closes.length - W; i < closes.length; i++) if (closes[i] >= closes[i - 1]) ups++;  // 持平算涨(推土机口径)
  const upRatio = W ? ups / W : 0.5;
  let bulldozer;
  if (upRatio >= 0.7) bulldozer = 0.5 + (upRatio - 0.7) / 0.3 * 0.5;        // grinding up -> long
  else if (upRatio <= 0.3) bulldozer = -(0.5 + (0.3 - upRatio) / 0.3 * 0.5); // steady distribution -> short
  else bulldozer = (upRatio - 0.5) * 0.8;                                    // no one-way move -> weak signal
  // Structural anchor: trend is de-weighted if the window anchor breaks
  const anchorWin = closes.slice(-W - 1, -1);
  if (bulldozer > 0 && last < Math.min(...anchorWin)) bulldozer *= 0.35;
  if (bulldozer < 0 && last > Math.max(...anchorWin)) bulldozer *= 0.35;

  // --- Shared price-volume features ---
  const half = Math.floor(ks.length / 2);
  const baseK = ks.slice(0, half), recentK = ks.slice(half);
  const volRatio = hasVol ? avg(recentK.map(k => k.v)) / (avg(baseK.map(k => k.v)) || 1) : 1;
  const closeLoc = avg(recentK.map(k => k.h > k.l ? (k.c - k.l) / (k.h - k.l) : 0.5)); // close position within the candle range
  let downVol = 0, totVol = 0;
  for (let i = Math.max(1, ks.length - W); i < ks.length; i++) {
    totVol += ks[i].v;
    if (ks[i].c < ks[i - 1].c) downVol += ks[i].v;
  }
  const downVolShare = totVol ? downVol / totVol : 0.5;
  const lo = Math.min(...closes), hi = Math.max(...closes);
  const pricePos = hi > lo ? (last - lo) / (hi - lo) : 0.5;
  const lows5 = ks.slice(-5).map(k => k.l), lowsPrev = ks.slice(-12, -5).map(k => k.l);
  const highs5 = ks.slice(-5).map(k => k.h), highsPrev = ks.slice(-12, -5).map(k => k.h);
  const higherLows = lowsPrev.length && Math.min(...lows5) > Math.min(...lowsPrev);
  const lowerHighs = highsPrev.length && Math.max(...highs5) < Math.max(...highsPrev);

  // --- 🧲 Whale Accumulation (0..1) ---
  const accum = !hasVol ? 0 : clamp(
    clamp((0.35 - pricePos) / 0.35, 0, 1) * 0.30 +   // low price zone
    clamp(volRatio - 1, 0, 1) * 0.30 +               // rising volume
    clamp((closeLoc - 0.5) * 2, 0, 1) * 0.25 +       // closes near highs (absorption)
    (higherLows ? 0.15 : 0), 0, 1);                  // higher lows

  // --- 📉 Whale Distribution (0..1) ---
  const distrib = !hasVol ? 0 : clamp(
    clamp((pricePos - 0.65) / 0.35, 0, 1) * 0.25 +   // high price zone
    clamp((downVolShare - 0.5) * 2, 0, 1) * 0.30 +   // heavy volume on down candles
    clamp((0.5 - closeLoc) * 2, 0, 1) * 0.25 +       // closes near lows (selling pressure)
    (lowerHighs ? 0.20 : 0), 0, 1);                  // lower highs

  // --- Extended features: momentum / RSI / volatility ---
  const w10 = closes.slice(-10);
  const mom = last / (avg(w10) || last) - 1;
  const rets = closes.slice(1).map((v, i) => v / closes[i] - 1);
  const mean = avg(rets);
  const vol = Math.sqrt(avg(rets.map(r => (r - mean) ** 2)));
  const r = rsi(closes);

  // --- Composite score ---
  let score = bulldozer * 0.45 + (accum - distrib) * 0.25
    + Math.tanh(mom * 120) * 0.20 + ((r - 50) / 50) * 0.10;
  if (vol > 0.01) score *= 0.7; // dampen in high volatility
  score = +clamp(score, -1, 1).toFixed(4);

  const regime =
    bulldozer >= 0.5 ? 'Bulldozer Long' :
    bulldozer <= -0.5 ? 'Bulldozer Short' :
    accum >= 0.5 && accum > distrib ? 'Whale Accumulation' :
    distrib >= 0.5 ? 'Whale Distribution' : 'Range';

  return {
    score, regime,
    features: {
      bulldozer: +bulldozer.toFixed(3), upRatio: +upRatio.toFixed(2),
      accum: +accum.toFixed(3), distrib: +distrib.toFixed(3),
      mom: +mom.toFixed(5), rsi: +r.toFixed(1), vol: +vol.toFixed(5),
      volRatio: +volRatio.toFixed(2), pricePos: +pricePos.toFixed(2),
    },
  };
}

// ETF daily net flow ($M): Farside public tables (no key). Latest dated row,
// last numeric column = day's total net flow; "(x)" means negative.
async function getEtfFlow(asset) {
  if (MOCK) return { netM: +mockCtx('etf' + asset, -150, 400).toFixed(1), day: new Date().toISOString().slice(0, 10), source: 'mock' };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  let html;
  try {
    const res = await fetch(`https://farside.co.uk/${asset.toLowerCase()}/`, {
      signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (LGAI-Node)' },
    });
    if (!res.ok) throw new Error('http ' + res.status);
    html = await res.text();
  } finally { clearTimeout(t); }
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  let latest = null;
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map(m => m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (!cells.length || !/^\d{1,2} \w{3} \d{4}$/.test(cells[0])) continue;  // dated data rows only
    const nums = cells.slice(1).map(c => {
      const neg = /^\(.*\)$/.test(c);
      const v = parseFloat(c.replace(/[(),$]/g, ''));
      return Number.isFinite(v) ? (neg ? -v : v) : null;
    }).filter(v => v != null);
    if (nums.length) latest = { day: cells[0], netM: nums[nums.length - 1] };  // last column = total
  }
  if (!latest) throw new Error('ETF flow table not found (source layout changed?)');
  return { day: latest.day, netM: +latest.netM.toFixed(1), source: 'farside' };
}

// ---------------- Chan theory (缠论) lite ----------------
// Simplified pipeline: inclusion merge (包含处理) -> fractals (分型) -> strokes (笔)
// -> pivot (中枢 = overlap of the last 3 strokes) -> signals:
//   chan_3buy / chan_3sell        escaped the pivot and the pullback held outside it (三买/三卖)
//   chan_1buy_div / chan_1sell_div new extreme with momentum divergence, MACD-lite (一买/一卖背驰)
function chanSignal(ks) {
  if (!ks || ks.length < 20) return null;
  // inclusion merge
  const m = [];
  for (const k of ks) {
    const last = m[m.length - 1];
    if (last && ((k.h <= last.h && k.l >= last.l) || (k.h >= last.h && k.l <= last.l))) {
      const up = m.length < 2 || last.h >= m[m.length - 2].h;
      last.h = up ? Math.max(last.h, k.h) : Math.min(last.h, k.h);
      last.l = up ? Math.max(last.l, k.l) : Math.min(last.l, k.l);
      last.c = k.c;
    } else m.push({ h: k.h, l: k.l, c: k.c });
  }
  if (m.length < 7) return null;
  // fractals
  const fr = [];
  for (let i = 1; i < m.length - 1; i++) {
    if (m[i].h > m[i - 1].h && m[i].h > m[i + 1].h) fr.push({ i, t: 'top', px: m[i].h });
    else if (m[i].l < m[i - 1].l && m[i].l < m[i + 1].l) fr.push({ i, t: 'bot', px: m[i].l });
  }
  // strokes: alternating fractals with >= 4 merged candles between them
  const st = [];
  for (const f of fr) {
    const last = st[st.length - 1];
    if (!last) { st.push(f); continue; }
    if (f.t === last.t) {   // same type: keep the more extreme fractal
      if ((f.t === 'top' && f.px > last.px) || (f.t === 'bot' && f.px < last.px)) st[st.length - 1] = f;
    } else if (f.i - last.i >= 4) st.push(f);
  }
  if (st.length < 4) return null;
  // pivot: overlap of the last 3 completed strokes
  const seg = st.slice(-4);
  const his = [], los = [];
  for (let i = 0; i < 3; i++) {
    his.push(Math.max(seg[i].px, seg[i + 1].px));
    los.push(Math.min(seg[i].px, seg[i + 1].px));
  }
  const zg = Math.min(...his), zd = Math.max(...los);
  const pivot = zg > zd ? { hi: +zg.toPrecision(8), lo: +zd.toPrecision(8) } : null;
  const last = m[m.length - 1].c;
  const lastF = st[st.length - 1];
  // 三买/三卖
  if (pivot) {
    if (last > pivot.hi && lastF.t === 'bot' && lastF.px > pivot.hi) return { dir: 'LONG', signal: 'chan_3buy', pivot };
    if (last < pivot.lo && lastF.t === 'top' && lastF.px < pivot.lo) return { dir: 'SHORT', signal: 'chan_3sell', pivot };
  }
  // 一买/一卖背驰: new extreme + momentum divergence (MACD-lite histogram)
  const closes = ks.map(k => k.c);
  const ema = n => { let e = closes[0]; const out = [e]; const kf = 2 / (n + 1); for (let i = 1; i < closes.length; i++) { e = closes[i] * kf + e * (1 - kf); out.push(e); } return out; };
  const e12 = ema(12), e26 = ema(26);
  const hist = closes.map((_, i) => e12[i] - e26[i]);
  const lows = ks.map(k => k.l), highs = ks.map(k => k.h), n = ks.length;
  const prevLow = Math.min(...lows.slice(0, n - 5)), prevHigh = Math.max(...highs.slice(0, n - 5));
  const h5 = hist.slice(-5), hPrev = hist.slice(0, -5);
  if (Math.min(...lows.slice(-5)) < prevLow && Math.min(...h5) > Math.min(...hPrev)) return { dir: 'LONG', signal: 'chan_1buy_div', pivot };
  if (Math.max(...highs.slice(-5)) > prevHigh && Math.max(...h5) < Math.max(...hPrev)) return { dir: 'SHORT', signal: 'chan_1sell_div', pivot };
  return pivot ? { dir: null, signal: 'chan_pivot', pivot } : null;
}

// ---------------- push-data inference (primary model) ----------------
// The AI regime call runs on the LGAI push series (network-wide holding-cost pushes),
// NOT on candle indicators / RSI. Four states are judged straight from the push series,
// aligned with the main signal system (推土机 / 吸筹 / 震荡 / 出货):
//   🚜 Bulldozer          push prices grinding one way up (>=70% rising pushes) -> hold long
//   🧲 Whale Accumulation  holding cost parked in the low zone but carving higher-lows /
//                          being lifted -> whales building at the bottom (吸筹)
//   📉 Distribution        push prices grinding down (>=70% falling), OR holding cost
//                          stalling in the high zone with lower-highs / eroding (出货)
//   〰️ Range              no directional push flow -> stand aside (震荡)
// Extras: structural anchor (a pullback breaking the window-low push kills the trend)
//         and push momentum (last push vs. earlier average) as confidence modifiers.
function inferPush(pushes) {
  const prices = pushes.map(p => +p.price).filter(Number.isFinite);
  const n = prices.length;
  const last = prices[n - 1];
  const W = Math.min(14, n - 1);
  let ups = 0;
  for (let i = n - W; i < n; i++) if (prices[i] >= prices[i - 1]) ups++;  // 持平算涨(推土机口径)
  const upRatio = W ? ups / W : 0.5;

  // Holding-cost structure, read straight from the push series (no candle indicators / RSI):
  //   pricePos  = where the latest push sits within its recent range (0 = low, 1 = high)
  //   higherLows / lowerHighs = whether recent pushes carve higher-lows (accumulation)
  //                             or lower-highs (distribution) vs. the earlier window
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const pricePos = hi > lo ? (last - lo) / (hi - lo) : 0.5;
  const recent = prices.slice(-5), prior = prices.slice(-Math.min(12, n), -5);
  const higherLows = prior.length ? Math.min(...recent) > Math.min(...prior) : false;
  const lowerHighs = prior.length ? Math.max(...recent) < Math.max(...prior) : false;
  const early = prices.slice(0, Math.max(2, Math.ceil(n / 2)));
  const pushMom = last / (avg(early) || last) - 1;

  let score, regime;
  if (upRatio >= 0.7) {                    // 🚜 pushes grinding up -> bulldozer long
    regime = 'Bulldozer'; score = 0.5 + (upRatio - 0.7) / 0.3 * 0.5;
  } else if (upRatio <= 0.3) {             // 📉 pushes grinding down -> distribution / short
    regime = 'Distribution'; score = -(0.5 + (0.3 - upRatio) / 0.3 * 0.5);
  } else if (pricePos <= 0.4 && (higherLows || pushMom > 0.002)) {
    // 🧲 holding cost parked in the low zone and being lifted -> whale accumulation (吸筹)
    regime = 'Whale Accumulation';
    score = clamp(0.15 + (0.4 - pricePos) * 0.5 + (higherLows ? 0.10 : 0), 0, 0.45);
  } else if (pricePos >= 0.6 && (lowerHighs || pushMom < -0.002)) {
    // 📉 holding cost stalling in the high zone and eroding -> distribution / topping (出货)
    regime = 'Distribution';
    score = -clamp(0.15 + (pricePos - 0.6) * 0.5 + (lowerHighs ? 0.10 : 0), 0, 0.45);
  } else {                                 // 〰️ no directional push flow -> range (震荡)
    regime = 'Range'; score = (upRatio - 0.5) * 0.8;
  }

  // Structural anchor on push prices: trend invalidated if the window anchor breaks
  const anchorWin = prices.slice(-W - 1, -1);
  let anchorIntact = true;
  if (score > 0 && last < Math.min(...anchorWin)) { anchorIntact = false; score *= 0.35; }
  if (score < 0 && last > Math.max(...anchorWin)) { anchorIntact = false; score *= 0.35; }

  // Push momentum: last push vs. average of the earlier half (confidence modifier)
  score = clamp(score + Math.tanh(pushMom * 5) * 0.15, -1, 1);

  return {
    score: +score.toFixed(4), regime,
    features: {
      upRatio: +upRatio.toFixed(2), anchorIntact,
      pricePos: +pricePos.toFixed(2), higherLows, lowerHighs,
      pushMom: +pushMom.toFixed(4), pushes: n,
      src: 'lgai_push',
    },
  };
}

// ---------------- task execution ----------------
async function execTask(t) {
  if (t.type === 'market_data') {
    const { candles, source } = await getCandles(t.symbol, t.payload.limit || 40, t.payload.interval || '5m');
    const k = candles[candles.length - 1];
    return { close: k.c, high: k.h, low: k.l, vol: k.v, n: candles.length, source };
  }
  if (t.type === 'ai_infer') {
    // Primary: judge regime on the LGAI push series; fallback: OHLCV model when no push data
    if (t.payload.pushes) return inferPush(t.payload.pushes);
    return inferScore(t.payload.candles || t.payload.closes || []);
  }
  if (t.type === 'signal_verify') {
    const { price1 } = await (async () => {
      const { price } = await getPrice(t.symbol);
      return { price1: price };
    })();
    const up = price1 > t.payload.price0;
    const verdict = (t.payload.dir === 'LONG') === up ? 'WIN' : 'LOSS';
    return { price1, verdict };
  }
  // Market context tasks (v0.8.0): TVL / funding / liquidations feed prediction confidence
  if (t.type === 'chain_tvl') return await getChainTvl();
  if (t.type === 'funding_rate') return await getFundingRate(t.symbol);
  if (t.type === 'liquidation') return await getLiquidations(t.symbol, t.payload.windowMin || 60);
  if (t.type === 'etf_flow') return await getEtfFlow(t.payload.asset || t.symbol);
  // Multi-timeframe forecast (v0.9.0): Chan signals first, AI composite score as fallback
  if (t.type === 'tf_forecast') {
    const iv = t.payload.interval || '1h';
    const { candles, source } = await getCandles(t.symbol, 80, iv);
    const chan = chanSignal(candles);
    const ai = inferScore(candles);
    const dir = chan && chan.dir ? chan.dir
      : (Math.abs(ai.score) >= 0.15 ? (ai.score > 0 ? 'LONG' : 'SHORT') : null);
    return {
      dir, interval: iv, score: ai.score,
      signal: (chan && chan.dir) ? chan.signal : (dir ? 'ai_score' : 'no_signal'),
      pivot: chan ? chan.pivot : null,
      price: candles[candles.length - 1].c, source,
    };
  }
  throw new Error('unknown task type ' + t.type);
}

const TYPE_LABEL = {
  market_data: 'Market Data', ai_infer: 'AI Inference', signal_verify: 'Signal Verify',
  chain_tvl: 'Chain TVL', funding_rate: 'Funding Rate', liquidation: 'Liquidations',
  tf_forecast: 'TF Forecast', etf_flow: 'ETF Flow',
};
let done = 0, points = 0;

async function pollOnce() {
  const { tasks } = await api('/api/tasks');
  for (const t of tasks) {
    const label = `${violet(TYPE_LABEL[t.type] || t.type)} ${bold(t.symbol)}`;
    try {
      const data = await execTask(t);
      await api('/api/result', { method: 'POST', body: { taskId: t.id, data } });
      done++;
      const detail = t.type === 'market_data' ? `close=${data.close} vol=${data.vol} (${data.source})`
        : t.type === 'ai_infer' ? (data.features && data.features.src === 'lgai_push'
          ? `score=${data.score} [${data.regime}] push up=${Math.round(data.features.upRatio * 100)}% anchor=${data.features.anchorIntact ? 'ok' : 'broken'}`
          : `score=${data.score} [${data.regime}] (ohlcv fallback)`)
        : t.type === 'chain_tvl' ? `TVL $${data.totalB}B (${data.source})`
        : t.type === 'funding_rate' ? `rate=${(data.rate * 100).toFixed(4)}%/8h (${data.source})`
        : t.type === 'liquidation' ? `long $${Math.round(data.longUsd / 1e3)}k / short $${Math.round(data.shortUsd / 1e3)}k, ${data.count} orders (${data.source})`
        : t.type === 'tf_forecast' ? `${data.interval} ${data.dir || 'NEUTRAL'} [${data.signal}]${data.pivot ? ` pivot ${data.pivot.lo}~${data.pivot.hi}` : ''} (${data.source})`
        : t.type === 'etf_flow' ? `${t.symbol} ETF net ${data.netM > 0 ? '+' : ''}$${data.netM}M (${data.day}, ${data.source})`
          : `verdict=${data.verdict} @ ${data.price1}`;
      log(green('✓'), label, dim(detail));
    } catch (e) {
      log(red('✗'), label, red(String(e.message || e)));
    }
  }
  return tasks.length;
}

async function heartbeat() {
  await api('/api/heartbeat', {
    method: 'POST',
    body: {
      load: os.loadavg()[0],
      memPct: (1 - os.freemem() / os.totalmem()) * 100,
      uptimeS: os.uptime(),
    },
  });
}

// ---------------- main ----------------
(async () => {
  console.log(bold(amber(`
   ██╗      ██████╗  █████╗ ██╗    LGAI Node v${VERSION}
   ██║     ██╔════╝ ██╔══██╗██║    The Trusted Intelligence Network for AI Agents
   ██║     ██║  ███╗███████║██║    ${MOCK ? '[MOCK data source]' : '[Binance→OKX live data]'}
   ███████╗╚██████╔╝██╔══██║██║
   ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝    coordinator: ${COORD}
`)));
  async function register() {
    const reg = await api('/api/register', {
      method: 'POST', authd: false,
      body: {
        name: NAME, platform: `${os.platform()} ${os.release().split('.')[0]}`,
        arch: os.arch(), cpus: os.cpus().length,
        memGB: +(os.totalmem() / 2 ** 30).toFixed(1), version: VERSION,
      },
    });
    cred = { nodeId: reg.nodeId, token: reg.token };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(cred), { mode: 0o600 });
    log(green('✓'), `Registered on ${bold(reg.network)}, node ID ${bold(cred.nodeId.slice(0, 8))}`);
  }
  // Stale credentials (e.g. coordinator reset) -> auto re-register
  async function withReauth(fn) {
    try { return await fn(); }
    catch (e) {
      if (!/^401/.test(String(e.message))) throw e;
      log(amber('⟳'), 'credentials invalid (coordinator may have been reset), re-registering…');
      await register();
      return await fn();
    }
  }
  if (!cred) await register();
  else log(dim(`using saved credentials ${cred.nodeId.slice(0, 8)} (${stateFile})`));

  // ---- One-shot commands: marketplace / agent intel ----
  if (flag('--market')) {
    const { listings, volume } = await api('/api/market/listings', { authd: false });
    console.log(bold('AI Data Marketplace') + dim(` (total volume: ${volume} pts)`));
    for (const l of listings) console.log(`  ${amber(l.id.padEnd(14))} ${l.title}  ${dim(`size ${l.size}`)}  ${bold(l.price + ' pts')}`);
    process.exit(0);
  }
  if (opt('--buy')) {
    const r = await api('/api/market/buy', { method: 'POST', body: { listingId: opt('--buy') } });
    log(green('✓'), `purchased ${bold(r.title)} for ${r.price} pts, balance ${bold(r.balance)}`);
    log(dim(`proof ${r.proof} · ${Array.isArray(r.data) ? r.data.length : 0} records`));
    process.exit(0);
  }
  if (opt('--intel')) {
    const r = await api(`/api/agent/intel?symbol=${opt('--intel')}`, { authd: false });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }
  if (opt('--vote')) {
    const [sym, dir] = String(opt('--vote')).split(/[=:]/);
    const r = await api('/api/feedback', {
      method: 'POST',
      body: { targetType: 'sentiment', targetId: (sym || '').toUpperCase(), value: (dir || 'LONG').toUpperCase() },
    });
    log(green('✓'), `sentiment submitted for ${bold((sym || '').toUpperCase())}, points balance ${bold(r.points)}`);
    process.exit(0);
  }

  await withReauth(heartbeat);
  log(green('✓'), `heartbeat OK · node ${bold(NAME)} (${os.platform()}/${os.arch()}, ${os.cpus().length} cores)`);

  if (ONCE) {
    // Self-check mode: poll until tasks (incl. derived ones) are claimed and done, then exit
    let idle = 0;
    for (let i = 0; i < 20 && idle < 3; i++) {
      const got = await pollOnce().catch(() => 0);
      idle = got ? 0 : idle + 1;
      await new Promise(r => setTimeout(r, 800));
    }
    log(bold(`--once done: ${done} tasks completed`));
    process.exit(done > 0 ? 0 : 1);
  }

  const hb = setInterval(() => withReauth(heartbeat).catch(e => log(red('heartbeat failed'), dim(e.message))), 30_000);
  const poll = setInterval(() => withReauth(pollOnce).catch(e => log(red('task poll failed'), dim(e.message))), 8_000);
  const shutdown = () => {
    clearInterval(hb); clearInterval(poll);
    log(`stopped · ${bold(done)} tasks completed this session`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log(dim('working: claiming tasks every 8s, heartbeat every 30s. Ctrl+C to exit.'));
})().catch(e => {
  console.error(red('startup failed:'), e.message || e);
  console.error(dim('make sure the coordinator is running and the URL is correct (--coordinator http://host:18402)'));
  process.exit(1);
});
