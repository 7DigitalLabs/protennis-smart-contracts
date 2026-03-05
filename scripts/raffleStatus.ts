import "dotenv/config";
import { network } from "hardhat";

const RAFFLE_ADDRESS = process.env.RAFFLE_ADDRESS as `0x${string}`;
if (!RAFFLE_ADDRESS) {
    console.error("Missing env: RAFFLE_ADDRESS");
    process.exit(1);
}

const RAFFLE_ABI = [
    { name: "currentPhase", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    { name: "totalTickets", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "totalDeposited", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "depositStartTime", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "depositEndTime", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "getParticipantCount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "drawnWinnersCount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const PHASE_NAMES = ["Inactive", "Deposit", "Drawing", "Claiming", "Closed"];

async function main() {
    const { viem } = await network.connect();
    const publicClient = await viem.getPublicClient();

    console.log("\nRaffle Status");
    console.log("═══════════════════════════════════════");
    console.log("Contract:", RAFFLE_ADDRESS);

    try {
        const [phase, totalTickets, totalDeposited, depositStartTime, depositEndTime, participants, drawnWinners] = await Promise.all([
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "currentPhase" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "totalTickets" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "totalDeposited" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "depositStartTime" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "depositEndTime" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "getParticipantCount" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "drawnWinnersCount" }),
        ]);

        const now = BigInt(Math.floor(Date.now() / 1000));

        console.log(`\nPhase:           ${PHASE_NAMES[Number(phase)]} (${phase})`);
        console.log(`Total Tickets:   ${totalTickets}`);
        console.log(`Total Deposited: ${Number(totalDeposited) / 1e6} USDC`);
        console.log(`Participants:    ${participants}`);
        console.log(`Winners Drawn:   ${drawnWinners}`);
        
        if (depositStartTime > 0n) {
            console.log(`Deposit Start:   ${new Date(Number(depositStartTime) * 1000).toISOString()}`);
        }
        if (depositEndTime > 0n) {
            console.log(`Deposit End:     ${new Date(Number(depositEndTime) * 1000).toISOString()}`);
            if (now >= depositEndTime) {
                console.log(`                 DEPOSITS ENDED`);
            }
        }

        console.log("\n═══════════════════════════════════════\n");
    } catch (e: any) {
        console.error("Error:", e.message);
    }
}

main().then(() => process.exit(0)).catch(console.error);
