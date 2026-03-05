import "dotenv/config";
import { network } from "hardhat";
import { formatUnits, parseUnits } from "viem";

/**
 * Script to diagnose RouterSwapFailed errors
 * 
 * Usage:
 *   ROUTER_ADDRESS=0x... USER_ADDRESS=0x... INPUT_TOKEN=0x... INPUT_AMOUNT=100 POOL_ADDRESS=0x... \
 *   yarn hardhat run scripts/debugRouterSwap.ts --network avalanche
 * 
 * Env vars:
 *   ROUTER_ADDRESS  - OdosSharesRouter or YakSharesRouter address
 *   ROUTER_TYPE     - "odos" or "yak" (default: odos)
 *   USER_ADDRESS    - Address of the user who wants to swap
 *   INPUT_TOKEN     - Token the user wants to use (0x0 for native)
 *   INPUT_AMOUNT    - Token amount (in human-readable units, e.g.: "100" for 100 USDC)
 *   POOL_ADDRESS    - Target PlayerSharePool address
 */

const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS as `0x${string}` | undefined;
const ROUTER_TYPE = process.env.ROUTER_TYPE ?? "odos";
const USER_ADDRESS = process.env.USER_ADDRESS as `0x${string}` | undefined;
const INPUT_TOKEN = process.env.INPUT_TOKEN as `0x${string}` | undefined;
const INPUT_AMOUNT = process.env.INPUT_AMOUNT as string | undefined;
const POOL_ADDRESS = process.env.POOL_ADDRESS as `0x${string}` | undefined;

const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// Minimal ERC20 ABI
const ERC20_ABI = [
    { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
    { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
    { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

function requiredEnv(name: string, value: unknown): asserts value {
    if (value === undefined || value === null || value === "") {
        console.error(`Missing env: ${name}`);
        process.exit(1);
    }
}

requiredEnv("ROUTER_ADDRESS", ROUTER_ADDRESS);
requiredEnv("USER_ADDRESS", USER_ADDRESS);
requiredEnv("INPUT_TOKEN", INPUT_TOKEN);
requiredEnv("INPUT_AMOUNT", INPUT_AMOUNT);
requiredEnv("POOL_ADDRESS", POOL_ADDRESS);

async function main() {
    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient();
    const chainId = await publicClient.getChainId();

    const isYak = ROUTER_TYPE.toLowerCase() === "yak";
    const routerName = isYak ? "YakSharesRouter" : "OdosSharesRouter";
    const isNative = INPUT_TOKEN!.toLowerCase() === NATIVE_ADDRESS.toLowerCase();

    console.log("=".repeat(70));
    console.log("ROUTER SWAP DIAGNOSTICS");
    console.log("=".repeat(70));
    console.log(`Chain ID:      ${chainId}`);
    console.log(`Router:        ${ROUTER_ADDRESS} (${routerName})`);
    console.log(`User:          ${USER_ADDRESS}`);
    console.log(`Input Token:   ${INPUT_TOKEN} ${isNative ? "(NATIVE)" : ""}`);
    console.log(`Input Amount:  ${INPUT_AMOUNT}`);
    console.log(`Pool:          ${POOL_ADDRESS}`);
    console.log("=".repeat(70));

    const router = await viem.getContractAt(routerName, ROUTER_ADDRESS!);
    const pool = await viem.getContractAt("PlayerSharePool", POOL_ADDRESS!);

    let hasError = false;

    // 1. Check if pool is supported on router
    console.log("\n[1] Pool Support Check");
    console.log("-".repeat(50));
    const poolSupported = await router.read.supportedPools([POOL_ADDRESS!]);
    if (poolSupported) {
        console.log("  Pool is supported on router");
    } else {
        console.log("  Pool is NOT supported on router");
        console.log("     Fix: Call router.setPoolSupported(poolAddress, true)");
        hasError = true;
    }

    // 2. Check if token is supported on router
    console.log("\n[2] Token Support Check");
    console.log("-".repeat(50));
    const tokenSupported = await router.read.supportedTokens([INPUT_TOKEN!]);
    if (tokenSupported) {
        console.log("  Token is supported on router");
    } else {
        console.log("  Token is NOT supported on router");
        console.log("     Fix: Call router.setTokenSupported(tokenAddress, true)");
        hasError = true;
    }

    // 3. Check if Yak is used with native token
    if (isYak && isNative) {
        console.log("\n[3] Yak Native Token Check");
        console.log("-".repeat(50));
        console.log("  YakRouter does NOT support native tokens!");
        console.log("     Fix: Use wrapped token (WAVAX/WETH) instead");
        hasError = true;
    }

    // 4. Check user balance and allowance (for ERC20)
    console.log("\n[4] User Balance & Allowance Check");
    console.log("-".repeat(50));

    if (isNative) {
        const balance = await publicClient.getBalance({ address: USER_ADDRESS! });
        const inputAmountWei = parseUnits(INPUT_AMOUNT!, 18);
        console.log(`  Native Balance: ${formatUnits(balance, 18)}`);
        console.log(`  Required:       ${INPUT_AMOUNT}`);
        
        if (balance >= inputAmountWei) {
            console.log("  Sufficient balance");
        } else {
            console.log("  Insufficient balance");
            hasError = true;
        }
        console.log("  Native tokens don't need allowance");
    } else {
        const token = await viem.getContractAt("MockUSDC" as any, INPUT_TOKEN!);
        
        let decimals = 18;
        let symbol = "TOKEN";
        try {
            decimals = await publicClient.readContract({
                address: INPUT_TOKEN!,
                abi: ERC20_ABI,
                functionName: "decimals",
            });
            symbol = await publicClient.readContract({
                address: INPUT_TOKEN!,
                abi: ERC20_ABI,
                functionName: "symbol",
            });
        } catch {
            console.log("  Could not read token decimals/symbol, assuming 18");
        }

        const balance = await publicClient.readContract({
            address: INPUT_TOKEN!,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [USER_ADDRESS!],
        });

        const allowance = await publicClient.readContract({
            address: INPUT_TOKEN!,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [USER_ADDRESS!, ROUTER_ADDRESS!],
        });

        const inputAmountWei = parseUnits(INPUT_AMOUNT!, decimals);

        console.log(`  Token:     ${symbol} (${decimals} decimals)`);
        console.log(`  Balance:   ${formatUnits(balance, decimals)} ${symbol}`);
        console.log(`  Allowance: ${formatUnits(allowance, decimals)} ${symbol}`);
        console.log(`  Required:  ${INPUT_AMOUNT} ${symbol}`);

        if (balance >= inputAmountWei) {
            console.log("  Sufficient balance");
        } else {
            console.log("  Insufficient balance");
            hasError = true;
        }

        if (allowance >= inputAmountWei) {
            console.log("  Sufficient allowance");
        } else {
            console.log("  Insufficient allowance");
            console.log(`     Fix: User must call token.approve(${ROUTER_ADDRESS}, amount)`);
            hasError = true;
        }
    }

    // 5. Check router has admin role on pool
    console.log("\n[5] Router Admin Role Check");
    console.log("-".repeat(50));
    const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
    const hasAdminRole = await pool.read.hasRole([DEFAULT_ADMIN_ROLE, ROUTER_ADDRESS!]);
    
    if (hasAdminRole) {
        console.log("  Router has DEFAULT_ADMIN_ROLE on pool");
    } else {
        console.log("  Router does NOT have admin role on pool");
        console.log("     Fix: Pool admin must call pool.grantRole(0x00, routerAddress)");
        hasError = true;
    }

    // 6. Check treasury has shares
    console.log("\n[6] Treasury Shares Check");
    console.log("-".repeat(50));
    const treasury = await pool.read.treasury();
    const treasuryShares = (await pool.read.balanceOf([treasury])) as bigint;
    const currentPrice = (await pool.read.currentPrice()) as bigint;

    console.log(`  Treasury:        ${treasury}`);
    console.log(`  Treasury Shares: ${formatUnits(treasuryShares, 6)}`);
    console.log(`  Current Price:   ${formatUnits(currentPrice, 6)} USDC per share`);

    if (treasuryShares > 0n) {
        console.log("  Treasury has shares available");
    } else {
        console.log("  Treasury has NO shares");
        console.log("     Fix: Transfer shares to treasury first");
        hasError = true;
    }

    // 7. Check pool USDC address
    console.log("\n[7] Pool USDC Check");
    console.log("-".repeat(50));
    const poolUsdc = (await pool.read.usdc()) as `0x${string}`;
    const routerUsdc = (await router.read.usdc()) as `0x${string}`;
    
    console.log(`  Pool USDC:   ${poolUsdc}`);
    console.log(`  Router USDC: ${routerUsdc}`);

    if (poolUsdc.toLowerCase() === routerUsdc.toLowerCase()) {
        console.log("  USDC addresses match");
    } else {
        console.log("  USDC addresses DON'T match!");
        console.log("     This is a critical configuration error");
        hasError = true;
    }

    // 8. Odos/Yak specific checks
    console.log("\n[8] DEX Aggregator Check");
    console.log("-".repeat(50));
    
    if (isYak) {
        const yakRouter = await router.read.yakRouter();
        console.log(`  Yak Router: ${yakRouter}`);
        console.log("  Make sure to call yakRouter.findBestPathWithGas() off-chain");
        console.log("     to get the swap path before calling claimOrder");
    } else {
        console.log("  Odos Router V3: 0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05");
        console.log("  Make sure to call Odos API to get fresh swap calldata:");
        console.log("     1. POST https://api.odos.xyz/sor/quote/v2");
        console.log("     2. POST https://api.odos.xyz/sor/assemble");
        console.log("     3. Use pathId from quote in assemble request");
        console.log("     4. Calldata expires quickly (~30 sec)");
    }

    // Summary
    console.log("\n" + "=".repeat(70));
    if (hasError) {
        console.log("ISSUES FOUND - Fix the errors above before retrying");
    } else {
        console.log("ALL CHECKS PASSED");
        console.log("\nIf swap still fails, the issue is likely:");
        console.log("  - Odos/Yak calldata expired (regenerate fresh quote)");
        console.log("  - Slippage too tight (increase minUsdcOut tolerance)");
        console.log("  - Insufficient DEX liquidity for this pair/amount");
    }
    console.log("=".repeat(70));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
