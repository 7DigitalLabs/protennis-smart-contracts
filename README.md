<p align="center">
  <img src="https://img.shields.io/badge/ProTennis-Backend_API-1565C0?style=for-the-badge&logo=express&logoColor=white" alt="ProTennis Backend API" />
</p>

<h1 align="center">ProTennis</h1>

<p align="center">
  <strong>Buy, sell & trade virtual shares of professional tennis players — on-chain.</strong>
</p>

<p align="center">
  <a href="https://github.com/7DigitalLabs/protennis-smart-contracts">
    <img src="https://img.shields.io/badge/Smart_Contracts-00C853?style=flat-square&logo=solidity&logoColor=white" alt="Smart Contracts" />
  </a>
  &nbsp;&nbsp;
  <a href="https://github.com/7DigitalLabs/protennis-backend">
    <img src="https://img.shields.io/badge/Backend_API-1565C0?style=flat-square&logo=express&logoColor=white" alt="Backend" />
  </a>
</p>

<br/>

<p align="center">
  <img src="https://img.shields.io/badge/Express-5.x-000000?style=flat-square&logo=express&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/MongoDB-Mongoose_8-47A248?style=flat-square&logo=mongodb&logoColor=white" />
  <img src="https://img.shields.io/badge/ethers.js-6.x-6332F6?style=flat-square&logo=ethereum&logoColor=white" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" />
</p>

---

## Repositories

| Repo | Stack | Descrizione |
|:-----|:------|:------------|
| [**protennis-smart-contracts**](https://github.com/7DigitalLabs/protennis-smart-contracts) | Solidity · Hardhat 3 · Viem | Contratti on-chain: pool con bonding curve, AMM, raffle rimborsabile, router DEX, engagement renewal |
| [**protennis-backend**](https://github.com/7DigitalLabs/protennis-backend) | Express 5 · TypeScript · MongoDB | API server: firma ordini EIP-712, gestione utenti, integrazione Odos, scheduling tornei, airdrop |

---

## Architecture Overview

```
                         ┌──────────────────────────────────────┐
                         │         protennis-backend            │
                         │                                      │
                         │  EIP-712 Order Signing                │
                         │  Odos / Yak API Integration           │
                         │  Merkle Tree Generation               │
                         │  MongoDB Player Registry              │
                         └──────────────────┬───────────────────┘
                                            │
                          signed orders      │      merkle roots
                          & calldata         ▼      & proofs
                ┌────────────────────────────────────────────────────┐
                │            protennis-smart-contracts               │
                │                                                    │
                │  ┌──────────────────┐   ┌────────────────────────┐ │
                │  │ OdosSharesRouter │   │   YakSharesRouter      │ │
                │  │ (any token →     │   │   (Avalanche, Arb,     │ │
                │  │  USDC → shares)  │   │    Optimism)           │ │
                │  └────────┬─────────┘   └───────────┬────────────┘ │
                │           │                         │              │
                │           └────────────┬────────────┘              │
                │                        ▼                           │
                │  ┌─────────────────────────────────────────────┐   │
                │  │            PlayerSharePool                  │   │
                │  │                                             │   │
                │  │  Phase 1 ─ Seeding    (fixed-price bins)    │   │
                │  │  Phase 2 ─ OpenMarket (x·y=k AMM)          │   │
                │  │  Phase 3 ─ Raffle     (ticket sale)         │   │
                │  └─────────────────────────────────────────────┘   │
                │                                                    │
                │  ┌─────────────────────┐  ┌──────────────────────┐ │
                │  │ RefundableRaffle     │  │ EngagementRenew      │ │
                │  │ Merkle-verified      │  │ Player renewals      │ │
                │  │ refunds for losers   │  │ via USDC payments    │ │
                │  └─────────────────────┘  └──────────────────────┘ │
                │                                                    │
                │                  ┌──────────┐                      │
                │                  │ Treasury  │                      │
                │                  │ USDC +    │                      │
                │                  │ shares    │                      │
                │                  └──────────┘                      │
                └────────────────────────────────────────────────────┘
```

---

## API Modules

### Core

| Module | Description |
|:-------|:------------|
| **player** | Player registry with CRUD operations, market data aggregation, price snapshots, match sync from StatsPerform, and blockchain event listeners for pool state changes. |
| **trading** | Portfolio management, top gainers/losers, trending players, market history, and global market snapshots. |
| **market** | Prepares EIP-712 signed buy/sell orders for execution through Privy smart wallets against on-chain pools. |
| **tournament** | Weekly tournament engine: edition management, lineup submission, ATP competition sync, match scoring via StatsPerform, salary allocation, and prize distribution across configurable brackets. |
| **engagement** | Player engagement contracts: renewal estimation, EIP-712 order preparation, lineup consumption tracking, and on-chain event listening for `EngagementRenewed`. |
| **pack** | Pack economy: tiered pricing, pack opening with player selection, pending share settlement, liquidation, and activation bonus flow. |

### Growth & Rewards

| Module | Description |
|:-------|:------------|
| **airdrop** | Points system across four categories (trading, holding, tournament, pack) with configurable weights and a global leaderboard. |
| **referral** | Referral program with code registration, team value tracking, milestone rewards, and badge progression. |
| **ambassador** | Ambassador tier built on referrals: squad management and grant distribution. |
| **raffle** | Raffle ticket deposits via EIP-712 signed orders, crate management, and on-chain event integration with `RefundableRaffle`. |

### Infrastructure

| Module | Description |
|:-------|:------------|
| **privy** | User authentication via Privy (session tokens, embedded wallets), USDC deposit/withdrawal listener, and transaction backfill. |
| **arena** | Alternative auth flow: nonce-based wallet signature verification with dedicated JWT sessions. |
| **odosSwap** | Multi-token share purchases routed through the [Odos V3](https://docs.odos.xyz/) SOR API, with signed orders for `OdosSharesRouter`. |
| **seeding** | Initial share distribution: prepares EIP-712 signed seeding orders with configurable expiry and confirmation thresholds. |
| **buyback** | Automated USDC buyback engine with dynamic budget planning, TWAP execution strategy, and configurable scheduling. |
| **notification** | Push notification system with admin broadcast, per-user delivery tracking, and read-status management. |
| **dashboard** | Admin dashboard: platform statistics, user management, and JWT-based admin authentication with role checks. |
| **metrics** | Platform analytics: engagement fee tracking and player signal aggregation (popularity, match scores). |
| **meta** | API bootstrap endpoint and `/llms.txt` documentation generator for LLM consumption. |

---

## Middleware

| Middleware | Description |
|:-----------|:------------|
| **requirePrivySession** | Validates Privy session tokens on protected routes. |
| **requireArenaSession** | Validates Arena JWT tokens for wallet-authenticated users. |
| **requirePrivyOrArenaSession** | Accepts either Privy or Arena auth, enabling dual auth support. |
| **requireAdmin** | Guards admin-only endpoints via `x-admin-token` header or dashboard cookie. |
| **requireDashboardAuth** | JWT-based admin authentication with role verification for the dashboard. |
| **sanitizeRequest** | Strips MongoDB operators from request body/params to prevent NoSQL injection. |
| **errorHandler** | Centralized error handler with structured JSON responses and stack traces in development. |

---

## Key Design Decisions

- **EIP-712 signed orders** — Every buy, sell, seeding, engagement, raffle, and swap operation requires a backend-signed EIP-712 order, enabling off-chain validation and rate limiting before on-chain execution.
- **Primary-instance scheduling** — Blockchain listeners and cron jobs run only on PM2 instance 0 to prevent duplicate processing in cluster mode.
- **Dual auth system** — Supports both Privy (embedded wallets) and Arena (wallet-signature nonce) authentication, unified through composable middleware.
- **Modular domain architecture** — Each business domain is self-contained with its own controller, service, and Mongoose models, enabling independent development and testing.
- **Configurable economy** — Pack tiers, tournament brackets, buyback weights, airdrop categories, and engagement parameters are all driven by environment config, not hardcoded.

---

## Getting Started

### Prerequisites

- Node.js >= 20
- pnpm
- MongoDB (local or Atlas)

### Install

```bash
pnpm install
```

### Configure

```bash
cp .env.example .env
# Fill in MongoDB URI, Privy credentials, blockchain RPC, and contract addresses
```

### Dev

```bash
pnpm dev
```

### Test

```bash
pnpm test
```

---

## Deployment

The application runs with PM2 in cluster mode:

```bash
# Start with PM2
pm2 start ecosystem.config.cjs

# Or via pnpm script
pnpm start
```

See `ecosystem.config.cjs` for cluster and environment configuration.

---

## Background Services

Only the primary PM2 instance runs these:

| Service | Description |
|:--------|:------------|
| **Blockchain Listeners** | Pool events, USDC deposits, engagement renewals, raffle events |
| **Tournament Scheduler** | Manages tournament lifecycle (open → lock → score → distribute) |
| **Price Snapshots** | Captures player share prices every 10 minutes |
| **Match Sync** | Syncs player matches from StatsPerform (every 6h, live every 30s) |
| **Buyback Executor** | Runs TWAP buyback orders on a configurable tick interval |
| **Order Cleanup** | Expires stale seeding, raffle, activation, engagement, and market orders |
| **Reward Evaluation** | Periodic referral and ambassador reward calculation |

---

## Project Structure

```
src/
  abi/              Contract ABIs (PlayerSharePool, OdosSharesRouter, ...)
  middleware/        Auth, admin, sanitize, error handling
  modules/
    player/          Player registry, market data, blockchain listeners
    trading/         Portfolio, market snapshots, trending
    market/          Buy/sell order signing
    tournament/      Weekly tournaments, scoring, prizes
    engagement/      Player engagement contracts
    pack/            Pack economy, opening, liquidation
    airdrop/         Points system, leaderboard
    referral/        Referral program, badges
    ambassador/      Ambassador management
    raffle/          Raffle orders, crates
    privy/           User auth, USDC deposits
    arena/           Wallet-signature auth
    odosSwap/        Multi-token swap routing
    seeding/         Initial share distribution
    buyback/         Automated buyback engine
    notification/    Push notifications
    dashboard/       Admin panel API
    metrics/         Platform analytics
    meta/            API docs, LLM bootstrap
  routes/            Express route definitions
  types/             TypeScript type definitions
  utils/             Shared utilities (blockchain, errors, multicall)
  app.ts             Express app setup
  server.ts          Server bootstrap, listeners, cron jobs
  config.ts          Centralized configuration
scripts/             Migration, backfill, and admin utilities
tests/               Jest integration and unit tests
```

---

## License

MIT

---

<p align="center">
  <sub>Built by <a href="https://github.com/7DigitalLabs">7 Digital Labs</a></sub>
</p>
