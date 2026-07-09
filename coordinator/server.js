#!/usr/bin/env node
/**
 * LGAI Coordinator — 轻量协调服务器 (Phase 02)
 * 职责：节点注册/心跳、任务生成与分发（数据采集/AI推理/信号验证）、
 *       共识校验、贡献积分账本、网页仪表盘。
 * 零依赖，Node >= 18。
 *
 *   PORT=8402 SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT node coordinator/server.js
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';
const PORT = +(process.env.PORT || 8402);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TICK_MS = +(process.env.TICK_MS || 45_000);       // 任务生成周期
const HORIZON_MIN = +(process.env.HORIZON_MIN || 15);   // 预测验证时限(分钟)
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map(s => s.trim());
const ONLINE_MS = 90_000;       // 心跳超时即离线
const LEASE_MS = 5 * 60_000;    // 任务租约
const POINTS = { market_data: 5, ai_infer: 8, signal_verify: 10 };

// ---------------- state ----------------
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let S = {
  nodes: {},        // id -> node
  tasks: {},        // id -> task
  predictions: [],  // 网络自产预测（用于信号验证闭环）
  signals: [],      // 节点推理产出（集成共识后）
  ledger: [],       // 贡献账本
  marketHistory: {},// symbol -> [{ts, c,h,l,v}]
  archive: [],      // 永久存证（哈希链，Arweave 适配预留）
  chain: { seq: 0, head: '' },
  oracle: {},       // symbol -> 最新共识喂价（去中心化预言机）
  market: { sales: [] }, // AI 数据市场成交记录
  stats: { tasksCompleted: 0, pointsIssued: 0, wins: 0, losses: 0, marketVolume: 0 },
};
function load() {
  try { S = { ...S, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
  catch { /* fresh start */ }
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(S));
    fs.renameSync(tmp, STATE_FILE);
  }, 200);
}
const uid = () => crypto.randomBytes(8).toString('hex');
const now = () => Date.now();
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------- domain ----------------
function onlineNodes() { return Object.values(S.nodes).filter(n => now() - n.lastSeen < ONLINE_MS); }

function createTask(type, symbol, payload, redundancy) {
  const t = {
    id: uid(), type, symbol, payload,
    redundancy: Math.max(1, redundancy),
    assignedTo: [], results: {},
    status: 'pending', createdAt: now(),
  };
  S.tasks[t.id] = t;
  return t;
}

// ---- 智能贡献激励：声誉分级，以贡献质量而非算力定酬 ----
function tierOf(n) {
  const strikeRate = n.tasksDone ? n.strikes / n.tasksDone : 0;
  if (n.points >= 300 && strikeRate < 0.05) return '金';
  if (n.points >= 100 && strikeRate < 0.15) return '银';
  return '铜';
}
const TIER_MULT = { '金': 1.5, '银': 1.2, '铜': 1.0 };
function award(nodeId, task, basePts, note) {
  const n = S.nodes[nodeId]; if (!n) return;
  const tier = tierOf(n);
  const pts = Math.round(basePts * TIER_MULT[tier]);
  n.points += pts; n.tasksDone += 1;
  S.stats.pointsIssued += pts;
  S.ledger.unshift({ ts: now(), nodeId, name: n.name, taskId: task.id, type: task.type, symbol: task.symbol, points: pts, note: note + (tier !== '铜' ? ` ×${TIER_MULT[tier]}(${tier})` : '') });
  S.ledger = S.ledger.slice(0, 400);
}

// ---- 去中心化存储：哈希链存证（Arweave 上链适配预留 ARWEAVE_GATEWAY）----
function archivePut(kind, data) {
  const prev = S.chain.head || '';
  const hash = crypto.createHash('sha256').update(prev + JSON.stringify({ kind, data })).digest('hex');
  S.chain = { seq: S.chain.seq + 1, head: hash };
  const rec = { seq: S.chain.seq, ts: now(), kind, data, hash, prevHash: prev, txid: 'ar://' + hash.slice(0, 43) };
  S.archive.unshift(rec);
  S.archive = S.archive.slice(0, 200);
  return rec;
}
function strike(nodeId, task, note) {
  const n = S.nodes[nodeId]; if (!n) return;
  n.strikes += 1;
  S.ledger.unshift({ ts: now(), nodeId, name: n.name, taskId: task.id, type: task.type, symbol: task.symbol, points: 0, note });
  S.ledger = S.ledger.slice(0, 400);
}

function maybeCreatePrediction(symbol) {
  const open = S.predictions.some(p => p.symbol === symbol && (p.status === 'open' || p.status === 'verifying'));
  const hist = S.marketHistory[symbol] || [];
  if (open || hist.length < 12 || Math.random() > 0.5) return;
  const last = hist[hist.length - 1].close;
  // 优先采用节点 AI 推理信号（推土机/吸筹/出货综合评分），无近期信号则退回 SMA 动量
  const sig = S.signals.find(s => s.symbol === symbol && now() - s.ts < 10 * 60_000);
  let dir, basis;
  if (sig && Math.abs(sig.score) >= 0.15) {
    dir = sig.score > 0 ? 'LONG' : 'SHORT';
    basis = `${sig.regime} (${sig.score})`;
  } else {
    const closes = hist.slice(-10).map(h => h.close);
    const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
    dir = last > sma ? 'LONG' : 'SHORT';
    basis = 'SMA动量';
  }
  S.predictions.unshift({
    id: uid(), symbol, dir, basis,
    price0: last, createdAt: now(), horizonMin: HORIZON_MIN, status: 'open',
  });
  S.predictions = S.predictions.slice(0, 120);
  log(`[pred] ${symbol} ${dir} @ ${last} 依据=${basis}`);
}

function finalize(t) {
  const entries = Object.entries(t.results);
  if (t.type === 'market_data') {
    const closes = entries.map(([, r]) => +r.close).filter(Number.isFinite);
    if (!closes.length) { t.status = 'expired'; return; }
    const mid = median(closes);
    let maxDev = 0;
    for (const [nid, r] of entries) {
      const dev = Math.abs(+r.close - mid) / mid;
      maxDev = Math.max(maxDev, dev);
      if (dev <= 0.005) award(nid, t, POINTS.market_data, `close=${r.close} 共识通过`);
      else strike(nid, t, `close=${r.close} 偏离共识 ${(dev * 100).toFixed(2)}%`);
    }
    const medOf = k => { const v = entries.map(([, r]) => +r[k]).filter(Number.isFinite); return v.length ? median(v) : mid; };
    const hist = (S.marketHistory[t.symbol] ||= []);
    hist.push({ ts: now(), c: mid, h: medOf('high'), l: medOf('low'), v: medOf('vol') || 0, close: mid });
    if (hist.length > 300) hist.splice(0, hist.length - 300);
    // 去中心化预言机：多节点共识喂价 + 永久存证
    const rec = archivePut('oracle_price', { symbol: t.symbol, price: mid, nodes: entries.length, maxDevPct: +(maxDev * 100).toFixed(3) });
    S.oracle[t.symbol] = { symbol: t.symbol, price: mid, ts: now(), contributors: entries.length, deviationPct: +(maxDev * 100).toFixed(3), proof: rec.txid };
    maybeCreatePrediction(t.symbol);
    // AI Agent 协作：多节点集成推理（推土机/吸筹/出货三大模型）
    if (hist.length >= 12 && Math.random() < 0.6) {
      createTask('ai_infer', t.symbol, { candles: hist.slice(-30).map(h => ({ c: h.c ?? h.close, h: h.h ?? h.close, l: h.l ?? h.close, v: h.v || 0 })) }, Math.min(3, onlineNodes().length || 1));
    }
  } else if (t.type === 'ai_infer') {
    const valid = [];
    for (const [nid, r] of entries) {
      if (Number.isFinite(r.score) && r.score >= -1 && r.score <= 1) {
        award(nid, t, POINTS.ai_infer, `score=${r.score.toFixed(3)} ${r.regime || ''}`);
        valid.push({ nid, ...r });
      } else strike(nid, t, '无效推理结果');
    }
    if (valid.length) {
      // 集成共识：多智能体评分取中位数，形态取多数
      const score = +median(valid.map(v => v.score)).toFixed(4);
      const counts = {};
      for (const v of valid) counts[v.regime] = (counts[v.regime] || 0) + 1;
      const regime = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      const best = valid.reduce((a, b) => Math.abs(b.score - score) < Math.abs(a.score - score) ? b : a);
      const rec = archivePut('ai_signal', { symbol: t.symbol, score, regime, contributors: valid.length });
      S.signals.unshift({
        ts: now(), symbol: t.symbol, score, regime: String(regime || '').slice(0, 12),
        features: best.features, contributors: valid.length,
        name: valid.length > 1 ? `${valid.length} 节点集成` : S.nodes[valid[0].nid]?.name,
        proof: rec.txid,
      });
      S.signals = S.signals.slice(0, 100);
    }
  } else if (t.type === 'signal_verify') {
    const verdicts = entries.map(([, r]) => r.verdict);
    const winVotes = verdicts.filter(v => v === 'WIN').length;
    const majority = winVotes * 2 >= verdicts.length ? 'WIN' : 'LOSS';
    for (const [nid, r] of entries) {
      if (r.verdict === majority) award(nid, t, POINTS.signal_verify, `verdict=${r.verdict} 与多数一致`);
      else strike(nid, t, `verdict=${r.verdict} 与多数不一致`);
    }
    const p = S.predictions.find(p => p.id === t.payload.predictionId);
    if (p) {
      p.status = majority === 'WIN' ? 'win' : 'loss';
      p.resolvedAt = now();
      p.price1 = median(entries.map(([, r]) => +r.price1).filter(Number.isFinite));
      S.stats[majority === 'WIN' ? 'wins' : 'losses'] += 1;
      // 预测全生命周期永久存证：入场→验证→裁定
      const rec = archivePut('prediction', { symbol: p.symbol, dir: p.dir, basis: p.basis, price0: p.price0, price1: p.price1, result: majority, verifiers: entries.length });
      p.proof = rec.txid;
    }
  }
  t.status = 'done'; t.doneAt = now();
  S.stats.tasksCompleted += 1;
  save();
}

function tick() {
  const online = onlineNodes();
  if (online.length) {
    const red = Math.min(3, online.length);
    for (const sym of SYMBOLS) {
      const exists = Object.values(S.tasks).some(t =>
        t.type === 'market_data' && t.symbol === sym && t.status !== 'done' && t.status !== 'expired');
      if (!exists) createTask('market_data', sym, { interval: '5m', limit: 40 }, red);
    }
    for (const p of S.predictions) {
      if (p.status === 'open' && now() - p.createdAt >= p.horizonMin * 60_000) {
        p.status = 'verifying';
        createTask('signal_verify', p.symbol, { predictionId: p.id, price0: p.price0, dir: p.dir }, red);
      }
    }
  }
  // 租约到期处理
  for (const t of Object.values(S.tasks)) {
    if (t.status === 'done' || t.status === 'expired') continue;
    if (now() - t.createdAt > LEASE_MS) {
      if (Object.keys(t.results).length) finalize(t);
      else {
        t.status = 'expired';
        if (t.type === 'signal_verify') {
          const p = S.predictions.find(p => p.id === t.payload.predictionId);
          if (p && p.status === 'verifying') p.status = 'open';
        }
      }
    }
  }
  // 清理旧任务
  const done = Object.values(S.tasks).filter(t => t.status === 'done' || t.status === 'expired')
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const t of done.slice(300)) delete S.tasks[t.id];
  save();
}

// ---------------- http ----------------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 262144) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function auth(req) {
  const n = S.nodes[req.headers['x-node-id']];
  return n && n.token === req.headers['x-node-token'] ? n : null;
}

const DASHBOARD = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

// ---- AI 数据市场：数据集与模型信号流通，积分结算 ----
function listings() {
  const ls = [];
  for (const sym of SYMBOLS) {
    ls.push({ id: 'ds-' + sym, kind: 'dataset', symbol: sym, title: `${sym} 共识行情数据集`, price: 50, size: (S.marketHistory[sym] || []).length });
    ls.push({ id: 'sig-' + sym, kind: 'signal', symbol: sym, title: `${sym} AI 信号流订阅`, price: 30, size: S.signals.filter(s => s.symbol === sym).length });
  }
  return ls;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(DASHBOARD);
    }
    // ---- 去中心化预言机（公开读）：可信共识喂价 ----
    if (req.method === 'GET' && url.pathname === '/api/oracle') {
      return send(res, 200, { feeds: Object.values(S.oracle) });
    }
    if (req.method === 'GET' && url.pathname === '/api/oracle/price') {
      const f = S.oracle[url.searchParams.get('symbol')];
      return f ? send(res, 200, f) : send(res, 404, { error: 'no feed' });
    }
    // ---- 永久存证（公开读）：哈希链可验证 ----
    if (req.method === 'GET' && url.pathname === '/api/archive') {
      return send(res, 200, { chain: S.chain, records: S.archive.slice(0, 50) });
    }
    // ---- AI Agent 协作接口（公开读）：外部智能体一次拉取全维度情报 ----
    if (req.method === 'GET' && url.pathname === '/api/agent/intel') {
      const sym = url.searchParams.get('symbol');
      if (!sym) return send(res, 400, { error: 'symbol required' });
      return send(res, 200, {
        symbol: sym,
        oracle: S.oracle[sym] || null,
        signal: S.signals.find(s => s.symbol === sym) || null,
        predictions: S.predictions.filter(p => p.symbol === sym).slice(0, 5),
        accuracy: S.stats.wins + S.stats.losses ? +(S.stats.wins / (S.stats.wins + S.stats.losses) * 100).toFixed(1) : null,
      });
    }
    // ---- AI 数据市场（公开读列表）----
    if (req.method === 'GET' && url.pathname === '/api/market/listings') {
      return send(res, 200, { listings: listings(), volume: S.stats.marketVolume, sales: S.market.sales.slice(0, 20) });
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      const nodes = Object.values(S.nodes).map(n => ({
        id: n.id.slice(0, 8), name: n.name, platform: n.platform, arch: n.arch,
        cpus: n.cpus, memGB: n.memGB, version: n.version,
        online: now() - n.lastSeen < ONLINE_MS,
        points: n.points, tasksDone: n.tasksDone, strikes: n.strikes, tier: tierOf(n),
        lastSeen: n.lastSeen, metrics: n.metrics,
      })).sort((a, b) => b.points - a.points);
      const { wins, losses } = S.stats;
      return send(res, 200, {
        version: VERSION, network: 'LGAI Testnet',
        onlineNodes: nodes.filter(n => n.online).length, totalNodes: nodes.length,
        tasksCompleted: S.stats.tasksCompleted, pointsIssued: S.stats.pointsIssued,
        openTasks: Object.values(S.tasks).filter(t => t.status === 'pending' || t.status === 'assigned').length,
        accuracy: { wins, losses, rate: wins + losses ? +(wins / (wins + losses) * 100).toFixed(1) : null },
        nodes, ledger: S.ledger.slice(0, 30),
        predictions: S.predictions.slice(0, 20),
        signals: S.signals.slice(0, 10),
        oracle: Object.values(S.oracle),
        chain: S.chain, archive: S.archive.slice(0, 10),
        market: { listings: listings(), sales: S.market.sales.slice(0, 8), volume: S.stats.marketVolume || 0 },
        symbols: Object.fromEntries(SYMBOLS.map(s => [s, (S.marketHistory[s] || []).slice(-1)[0] || null])),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/register') {
      const b = await readBody(req);
      if (!b.name || typeof b.name !== 'string') return send(res, 400, { error: 'name required' });
      const id = uid(), token = crypto.randomBytes(16).toString('hex');
      S.nodes[id] = {
        id, token, name: String(b.name).slice(0, 40),
        platform: String(b.platform || '?').slice(0, 20), arch: String(b.arch || '?').slice(0, 12),
        cpus: +b.cpus || 0, memGB: +b.memGB || 0, version: String(b.version || '?').slice(0, 12),
        createdAt: now(), lastSeen: now(), points: 0, tasksDone: 0, strikes: 0, metrics: {},
      };
      save();
      log(`[join] ${b.name} (${b.platform}/${b.arch}) -> ${id.slice(0, 8)}`);
      return send(res, 200, { nodeId: id, token, network: 'LGAI Testnet', coordinatorVersion: VERSION, heartbeatMs: 30_000, pollMs: 8_000 });
    }
    const node = auth(req);
    if (!node) return send(res, 401, { error: 'unauthorized' });

    if (req.method === 'POST' && url.pathname === '/api/heartbeat') {
      const b = await readBody(req);
      node.lastSeen = now();
      node.metrics = {
        load: +(+b.load || 0).toFixed(2), memPct: +(+b.memPct || 0).toFixed(1),
        uptimeS: Math.round(+b.uptimeS || 0),
      };
      tick(); // 有活跃节点即保证任务池充盈
      save();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      node.lastSeen = now();
      const mine = [];
      for (const t of Object.values(S.tasks)) {
        if (mine.length >= 3) break;
        if (t.status === 'done' || t.status === 'expired') continue;
        if (t.assignedTo.includes(node.id) || t.assignedTo.length >= t.redundancy) continue;
        t.assignedTo.push(node.id); t.status = 'assigned';
        mine.push({ id: t.id, type: t.type, symbol: t.symbol, payload: t.payload });
      }
      if (mine.length) save();
      return send(res, 200, { tasks: mine });
    }
    // ---- AI 数据市场：购买（积分结算 + 成交存证）----
    if (req.method === 'POST' && url.pathname === '/api/market/buy') {
      const b = await readBody(req);
      const item = listings().find(l => l.id === b.listingId);
      if (!item) return send(res, 404, { error: 'listing not found' });
      if (node.points < item.price) return send(res, 402, { error: `积分不足（需 ${item.price}，当前 ${node.points}）` });
      node.points -= item.price;
      const rec = archivePut('market_sale', { buyer: node.name, listingId: item.id, title: item.title, price: item.price });
      S.market.sales.unshift({ ts: now(), nodeId: node.id, name: node.name, listingId: item.id, title: item.title, price: item.price, proof: rec.txid });
      S.market.sales = S.market.sales.slice(0, 100);
      S.stats.marketVolume = (S.stats.marketVolume || 0) + item.price;
      S.ledger.unshift({ ts: now(), nodeId: node.id, name: node.name, taskId: rec.txid, type: 'market', symbol: item.symbol, points: -item.price, note: `购买 ${item.title}` });
      S.ledger = S.ledger.slice(0, 400);
      const data = item.kind === 'dataset'
        ? (S.marketHistory[item.symbol] || []).slice(-100)
        : S.signals.filter(s => s.symbol === item.symbol).slice(0, 10);
      save();
      return send(res, 200, { ok: true, proof: rec.txid, title: item.title, price: item.price, balance: node.points, data });
    }
    if (req.method === 'POST' && url.pathname === '/api/result') {
      const b = await readBody(req);
      const t = S.tasks[b.taskId];
      if (!t) return send(res, 404, { error: 'task not found' });
      if (!t.assignedTo.includes(node.id)) return send(res, 403, { error: 'not assigned' });
      if (t.results[node.id]) return send(res, 409, { error: 'already submitted' });
      if (t.status === 'done' || t.status === 'expired') return send(res, 410, { error: 'task closed' });
      t.results[node.id] = { ...b.data, ts: now() };
      if (Object.keys(t.results).length >= t.redundancy) finalize(t); else save();
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

load();
setInterval(tick, TICK_MS);
server.listen(PORT, () => {
  log(`LGAI Coordinator v${VERSION}`);
  log(`dashboard  http://localhost:${PORT}`);
  log(`symbols    ${SYMBOLS.join(', ')}  |  tick ${TICK_MS / 1000}s  |  horizon ${HORIZON_MIN}min`);
});
