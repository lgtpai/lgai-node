# LGAI Node — Cross-platform Node Client (Phase 02: AI Agent Network)

**English** | [中文](README.zh-CN.md)

Node client + lightweight coordinator for the LGAI Trusted Intelligence Network.
**Zero dependencies** — any device with Node.js ≥ 18 (Raspberry Pi / Mac mini / PC / server / cloud) runs it directly, no `npm install` required.

## Install (packaged)

**macOS / Linux / Raspberry Pi** — one line:
```bash
curl -fsSL https://raw.githubusercontent.com/lgtpai/lgai-node/main/packaging/get.sh | bash -s -- --coordinator http://<server>:18402 --service
```
Or download `lgai-node-<v>-macos-linux.tar.gz` from [Releases](https://github.com/lgtpai/lgai-node/releases), extract and run `./install.sh [--coordinator URL] [--name NAME] [--service]`.
`--service` auto-starts on login (launchd on macOS, systemd on Linux). Uninstall: `./uninstall.sh`.

**Windows 10/11** — download `lgai-node-<v>-windows.zip`, extract, then:
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Coordinator http://<server>:18402 -Service
```
Installs to `%LOCALAPPDATA%\LGAI\node`, adds `lgai-node` / `lgai-coordinator` to PATH; `-Service` registers a logon Scheduled Task. Uninstall: `uninstall.ps1`.

Build packages yourself: `packaging/build.sh` → `dist/`.

## Quick Start

```bash
# 1. Start the coordinator (deploy on your server, default port 18402)
node coordinator/server.js
# Dashboard: http://localhost:18402

# 2. Start a node on any device
node client/lgai-node.js --coordinator http://<server>:18402 --name my-pi

# Offline test (mock market data source)
node client/lgai-node.js --mock

# Self-check (coordinator + mock node, full closed loop)
npm run smoke
```

## Node Roles

| Task Type | Role | What it does | Points |
|---|---|---|---|
| `market_data` | Data Compute | Fetch public OHLCV (Binance → OKX fallback); multi-node cross consensus — deviating >0.5% from the median is a strike | 5 |
| `ai_infer` | AI Inference | **Three base models** (price-volume proxies): 🚜 Bulldozer Trend (≥70% one-directional closes set the direction + structural anchor), 🧲 Whale Accumulation (low zone + rising volume + closes near candle highs + higher lows), 📉 Whale Distribution (high zone + heavy volume on down candles + closes near lows + lower highs) — extended with momentum / RSI / volatility into a composite score [-1, 1] + regime label | 8 |
| `signal_verify` | Signal Verification | Independently verify matured network predictions; only majority-consistent verdicts earn points | 10 |
| — | Intelligence Contribution | Every valid contribution is written to the ledger (Contribution Proof prototype) | — |

## The Closed Loop

```
Nodes collect data → Coordinator consensus pricing → Network predictions (model-driven, 15min horizon)
     → Verification tasks on expiry → Multi-node vote WIN/LOSS → Accuracy stats + points issued
```

## Five Protocol Dimensions

| Dimension | Implementation |
|---|---|
| 🗄 Decentralized Storage | Price feeds / signals / prediction verdicts / market sales all written to a **SHA-256 hash chain** (`prevHash`-linked, tamper-evident, mock `ar://` txids); Arweave settlement adapter reserved |
| 🔮 Decentralized Oracle | Independent multi-node collection → median consensus → >0.5% deviation slashed; `GET /api/oracle/price?symbol=X` serves feeds with contributor count / max deviation / archive proof |
| 🤝 AI Agent Network | `ai_infer` fanned out to multiple nodes → **ensemble inference** (median score, majority regime); `GET /api/agent/intel?symbol=X` gives any external agent full intelligence in one call |
| 🛒 AI Data Marketplace | Consensus datasets / AI signal feeds listed for point-settled trading with on-chain sale proofs; `--market` to browse, `--buy <id>` to purchase |
| 💎 Contribution Incentives | Reputation tiers: Bronze ×1.0 / Silver ×1.2 (≥100 pts, strike rate <15%) / Gold ×1.5 (≥300 pts, strike rate <5%) — rewards by contribution quality, not hashpower |

## Coordinator Configuration (env vars)

| Variable | Default | Description |
|---|---|---|
| `PORT` | 18402 | Listen port |
| `SYMBOLS` | BTCUSDT,ETHUSDT,SOLUSDT | Task symbols |
| `TICK_MS` | 45000 | Task generation interval |
| `HORIZON_MIN` | 15 | Prediction verification horizon (minutes) |
| `DATA_DIR` | coordinator/data | State persistence dir (gitignored) |

## Protocol (HTTP JSON)

Node endpoints (auth via `x-node-id` + `x-node-token` headers):
- `POST /api/register` → `{nodeId, token}` (credentials stored in `~/.lgai/`)
- `POST /api/heartbeat` — 30s heartbeat with load/memory metrics
- `GET  /api/tasks` — claim tasks (5min lease, re-dispatched on timeout)
- `POST /api/result` — submit results; consensus finalizes once redundancy is met
- `POST /api/market/buy` — marketplace purchase (point-settled)

Public endpoints (oracle / archive / agent collaboration / marketplace):
- `GET /api/oracle` · `GET /api/oracle/price?symbol=X` — consensus price feeds
- `GET /api/archive` — hash-chain archive (chain height + latest 50 records)
- `GET /api/agent/intel?symbol=X` — feed + latest ensemble signal + predictions + network accuracy
- `GET /api/market/listings` — marketplace listings and sales
- `GET /api/stats` — dashboard data (no sensitive fields)

## Beyond the MVP

- Single-binary packaging (`node --experimental-sea` or pkg), systemd/launchd install scripts
- Result signing (node private keys) → contribution proofs settled to Arweave
- Task-level stake/slash replacing simple strike counting
- Multi-instance coordinator + sqlite persistence (current JSON files suit ≤ a few hundred nodes)
- Ingesting proprietary prediction feeds to replace self-generated momentum predictions (Phase 03)
