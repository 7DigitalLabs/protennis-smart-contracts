import "dotenv/config";
import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import { parseUnits } from "viem";

// Usage:
//   yarn hardhat run scripts/deployPlayerSharePool.ts --network baseSepolia
// Required env vars (see env.example):
//   ADMIN_ADDRESS
//   CSP_TARGET_RAISE
//   CSP_TREASURY_ADDRESS
//   CSP_PRICES           (e.g.: 0.0075,0.0100,0.0125)
//   CSP_SHARE_COUNTS     (e.g.: 16162,32323,48485)
//   CSP_USDC_ADDRESS     (on-chain token used for the pool)
// Optional:
//   ORDER_SIGNER_ADDRESS
//   REGISTRY_ADDRESS
//   PLAYER_ID (UUIDv4)

const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS as `0x${string}` | undefined;
const CSP_TARGET_RAISE = process.env.CSP_TARGET_RAISE;
const CSP_TREASURY_ADDRESS = process.env.CSP_TREASURY_ADDRESS as `0x${string}` | undefined;
const CSP_PRICES = process.env.CSP_PRICES;
const CSP_SHARE_COUNTS = process.env.CSP_SHARE_COUNTS;
const CSP_USDC_ADDRESS = process.env.CSP_USDC_ADDRESS as `0x${string}` | undefined;
const ORDER_SIGNER_ADDRESS = process.env.ORDER_SIGNER_ADDRESS as `0x${string}` | undefined;
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS as `0x${string}` | undefined;
const PLAYER_ID = process.env.PLAYER_ID as string | undefined;

function requiredEnv(name: string, value: unknown): asserts value {
    if (value === undefined || value === null || value === "") {
        console.error(`Missing env: ${name}`);
        process.exit(1);
    }
}

requiredEnv("ADMIN_ADDRESS", ADMIN_ADDRESS);
requiredEnv("CSP_TARGET_RAISE", CSP_TARGET_RAISE);
requiredEnv("CSP_TREASURY_ADDRESS", CSP_TREASURY_ADDRESS);
requiredEnv("CSP_PRICES", CSP_PRICES);
requiredEnv("CSP_SHARE_COUNTS", CSP_SHARE_COUNTS);
requiredEnv("CSP_USDC_ADDRESS", CSP_USDC_ADDRESS);

function parseDecimalCsvToWei(csv: string): bigint[] {
    // Accepts formats: "0.0075,0.0100" or JSON "[0.0075, 0.0100]"
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
    // Accepts formats: "16162,32323" or JSON "[16162, 32323]"
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

const prices = parseDecimalCsvToWei(CSP_PRICES!);
const shareQuantities = parseCountsCsvToWei(CSP_SHARE_COUNTS!);

if (prices.length === 0 || prices.length !== shareQuantities.length) {
    console.error(
        `Invalid seeding bins: PRICES(${prices.length}) vs SHARE_COUNTS(${shareQuantities.length})`
    );
    process.exit(1);
}

const targetRaise = parseUnits(CSP_TARGET_RAISE!, 6);

const { viem } = await network.connect();

console.log("Deploying PlayerSharePool...");

const pool = await viem.deployContract("PlayerSharePool", [
    ADMIN_ADDRESS!,
    ORDER_SIGNER_ADDRESS!,
    CSP_USDC_ADDRESS!,
    CSP_TREASURY_ADDRESS!,
    targetRaise,
    prices,
    shareQuantities,
], { confirmations: 2 });

console.log("PlayerSharePool deployed at:", pool.address);

// Verify on explorer (Basescan/Etherscan via hardhat-verify)
try {
    console.log("Verifying PlayerSharePool on explorer...");
    await verifyContract(
        {
            address: pool.address,
            constructorArgs: [
                ADMIN_ADDRESS!,
                ORDER_SIGNER_ADDRESS!,
                CSP_USDC_ADDRESS!,
                CSP_TREASURY_ADDRESS!,
                targetRaise,
                prices,
                shareQuantities,
            ],
            contract: "contracts/pool/PlayerSharePool.sol:PlayerSharePool",
        },
        hre as any
    );
    console.log("Verification submitted.");
} catch (err) {
    console.warn("Verification failed (possibly already verified):", (err as Error).message);
}

// Useful info / roles
const orderSignerRole = await pool.read.ORDER_SIGNER_ROLE();
if (ORDER_SIGNER_ADDRESS) {
    const hasSigner = await pool.read.hasRole([orderSignerRole, ORDER_SIGNER_ADDRESS]);
    console.log("ORDER_SIGNER_ADDRESS has role:", hasSigner);
    if (!hasSigner) {
        console.log(
            "Note: you can assign the role with grantRole(ORDER_SIGNER_ROLE, ORDER_SIGNER_ADDRESS) using the admin."
        );
    }
}

// Optional registration on the Registry
if (REGISTRY_ADDRESS && PLAYER_ID) {
    console.log("Registering pool on PlayerSharePoolRegistry...", REGISTRY_ADDRESS);
    const registry = await viem.getContractAt(
        "PlayerSharePoolRegistry",
        REGISTRY_ADDRESS
    );
    try {
        function uuidToBytes16(uuid: string): `0x${string}` {
            const hex = uuid.replace(/-/g, "").toLowerCase();
            if (!/^([0-9a-f]{32})$/.test(hex)) {
                throw new Error("PLAYER_ID is not a valid UUIDv4");
            }
            return ("0x" + hex) as `0x${string}`;
        }
        const txHash = await registry.write.register([
            uuidToBytes16(PLAYER_ID!),
            pool.address,
        ]);
        console.log("Registry.register tx:", txHash);
    } catch (err) {
        console.warn("Registry.register failed:", (err as Error).message);
    }
}


