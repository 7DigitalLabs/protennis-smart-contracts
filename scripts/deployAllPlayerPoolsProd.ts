import "dotenv/config";
import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import { parseUnits } from "viem";
import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * PRODUCTION script to deploy PlayerSharePool for all players in the MongoDB database
 * and update each player's `contractAddress` field.
 *
 * Uses native USDC on the chain.
 *
 * Usage:
 *   yarn hardhat run scripts/deployAllPlayerPoolsProd.ts --network avalanche
 *
 * Required env vars (.env):
 *   PROD_MONGODB_URI              - MongoDB connection URI
 *   PROD_ADMIN_ADDRESS            - Contract admin
 *   PROD_ORDER_SIGNER_ADDRESS     - Signer for EIP-712 orders
 *   PROD_CSP_TREASURY_ADDRESS     - Treasury that receives fees
 *   PROD_CSP_TARGET_RAISE         - Target raise in USDC (e.g.: "7500")
 *   PROD_CSP_PRICES               - Prices per bin (e.g.: "0.0075,0.0100,0.0125")
 *   PROD_CSP_SHARE_COUNTS         - Share quantities per bin (e.g.: "16162,32323,48485")
 *
 * Optional:
 *   PROD_REGISTRY_ADDRESS         - If set, registers each pool on the registry
 *   PROD_SKIP_VERIFICATION        - If "true", skips explorer verification
 *   PROD_BATCH_SIZE               - Number of players to process per batch (default: 10)
 *   PROD_DRY_RUN                  - If "true", simulates without actual deployment
 *   PROD_USDC_ADDRESS             - USDC address
 */

// --- Interfaces ---
interface IPlayer {
    statsPerformPlayerId: string;
    playerId: string;
    name: string;
    contractAddress: string;
    age: number;
    country: string;
    countryCode: string;
    ranking: number;
    rating: number;
    wins: number;
    losses: number;
    setsWon: number;
    setsLost: number;
    tournamentsPlayed: number;
    titles: number;
}

interface IPlayerDocument extends IPlayer, Document {}

interface DeployResult {
    playerId: string;
    playerName: string;
    poolAddress: string;
    success: boolean;
    error?: string;
}

// --- Mongoose Schema ---
const PlayerSchema = new Schema<IPlayerDocument>(
    {
        statsPerformPlayerId: { type: String, required: true },
        playerId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        contractAddress: { type: String, default: "" },
        age: { type: Number },
        country: { type: String },
        countryCode: { type: String },
        ranking: { type: Number },
        rating: { type: Number },
        wins: { type: Number },
        losses: { type: Number },
        setsWon: { type: Number },
        setsLost: { type: Number },
        tournamentsPlayed: { type: Number },
        titles: { type: Number },
    },
    { collection: "players" }
);

const Player: Model<IPlayerDocument> = mongoose.model<IPlayerDocument>("Player", PlayerSchema);

// --- Env Vars (PROD_) ---
const MONGODB_URI = process.env.PROD_MONGODB_URI as string | undefined;
const ADMIN_ADDRESS = process.env.PROD_ADMIN_ADDRESS as `0x${string}` | undefined;
const ORDER_SIGNER_ADDRESS = process.env.PROD_ORDER_SIGNER_ADDRESS as `0x${string}` | undefined;
const CSP_TREASURY_ADDRESS = process.env.PROD_CSP_TREASURY_ADDRESS as `0x${string}` | undefined;
const CSP_TARGET_RAISE = process.env.PROD_CSP_TARGET_RAISE;
const CSP_PRICES = process.env.PROD_CSP_PRICES;
const CSP_SHARE_COUNTS = process.env.PROD_CSP_SHARE_COUNTS;
const REGISTRY_ADDRESS = process.env.PROD_REGISTRY_ADDRESS as `0x${string}` | undefined;
const SKIP_VERIFICATION = process.env.PROD_SKIP_VERIFICATION === "true";
const BATCH_SIZE = parseInt(process.env.PROD_BATCH_SIZE || "10", 10);
const DRY_RUN = process.env.PROD_DRY_RUN === "true";
const USDC_ADDRESS = process.env.PROD_USDC_ADDRESS as `0x${string}` | undefined;

// --- Validation ---
function requiredEnv(name: string, value: unknown): asserts value {
    if (value === undefined || value === null || value === "") {
        console.error(`Missing env: ${name}`);
        process.exit(1);
    }
}

requiredEnv("PROD_MONGODB_URI", MONGODB_URI);
requiredEnv("PROD_ADMIN_ADDRESS", ADMIN_ADDRESS);
requiredEnv("PROD_ORDER_SIGNER_ADDRESS", ORDER_SIGNER_ADDRESS);
requiredEnv("PROD_CSP_TREASURY_ADDRESS", CSP_TREASURY_ADDRESS);
requiredEnv("PROD_CSP_TARGET_RAISE", CSP_TARGET_RAISE);
requiredEnv("PROD_CSP_PRICES", CSP_PRICES);
requiredEnv("PROD_CSP_SHARE_COUNTS", CSP_SHARE_COUNTS);
requiredEnv("PROD_USDC_ADDRESS", USDC_ADDRESS);

// --- Helpers ---
function parseDecimalCsvToWei(csv: string): bigint[] {
    let parts: string[];
    try {
        const parsed = JSON.parse(csv);
        if (Array.isArray(parsed)) {
            parts = parsed.map((x) => String(x));
        } else {
            throw new Error("not array");
        }
    } catch {
        const cleaned = csv.replace(/[\[\]\s]/g, "");
        parts = cleaned.split(/[,;]+/).filter((s) => s.length > 0);
    }
    return parts.map((s) => parseUnits(s, 6));
}

function parseCountsCsvToWei(csv: string): bigint[] {
    let parts: string[];
    try {
        const parsed = JSON.parse(csv);
        if (Array.isArray(parsed)) {
            parts = parsed.map((x) => String(x));
        } else {
            throw new Error("not array");
        }
    } catch {
        const cleaned = csv.replace(/[\[\]\s]/g, "");
        parts = cleaned.split(/[,;]+/).filter((s) => s.length > 0);
    }
    return parts.map((s) => parseUnits(s, 6));
}

function uuidToBytes16(uuid: string): `0x${string}` {
    const hex = uuid.replace(/-/g, "").toLowerCase();
    if (!/^([0-9a-f]{32})$/.test(hex)) {
        throw new Error(`Invalid UUID: ${uuid}`);
    }
    return ("0x" + hex) as `0x${string}`;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main ---
async function main() {
    console.log("Starting PRODUCTION batch deployment of PlayerSharePools...\n");

    if (DRY_RUN) {
        console.log("DRY_RUN mode enabled - no actual deployments will be made\n");
    }

    // Parse seeding curve config
    const prices = parseDecimalCsvToWei(CSP_PRICES!);
    const shareQuantities = parseCountsCsvToWei(CSP_SHARE_COUNTS!);

    if (prices.length === 0 || prices.length !== shareQuantities.length) {
        console.error(`Invalid seeding bins: PRICES(${prices.length}) vs SHARE_COUNTS(${shareQuantities.length})`);
        process.exit(1);
    }

    const targetRaise = parseUnits(CSP_TARGET_RAISE!, 6);

    // Connect to network
    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient();
    
    const usdcAddress = USDC_ADDRESS!;
    
    if (!DRY_RUN) {
        // Check USDC balance
        const balance = await publicClient.readContract({
            address: usdcAddress,
            abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
            functionName: "balanceOf",
            args: [ADMIN_ADDRESS!]
        });
        console.log(`   Admin USDC balance: ${Number(balance) / 1e6} USDC\n`);
    }

    console.log("Configuration (PRODUCTION):");
    console.log(`   Admin: ${ADMIN_ADDRESS}`);
    console.log(`   Order Signer: ${ORDER_SIGNER_ADDRESS}`);
    console.log(`   USDC: ${usdcAddress}`);
    console.log(`   Treasury: ${CSP_TREASURY_ADDRESS}`);
    console.log(`   Target Raise: ${CSP_TARGET_RAISE} USDC`);
    console.log(`   Bins: ${prices.length}`);
    console.log(`   Registry: ${REGISTRY_ADDRESS || "Not configured"}`);
    console.log(`   Batch Size: ${BATCH_SIZE}`);
    console.log("");

    // Connect to MongoDB with Mongoose
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI!, { dbName: "fantasy" });
    console.log("Connected to MongoDB\n");

    // Fetch players without contractAddress
    const players = await Player.find({
        $or: [{ contractAddress: { $exists: false } }, { contractAddress: "" }],
    }).exec();

    console.log(`Found ${players.length} players without contractAddress\n`);

    if (players.length === 0) {
        console.log("All players already have contracts deployed!");
        await mongoose.disconnect();
        return;
    }

    // Get registry contract if configured
    let registry: any = null;
    if (REGISTRY_ADDRESS) {
        registry = await viem.getContractAt("PlayerSharePoolRegistry", REGISTRY_ADDRESS);
        console.log(`Registry connected at ${REGISTRY_ADDRESS}\n`);
    }

    // Deploy results
    const results: DeployResult[] = [];
    let successCount = 0;
    let failCount = 0;

    // Process in batches
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
        const batch = players.slice(i, Math.min(i + BATCH_SIZE, players.length));
        console.log(`\nProcessing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(players.length / BATCH_SIZE)} (${batch.length} players)`);
        console.log("─".repeat(60));

        for (const player of batch) {
            console.log(`\nDeploying pool for: ${player.name} (${player.playerId})`);

            if (DRY_RUN) {
                console.log("   [DRY_RUN] Would deploy PlayerSharePool");
                results.push({
                    playerId: player.playerId,
                    playerName: player.name,
                    poolAddress: "0x_DRY_RUN",
                    success: true,
                });
                successCount++;
                continue;
            }

            try {
                // Deploy PlayerSharePool
                const pool = await viem.deployContract(
                    "PlayerSharePool",
                    [
                        ADMIN_ADDRESS!,
                        ORDER_SIGNER_ADDRESS!,
                        usdcAddress,
                        CSP_TREASURY_ADDRESS!,
                        targetRaise,
                        prices,
                        shareQuantities,
                    ],
                    { confirmations: 1 }
                );

                console.log(`   Pool deployed at: ${pool.address}`);

                // Verify contract (optional)
                if (!SKIP_VERIFICATION) {
                    try {
                        console.log("   Verifying on explorer...");
                        await verifyContract(
                            {
                                address: pool.address,
                                constructorArgs: [
                                    ADMIN_ADDRESS!,
                                    ORDER_SIGNER_ADDRESS!,
                                    usdcAddress,
                                    CSP_TREASURY_ADDRESS!,
                                    targetRaise,
                                    prices,
                                    shareQuantities,
                                ],
                                contract: "contracts/pool/PlayerSharePool.sol:PlayerSharePool",
                            },
                            hre as any
                        );
                        console.log("   Verification submitted");
                    } catch (err) {
                        console.log(`   Verification skipped: ${(err as Error).message.slice(0, 50)}...`);
                    }
                }

                // Register on Registry (optional)
                if (registry) {
                    try {
                        const playerId16 = uuidToBytes16(player.playerId);
                        const txHash = await registry.write.register([playerId16, pool.address]);
                        console.log(`   Registered on registry (tx: ${txHash.slice(0, 18)}...)`);
                    } catch (err) {
                        console.log(`   Registry registration failed: ${(err as Error).message.slice(0, 50)}...`);
                    }
                }

                // Update MongoDB with Mongoose
                await Player.updateOne(
                    { playerId: player.playerId },
                    { $set: { contractAddress: pool.address } }
                );
                console.log("   Database updated");

                results.push({
                    playerId: player.playerId,
                    playerName: player.name,
                    poolAddress: pool.address,
                    success: true,
                });
                successCount++;

            } catch (err) {
                const errorMsg = (err as Error).message;
                console.log(`   Deploy failed: ${errorMsg.slice(0, 100)}...`);

                results.push({
                    playerId: player.playerId,
                    playerName: player.name,
                    poolAddress: "",
                    success: false,
                    error: errorMsg,
                });
                failCount++;
            }

            // Small delay between deployments to avoid rate limits
            await sleep(1000);
        }
    }

    // Summary
    console.log("\n");
    console.log("═".repeat(60));
    console.log("PRODUCTION DEPLOYMENT SUMMARY");
    console.log("═".repeat(60));
    console.log(`   USDC: ${usdcAddress}`);
    console.log(`   Total Players: ${players.length}`);
    console.log(`   Successful: ${successCount}`);
    console.log(`   Failed: ${failCount}`);
    console.log("═".repeat(60));

    // Log failed deployments
    if (failCount > 0) {
        console.log("\nFailed Deployments:");
        results
            .filter((r) => !r.success)
            .forEach((r) => {
                console.log(`   - ${r.playerName} (${r.playerId}): ${r.error?.slice(0, 80)}...`);
            });
    }

    // Log successful deployments
    if (successCount > 0) {
        console.log("\nSuccessful Deployments:");
        results
            .filter((r) => r.success)
            .forEach((r) => {
                console.log(`   - ${r.playerName}: ${r.poolAddress}`);
            });
    }

    await mongoose.disconnect();
    console.log("\nDone!");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
