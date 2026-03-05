import "dotenv/config";
import { network } from "hardhat";
import { parseUnits } from "viem";
import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * Script to initialize all PlayerSharePool instances with raffle and open the market.
 *
 * Flow for each pool:
 *   1. startRaffle() - Starts the Raffle phase
 *   2. approve USDC for the pool
 *   3. finalizeRaffle(shareLiquidity, usdcLiquidity) - Finalizes and opens OpenMarket
 *
 * The raffle sells tickets, not shares. Liquidity shares are calculated
 * to achieve the desired target price.
 *
 * Formula: shareLiquidity = (usdcLiquidity * 1e6) / targetPrice
 * E.g.: for price 0.03 USDC with 4000 USDC -> shareLiquidity = 133,333,333,333
 *
 * Usage:
 *   yarn hardhat run scripts/initializePlayerPools.ts --network avalanche
 *
 * Required environment variables (.env):
 *   MONGODB_URI              - MongoDB connection URI
 *   USDC_ADDRESS             - USDC address
 *   INITIAL_LIQUIDITY        - Initial USDC liquidity per pool (e.g.: "4000" = 4k USDC)
 *
 * Optional:
 *   SHARE_LIQUIDITY          - Shares for AMM liquidity (default: 133333333333 for price 0.03)
 *   BATCH_SIZE               - Number of players to process per batch (default: 10)
 *   DRY_RUN                  - If "true", simulates without real transactions
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

interface InitResult {
    playerId: string;
    playerName: string;
    poolAddress: string;
    success: boolean;
    phase?: string;
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

// --- Env Vars ---
const MONGODB_URI = process.env.MONGODB_URI as string | undefined;
const USDC_ADDRESS = process.env.MOCK_USDC_ADDRESS as `0x${string}` | undefined;
const INITIAL_LIQUIDITY = process.env.INITIAL_LIQUIDITY || "4000"; // 4k USDC default
// shareLiquidity for price 0.03 USDC with 4000 USDC: (4000 * 1e6 * 1e6) / 30000 = 133,333,333,333
const SHARE_LIQUIDITY = process.env.SHARE_LIQUIDITY || "133333333333";
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "10", 10);
const DRY_RUN = process.env.DRY_RUN === "true";

// --- Validation ---
function requiredEnv(name: string, value: unknown): asserts value {
    if (value === undefined || value === null || value === "") {
        console.error(`Missing env: ${name}`);
        process.exit(1);
    }
}

requiredEnv("MONGODB_URI", MONGODB_URI);
requiredEnv("USDC_ADDRESS", USDC_ADDRESS);
// --- Helpers ---
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function phaseToString(phase: number): string {
    const phases = ["None", "Seeding", "OpenMarket", "Raffle"];
    return phases[phase] || `Unknown(${phase})`;
}

// --- Main ---
async function main() {
    console.log("Starting PlayerSharePool initialization...\n");

    if (DRY_RUN) {
        console.log("DRY_RUN mode enabled - no actual transactions will be made\n");
    }

    const usdcLiquidity = parseUnits(INITIAL_LIQUIDITY, 6);
    const shareLiquidity = BigInt(SHARE_LIQUIDITY);
    
    // Calculate expected price: price = (usdcLiquidity * 1e6) / shareLiquidity
    const expectedPrice = (usdcLiquidity * 1_000_000n) / shareLiquidity;
    const priceUsd = Number(expectedPrice) / 1_000_000;

    console.log("Configuration:");
    console.log(`   USDC: ${USDC_ADDRESS}`);
    console.log(`   Initial Liquidity: ${INITIAL_LIQUIDITY} USDC per pool`);
    console.log(`   Share Liquidity: ${SHARE_LIQUIDITY} (${Number(shareLiquidity) / 1e6} shares)`);
    console.log(`   Expected Price: ${priceUsd.toFixed(4)} USDC`);
    console.log(`   Batch Size: ${BATCH_SIZE}`);
    console.log("");

    // Connect to network
    const { viem } = await network.connect();
    const client = await viem.getPublicClient();
    const [deployer] = await viem.getWalletClients();
    
    // Minimal ERC20 ABI
    const ERC20_ABI = [
        { 
            name: "balanceOf", 
            type: "function", 
            stateMutability: "view", 
            inputs: [{ name: "account", type: "address" }], 
            outputs: [{ name: "", type: "uint256" }] 
        },
        { 
            name: "approve", 
            type: "function", 
            stateMutability: "nonpayable", 
            inputs: [
                { name: "spender", type: "address" }, 
                { name: "amount", type: "uint256" }
            ], 
            outputs: [{ name: "", type: "bool" }] 
        },
    ] as const;
    
    console.log(`USDC at ${USDC_ADDRESS}`);

    // Check deployer balance
    const deployerAddress = deployer.account.address;
    const balance = await client.readContract({
        address: USDC_ADDRESS!,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [deployerAddress]
    });
    console.log(`   Deployer: ${deployerAddress}`);
    console.log(`   Balance: ${Number(balance) / 1e6} USDC\n`);

    // Connect to MongoDB
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI!, { dbName: "fantasy" });
    console.log("Connected to MongoDB\n");

    // Fetch players with contractAddress
    const players = await Player.find({
        contractAddress: { $exists: true, $ne: "" },
    }).exec();

    console.log(`Found ${players.length} players with deployed contracts\n`);

    if (players.length === 0) {
        console.log("No players with contracts found!");
        await mongoose.disconnect();
        return;
    }

    // Calculate total USDC needed
    const totalUsdcNeeded = usdcLiquidity * BigInt(players.length);
    console.log(`Total USDC needed: ${Number(totalUsdcNeeded) / 1e6} USDC`);
    
    /*if (balance < totalUsdcNeeded) {
        console.error(`Insufficient balance! Need ${Number(totalUsdcNeeded) / 1e6} USDC, have ${Number(balance) / 1e6} USDC`);
        await mongoose.disconnect();
        process.exit(1);
    }*/
    console.log("");

    // Results tracking
    const results: InitResult[] = [];
    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    // Process in batches
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
        const batch = players.slice(i, Math.min(i + BATCH_SIZE, players.length));
        console.log(`\nProcessing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(players.length / BATCH_SIZE)} (${batch.length} players)`);
        console.log("─".repeat(60));

        for (const player of batch) {
            const poolAddress = player.contractAddress as `0x${string}`;
            console.log(`\nInitializing pool for: ${player.name}`);
            console.log(`   Pool: ${poolAddress}`);

            if (DRY_RUN) {
                console.log("   [DRY_RUN] Would initialize pool");
                results.push({
                    playerId: player.playerId,
                    playerName: player.name,
                    poolAddress,
                    success: true,
                    phase: "OpenMarket",
                });
                successCount++;
                continue;
            }

            try {
                // Get pool contract
                const pool = await viem.getContractAt("PlayerSharePool", poolAddress);

                // Check current phase
                const currentPhase = (await pool.read.currentPhase()) as number;
                console.log(`   Current phase: ${phaseToString(currentPhase)}`);

                // If already in OpenMarket, add LP to reach 4k USDC reserve
                if (currentPhase === 2) { // OpenMarket
                    const currentReserveUsdc = (await pool.read.reserveUsdc()) as bigint;
                    const currentPriceRaw = (await pool.read.currentPrice()) as bigint;
                    const currentPriceUsd = Number(currentPriceRaw) / 1_000_000;
                    
                    console.log(`   Already in OpenMarket`);
                    console.log(`   Current: ${Number(currentReserveUsdc) / 1e6} USDC, price: ${currentPriceUsd.toFixed(4)} USDC`);
                    
                    // Target 4000 USDC reserve
                    const targetReserveUsdc = usdcLiquidity; // 4000 USDC
                    
                    if (currentReserveUsdc >= targetReserveUsdc) {
                        console.log(`   Reserve already >= ${INITIAL_LIQUIDITY} USDC, skipping`);
                        results.push({
                            playerId: player.playerId,
                            playerName: player.name,
                            poolAddress,
                            success: true,
                            phase: `OpenMarket (${Number(currentReserveUsdc) / 1e6} USDC)`,
                        });
                        skipCount++;
                        continue;
                    }
                    
                    // Calculate USDC needed
                    const usdcNeeded = targetReserveUsdc - currentReserveUsdc;
                    console.log(`   Need to add ${Number(usdcNeeded) / 1e6} USDC to reach ${INITIAL_LIQUIDITY} USDC`);
                    
                    // Approve USDC
                    console.log(`   Approving ${Number(usdcNeeded) / 1e6} USDC...`);
                    const approveTx = await deployer.writeContract({
                        address: USDC_ADDRESS!,
                        abi: ERC20_ABI,
                        functionName: "approve",
                        args: [poolAddress, usdcNeeded] as const,
                        account: deployer.account,
                        chain: deployer.chain
                    });
                    await client.waitForTransactionReceipt({ hash: approveTx, confirmations: 1 });
                    console.log(`   Approved`);
                    await sleep(1000);
                    
                    // Add liquidity (maintains price, adds proportional shares from treasury)
                    console.log(`   Adding ${Number(usdcNeeded) / 1e6} USDC liquidity...`);
                    const addLpTx = await pool.write.addLiquidity([usdcNeeded]);
                    await client.waitForTransactionReceipt({ hash: addLpTx, confirmations: 1 });
                    
                    const newReserveUsdc = (await pool.read.reserveUsdc()) as bigint;
                    const newPrice = (await pool.read.currentPrice()) as bigint;
                    console.log(`   LP added! New reserve: ${Number(newReserveUsdc) / 1e6} USDC, price: ${(Number(newPrice) / 1e6).toFixed(4)} USDC`);
                    
                    results.push({
                        playerId: player.playerId,
                        playerName: player.name,
                        poolAddress,
                        success: true,
                        phase: `OpenMarket (LP added: ${Number(usdcNeeded) / 1e6} USDC)`,
                    });
                    successCount++;
                    continue;
                }

                // If in None phase, start raffle
                if (currentPhase === 0) { // None
                    console.log("   Starting raffle...");
                    const startTx = await pool.write.startRaffle();
                    await client.waitForTransactionReceipt({ hash: startTx, confirmations: 1 });
                    console.log(`   Raffle started (tx: ${startTx.slice(0, 18)}...)`);
                    await sleep(2000); // Wait for confirmation
                }

                // Verify we're in Raffle phase
                const phaseAfterStart = (await pool.read.currentPhase()) as number;
                if (phaseAfterStart !== 3) { // Raffle
                    throw new Error(`Expected Raffle phase (3), got ${phaseToString(phaseAfterStart)}`);
                }

                // Approve USDC for the pool
                console.log(`   Approving ${INITIAL_LIQUIDITY} USDC...`);
                const approveTx = await deployer.writeContract({
                    address: USDC_ADDRESS!,
                    abi: ERC20_ABI,
                    functionName: "approve",
                    args: [poolAddress, usdcLiquidity] as const,
                    account: deployer.account,
                    chain: deployer.chain
                });
                await client.waitForTransactionReceipt({ hash: approveTx, confirmations: 1 });
                console.log(`   Approved (tx: ${approveTx.slice(0, 18)}...)`);
                await sleep(1000);

                // Finalize raffle with shareLiquidity and usdcLiquidity
                console.log(`   Finalizing raffle with ${Number(shareLiquidity) / 1e6} shares + ${INITIAL_LIQUIDITY} USDC...`);
                const finalizeTx = await pool.write.finalizeRaffle([shareLiquidity, usdcLiquidity]);
                await client.waitForTransactionReceipt({ hash: finalizeTx, confirmations: 1 });
                
                console.log(`   Raffle finalized (tx: ${finalizeTx.slice(0, 18)}...)`);

                // Verify final phase
                const finalPhase = (await pool.read.currentPhase()) as number;
                console.log(`   Final phase: ${phaseToString(finalPhase)}`);

                if (finalPhase !== 2) { // OpenMarket
                    throw new Error(`Expected OpenMarket phase (2), got ${phaseToString(finalPhase)}`);
                }

                results.push({
                    playerId: player.playerId,
                    playerName: player.name,
                    poolAddress,
                    success: true,
                    phase: "OpenMarket",
                });
                successCount++;

            } catch (err) {
                const errorMsg = (err as Error).message;
                console.log(`   Initialization failed: ${errorMsg}`);

                results.push({
                    playerId: player.playerId,
                    playerName: player.name,
                    poolAddress,
                    success: false,
                    error: errorMsg,
                });
                failCount++;
            }

            // Small delay between operations
            await sleep(1000);
        }
    }

    // Summary
    console.log("\n");
    console.log("═".repeat(60));
    console.log("INITIALIZATION SUMMARY");
    console.log("═".repeat(60));
    console.log(`   Total Players: ${players.length}`);
    console.log(`   Successful: ${successCount}`);
    console.log(`   Skipped (already open): ${skipCount}`);
    console.log(`   Failed: ${failCount}`);
    console.log("═".repeat(60));

    // Log failed initializations
    if (failCount > 0) {
        console.log("\nFailed Initializations:");
        results
            .filter((r) => !r.success)
            .forEach((r) => {
                console.log(`   - ${r.playerName} (${r.poolAddress}): ${r.error?.slice(0, 80)}...`);
            });
    }

    // Log successful initializations
    const successResults = results.filter((r) => r.success);
    if (successResults.length > 0) {
        console.log("\nInitialized Pools (ready for market orders):");
        successResults.forEach((r) => {
            console.log(`   - ${r.playerName}: ${r.poolAddress} [${r.phase}]`);
        });
    }

    await mongoose.disconnect();
    console.log("\nDone!");
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
