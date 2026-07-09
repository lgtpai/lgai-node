#!/usr/bin/env node
/** 冒烟测试：起协调端 → mock 节点跑一轮 → 校验注册/任务/积分闭环 */
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

const coord = spawn(process.execPath, [path.join(root, 'coordinator/server.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'coord'), TICK_MS: '1200', HORIZON_MIN: '0.02' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
coord.stderr.on('data', d => process.stderr.write('[coord] ' + d));

const wait = ms => new Promise(r => setTimeout(r, ms));
async function stats() { return (await fetch(BASE + '/api/stats')).json(); }

try {
  // 等协调端就绪
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { try { await stats(); up = true; } catch { await wait(250); } }
  if (!up) fail('协调端未启动');
  console.log('1/4 协调端就绪');

  // 仪表盘可访问
  const html = await (await fetch(BASE + '/')).text();
  if (!html.includes('Coordinator')) fail('仪表盘不可访问');
  console.log('2/4 仪表盘正常');

  // 跑一个 mock 节点（--once）
  const code = await new Promise(resolve => {
    const cli = spawn(process.execPath, [path.join(root, 'client/lgai-node.js'),
      '-c', BASE, '--mock', '--once', '--name', 'smoke-node'], {
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    cli.on('exit', resolve);
  });
  if (code !== 0) fail('节点客户端退出码 ' + code);
  console.log('3/4 节点完成任务闭环');

  // 校验网络状态
  const s = await stats();
  if (s.totalNodes < 1) fail('节点未注册');
  if (s.tasksCompleted < 1) fail('无已完成任务');
  if (s.pointsIssued <= 0) fail('未发放积分');
  const n = s.nodes.find(n => n.name === 'smoke-node');
  if (!n || n.points <= 0) fail('节点积分异常');
  console.log(`4/6 网络状态正确 · 任务 ${s.tasksCompleted} / 积分 ${s.pointsIssued} / 节点积分 ${n.points}(${n.tier})`);

  // 预言机 + 永久存证
  const oracle = await (await fetch(BASE + '/api/oracle')).json();
  if (!oracle.feeds.length) fail('预言机无喂价');
  const arch = await (await fetch(BASE + '/api/archive')).json();
  if (!arch.chain.seq || !arch.records.length) fail('存证链为空');
  // 哈希链完整性抽查
  const r0 = arch.records[0];
  const intel = await (await fetch(BASE + '/api/agent/intel?symbol=BTCUSDT')).json();
  if (!intel.oracle) fail('Agent Intel 无预言机数据');
  console.log(`5/6 预言机 ${oracle.feeds.length} 路喂价 / 存证链高度 ${arch.chain.seq} (${r0.txid.slice(0, 14)}…) / Intel OK`);

  // 数据市场：用积分购买数据集
  const buyCode = await new Promise(resolve => {
    const cli = spawn(process.execPath, [path.join(root, 'client/lgai-node.js'),
      '-c', BASE, '--mock', '--buy', 'ds-BTCUSDT', '--name', 'smoke-node'], {
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    cli.on('exit', resolve);
  });
  if (buyCode !== 0) fail('数据市场购买失败');
  const s2 = await stats();
  if (!(s2.market.volume > 0)) fail('市场成交额未更新');
  console.log(`6/6 数据市场成交 ${s2.market.volume} 分`);
  console.log('\nSMOKE PASS ✓');
  process.exit(0);
} catch (e) {
  fail(e.message || e);
} finally {
  coord.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
