# Alpha API

Standalone Express + SQLite trading backend for the Alpha cockpit.

**Fully independent** — no dependency on the ChainScope research database,
investigation corpus, or research workers.

## Architecture

```
Alpha cockpit (chainscope-alpha/)
        ↓
Alpha API (this service)
        ↓
DexScreener fresh-token discovery (3-min poller)
        ↓
Elite filter (configurable profile + gold dataset)
        ↓
Telegram alerts
        ↓
Simulation engine / live execution
```

## Execution safety defaults

| Setting | Default |
|---|---|
| `execution_mode` | `OFF` |
| `auto_trading_enabled` | `false` |
| `live_trading_enabled` | `false` (all flows) |

**Real trading is disabled by default and requires explicit database configuration.**

---

## Local development

### Prerequisites

- Node.js 20+
- pnpm 9+

### Install

```bash
pnpm install
```

### Environment

Copy `.env.example` to `.env` and set at minimum `SESSION_SECRET`:

```bash
cp .env.example .env
```

### Start (dev, hot-reload)

```bash
pnpm dev
```

The API starts on `http://localhost:3001`.

---

## Production build

```bash
pnpm build     # compiles TypeScript → dist/
pnpm start     # runs dist/index.mjs
```

Or with `node` directly:

```bash
node build.mjs
node --enable-source-maps dist/index.mjs
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3001` | HTTP port |
| `SESSION_SECRET` | **Yes (prod)** | dev fallback | AES-256-GCM key for wallet encryption |
| `DATA_ROOT` | No | `<cwd>/data` | Directory for `alpha.db` |
| `ALLOWED_ORIGIN` | No | `*` | CORS allowed origin |
| `NODE_ENV` | No | `development` | `production` enables JSON logging |
| `LOG_LEVEL` | No | `info` | Pino log level |

---

## Render deployment

1. Create a new **Web Service** pointing at this directory (or a Git repo containing it).
2. **Build command:** `pnpm install && pnpm build`
3. **Start command:** `pnpm start`
4. Add a **Persistent Disk** mounted at `/var/data` (stores `alpha.db`).
5. Set environment variables:
   - `SESSION_SECRET` — a long random string
   - `DATA_ROOT` — `/var/data`
   - `NODE_ENV` — `production`

---

## Key endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Health check |
| `GET` | `/api/alpha/feed` | DexScreener candidates |
| `GET` | `/api/tokens/:address` | Token metadata from candidate pool |
| `GET` | `/api/settings/flows` | Alert flow configuration |
| `PUT` | `/api/settings/flows/:id` | Update a flow |
| `GET` | `/api/trader/config` | Trader configuration |
| `GET` | `/api/trader/buy-settings` | Per-tier buy amounts |
| `GET` | `/api/trader/elite` | ELITE signal queue |
| `GET` | `/api/trader/pro` | PRO signal queue |
| `GET` | `/api/trader/watch` | WATCH signal queue |
| `GET` | `/api/trader/ignition` | IGNITION signal queue |
| `GET` | `/api/trader/watch-for-upgrade` | Watch-for-upgrade queue |
| `GET` | `/api/elite-filter/profiles` | Elite filter profiles |
| `POST` | `/api/trader/alert/inject-test` | Inject synthetic test alert |
