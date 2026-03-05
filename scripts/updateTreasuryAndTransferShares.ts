import "dotenv/config";
import { network } from "hardhat";
import { parseUnits } from "viem";

/**
 * Script to update the treasury address and transfer shares for each registered pool.
 *
 * Usage:
 *   yarn hardhat run scripts/updateTreasuryAndTransferShares.ts --network baseSepolia
 *
 * Required environment variables (.env):
 *   REGISTRY_ADDRESS         - PlayerSharePoolRegistry address
 *
 * Optional:
 *   DRY_RUN                  - If "true", simulates without executing transactions
 */

const NEW_TREASURY = process.env.NEW_TREASURY_ADDRESS as `0x${string}`;
if (!NEW_TREASURY) {
    console.error("Missing env: NEW_TREASURY_ADDRESS");
    process.exit(1);
}
const SHARES_TO_TRANSFER = parseUnits("23500000", 6); // 23.5M shares (1e6 decimals)

const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS as `0x${string}` | undefined;
const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
    console.log("=".repeat(60));
    console.log("Update Treasury & Transfer Shares Script");
    console.log("=".repeat(60));

    if (!REGISTRY_ADDRESS) {
        throw new Error("REGISTRY_ADDRESS not configured in .env");
    }

    console.log(`\nRegistry: ${REGISTRY_ADDRESS}`);
    console.log(`New Treasury: ${NEW_TREASURY}`);
    console.log(`Shares to transfer: ${SHARES_TO_TRANSFER.toString()} (23.5M)`);
    console.log(`Dry run: ${DRY_RUN}`);
    console.log("");

    const { viem } = await network.connect();

    const [signer] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const signerAddress = signer.account.address;

    console.log(`Signer: ${signerAddress}`);

    // Load Registry
    const registry = await viem.getContractAt(
        "PlayerSharePoolRegistry",
        REGISTRY_ADDRESS
    );

    // Get all pools
    const poolCount = await registry.read.poolsCount();
    console.log(`\nRegistered pools: ${poolCount}`);

    if (poolCount === 0n) {
        console.log("No pools to process.");
        return;
    }

    const pools = await registry.read.getAllPools() as `0x${string}`[];
    console.log(`Pool addresses: ${pools.length}`);

    const results: { pool: string; success: boolean; error?: string }[] = [];

    for (let i = 0; i < pools.length; i++) {
        const poolAddress = pools[i];
        console.log(`\n[${ i + 1}/${pools.length}] Processing pool: ${poolAddress}`);

        try {
            const pool = await viem.getContractAt(
                "PlayerSharePool",
                poolAddress
            );

            // 1. Get current treasury
            const currentTreasury = await pool.read.treasury();
            console.log(`  Current treasury: ${currentTreasury}`);

            // 2. Check treasury balance
            const treasuryBalance = await pool.read.balanceOf([currentTreasury]) as bigint;
            console.log(`  Treasury balance: ${treasuryBalance.toString()}`);

            if (treasuryBalance < SHARES_TO_TRANSFER) {
                console.log(`  Insufficient balance for transfer (need ${SHARES_TO_TRANSFER}, have ${treasuryBalance})`);
            }

            if (DRY_RUN) {
                console.log("  [DRY RUN] Would execute:");
                console.log(`    - setTreasury(${NEW_TREASURY})`);
                if (treasuryBalance >= SHARES_TO_TRANSFER) {
                    console.log(`    - adminTransferShares(${currentTreasury}, ${NEW_TREASURY}, ${SHARES_TO_TRANSFER})`);
                }
                results.push({ pool: poolAddress, success: true });
                continue;
            }

            // 3. Update treasury
            console.log(`  Setting new treasury...`);
            const setTreasuryTx = await pool.write.setTreasury([NEW_TREASURY], {
                account: signer.account,
            });
            console.log(`  TX: ${setTreasuryTx}`);
            await publicClient.waitForTransactionReceipt({ hash: setTreasuryTx });
            console.log(`  Treasury updated`);

            // 4. Transfer shares (from old treasury to new treasury)
            if (treasuryBalance >= SHARES_TO_TRANSFER) {
                console.log(`  Transferring ${SHARES_TO_TRANSFER} shares...`);
                const transferTx = await pool.write.adminTransferShares(
                    [currentTreasury, NEW_TREASURY, SHARES_TO_TRANSFER],
                    { account: signer.account }
                );
                console.log(`  TX: ${transferTx}`);
                await publicClient.waitForTransactionReceipt({ hash: transferTx });
                console.log(`  Shares transferred`);
            } else {
                console.log(`  Skipped transfer (insufficient balance)`);
            }

            results.push({ pool: poolAddress, success: true });

        } catch (error: any) {
            console.log(`  Error: ${error.message}`);
            results.push({ pool: poolAddress, success: false, error: error.message });
        }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`\nTotal: ${results.length}`);
    console.log(`Success: ${successful}`);
    console.log(`Failed: ${failed}`);

    if (failed > 0) {
        console.log("\nFailed pools:");
        results.filter(r => !r.success).forEach(r => {
            console.log(`  - ${r.pool}: ${r.error}`);
        });
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
