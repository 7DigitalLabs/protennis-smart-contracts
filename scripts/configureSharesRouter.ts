import "dotenv/config";
import { network } from "hardhat";
import mongoose, { Schema, Document, Model } from "mongoose";

// Usage:
//   yarn hardhat run scripts/configureSharesRouter.ts --network base
//   yarn hardhat run scripts/configureSharesRouter.ts --network avalanche
//   yarn hardhat run scripts/configureSharesRouter.ts --network arbitrum
//
// Required environment variables:
//   ROUTER_ADDRESS          - Address of OdosSharesRouter or YakSharesRouter
//   MONGODB_URI             - MongoDB connection URI (pools are read from DB)
//
// Optional:
//   ROUTER_TYPE             - "odos" or "yak" (default: odos)
//   SUPPORTED_TOKENS        - Comma-separated list of tokens to enable
//                             Default: native + wrapped (e.g. ETH + WETH, AVAX + WAVAX)
//                             Note: YakRouter does not support native tokens, only wrapped
//   WETH_ADDRESS            - Override for wrapped native token (WETH/WAVAX)
//
// Supported chains:
//   - Ethereum (1), Optimism (10), Polygon (137), Base (8453)
//   - Arbitrum (42161), Avalanche (43114)
//   - Testnets: Base Sepolia (84532), Avalanche Fuji (43113)

// --- Mongoose Schema for Player ---
interface IPlayer extends Document {
    playerId: string;
    name: string;
    contractAddress: string;
}

const PlayerSchema = new Schema<IPlayer>(
    {
        playerId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        contractAddress: { type: String, default: "" },
    },
    { collection: "players" }
);

const Player: Model<IPlayer> = mongoose.models.Player || mongoose.model<IPlayer>("Player", PlayerSchema);

// --- Env Vars ---
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS as `0x${string}` | undefined;
const ROUTER_TYPE = process.env.ROUTER_TYPE ?? "odos"; // "odos" or "yak"
const MONGODB_URI = process.env.PROD_MONGODB_URI as string | undefined;
const SUPPORTED_TOKENS = process.env.SUPPORTED_TOKENS as string | undefined;
const WETH_ADDRESS = process.env.WETH_ADDRESS as `0x${string}` | undefined;

// Wrapped native token addresses per chain (WETH, WAVAX, etc.)
const WRAPPED_NATIVE_ADDRESSES: Record<number, { address: `0x${string}`; symbol: string }> = {
    1: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH" },       // Ethereum Mainnet
    10: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" },      // Optimism
    137: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", symbol: "WETH" },     // Polygon
    8453: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" },    // Base
    42161: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH" },   // Arbitrum One
    43114: { address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", symbol: "WAVAX" },  // Avalanche C-Chain
    84532: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH" },   // Base Sepolia
    43113: { address: "0xd00ae08403B9bbb9124bB305C09058E32C39A48c", symbol: "WAVAX" },  // Avalanche Fuji Testnet
};

// Native token address (address(0) for ETH/AVAX)
const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// OpenZeppelin AccessControl DEFAULT_ADMIN_ROLE = bytes32(0)
const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

// Chain names for display
const CHAIN_NAMES: Record<number, { name: string; nativeSymbol: string }> = {
    1: { name: "Ethereum", nativeSymbol: "ETH" },
    10: { name: "Optimism", nativeSymbol: "ETH" },
    137: { name: "Polygon", nativeSymbol: "MATIC" },
    8453: { name: "Base", nativeSymbol: "ETH" },
    42161: { name: "Arbitrum", nativeSymbol: "ETH" },
    43114: { name: "Avalanche", nativeSymbol: "AVAX" },
    84532: { name: "Base Sepolia", nativeSymbol: "ETH" },
    43113: { name: "Avalanche Fuji", nativeSymbol: "AVAX" },
};

function requiredEnv(name: string, value: unknown): asserts value {
    if (value === undefined || value === null || value === "") {
        console.error(`Missing env: ${name}`);
        process.exit(1);
    }
}

requiredEnv("ROUTER_ADDRESS", ROUTER_ADDRESS);
requiredEnv("MONGODB_URI", MONGODB_URI);

async function main() {
    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    const isYak = ROUTER_TYPE.toLowerCase() === "yak";
    const routerName = isYak ? "YakSharesRouter" : "OdosSharesRouter";
    const chainInfo = CHAIN_NAMES[chainId] ?? { name: `Chain ${chainId}`, nativeSymbol: "ETH" };

    console.log("=".repeat(60));
    console.log(`Configuring ${routerName}`);
    console.log("=".repeat(60));
    console.log("Chain:", chainInfo.name, `(${chainId})`);
    console.log("Router:", ROUTER_ADDRESS);
    console.log("Type:", routerName);
    console.log("Native Token:", chainInfo.nativeSymbol);
    console.log("=".repeat(60));

    // Fetch pool addresses from MongoDB
    console.log("\nConnecting to MongoDB...");
    await mongoose.connect(MONGODB_URI!, { dbName: "fantasy" });
    
    const players = await Player.find({
        contractAddress: { $exists: true, $ne: "" }
    }).select({ name: 1, contractAddress: 1 }).exec();

    await mongoose.disconnect();

    const poolAddresses = players
        .map(p => p.contractAddress as `0x${string}`)
        .filter(addr => addr && addr.startsWith("0x"));

    if (poolAddresses.length === 0) {
        console.error("No pool addresses found in database");
        process.exit(1);
    }

    console.log(`Found ${poolAddresses.length} pools in database\n`);
    
    // Show player names
    for (const player of players) {
        console.log(`  - ${player.name}: ${player.contractAddress}`);
    }

    // Get router contract
    const router = await viem.getContractAt(routerName, ROUTER_ADDRESS!);

    console.log(`\nConfiguring ${poolAddresses.length} pools...\n`);

    // Step 1: Grant DEFAULT_ADMIN_ROLE to router on each pool
    for (const poolAddress of poolAddresses) {
        console.log(`\nPool: ${poolAddress}`);
        
        const pool = await viem.getContractAt("PlayerSharePool", poolAddress);
        
        // Check if router already has admin role (DEFAULT_ADMIN_ROLE = 0x00)
        const hasRole = await pool.read.hasRole([DEFAULT_ADMIN_ROLE, ROUTER_ADDRESS!]);
        
        if (hasRole) {
            console.log("  - Router already has DEFAULT_ADMIN_ROLE");
        } else {
            console.log("  - Granting DEFAULT_ADMIN_ROLE to router...");
            try {
                const hash = await pool.write.grantRole([DEFAULT_ADMIN_ROLE, ROUTER_ADDRESS!]);
                console.log("    Tx:", hash);
                await publicClient.waitForTransactionReceipt({ hash });
                console.log("    Done!");
            } catch (err) {
                console.error("    Failed:", (err as Error).message);
                console.log("    (Make sure you're using an admin account for this pool)");
            }
        }

        // Step 2: Enable pool on router
        const isSupported = await router.read.supportedPools([poolAddress]);
        if (isSupported) {
            console.log("  - Pool already supported on router");
        } else {
            console.log("  - Enabling pool on router...");
            try {
                const hash = await router.write.setPoolSupported([poolAddress, true]);
                console.log("    Tx:", hash);
                await publicClient.waitForTransactionReceipt({ hash });
                console.log("    Done!");
            } catch (err) {
                console.error("    Failed:", (err as Error).message);
            }
        }
    }

    // Step 3: Enable tokens
    console.log("\n" + "-".repeat(60));
    console.log("Configuring supported tokens...\n");

    let tokensToEnable: { address: `0x${string}`; name: string }[] = [];

    if (SUPPORTED_TOKENS) {
        // Custom token list from env
        const customTokens = SUPPORTED_TOKENS
            .split(",")
            .map(s => s.trim() as `0x${string}`)
            .filter(s => s.length > 0);
        
        for (const addr of customTokens) {
            const name = addr === NATIVE_ADDRESS 
                ? `${chainInfo.nativeSymbol} (native)` 
                : addr;
            tokensToEnable.push({ address: addr, name });
        }
    } else {
        // Default tokens based on router type and chain
        
        // Yak doesn't support native tokens, only wrapped
        // Odos supports native on most chains
        if (!isYak) {
            tokensToEnable.push({ 
                address: NATIVE_ADDRESS, 
                name: `${chainInfo.nativeSymbol} (native)` 
            });
        }
        
        // Add wrapped native token (WETH/WAVAX)
        const wrappedInfo = WETH_ADDRESS 
            ? { address: WETH_ADDRESS, symbol: "WRAPPED" }
            : WRAPPED_NATIVE_ADDRESSES[chainId];
        
        if (wrappedInfo) {
            tokensToEnable.push({ 
                address: wrappedInfo.address, 
                name: wrappedInfo.symbol 
            });
        }
    }

    for (const token of tokensToEnable) {
        const isSupported = await router.read.supportedTokens([token.address]);
        
        if (isSupported) {
            console.log(`  - ${token.name}: already supported`);
        } else {
            console.log(`  - ${token.name}: enabling...`);
            try {
                const hash = await router.write.setTokenSupported([token.address, true]);
                console.log(`    Tx: ${hash}`);
                await publicClient.waitForTransactionReceipt({ hash });
                console.log("    Done!");
            } catch (err) {
                console.error("    Failed:", (err as Error).message);
            }
        }
    }

    console.log("\n" + "=".repeat(60));
    console.log("Configuration complete!");
    console.log("=".repeat(60));

    // Summary
    console.log("\nSummary:");
    console.log(`  Router: ${ROUTER_ADDRESS} (${routerName})`);
    console.log(`  Pools configured: ${poolAddresses.length}`);
    console.log(`  Tokens enabled: ${tokensToEnable.length}`);
    
    const domainSeparator = await router.read.domainSeparator();
    console.log(`\n  EIP-712 Domain Separator: ${domainSeparator}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
