# ProTennis Smart Contracts

On-chain infrastructure for ProTennis -- a platform where users can buy, sell, and trade virtual shares of professional tennis players using USDC.

Built with [Hardhat 3](https://hardhat.org/), Solidity 0.8.28, and [OpenZeppelin Contracts v5](https://docs.openzeppelin.com/contracts/5.x/).

## Architecture

### Core Contracts

| Contract | Description |
|---|---|
| **PlayerSharePool** | Per-player bonding curve pool with three lifecycle phases: **Seeding** (fixed-price bins), **OpenMarket** (constant-product AMM), and **Raffle** (off-chain ticket sale). Manages virtual shares (not ERC-20), USDC reserves, and a tiered sell-fee mechanism that reacts to price drops. |
| **RefundableRaffle** | Deposit USDC to receive tickets. 50,000 winning tickets are drawn off-chain and committed on-chain via Merkle root. Losers claim full refunds through Merkle proofs. |
| **EngagementRenew** | Handles player engagement renewals via USDC payments. Orders are signed off-chain (EIP-712) and executed on-chain. |
| **OdosSharesRouter** | Lets users buy PlayerSharePool shares with any token (ETH, WETH, stablecoins) by routing through [Odos V3](https://docs.odos.xyz/) for the swap, then transferring shares from the treasury. |
| **YakSharesRouter** | Same concept as OdosSharesRouter but uses [Yield Yak Aggregator](https://yieldyak.com/) for chains where Yak has better liquidity (Avalanche, Arbitrum, Optimism). |

### Libraries

| Library | Description |
|---|---|
| **MathUtils** | 512-bit `mulDiv` with configurable rounding (floor/ceil), used throughout for safe fixed-point arithmetic. |

### Key Design Decisions

- **Virtual shares** -- Balances are tracked in contract storage, not as ERC-20 tokens. This simplifies the bonding curve logic and avoids transfer-related attack vectors.
- **EIP-712 signed orders** -- All user-facing operations (seeding purchases, market trades, raffle deposits, engagement renewals) require a backend-signed order. This enables off-chain validation, rate limiting, and KYC checks before on-chain execution.
- **Tiered sell fees** -- Sell fees automatically increase when the price drops significantly from the reference price, discouraging panic selling. Fees decay back to baseline after a time window expires.
- **Constant-product AMM** -- After seeding completes, the pool operates as a standard `x * y = k` AMM with USDC and virtual shares as the two reserves.

## Setup

### Prerequisites

- Node.js >= 20
- Yarn 4 (corepack)

### Install

```bash
corepack enable
yarn install
```

### Configure

```bash
cp .env.example .env
# Fill in your private keys, RPC URLs, and contract addresses
```

### Compile

```bash
yarn compile
```

### Test

```bash
npx hardhat test
```

## Deployment

Each contract has its own deployment script under `scripts/`. Examples:

```bash
# Deploy a single PlayerSharePool
npx hardhat run scripts/deployPlayerSharePool.ts --network avalanche

# Batch deploy pools for all players in MongoDB
npx hardhat run scripts/deployAllPlayerPoolsProd.ts --network avalanche

# Deploy the Odos shares router
npx hardhat run scripts/deployOdosSharesRouter.ts --network avalanche

# Deploy the refundable raffle
npx hardhat run scripts/deployRefundableRaffle.ts --network sepolia
```

See the header comments in each script for required environment variables.

## Project Structure

```
contracts/
  broker/         OdosSharesRouter, YakSharesRouter
  engagement/     EngagementRenew
  interfaces/     Contract interfaces
  libraries/      MathUtils
  mocks/          MockUSDC (for testing)
  pool/           PlayerSharePool
  raffle/         RefundableRaffle
scripts/          Deployment and management scripts
test/             TypeScript integration tests
```

## License

MIT
