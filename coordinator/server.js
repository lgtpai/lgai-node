#!/usr/bin/env node
/**
 * LGAI Coordinator — lightweight coordination server (Phase 02)
 * Responsibilities: node registration/heartbeats, task generation & dispatch
 * (data collection / AI inference / signal verification), consensus checks,
 * contribution point ledger, and the web dashboard.
 * Zero dependencies, Node >= 18.
 *
 *   PORT=18402 SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT node coordinator/server.js
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.2.2';
const PORT = +(process.env.PORT || 18402);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TICK_MS = +(process.env.TICK_MS || 45_000);       // task generation interval
const HORIZON_MIN = +(process.env.HORIZON_MIN || 15);   // prediction verification horizon (minutes)
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map(s => s.trim());
const ONLINE_MS = 90_000;       // offline after missed heartbeats
const LEASE_MS = 5 * 60_000;    // task lease
const POINTS = { market_data: 5, ai_infer: 8, signal_verify: 10 };

// ---------------- state ----------------
const STATE_FILE = path.join(DATA_DIR, 'state.json');
let S = {
  nodes: {},        // id -> node
  tasks: {},        // id -> task
  predictions: [],  // network-generated predictions (for the verification loop)
  signals: [],      // node inference output (after ensemble consensus)
  ledger: [],       // contribution ledger
  marketHistory: {},// symbol -> [{ts, c,h,l,v}]
  archive: [],      // permanent archive (hash chain, Arweave adapter reserved)
  chain: { seq: 0, head: '' },
  oracle: {},       // symbol -> latest consensus feed (decentralized oracle)
  market: { sales: [] }, // AI data marketplace sales
  feedback: [],     // human feedback trail (PoI dual-channel: humans + AI agents)
  sentiment: {},    // symbol -> [{userId, dir, ts}] human market sentiment votes
  lgai: {},         // symbol -> bulldozer trend derived from proprietary LGAI push data (optional)
  stats: { tasksCompleted: 0, pointsIssued: 0, wins: 0, losses: 0, marketVolume: 0, humanWins: 0, humanLosses: 0 },
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

// ---- Contribution incentives: reputation tiers, rewards by quality not hashpower ----
function tierOf(n) {
  const strikeRate = n.tasksDone ? n.strikes / n.tasksDone : 0;
  if (n.points >= 300 && strikeRate < 0.05) return 'gold';
  if (n.points >= 100 && strikeRate < 0.15) return 'silver';
  return 'bronze';
}
const TIER_MULT = { gold: 1.5, silver: 1.2, bronze: 1.0 };
function award(nodeId, task, basePts, note) {
  const n = S.nodes[nodeId]; if (!n) return;
  const tier = tierOf(n);
  const pts = Math.round(basePts * TIER_MULT[tier]);
  n.points += pts; n.tasksDone += 1;
  S.stats.pointsIssued += pts;
  S.ledger.unshift({ ts: now(), nodeId, name: n.name, taskId: task.id, type: task.type, symbol: task.symbol, points: pts, note: note + (tier !== 'bronze' ? ` ×${TIER_MULT[tier]}(${tier})` : '') });
  S.ledger = S.ledger.slice(0, 400);
}

// ---- Decentralized storage: hash-chained archive (Arweave adapter reserved via ARWEAVE_GATEWAY) ----
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

// ---- LGAI push data: proprietary network-wide holding-cost pushes (strongest signal source) ----
// Optional: set LGAI_DB=/path/to/lgai.db (or auto-detected at ../../data/lgai.db). Requires Node >= 22 (node:sqlite).
const LGAI_DB = process.env.LGAI_DB || (fs.existsSync(path.join(__dirname, '../../data/lgai.db')) ? path.join(__dirname, '../../data/lgai.db') : '');
let lgaiDb = null;
async function openLgaiDb() {
  if (!LGAI_DB) return;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    lgaiDb = new DatabaseSync(LGAI_DB, { readOnly: true });
    log(`[lgai] push database connected (read-only): ${LGAI_DB}`);
    refreshLgaiPush();
  } catch (e) { log(`[lgai] push db unavailable: ${e.message}`); }
}
function refreshLgaiPush() {
  if (!lgaiDb) return;
  for (const sym of SYMBOLS) {
    try {
      const rows = lgaiDb.prepare('SELECT price, time FROM newcoins WHERE token = ? ORDER BY time DESC LIMIT 15')
        .all(sym.replace(/USDT$/, ''));
      if (rows.length < 5) continue;
      const prices = rows.map(r => +r.price).reverse(); // oldest -> newest
      let ups = 0;
      for (let i = 1; i < prices.length; i++) if (prices[i] > prices[i - 1]) ups++;
      const upRatio = ups / (prices.length - 1);
      // Bulldozer rule on push prices: >=70% one-directional pushes set the direction
      const dir = upRatio >= 0.7 ? 'LONG' : upRatio <= 0.3 ? 'SHORT' : null;
      S.lgai[sym] = {
        symbol: sym, dir, upRatio: +upRatio.toFixed(2),
        pushes: rows.length, lastPush: rows[0].time, lastPrice: +rows[0].price,
      };
    } catch { /* token missing or schema mismatch: skip */ }
  }
}

function maybeCreatePrediction(symbol) {
  const open = S.predictions.some(p => p.symbol === symbol && (p.status === 'open' || p.status === 'verifying'));
  const hist = S.marketHistory[symbol] || [];
  if (open || hist.length < 12 || Math.random() > 0.5) return;
  const last = hist[hist.length - 1].close;
  // PoI dual-channel: AI inference signals first, fused with recent human sentiment; SMA as last resort
  const sig = S.signals.find(s => s.symbol === symbol && now() - s.ts < 10 * 60_000);
  const senti = (S.sentiment[symbol] || []).filter(v => now() - v.ts < 60 * 60_000).slice(-30);
  const nL = senti.filter(v => v.dir === 'LONG').length;
  let humanDir = null;
  if (senti.length >= 3) {
    if (nL / senti.length >= 0.7) humanDir = 'LONG';
    else if ((senti.length - nL) / senti.length >= 0.7) humanDir = 'SHORT';
  }
  // LGAI push trend (proprietary, strongest) > AI ensemble signal > human sentiment > SMA
  const push = S.lgai[symbol];
  const pushTs = push ? Date.parse(String(push.lastPush).replace(' ', 'T')) : NaN;
  const pushOk = push && push.dir && (!Number.isFinite(pushTs) || now() - pushTs < 48 * 3600_000);
  let dir, basis;
  if (pushOk) {
    dir = push.dir;
    basis = `LGAI push bulldozer ${Math.round(push.upRatio * 100)}%↑ (${push.pushes} pushes)`;
    if (sig && Math.abs(sig.score) >= 0.15 && (sig.score > 0 ? 'LONG' : 'SHORT') === dir) basis += ' + AI confirm';
    if (humanDir === dir) basis += ' + human consensus';
  } else if (sig && Math.abs(sig.score) >= 0.15) {
    dir = sig.score > 0 ? 'LONG' : 'SHORT';
    basis = `${sig.regime} (${sig.score})`;
    if (humanDir === dir) basis += ' + human consensus';
  } else if (humanDir) {
    dir = humanDir;
    basis = `Human sentiment (${senti.length} votes)`;
  } else {
    const closes = hist.slice(-10).map(h => h.close);
    const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
    dir = last > sma ? 'LONG' : 'SHORT';
    basis = 'SMA momentum';
  }
  S.predictions.unshift({
    id: uid(), symbol, dir, basis,
    price0: last, createdAt: now(), horizonMin: HORIZON_MIN, status: 'open',
  });
  S.predictions = S.predictions.slice(0, 120);
  log(`[pred] ${symbol} ${dir} @ ${last} basis=${basis}`);
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
      if (dev <= 0.005) award(nid, t, POINTS.market_data, `close=${r.close} consensus ok`);
      else strike(nid, t, `close=${r.close} deviates ${(dev * 100).toFixed(2)}% from consensus`);
    }
    const medOf = k => { const v = entries.map(([, r]) => +r[k]).filter(Number.isFinite); return v.length ? median(v) : mid; };
    const hist = (S.marketHistory[t.symbol] ||= []);
    hist.push({ ts: now(), c: mid, h: medOf('high'), l: medOf('low'), v: medOf('vol') || 0, close: mid });
    if (hist.length > 300) hist.splice(0, hist.length - 300);
    // Decentralized oracle: multi-node consensus feed + permanent proof (source labeled, mock data obvious)
    const sources = [...new Set(entries.map(([, r]) => r.source).filter(Boolean))].join('+') || '?';
    const rec = archivePut('oracle_price', { symbol: t.symbol, price: mid, nodes: entries.length, maxDevPct: +(maxDev * 100).toFixed(3), source: sources });
    S.oracle[t.symbol] = { symbol: t.symbol, price: mid, ts: now(), contributors: entries.length, deviationPct: +(maxDev * 100).toFixed(3), proof: rec.txid, source: sources };
    maybeCreatePrediction(t.symbol);
    // Agent collaboration: multi-node ensemble inference (bulldozer/accumulation/distribution models)
    if (hist.length >= 12 && Math.random() < 0.6) {
      createTask('ai_infer', t.symbol, { candles: hist.slice(-30).map(h => ({ c: h.c ?? h.close, h: h.h ?? h.close, l: h.l ?? h.close, v: h.v || 0 })) }, Math.min(3, onlineNodes().length || 1));
    }
  } else if (t.type === 'ai_infer') {
    const valid = [];
    for (const [nid, r] of entries) {
      if (Number.isFinite(r.score) && r.score >= -1 && r.score <= 1) {
        award(nid, t, POINTS.ai_infer, `score=${r.score.toFixed(3)} ${r.regime || ''}`);
        valid.push({ nid, ...r });
      } else strike(nid, t, 'invalid inference result');
    }
    if (valid.length) {
      // Ensemble consensus: median of scores, majority regime
      const score = +median(valid.map(v => v.score)).toFixed(4);
      const counts = {};
      for (const v of valid) counts[v.regime] = (counts[v.regime] || 0) + 1;
      const regime = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      const best = valid.reduce((a, b) => Math.abs(b.score - score) < Math.abs(a.score - score) ? b : a);
      const rec = archivePut('ai_signal', { symbol: t.symbol, score, regime, contributors: valid.length });
      S.signals.unshift({
        id: uid(), ts: now(), symbol: t.symbol, score, regime: String(regime || '').slice(0, 24),
        features: best.features, contributors: valid.length,
        name: valid.length > 1 ? `${valid.length}-node ensemble` : S.nodes[valid[0].nid]?.name,
        proof: rec.txid, up: 0, down: 0,
      });
      S.signals = S.signals.slice(0, 100);
    }
  } else if (t.type === 'signal_verify') {
    const verdicts = entries.map(([, r]) => r.verdict);
    const winVotes = verdicts.filter(v => v === 'WIN').length;
    const majority = winVotes * 2 >= verdicts.length ? 'WIN' : 'LOSS';
    for (const [nid, r] of entries) {
      if (r.verdict === majority) award(nid, t, POINTS.signal_verify, `verdict=${r.verdict} majority match`);
      else strike(nid, t, `verdict=${r.verdict} minority`);
    }
    const p = S.predictions.find(p => p.id === t.payload.predictionId);
    if (p) {
      p.status = majority === 'WIN' ? 'win' : 'loss';
      p.resolvedAt = now();
      p.price1 = median(entries.map(([, r]) => +r.price1).filter(Number.isFinite));
      S.stats[majority === 'WIN' ? 'wins' : 'losses'] += 1;
      // PoI human verification: voters who called the outcome correctly earn a verified-insight bonus
      let vOk = 0, vBad = 0;
      for (const [uidV, dirV] of Object.entries(p.votes || {})) {
        const correct = (majority === 'WIN') === (dirV === p.dir);
        if (correct) {
          vOk++; S.stats.humanWins = (S.stats.humanWins || 0) + 1;
          award(uidV, { id: p.id, type: 'feedback', symbol: p.symbol }, 5, `verified human insight ${dirV}`);
        } else { vBad++; S.stats.humanLosses = (S.stats.humanLosses || 0) + 1; }
      }
      // Full prediction lifecycle archived: entry -> verification -> verdict (+ human votes)
      const rec = archivePut('prediction', { symbol: p.symbol, dir: p.dir, basis: p.basis, price0: p.price0, price1: p.price1, result: majority, verifiers: entries.length, humanVotes: { correct: vOk, wrong: vBad } });
      p.proof = rec.txid;
    }
  }
  t.status = 'done'; t.doneAt = now();
  S.stats.tasksCompleted += 1;
  save();
}

function tick() {
  refreshLgaiPush();
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
  // handle expired leases
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
  // prune old tasks
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

// ---- AI data marketplace: datasets & signal feeds, point-settled ----
// LGAI weighting: items backed by a live proprietary push trend carry a premium (×1.5);
// the raw push trend feed itself is a top-tier exclusive item (×2.0 base).
function lgaiWeightOf(sym) {
  const g = S.lgai[sym];
  return g && g.dir ? 1.5 : 1.0;
}
function listings() {
  const ls = [];
  for (const sym of SYMBOLS) {
    const w = lgaiWeightOf(sym);
    ls.push({ id: 'ds-' + sym, kind: 'dataset', symbol: sym, title: `${sym} consensus OHLCV dataset`, price: Math.round(50 * w), lgaiWeight: w, size: (S.marketHistory[sym] || []).length });
    ls.push({ id: 'sig-' + sym, kind: 'signal', symbol: sym, title: `${sym} AI signal feed`, price: Math.round(30 * w), lgaiWeight: w, size: S.signals.filter(s => s.symbol === sym).length });
    if (S.lgai[sym]) {
      ls.push({ id: 'lgai-' + sym, kind: 'lgai', symbol: sym, title: `${sym} LGAI push trend feed (proprietary)`, price: 80, lgaiWeight: 2.0, size: S.lgai[sym].pushes });
    }
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
    // Brand logo (same asset as the official website)
    if (req.method === 'GET' && url.pathname === '/logo.jpg') {
      try {
        const img = fs.readFileSync(path.join(__dirname, 'lgai_logo.jpg'));
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
        return res.end(img);
      } catch { return send(res, 404, { error: 'logo not found' }); }
    }
    // ---- Decentralized oracle (public read): trusted consensus feeds ----
    if (req.method === 'GET' && url.pathname === '/api/oracle') {
      return send(res, 200, { feeds: Object.values(S.oracle) });
    }
    if (req.method === 'GET' && url.pathname === '/api/oracle/price') {
      const f = S.oracle[url.searchParams.get('symbol')];
      return f ? send(res, 200, f) : send(res, 404, { error: 'no feed' });
    }
    // ---- Permanent archive (public read): verifiable hash chain ----
    if (req.method === 'GET' && url.pathname === '/api/archive') {
      return send(res, 200, { chain: S.chain, records: S.archive.slice(0, 50) });
    }
    // ---- Agent collaboration API (public read): full intel for external agents in one call ----
    if (req.method === 'GET' && url.pathname === '/api/agent/intel') {
      const sym = url.searchParams.get('symbol');
      if (!sym) return send(res, 400, { error: 'symbol required' });
      return send(res, 200, {
        symbol: sym,
        oracle: S.oracle[sym] || null,
        lgaiPush: S.lgai[sym] || null,
        signal: S.signals.find(s => s.symbol === sym) || null,
        predictions: S.predictions.filter(p => p.symbol === sym).slice(0, 5),
        accuracy: S.stats.wins + S.stats.losses ? +(S.stats.wins / (S.stats.wins + S.stats.losses) * 100).toFixed(1) : null,
      });
    }
    // ---- AI data marketplace (public listings) ----
    if (req.method === 'GET' && url.pathname === '/api/market/listings') {
      return send(res, 200, { listings: listings(), volume: S.stats.marketVolume, sales: S.market.sales.slice(0, 20) });
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      const nodes = Object.values(S.nodes).map(n => ({
        id: n.id.slice(0, 8), name: n.name, role: n.role || 'node', platform: n.platform, arch: n.arch,
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
        predictions: S.predictions.slice(0, 20).map(p => ({ ...p, votes: undefined, votesCount: Object.keys(p.votes || {}).length })),
        signals: S.signals.slice(0, 10),
        feedback: S.feedback.slice(0, 15),
        humanAccuracy: (S.stats.humanWins + S.stats.humanLosses)
          ? +(S.stats.humanWins / (S.stats.humanWins + S.stats.humanLosses) * 100).toFixed(1) : null,
        sentiment: Object.fromEntries(SYMBOLS.map(sym => {
          const arr = (S.sentiment[sym] || []).filter(v => now() - v.ts < 60 * 60_000);
          return [sym, { long: arr.filter(v => v.dir === 'LONG').length, short: arr.filter(v => v.dir === 'SHORT').length }];
        })),
        oracle: Object.values(S.oracle),
        lgai: Object.values(S.lgai),
        chain: S.chain, archive: S.archive.slice(0, 10),
        market: { listings: listings(), sales: S.market.sales.slice(0, 8), volume: S.stats.marketVolume || 0 },
        symbols: Object.fromEntries(SYMBOLS.map(s => [s, (S.marketHistory[s] || []).slice(-1)[0] || null])),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/register') {
      const b = await readBody(req);
      if (!b.name || typeof b.name !== 'string') return send(res, 400, { error: 'name required' });
      const id = uid(), token = crypto.randomBytes(16).toString('hex');
      const role = b.role === 'human' ? 'human' : 'node';
      S.nodes[id] = {
        id, token, role, name: String(b.name).slice(0, 40),
        platform: String(b.platform || (role === 'human' ? 'web' : '?')).slice(0, 20), arch: String(b.arch || '-').slice(0, 12),
        cpus: +b.cpus || 0, memGB: +b.memGB || 0, version: String(b.version || '?').slice(0, 12),
        createdAt: now(), lastSeen: now(), points: 0, tasksDone: 0, strikes: 0, metrics: {},
      };
      save();
      log(`[join] ${role} ${b.name} -> ${id.slice(0, 8)}`);
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
      tick(); // keep the task pool filled while nodes are active
      save();
      return send(res, 200, { ok: true });
    }
    // ---- PoI human feedback: rate signals, vote on predictions, contribute sentiment ----
    if (req.method === 'POST' && url.pathname === '/api/feedback') {
      const b = await readBody(req);
      node.lastSeen = now();
      const hour = S.feedback.filter(f => f.userId === node.id && now() - f.ts < 3600_000).length;
      if (hour >= 30) return send(res, 429, { error: 'feedback rate limit (30/hour)' });
      const pushFb = (targetType, targetId, value, symbol) => {
        S.feedback.unshift({ ts: now(), userId: node.id, name: node.name, role: node.role || 'node', targetType, targetId, value, symbol });
        S.feedback = S.feedback.slice(0, 300);
      };
      const fbAward = (pts, note) => award(node.id, { id: 'fb-' + uid(), type: 'feedback', symbol: b.symbol || '' }, pts, note);
      if (b.targetType === 'signal') {
        const sig = S.signals.find(x => x.id === b.targetId);
        if (!sig) return send(res, 404, { error: 'signal not found' });
        if (S.feedback.some(f => f.userId === node.id && f.targetType === 'signal' && f.targetId === sig.id))
          return send(res, 409, { error: 'already rated this signal' });
        const v = b.value === 'up' ? 'up' : 'down';
        sig[v] = (sig[v] || 0) + 1;
        pushFb('signal', sig.id, v, sig.symbol);
        award(node.id, { id: sig.id, type: 'feedback', symbol: sig.symbol }, 2, `signal ${v === 'up' ? 'confirmed' : 'disputed'}`);
        if (sig.up + sig.down === 5) archivePut('human_feedback', { kind: 'signal', signalId: sig.id, symbol: sig.symbol, up: sig.up, down: sig.down });
        save();
        return send(res, 200, { ok: true, up: sig.up, down: sig.down, points: node.points });
      }
      if (b.targetType === 'prediction') {
        const p = S.predictions.find(x => x.id === b.targetId);
        if (!p) return send(res, 404, { error: 'prediction not found' });
        if (p.status !== 'open' && p.status !== 'verifying') return send(res, 410, { error: 'prediction already resolved' });
        p.votes ||= {};
        if (p.votes[node.id]) return send(res, 409, { error: 'already voted on this prediction' });
        const dir = b.value === 'LONG' ? 'LONG' : 'SHORT';
        p.votes[node.id] = dir;
        pushFb('prediction', p.id, dir, p.symbol);
        award(node.id, { id: p.id, type: 'feedback', symbol: p.symbol }, 2, `prediction vote ${dir} (bonus on correct outcome)`);
        save();
        return send(res, 200, { ok: true, votes: Object.keys(p.votes).length, points: node.points });
      }
      if (b.targetType === 'sentiment') {
        const sym = String(b.targetId || '').toUpperCase();
        if (!SYMBOLS.includes(sym)) return send(res, 404, { error: 'unknown symbol' });
        const arr = (S.sentiment[sym] ||= []);
        if (arr.some(v => v.userId === node.id && now() - v.ts < 30 * 60_000))
          return send(res, 409, { error: 'sentiment already submitted recently (30min window)' });
        const dir = b.value === 'LONG' ? 'LONG' : 'SHORT';
        arr.push({ userId: node.id, dir, ts: now() });
        if (arr.length > 100) arr.splice(0, arr.length - 100);
        pushFb('sentiment', sym, dir, sym);
        award(node.id, { id: 'st-' + uid(), type: 'feedback', symbol: sym }, 2, `market sentiment ${dir}`);
        save();
        return send(res, 200, { ok: true, points: node.points });
      }
      return send(res, 400, { error: 'targetType must be signal | prediction | sentiment' });
    }
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      node.lastSeen = now();
      if (node.role === 'human') return send(res, 200, { tasks: [] });
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
    // ---- Marketplace purchase (point settlement + sale proof) ----
    if (req.method === 'POST' && url.pathname === '/api/market/buy') {
      const b = await readBody(req);
      const item = listings().find(l => l.id === b.listingId);
      if (!item) return send(res, 404, { error: 'listing not found' });
      if (node.points < item.price) return send(res, 402, { error: `insufficient points (need ${item.price}, have ${node.points})` });
      node.points -= item.price;
      const rec = archivePut('market_sale', { buyer: node.name, listingId: item.id, title: item.title, price: item.price });
      S.market.sales.unshift({ ts: now(), nodeId: node.id, name: node.name, listingId: item.id, title: item.title, price: item.price, proof: rec.txid });
      S.market.sales = S.market.sales.slice(0, 100);
      S.stats.marketVolume = (S.stats.marketVolume || 0) + item.price;
      S.ledger.unshift({ ts: now(), nodeId: node.id, name: node.name, taskId: rec.txid, type: 'market', symbol: item.symbol, points: -item.price, note: `purchase: ${item.title}` });
      S.ledger = S.ledger.slice(0, 400);
      let data;
      if (item.kind === 'dataset') data = (S.marketHistory[item.symbol] || []).slice(-100);
      else if (item.kind === 'lgai') {
        // exclusive: trend snapshot + raw recent pushes, read live from the push db
        let pushes = [];
        try {
          pushes = lgaiDb ? lgaiDb.prepare('SELECT price, time FROM newcoins WHERE token = ? ORDER BY time DESC LIMIT 15')
            .all(item.symbol.replace(/USDT$/, '')).map(r => ({ price: +r.price, time: r.time })) : [];
        } catch { }
        data = { trend: S.lgai[item.symbol] || null, pushes };
      }
      else data = S.signals.filter(s => s.symbol === item.symbol).slice(0, 10);
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
await openLgaiDb();
setInterval(tick, TICK_MS);
server.listen(PORT, () => {
  const tty = process.stdout.isTTY;
  const amber = s => tty ? `\x1b[1;33m${s}\x1b[0m` : s;
  console.log(amber(`
   ██╗      ██████╗  █████╗ ██╗    LGAI Coordinator v${VERSION}
   ██║     ██╔════╝ ██╔══██╗██║    The Trusted Intelligence Network for AI Agents
   ██║     ██║  ███╗███████║██║
   ███████╗╚██████╔╝██╔══██║██║    dashboard: http://localhost:${PORT}
   ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝
`));
  log(`symbols    ${SYMBOLS.join(', ')}  |  tick ${TICK_MS / 1000}s  |  horizon ${HORIZON_MIN}min`);
});
