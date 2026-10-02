# ChainScope Alpha API

Standalone Express + SQLite backend for an experimental Alpha cockpit.

> **Portfolio context:** This is an **early standalone ChainScope experiment**, not the canonical ChainScope research architecture. It is retained because it demonstrates API design, token discovery, configurable filtering, alert flows, simulation, and execution-safety controls.

## What it demonstrates

- Express/TypeScript API design
- SQLite-backed application state
- Fresh-token discovery
- Configurable candidate filtering
- Alert/signal queues
- Telegram integration
- Simulation-oriented trading workflows
- Explicit execution safety defaults
- Render deployment configuration

## Architecture

```
Alpha cockpit
     ↓
Alpha API
     ↓
Token discovery
     ↓
Configurable filter
     ↓
Alerts / signal queues
     ↓
Simulation or controlled execution
```

This service is deliberately independent from the ChainScope research database, investigation corpus, and research workers.

## Execution safety

Real trading is **disabled by default**.

| Setting | Default |
|---|---|
| `execution_mode` | `OFF` |
| `auto_trading_enabled` | `false` |
| `live_trading_enabled` | `false` |

Any future live-execution work should remain explicit, separately configured, and independently verified.

## Local development

### Requirements

- Node.js 20+
- pnpm 9+

### Install

```bash
pnpm install
```

### Environment

```bash
cp .env.example .env
```

At minimum, production requires `SESSION_SECRET`.

### Run

```bash
pnpm dev
```

The API starts on `http://localhost:3001`.

## Production build

```bash
pnpm build
pnpm start
```

## Key API areas

- Candidate/token feed
- Token metadata
- Flow configuration
- Trader configuration
- Signal queues
- Elite-filter profiles
- Synthetic test-alert injection

## Relationship to ChainScope

The broader ChainScope direction is an evidence-first blockchain behavior research platform:

**collect evidence → measure behavior → compare observations → discover recurring patterns**

This repository is one historical/experimental implementation path and should not be treated as the canonical ChainScope architecture.

## Status

**Experimental / standalone research and engineering component.**

For the current ChainScope research direction, use the dedicated ChainScope repositories.

## Author

**Mohammed Musbahu Abdullahi**
