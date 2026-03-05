import "dotenv/config";
import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";

// Usage:
//   yarn hardhat run scripts/deployYakSharesRouter.ts --network avalanche
//
// Required env vars:
//   ADMIN_ADDRESS           - Router admin
//   ORDER_SIGNER_ADDRESS    - Authorized signer for EIP-712 orders
//   CSP_TREASURY_ADDRESS    - Treasury that receives USDC and holds shares
//   CSP_USDC_ADDRESS        - USDC address on the target chain
//
// Optional:
//   ROUTER_SPREAD_BPS       - Spread in basis points (default: 100 = 1%)
//   YAK_ROUTER_ADDRESS      - Override YakRouter address

// YakRouter addresses by chain
// Source: https://github.com/yieldyak/yak-aggregator
const YAK_ROUTER_ADDRESSES: Record<number, `0x${string}`> = {
    43114: "0xC4729E56b831d74bBc18797e0e17A295fA77488c",  // Avalanche
    42161: "0xb32C79a25291265eF240Eb32E9faBbc6DcEE3cE3",  // Arbitrum
    10: "0xCd887F78c77b36B0b541E77AfD6F91C0253182A2",     // Optimism
};

const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS as `0x${string}` | undefined;
const ORDER_SIGNER_ADDRESS = process.env.ORDER_SIGNER_ADDRESS as `0x${string}` | undefined;
const CSP_TREASURY_ADDRESS = process.env.CSP_TREASURY_ADDRESS as `0x${string}` | undefined;
const CSP_USDC_ADDRESS = process.env.CSP_USDC_ADDRESS as `0x${string}` | undefined;
const ROUTER_SPREAD_BPS = process.env.ROUTER_SPREAD_BPS ?? "100"; // Default 1%
const YAK_ROUTER_OVERRIDE = process.env.YAK_ROUTER_ADDRESS as `0x${string}` | undefined;

function requiredEnv(name: string, value: unknown): asserts value {
    if (value === undefined || value === null || value === "") {
        console.error(`Missing env: ${name}`);
        process.exit(1);
    }
}

requiredEnv("ADMIN_ADDRESS", ADMIN_ADDRESS);
requiredEnv("ORDER_SIGNER_ADDRESS", ORDER_SIGNER_ADDRESS);
requiredEnv("CSP_TREASURY_ADDRESS", CSP_TREASURY_ADDRESS);
requiredEnv("CSP_USDC_ADDRESS", CSP_USDC_ADDRESS);

const { viem } = await network.connect();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();

// Determine YakRouter address
const yakRouterAddress = YAK_ROUTER_OVERRIDE ?? YAK_ROUTER_ADDRESSES[chainId];
if (!yakRouterAddress) {
    console.error(`YakRouter not found for chain ${chainId}.`);
    console.error("Supported chains: Avalanche (43114), Arbitrum (42161), Optimism (10)");
    console.error("Or set YAK_ROUTER_ADDRESS manually.");
    process.exit(1);
}

const spreadBps = BigInt(ROUTER_SPREAD_BPS);
if (spreadBps > 500n) {
    console.error("ROUTER_SPREAD_BPS cannot exceed 500 (5%)");
    process.exit(1);
}

console.log("=".repeat(60));
console.log("Deploying YakSharesRouter (Yield Yak DEX Aggregator)");
console.log("=".repeat(60));
console.log("Chain ID:", chainId);
console.log("Admin:", ADMIN_ADDRESS);
console.log("Order Signer:", ORDER_SIGNER_ADDRESS);
console.log("YakRouter:", yakRouterAddress);
console.log("USDC:", CSP_USDC_ADDRESS);
console.log("Treasury:", CSP_TREASURY_ADDRESS);
console.log("Spread:", spreadBps.toString(), "bps");
console.log("=".repeat(60));

const router = await viem.deployContract("YakSharesRouter", [
    ADMIN_ADDRESS!,
    ORDER_SIGNER_ADDRESS!,
    yakRouterAddress,
    CSP_USDC_ADDRESS!,
    CSP_TREASURY_ADDRESS!,
    spreadBps,
], { confirmations: 2 });

console.log("\nYakSharesRouter deployed at:", router.address);

// Verify on explorer
try {
    console.log("\nVerifying YakSharesRouter on explorer...");
    await verifyContract(
        {
            address: router.address,
            constructorArgs: [
                ADMIN_ADDRESS!,
                ORDER_SIGNER_ADDRESS!,
                yakRouterAddress,
                CSP_USDC_ADDRESS!,
                CSP_TREASURY_ADDRESS!,
                spreadBps,
            ],
            contract: "contracts/broker/YakSharesRouter.sol:YakSharesRouter",
        },
        hre as any
    );
    console.log("Verification submitted.");
} catch (err) {
    console.warn("Verification failed (possibly already verified):", (err as Error).message);
}

console.log("\n" + "=".repeat(60));
console.log("NEXT STEPS:");
console.log("=".repeat(60));
console.log(`
1. Grant DEFAULT_ADMIN_ROLE on the router to each PlayerSharePool:
   
   await playerSharePool.grantRole(
       await playerSharePool.DEFAULT_ADMIN_ROLE(),
       "${router.address}"
   );

2. Enable supported pools:
   
   await router.write.setPoolSupported([poolAddress, true]);

3. Enable input tokens (NO native ETH, use WETH):
   
   await router.write.setTokenSupported([wethAddress, true]);
   await router.write.setTokenSupported([usdtAddress, true]);

4. Configure the backend to generate orders using:
   - yakRouter.findBestPathWithGas() to get path and adapters
   - Sign EIP-712 order
`);

// Verify roles
const orderSignerRole = await router.read.ORDER_SIGNER_ROLE();
const hasSigner = await router.read.hasRole([orderSignerRole, ORDER_SIGNER_ADDRESS!]);
console.log("ORDER_SIGNER has role:", hasSigner);

const domainSeparator = await router.read.domainSeparator();
console.log("\nEIP-712 Domain Separator:", domainSeparator);
