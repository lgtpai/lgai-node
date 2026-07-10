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

const VERSION = '0.2.1';

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
    const k = await fetchJson(`https://www.okx.com/api/v5/market/candles?instId=${toOkx(symbol)}&bar=${interval}&limit=${limit}`);
    return { candles: k.data.map(r => ({ c: +r[4], h: +r[2], l: +r[3], v: +r[5] })).reverse(), source: 'okx' };
  } catch { }
  throw new Error('all market data sources unavailable (use --mock for testing)');
}
async function getPrice(symbol) {
  const { candles, source } = await getCandles(symbol, 2, '1m');
  return { price: candles[candles.length - 1].c, source };
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
  for (let i = closes.length - W; i < closes.length; i++) if (closes[i] > closes[i - 1]) ups++;
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

// ---------------- task execution ----------------
async function execTask(t) {
  if (t.type === 'market_data') {
    const { candles, source } = await getCandles(t.symbol, t.payload.limit || 40, t.payload.interval || '5m');
    const k = candles[candles.length - 1];
    return { close: k.c, high: k.h, low: k.l, vol: k.v, n: candles.length, source };
  }
  if (t.type === 'ai_infer') {
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
  throw new Error('unknown task type ' + t.type);
}

const TYPE_LABEL = { market_data: 'Market Data', ai_infer: 'AI Inference', signal_verify: 'Signal Verify' };
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
        : t.type === 'ai_infer' ? `score=${data.score} [${data.regime}] 🚜${data.features.bulldozer} 🧲${data.features.accum} 📉${data.features.distrib}`
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
