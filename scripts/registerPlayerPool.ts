import "dotenv/config";
import { network } from "hardhat";

// Usage:
//  yarn hardhat run scripts/registerPlayerPool.ts --network baseSepolia
// Required env vars:
//  REGISTRY_ADDRESS
//  PLAYER_ID (UUIDv4, e.g.: 123e4567-e89b-12d3-a456-426614174000)
//  POOL_ADDRESS

const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS as `0x${string}` | undefined;
const PLAYER_ID = process.env.PLAYER_ID as string | undefined;
const POOL_ADDRESS = process.env.POOL_ADDRESS as `0x${string}` | undefined;

function requiredEnv(name: string, value: unknown): asserts value {
    if (value === undefined || value === null || value === "") {
        console.error(`Missing env: ${name}`);
        process.exit(1);
    }
}

requiredEnv("REGISTRY_ADDRESS", REGISTRY_ADDRESS);
requiredEnv("PLAYER_ID", PLAYER_ID);
requiredEnv("POOL_ADDRESS", POOL_ADDRESS);

function uuidToBytes16(uuid: string): `0x${string}` {
    // Remove dashes and validate length: 32 hex chars (16 bytes)
    const hex = uuid.replace(/-/g, "").toLowerCase();
    if (!/^([0-9a-f]{32})$/.test(hex)) {
        console.error("PLAYER_ID is not a valid UUIDv4 (expected 32 hex chars after removing dashes)");
        process.exit(1);
    }
    return ("0x" + hex) as `0x${string}`;
}

const { viem } = await network.connect();

console.log("Registering playerId -> pool on registry...");

const registry = await viem.getContractAt(
    "PlayerSharePoolRegistry",
    REGISTRY_ADDRESS!
);

try {
    const txHash = await registry.write.register([
        uuidToBytes16(PLAYER_ID!),
        POOL_ADDRESS!,
    ]);
    console.log("Registry.register tx:", txHash);
} catch (err) {
    console.error("Registry.register failed:", (err as Error).message);
    process.exit(1);
}
