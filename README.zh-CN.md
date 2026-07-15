# LGAI Node — 跨平台节点程序（Phase 02: AI Agent Network）

[English](README.md) | **中文**

猎狗AI (LGAI) 可信智能网络的节点客户端 + 轻量协调端。
**零依赖**，任何装有 Node.js ≥ 18 的设备（树莓派 / Mac mini / PC / 服务器 / 云主机）直接运行，无需 `npm install`。

## 安装（安装包方式）

**macOS / Linux / 树莓派** — 一行命令：
```bash
curl -fsSL https://raw.githubusercontent.com/lgtpai/lgai-node/main/packaging/get.sh | bash -s -- --coordinator http://<服务器>:18402 --service
```
或从 [Releases](https://github.com/lgtpai/lgai-node/releases) 下载 `lgai-node-<版本>-macos-linux.tar.gz`，解压后运行 `./install.sh [--coordinator URL] [--name 名称] [--service]`。
`--service` 开机自启（macOS 用 launchd，Linux 用 systemd）。卸载：`./uninstall.sh`。

**Windows 10/11** — 下载 `lgai-node-<版本>-windows.zip`，解压后：
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Coordinator http://<服务器>:18402 -Service
```
安装到 `%LOCALAPPDATA%\LGAI\node`，`lgai-node` / `lgai-coordinator` 加入 PATH；`-Service` 注册登录自启计划任务。卸载：`uninstall.ps1`。

自行打包：`packaging/build.sh` → 生成 `dist/`。

## 快速开始

```bash
# 1. 启动协调端（部署在你的服务器上，默认端口 18402）
node coordinator/server.js
# 仪表盘: http://localhost:18402

# 2. 任意设备启动节点
node client/lgai-node.js --coordinator http://<服务器>:18402 --name my-pi

# 离线测试（模拟行情数据源）
node client/lgai-node.js --mock

# 自检（协调端 + mock 节点全闭环）
npm run smoke
```

## 节点职能

| 任务类型 | 角色 | 内容 | 积分 |
|---|---|---|---|
| `market_data` | 数据计算 | 拉取公开 OHLCV（Binance→OKX 自动降级），多节点交叉共识（偏离中位数 >0.5% 记违规） | 5 |
| `ai_infer` | AI 推理 | **三大基础模型**（价量代理）：🚜推土机趋势（近窗单边占比≥70% 定方向 + 结构锚）、🧲庄家吸筹（低位放量+收盘贴上沿+低点抬高）、📉庄家出货（高位下跌K放量+收盘贴下沿+高点下移），扩展动量/RSI/波动率 → 综合评分 [-1,1] + 形态标签 | 8 |
| `signal_verify` | 信号验证 | 独立复核网络预测到期后的实际结果，多数一致才计分 | 10 |
| — | 智能贡献 | 所有有效贡献记入账本（Contribution Proof 雏形） | — |

## 闭环流程

```
节点采集行情 → 协调端共识定价 → 生成网络预测(模型驱动, 15min 时限)
     → 到期派发验证任务 → 多节点投票裁定 WIN/LOSS → 胜率统计 + 积分发放
     → 按依据源累计信任账本(LGAI推送 / AI集成 / 人类情绪 / SMA)
     → 新预测携带由实测胜率算出的置信度
```

**PoI 信任闭环** —— 人类反馈真正影响预测，可信度靠实测挣得而非口头宣称：
每条预测记录依据源与置信度；每次裁定结果回灌到该源的公开胜率账本、每位人类验证者的判对率
（进而以 0.5×–1.5× 加权其后续情绪投票）、以及异议记分板（加权人类共识 ≥70% 反对时，弱依据
SMA 预测直接否决不开，强依据预测打 `disputed` 标记并事后记分验证人类是否救场）。

## 五大协议维度

| 维度 | 实现 |
|---|---|
| 🗄 去中心化存储 | 喂价/信号/预测裁定/市场成交全部写入 **SHA-256 哈希链存证**（`prevHash` 链式防篡改，mock `ar://` txid），Arweave 上链适配预留 |
| 🔮 去中心化预言机 | 多节点独立采集 → 中位数共识 → 偏离 >0.5% 记违规；`GET /api/oracle/price?symbol=X` 对外喂价（含贡献节点数/最大偏差/存证证明） |
| 🤝 AI Agent 网络 | `ai_infer` 冗余派发至多节点 → **集成推理**（评分取中位数、形态取多数）；`GET /api/agent/intel?symbol=X` 供外部智能体一键拉取全维度情报 |
| 🛒 AI 数据市场 | 共识行情数据集 / AI 信号流上架流通，积分结算，成交上链存证；`--market` 看货、`--buy <id>` 购买。**LGAI 权重**：有独家推送趋势背书的商品按 ×1.5 溢价定价；独家商品 `lgai-<SYM>` 推送趋势流（趋势快照 + 原始近期推送）为 ×2.0 顶级权重 |
| 💎 智能贡献激励 | 声誉分级：铜 ×1.0 / 银 ×1.2（≥100 分且违规率<15%）/ 金 ×1.5（≥300 分且违规率<5%），以贡献质量而非算力定酬 |
| 🧑‍🤝‍🧑 人类反馈（PoI 人机双通道） | 仪表盘一键以人类验证者身份加入（`role: human`）：评价 AI 信号（👍/👎，净差评的信号失去作为预测依据的资格）、对未决预测投票（**事后按实际行情裁定，投对才发验证奖励**，每次裁定更新你的公开判对率）、提交市场情绪（**按验证者历史判对率加权**，加权共识 ≥70% 时融合进预测依据；强烈反对可直接否决弱依据 SMA 预测，强依据预测打"人类异议"标记）。所有反馈计入账本与声誉、上链存证。CLI：`--vote BTCUSDT=LONG` |
| 🎯 可信预测（PoI 信任闭环） | 每条预测携带依据源（`lgai_push` / `ai` / `human` / `sma`）与**置信度**——由该源经拉普拉斯平滑的实测胜率算出（± AI 确认 / 人类共识 / 人类异议修正）。裁定结果持续累计各源信任账本（`/api/stats` 与 `/api/agent/intel` 的 `srcTrust`）、全网人类判对率、异议记分板（判对/误判）——全部公开并上链存证 |

## 协调端配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 18402 | 监听端口 |
| `SYMBOLS` | BTCUSDT,ETHUSDT,SOLUSDT | 任务币种 |
| `TICK_MS` | 45000 | 任务生成周期 |
| `HORIZON_MIN` | 15 | 预测验证时限（分钟） |
| `LEASE_MS` | 300000 | 任务租约（毫秒），超时未交重新派发 |
| `DATA_DIR` | coordinator/data | 状态持久化目录（已 gitignore） |
| `LEADER_AUTO` | 1 | 龙头自动判断开关（0=仅白名单）；`LEADER_TOP_N` 赛道内 top-N 判龙头（默认 3） |
| `LGAI_DB` | 自动探测 | 猎狗推送数据库路径（sqlite，`newcoins` 表）。连接后（只读，需 Node ≥ 22），推送价推土机趋势成为**预测最高优先级依据**（LGAI 推送 > AI 集成 > 人类情绪 > SMA），并对**全库所有推送项目**（约 900 个）做推土机扫描：市场宽度 + 强趋势榜，每 5 分钟刷新（`lgai-scan` 商品）。**交易范围自动扩展到有趋势的龙头项目**——龙头**自动判断**：CoinGecko 赛道内市值 top-`LEADER_TOP_N`(默认3) 且全市值排名前 50（`LEADER_MAX_RANK`） 且 机器人 7 天推送 ≥3 次，**同赛道多个候选只优选一个**（推送频率优先、赛道排名次之）；白名单 `LGAI_MAJORS`（默认对齐 lgai_regime.MAJORS 十四主流币）保留为兜底/手工补充（CG 不可达或 `LEADER_AUTO=0` 时仅用白名单），上限 `MAX_DYN_SYMBOLS`：采集/预测/验证任务与人类情绪投票面板全部跟随交易域；推送直发预测由推送价自裁定，反复失败币种自动熔断 |

## 协议（HTTP JSON）

节点接口（鉴权 `x-node-id` + `x-node-token`）：
- `POST /api/register` → `{nodeId, token}`（凭据保存在 `~/.lgai/`）
- `POST /api/heartbeat` — 30s 心跳，带负载/内存指标
- `GET  /api/tasks` — 领取任务（租约 5min，超时重新派发）
- `POST /api/result` — 提交结果，凑齐冗余份数后共识裁定
- `POST /api/market/buy` — 数据市场购买（积分结算）
- `POST /api/feedback` — 人类反馈：`{targetType: signal|prediction|sentiment, targetId, value}`（去重 + 每小时 30 次限流）

公开接口（预言机/存证/Agent 协作/市场）：
- `GET /api/oracle` · `GET /api/oracle/price?symbol=X` — 共识喂价
- `GET /api/archive` — 哈希链存证（链高 + 最近 50 条）
- `GET /api/agent/intel?symbol=X` — 喂价 + 最新集成信号 + 预测（含置信度）+ 各源信任度 + 网络胜率
- `GET /api/market/listings` — 市场商品与成交
- `GET /api/stats` — 仪表盘数据（无敏感字段）

## MVP 之外的路线

- 单二进制打包（`node --experimental-sea` 或 pkg），systemd/launchd 安装脚本
- 结果签名（节点私钥）→ 贡献证明上链（Arweave）
- 任务级 stake/slash，替代简单 strike 计数
- 协调端多实例 + sqlite 持久化（当前 JSON 文件适用于 ≤几百节点）
- 接入专有预测信号源，替代自产动量预测（Phase 03）
