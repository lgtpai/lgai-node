#!/usr/bin/env node
/** Smoke test: start coordinator -> run a mock node cycle -> verify register/task/points loop */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 18412;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lgai-smoke-'));

const fail = (msg) => { console.error('SMOKE FAIL:', msg); process.exit(1); };

// seed a fake LGAI push database (ascending pushes -> bulldozer LONG for all symbols)
const lgaiDbPath = path.join(tmp, 'lgai.db');
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(lgaiDbPath);
  db.exec('CREATE TABLE newcoins (ids TEXT, token TEXT, price REAL, time TEXT, address TEXT, chain TEXT)');
  const ins = db.prepare('INSERT INTO newcoins (ids, token, price, time, address, chain) VALUES (?,?,?,?,?,?)');
  for (const token of ['BTC', 'ETH', 'SOL', 'DOGE', 'FOO']) {
    for (let i = 0; i < 12; i++) {
      const ts = new Date(Date.now() - (12 - i) * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
      ins.run(String(i), token, 100 + i * 3, ts, '', 'test');
    }
  }
  db.close();
}

const coord = spawn(process.execPath, [path.join(root, 'coordinator/server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'coord'), TICK_MS: '1200', HORIZON_MIN: '0.02', LGAI_DB: lgaiDbPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
coord.stderr.on('data', d => process.stderr.write('[coord] ' + d));

const wait = ms => new Promise(r => setTimeout(r, ms));
async function stats() { return (await fetch(BASE + '/api/stats')).json(); }

try {
  // wait for coordinator
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { await stats(); up = true; } catch { await wait(250); } }
  if (!up) fail('coordinator did not start');
  console.log('1/8 coordinator ready');

  // dashboard reachable
  const html = await (await fetch(BASE + '/')).text();
  if (!html.includes('Coordinator')) fail('dashboard unreachable');
  console.log('2/8 dashboard ok');

  // run one mock node (--once)
  const code = await new Promise(resolve => {
    const cli = spawn(process.execPath, [path.join(root, 'client/lgai-node.js'),
      '-c', BASE, '--mock', '--once', '--name', 'smoke-node'], {
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    cli.on('exit', resolve);
  });
  if (code !== 0) fail('node client exit code ' + code);
  console.log('3/8 node completed the task loop');

  // verify network state
  const s = await stats();
  if (s.totalNodes < 1) fail('node not registered');
  if (s.tasksCompleted < 1) fail('no completed tasks');
  if (s.pointsIssued <= 0) fail('no points issued');
  const n = s.nodes.find(n => n.name === 'smoke-node');
  if (!n || n.points <= 0) fail('node points invalid');
  console.log(`4/8 network state ok · tasks ${s.tasksCompleted} / points ${s.pointsIssued} / node points ${n.points}(${n.tier})`);

  // oracle + permanent archive
  const oracle = await (await fetch(BASE + '/api/oracle')).json();
  if (!oracle.feeds.length) fail('oracle has no feeds');
  const arch = await (await fetch(BASE + '/api/archive')).json();
  if (!arch.chain.seq || !arch.records.length) fail('archive chain empty');
  // spot-check chain integrity
  const r0 = arch.records[0];
  const intel = await (await fetch(BASE + '/api/agent/intel?symbol=BTCUSDT')).json();
  if (!intel.oracle) fail('agent intel missing oracle data');
  console.log(`5/8 oracle ${oracle.feeds.length} feeds / chain height ${arch.chain.seq} (${r0.txid.slice(0, 14)}…) / intel ok`);

  // marketplace: buy a dataset with points
  const buyCode = await new Promise(resolve => {
    const cli = spawn(process.execPath, [path.join(root, 'client/lgai-node.js'),
      '-c', BASE, '--mock', '--buy', 'ds-BTCUSDT', '--name', 'smoke-node'], {
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    cli.on('exit', resolve);
  });
  if (buyCode !== 0) fail('marketplace purchase failed');
  const s2 = await stats();
  if (!(s2.market.volume > 0)) fail('market volume not updated');
  console.log(`6/8 marketplace volume ${s2.market.volume} pts`);

  // human feedback loop (PoI dual-channel)
  const reg = await (await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'smoke-human', role: 'human' }),
  })).json();
  const HH = { 'content-type': 'application/json', 'x-node-id': reg.nodeId, 'x-node-token': reg.token };
  const post = (body) => fetch(BASE + '/api/feedback', { method: 'POST', headers: HH, body: JSON.stringify(body) });
  const r1 = await post({ targetType: 'sentiment', targetId: 'BTCUSDT', value: 'LONG' });
  if (!(await r1.json()).ok) fail('sentiment feedback failed');
  const dup = await post({ targetType: 'sentiment', targetId: 'BTCUSDT', value: 'LONG' });
  if (dup.status !== 409) fail('sentiment dedupe failed (expected 409, got ' + dup.status + ')');
  const st = await stats();
  if (st.signals.length) {
    const r2 = await post({ targetType: 'signal', targetId: st.signals[0].id, value: 'up' });
    if (!(await r2.json()).ok) fail('signal rating failed');
  }
  const open = st.predictions.find(p => p.status === 'open' || p.status === 'verifying');
  if (open) {
    const r3 = await post({ targetType: 'prediction', targetId: open.id, value: 'LONG' });
    if (!(await r3.json()).ok) fail('prediction vote failed');
  }
  const s3 = await stats();
  if (!(s3.feedback || []).length) fail('feedback missing in stats');
  const hu = s3.nodes.find(n => n.name === 'smoke-human');
  if (!hu || hu.role !== 'human' || hu.points <= 0) fail('human participant not scored');
  if (!s3.sentiment || s3.sentiment.BTCUSDT.long < 1) fail('sentiment not aggregated');
  console.log(`7/8 human feedback loop ok · human points ${hu.points} / feedback ${s3.feedback.length} / BTC sentiment ${s3.sentiment.BTCUSDT.long}▲`);

  // LGAI push data drives predictions
  if (!(s3.lgai || []).length) fail('lgai push trend missing');
  const gb = s3.lgai.find(g => g.symbol === 'BTCUSDT');
  if (!gb || gb.dir !== 'LONG' || gb.upRatio < 0.7) fail('lgai bulldozer trend wrong: ' + JSON.stringify(gb));
  const lp = s3.predictions.find(p => (p.basis || '').startsWith('LGAI push'));
  if (!lp) fail('no prediction based on LGAI push data');
  if (lp.dir !== 'LONG') fail('LGAI-based prediction direction wrong');
  // marketplace LGAI weighting: premium pricing + exclusive push trend item
  const mkt = s3.market.listings;
  const dsB = mkt.find(l => l.id === 'ds-BTCUSDT');
  if (!dsB || dsB.lgaiWeight !== 1.5 || dsB.price !== 75) fail('dataset LGAI weight/pricing wrong: ' + JSON.stringify(dsB));
  const lgB = mkt.find(l => l.id === 'lgai-BTCUSDT');
  if (!lgB || lgB.lgaiWeight !== 2.0 || lgB.price !== 80) fail('LGAI exclusive listing missing/wrong');
  // full-market scan across all pushed projects
  const A = s3.lgaiAll;
  if (!A || A.total < 3) fail('full-market scan missing: ' + JSON.stringify(A));
  if (!A.topLong.some(g => g.token === 'BTC')) fail('full-market topLong missing BTC');
  if (A.long < 3) fail('full-market breadth wrong');
  if (!mkt.find(l => l.id === 'lgai-scan' && l.price === 120)) fail('lgai-scan listing missing');
  // trading universe: trending MAJORS join dynamically; non-major projects are excluded (for now)
  if (!s3.universe || !s3.universe.dynamic.includes('DOGEUSDT')) fail('dynamic universe missing major DOGEUSDT: ' + JSON.stringify(s3.universe));
  if (s3.universe.dynamic.includes('FOOUSDT')) fail('non-major FOOUSDT must be excluded from universe');
  const fp = s3.predictions.find(p => p.symbol === 'DOGEUSDT');
  if (!fp) fail('no prediction for dynamic major DOGEUSDT');
  if (!(fp.basis || '').startsWith('LGAI push')) fail('DOGEUSDT prediction basis wrong: ' + fp.basis);
  if (!s3.sentiment || !('DOGEUSDT' in s3.sentiment)) fail('human sentiment panel not synced to universe');
  const buyLgai = await new Promise(resolve => {
    const cli = spawn(process.execPath, [path.join(root, 'client/lgai-node.js'),
      '-c', BASE, '--mock', '--buy', 'lgai-BTCUSDT', '--name', 'smoke-node'], {
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    cli.on('exit', resolve);
  });
  if (buyLgai !== 0) fail('LGAI exclusive purchase failed');
  console.log(`8/8 LGAI push -> prediction ok · ${gb.symbol} ${gb.dir} ${Math.round(gb.upRatio * 100)}%↑ · basis "${lp.basis}" · market weight ×1.5/×2.0 ok`);
  console.log('\nSMOKE PASS ✓');
  process.exit(0);
} catch (e) {
  fail(e.message || e);
} finally {
  coord.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
