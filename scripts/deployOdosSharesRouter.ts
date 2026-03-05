import "dotenv/config";
import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";

// Usage:
//   yarn hardhat run scripts/deployOdosSharesRouter.ts --network base
//
// Required env vars:
//   ADMIN_ADDRESS           - Router admin
//   ORDER_SIGNER_ADDRESS    - Authorized signer for EIP-712 orders
//   CSP_TREASURY_ADDRESS    - Treasury that receives USDC and holds shares
//   CSP_USDC_ADDRESS        - USDC address on the target chain
//
// Optional:
//   ROUTER_SPREAD_BPS       - Spread in basis points (default: 100 = 1%)

// Odos Router V3 - Unified address across ALL supported EVM chains
// Source: https://docs.odos.xyz/build/contracts
// Audited by Zellic (2025)
const ODOS_ROUTER_V3 = "0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05";

const ADMIN_ADDRESS = process.env.PROD_ADMIN_ADDRESS as `0x${string}` | undefined;
const ORDER_SIGNER_ADDRESS = process.env.PROD_ORDER_SIGNER_ADDRESS as `0x${string}` | undefined;
const CSP_TREASURY_ADDRESS = process.env.PROD_CSP_TREASURY_ADDRESS as `0x${string}` | undefined;
const PROD_USDC_ADDRESS = process.env.PROD_USDC_ADDRESS as `0x${string}` | undefined;
const ROUTER_SPREAD_BPS = process.env.ROUTER_SPREAD_BPS ?? "100"; // Default 1%

function requiredEnv(name: string, value: unknown): asserts value {
    if (value === undefined || value === null || value === "") {
        console.error(`Missing env: ${name}`);
        process.exit(1);
    }
}

requiredEnv("ADMIN_ADDRESS", ADMIN_ADDRESS);
requiredEnv("ORDER_SIGNER_ADDRESS", ORDER_SIGNER_ADDRESS);
requiredEnv("CSP_TREASURY_ADDRESS", CSP_TREASURY_ADDRESS);
requiredEnv("PROD_USDC_ADDRESS", PROD_USDC_ADDRESS);

const { viem } = await network.connect();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();

const spreadBps = BigInt(ROUTER_SPREAD_BPS);
if (spreadBps > 500n) {
    console.error("ROUTER_SPREAD_BPS cannot exceed 500 (5%)");
    process.exit(1);
}

console.log("=".repeat(60));
console.log("Deploying OdosSharesRouter (Odos Router V3)");
console.log("=".repeat(60));
console.log("Chain ID:", chainId);
console.log("Admin:", ADMIN_ADDRESS);
console.log("Order Signer:", ORDER_SIGNER_ADDRESS);
console.log("Odos Router V3:", ODOS_ROUTER_V3, "(hardcoded, same on all chains)");
console.log("USDC:", PROD_USDC_ADDRESS);
console.log("Treasury:", CSP_TREASURY_ADDRESS);
console.log("Spread:", spreadBps.toString(), "bps");
console.log("=".repeat(60));

const router = await viem.deployContract("OdosSharesRouter", [
    ADMIN_ADDRESS!,
    ORDER_SIGNER_ADDRESS!,
    PROD_USDC_ADDRESS!,
    CSP_TREASURY_ADDRESS!,
    spreadBps,
], { confirmations: 2 });

console.log("\nOdosSharesRouter deployed at:", router.address);

// Verify on explorer
try {
    console.log("\nVerifying OdosSharesRouter on explorer...");
    await verifyContract(
        {
            address: router.address,
            constructorArgs: [
                ADMIN_ADDRESS!,
                ORDER_SIGNER_ADDRESS!,
                PROD_USDC_ADDRESS!,
                CSP_TREASURY_ADDRESS!,
                spreadBps,
            ],
            contract: "contracts/broker/OdosSharesRouter.sol:OdosSharesRouter",
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

3. Enable input tokens (address(0) = native ETH):
   
   await router.write.setTokenSupported(["0x0000000000000000000000000000000000000000", true]); // ETH
   await router.write.setTokenSupported([wethAddress, true]); // WETH
   await router.write.setTokenSupported([usdtAddress, true]); // USDT

4. Configure the backend to generate orders using the Odos API:
   - POST /sor/quote/v2 to get quotes
   - POST /sor/assemble to get transaction.data
   - Sign EIP-712 order
`);

// Verify roles
const orderSignerRole = await router.read.ORDER_SIGNER_ROLE();
const hasSigner = await router.read.hasRole([orderSignerRole, ORDER_SIGNER_ADDRESS!]);
console.log("ORDER_SIGNER has role:", hasSigner);

const domainSeparator = await router.read.domainSeparator();
console.log("\nEIP-712 Domain Separator:", domainSeparator);
