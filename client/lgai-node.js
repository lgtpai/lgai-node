#!/usr/bin/env node
/**
 * LGAI Node — 跨平台节点客户端 (Phase 02)
 * 树莓派 / Mac / PC / 服务器 / 云主机，只需 Node >= 18，零依赖。
 *
 *   node client/lgai-node.js --coordinator http://<host>:18402 [--name myPi] [--mock] [--once]
 *
 * 职能（对应官网四大节点角色）：
 *   数据计算  market_data   拉取公开行情并上报，参与多节点共识
 *   AI 推理   ai_infer      基于共识行情本地计算动量/波动特征与评分
 *   信号验证  signal_verify 独立复核网络预测的实际结果
 *   智能贡献  贡献积分账本，协调端记账
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = '0.1.1';

// ---------------- args ----------------
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
if (flag('--help') || flag('-h')) {
  console.log(`LGAI Node v${VERSION}
用法: node lgai-node.js [选项]
  --coordinator, -c <url>  协调端地址 (默认 $LGAI_COORDINATOR 或 http://127.0.0.1:18402)
  --name <name>            节点名称 (默认主机名)
  --mock                   使用模拟行情数据源（离线/测试）
  --once                   跑一轮任务后退出（自检用）
  --market                 查看 AI 数据市场商品后退出
  --buy <listingId>        用积分购买数据集/信号流后退出
  --intel <symbol>         拉取 Agent 协作情报（预言机+信号+预测）后退出
  --help                   显示帮助`);
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
// 确定性 OHLCV 随机游走（mock），同一 15s 窗口内全网一致 → 可通过共识校验
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
  throw new Error('所有行情数据源均不可用（可用 --mock 测试）');
}
async function getPrice(symbol) {
  const { candles, source } = await getCandles(symbol, 2, '1m');
  return { price: candles[candles.length - 1].c, source };
}

// ---------------- local inference ----------------
// 三大基础模型（价量代理实现，口径对齐主仓库 README_signals）：
//   🚜 推土机趋势  近窗单边推进占比 ≥70% 定方向 + 结构锚（回调不破近窗低点继续持多，反之持空）
//   📉 庄家出货    高位滞涨 + 下跌K放量 + 收盘贴近K线下沿 + 高点逐级下移
//   🧲 庄家吸筹    低位横盘 + 量能抬升 + 收盘贴近K线上沿 + 低点逐级抬高
// 扩展特征：动量 / RSI / 波动率 → 综合趋势评分 ∈ [-1,1]
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
  // 兼容纯 closes 数组（无量能时吸筹/出货模型自动降权为 0）
  const ks = candles.map(k => typeof k === 'number' ? { c: k, h: k, l: k, v: 0 } : { c: +k.c ?? +k.close, h: +k.h || +k.c, l: +k.l || +k.c, v: +k.v || 0 });
  const closes = ks.map(k => k.c);
  const last = closes[closes.length - 1];
  const hasVol = ks.some(k => k.v > 0);

  // --- 🚜 推土机趋势 ---
  const W = Math.min(14, closes.length - 1);
  let ups = 0;
  for (let i = closes.length - W; i < closes.length; i++) if (closes[i] > closes[i - 1]) ups++;
  const upRatio = W ? ups / W : 0.5;
  let bulldozer;
  if (upRatio >= 0.7) bulldozer = 0.5 + (upRatio - 0.7) / 0.3 * 0.5;        // 持续推高 → 持多
  else if (upRatio <= 0.3) bulldozer = -(0.5 + (0.3 - upRatio) / 0.3 * 0.5); // 持续出货 → 持空
  else bulldozer = (upRatio - 0.5) * 0.8;                                    // 无单边 → 弱信号
  // 结构锚：破近窗锚点则趋势失效降权
  const anchorWin = closes.slice(-W - 1, -1);
  if (bulldozer > 0 && last < Math.min(...anchorWin)) bulldozer *= 0.35;
  if (bulldozer < 0 && last > Math.max(...anchorWin)) bulldozer *= 0.35;

  // --- 公共价量特征 ---
  const half = Math.floor(ks.length / 2);
  const baseK = ks.slice(0, half), recentK = ks.slice(half);
  const volRatio = hasVol ? avg(recentK.map(k => k.v)) / (avg(baseK.map(k => k.v)) || 1) : 1;
  const closeLoc = avg(recentK.map(k => k.h > k.l ? (k.c - k.l) / (k.h - k.l) : 0.5)); // 收盘在K线内位置
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

  // --- 🧲 庄家吸筹 (0..1) ---
  const accum = !hasVol ? 0 : clamp(
    clamp((0.35 - pricePos) / 0.35, 0, 1) * 0.30 +   // 低位区
    clamp(volRatio - 1, 0, 1) * 0.30 +               // 量能抬升
    clamp((closeLoc - 0.5) * 2, 0, 1) * 0.25 +       // 收盘贴上沿（有承接）
    (higherLows ? 0.15 : 0), 0, 1);                  // 低点抬高

  // --- 📉 庄家出货 (0..1) ---
  const distrib = !hasVol ? 0 : clamp(
    clamp((pricePos - 0.65) / 0.35, 0, 1) * 0.25 +   // 高位区
    clamp((downVolShare - 0.5) * 2, 0, 1) * 0.30 +   // 下跌K放量
    clamp((0.5 - closeLoc) * 2, 0, 1) * 0.25 +       // 收盘贴下沿（抛压）
    (lowerHighs ? 0.20 : 0), 0, 1);                  // 高点下移

  // --- 扩展特征：动量 / RSI / 波动率 ---
  const w10 = closes.slice(-10);
  const mom = last / (avg(w10) || last) - 1;
  const rets = closes.slice(1).map((v, i) => v / closes[i] - 1);
  const mean = avg(rets);
  const vol = Math.sqrt(avg(rets.map(r => (r - mean) ** 2)));
  const r = rsi(closes);

  // --- 综合评分 ---
  let score = bulldozer * 0.45 + (accum - distrib) * 0.25
    + Math.tanh(mom * 120) * 0.20 + ((r - 50) / 50) * 0.10;
  if (vol > 0.01) score *= 0.7; // 高波动衰减
  score = +clamp(score, -1, 1).toFixed(4);

  const regime =
    bulldozer >= 0.5 ? '推土机多头' :
    bulldozer <= -0.5 ? '推土机出货' :
    accum >= 0.5 && accum > distrib ? '庄家吸筹' :
    distrib >= 0.5 ? '庄家派发' : '震荡';

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
  throw new Error('未知任务类型 ' + t.type);
}

const TYPE_LABEL = { market_data: '数据采集', ai_infer: 'AI 推理', signal_verify: '信号验证' };
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
   ██║     ██╔════╝ ██╔══██╗██║    猎狗AI · Trusted Intelligence Network
   ██║     ██║  ███╗███████║██║    ${MOCK ? '[MOCK 数据源]' : '[Binance→OKX 数据源]'}
   ███████╗╚██████╔╝██╔══██║██║
   ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝    coordinator: ${COORD}
`)));
  if (!cred) {
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
    log(green('✓'), `已注册加入 ${bold(reg.network)}，节点 ID ${bold(cred.nodeId.slice(0, 8))}`);
  } else {
    log(dim(`使用已保存凭据 ${cred.nodeId.slice(0, 8)} (${stateFile})`));
  }

  // ---- 一次性命令：数据市场 / Agent 情报 ----
  if (flag('--market')) {
    const { listings, volume } = await api('/api/market/listings', { authd: false });
    console.log(bold('AI 数据市场') + dim(`（累计成交 ${volume} 分）`));
    for (const l of listings) console.log(`  ${amber(l.id.padEnd(14))} ${l.title}  ${dim(`规模 ${l.size}`)}  ${bold(l.price + ' 分')}`);
    process.exit(0);
  }
  if (opt('--buy')) {
    const r = await api('/api/market/buy', { method: 'POST', body: { listingId: opt('--buy') } });
    log(green('✓'), `已购入 ${bold(r.title)}，支付 ${r.price} 分，余额 ${bold(r.balance)}`);
    log(dim(`存证 ${r.proof} · 数据 ${Array.isArray(r.data) ? r.data.length : 0} 条`));
    process.exit(0);
  }
  if (opt('--intel')) {
    const r = await api(`/api/agent/intel?symbol=${opt('--intel')}`, { authd: false });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }

  await heartbeat();
  log(green('✓'), `心跳正常 · 节点 ${bold(NAME)} (${os.platform()}/${os.arch()}, ${os.cpus().length} 核)`);

  if (ONCE) {
    // 自检模式：轮询直到拿到并完成任务（含派生任务），随后退出
    let idle = 0;
    for (let i = 0; i < 20 && idle < 3; i++) {
      const got = await pollOnce().catch(() => 0);
      idle = got ? 0 : idle + 1;
      await new Promise(r => setTimeout(r, 800));
    }
    log(bold(`--once 完成：${done} 个任务`));
    process.exit(done > 0 ? 0 : 1);
  }

  const hb = setInterval(() => heartbeat().catch(e => log(red('心跳失败'), dim(e.message))), 30_000);
  const poll = setInterval(() => pollOnce().catch(e => log(red('任务轮询失败'), dim(e.message))), 8_000);
  const shutdown = () => {
    clearInterval(hb); clearInterval(poll);
    log(`已退出 · 本次会话完成 ${bold(done)} 个任务`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log(dim('开始工作：每 8s 领取任务，每 30s 心跳。Ctrl+C 退出。'));
})().catch(e => {
  console.error(red('启动失败:'), e.message || e);
  console.error(dim('请确认协调端已启动且地址正确（--coordinator http://host:18402）'));
  process.exit(1);
});
