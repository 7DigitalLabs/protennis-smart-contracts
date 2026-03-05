import { network } from "hardhat";
import { parseUnits, toHex, type Address } from "viem";

const RAFFLE_ADDRESS = process.env.RAFFLE_ADDRESS as `0x${string}`;
const ACTION = process.env.ACTION;
const ARG1 = process.env.ARG1;
const ARG2 = process.env.ARG2;

// Minimal ABI for admin functions
const RAFFLE_ABI = [
    // View functions
    {
        name: "currentPhase",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint8" }]
    },
    {
        name: "totalTickets",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        name: "totalDeposited",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        name: "depositStartTime",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        name: "depositEndTime",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        name: "depositDuration",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        name: "drawnWinnersCount",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        name: "winnersRoot",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "bytes32" }]
    },
    {
        name: "getParticipantCount",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    // Admin functions
    {
        name: "startDeposit",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "startTime", type: "uint256" }],
        outputs: []
    },
    {
        name: "setDepositDuration",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "duration", type: "uint256" }],
        outputs: []
    },
    {
        name: "closeDeposits",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: []
    },
    {
        name: "setRandomSeed",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "seed", type: "bytes" }],
        outputs: []
    },
    {
        name: "commitWinners",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "merkleRoot", type: "bytes32" },
            { name: "totalWinners", type: "uint256" }
        ],
        outputs: []
    },
    {
        name: "closeRaffle",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: []
    },
    {
        name: "withdrawPrizePool",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: []
    },
    {
        name: "pause",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: []
    },
    {
        name: "unpause",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: []
    }
] as const;

const PHASE_NAMES = ["Inactive", "Deposit", "Drawing", "Claiming", "Closed"];

async function main() {
    if (!RAFFLE_ADDRESS) {
        throw new Error("RAFFLE_ADDRESS must be set in environment");
    }

    const action = ACTION;
    
    if (!action) {
        console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                   RefundableRaffle Manager                         ║
╠═══════════════════════════════════════════════════════════════════╣
║  Usage (PowerShell):                                               ║
║    $env:RAFFLE_ADDRESS="0x..."; $env:ACTION="status"               ║
║    npx hardhat run scripts/manageRaffle.ts --network sepolia       ║
╠═══════════════════════════════════════════════════════════════════╣
║  Actions (set via $env:ACTION):                                    ║
║    status              - Show current raffle status                ║
║    set-duration        - Set deposit duration (ARG1=seconds)       ║
║    start               - Start now or schedule (ARG1=timestamp)    ║
║    close-deposits      - Close deposits (after duration ends)      ║
║    set-seed            - Set random seed (ARG1=hex seed)           ║
║    commit              - Commit winners (ARG1=root, ARG2=count)    ║
║    close               - Close raffle                              ║
║    withdraw            - Withdraw prize pool                       ║
║    pause               - Pause raffle                              ║
║    unpause             - Unpause raffle                            ║
╚═══════════════════════════════════════════════════════════════════╝
        `);
        return;
    }

    const { viem } = await network.connect();
    const [admin] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    console.log("\nRefundableRaffle Manager");
    console.log("═══════════════════════════════════════");
    console.log("Contract:", RAFFLE_ADDRESS);
    console.log("Admin:", admin.account.address);
    console.log("═══════════════════════════════════════\n");

    // Helper to read state
    async function getStatus() {
        const [phase, totalTickets, totalDeposited, depositStartTime, depositEndTime, depositDuration, participants, drawnWinners, winnersRoot] = await Promise.all([
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "currentPhase" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "totalTickets" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "totalDeposited" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "depositStartTime" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "depositEndTime" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "depositDuration" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "getParticipantCount" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "drawnWinnersCount" }),
            publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "winnersRoot" }),
        ]);

        return { phase, totalTickets, totalDeposited, depositStartTime, depositEndTime, depositDuration, participants, drawnWinners, winnersRoot };
    }

    switch (action) {
        case "status": {
            const status = await getStatus();
            const now = BigInt(Math.floor(Date.now() / 1000));
            const startTime = status.depositStartTime as bigint;
            const endTime = status.depositEndTime as bigint;
            const duration = status.depositDuration as bigint;
            const durationDays = Number(duration) / 86400;
            
            // Time until start (if scheduled)
            const untilStart = startTime > now ? startTime - now : 0n;
            const startDays = untilStart / 86400n;
            const startHours = (untilStart % 86400n) / 3600n;
            const startMins = (untilStart % 3600n) / 60n;
            
            // Time until end
            const remaining = endTime > now ? endTime - now : 0n;
            const days = remaining / 86400n;
            const hours = (remaining % 86400n) / 3600n;
            const mins = (remaining % 3600n) / 60n;

            console.log("Current Status:");
            console.log("─────────────────────────────────────");
            console.log(`Phase:           ${PHASE_NAMES[Number(status.phase)]} (${status.phase})`);
            console.log(`Total Tickets:   ${status.totalTickets}`);
            console.log(`Total Deposited: ${Number(status.totalDeposited) / 1e6} USDC`);
            console.log(`Participants:    ${status.participants}`);
            console.log(`Winners Drawn:   ${status.drawnWinners}`);
            console.log(`Duration:        ${durationDays} days`);
            if (startTime > 0n) {
                console.log(`Deposit Starts:  ${new Date(Number(startTime) * 1000).toISOString()}`);
                if (untilStart > 0n) {
                    console.log(`Time to Start:   ${startDays}d ${startHours}h ${startMins}m`);
                }
            }
            if (endTime > 0n) {
                console.log(`Deposit Ends:    ${new Date(Number(endTime) * 1000).toISOString()}`);
                if (remaining > 0n && now >= startTime) {
                    console.log(`Time Remaining:  ${days}d ${hours}h ${mins}m`);
                } else if (now >= endTime) {
                    console.log(`Time Remaining:  ENDED`);
                }
            }
            if (status.winnersRoot !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
                console.log(`Winners Root:    ${status.winnersRoot}`);
            }
            break;
        }

        case "set-duration": {
            if (!ARG1) {
                console.error("Error: ARG1 (duration in seconds) required");
                console.log("Example: $env:ARG1=\"604800\" (7 days)");
                process.exit(1);
            }
            const durationSecs = BigInt(ARG1);
            console.log(`Setting deposit duration to ${Number(durationSecs) / 86400} days (${durationSecs}s)...`);
            const hash = await admin.writeContract({
                address: RAFFLE_ADDRESS,
                abi: RAFFLE_ABI,
                functionName: "setDepositDuration",
                args: [durationSecs],
                account: admin.account
            });
            console.log("Tx Hash:", hash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log("Duration set! Status:", receipt.status);
            break;
        }

        case "start": {
            // ARG1 = Unix timestamp (optional, 0 = now)
            const startTime = ARG1 ? BigInt(ARG1) : 0n;
            if (startTime === 0n) {
                console.log("Starting deposit phase NOW...");
            } else {
                console.log(`Scheduling deposit phase for ${new Date(Number(startTime) * 1000).toISOString()}...`);
            }
            const hash = await admin.writeContract({
                address: RAFFLE_ADDRESS,
                abi: RAFFLE_ABI,
                functionName: "startDeposit",
                args: [startTime],
                account: admin.account
            });
            console.log("Tx Hash:", hash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log("Deposit phase scheduled! Status:", receipt.status);
            
            const [depositStart, depositEnd] = await Promise.all([
                publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "depositStartTime" }),
                publicClient.readContract({ address: RAFFLE_ADDRESS, abi: RAFFLE_ABI, functionName: "depositEndTime" })
            ]);
            console.log("Deposits start at:", new Date(Number(depositStart) * 1000).toISOString());
            console.log("Deposits end at:", new Date(Number(depositEnd) * 1000).toISOString());
            break;
        }

        case "close-deposits": {
            console.log("Closing deposits...");
            const hash = await admin.writeContract({
                address: RAFFLE_ADDRESS,
                abi: RAFFLE_ABI,
                functionName: "closeDeposits",
                account: admin.account
            });
            console.log("Tx Hash:", hash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log("Deposits closed! Status:", receipt.status);
            break;
        }

        case "set-seed": {
            if (!ARG1) {
                console.error("Error: ARG1 (seed) required");
                console.log("Example: $env:ARG1=\"0x1234abcd...\"");
                process.exit(1);
            }
            console.log("Setting random seed:", ARG1);
            const hash = await admin.writeContract({
                address: RAFFLE_ADDRESS,
                abi: RAFFLE_ABI,
                functionName: "setRandomSeed",
                args: [ARG1 as `0x${string}`],
                account: admin.account
            });
            console.log("Tx Hash:", hash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log("Random seed set! Status:", receipt.status);
            break;
        }

        case "commit": {
            if (!ARG1 || !ARG2) {
                console.error("Error: ARG1 (merkleRoot) and ARG2 (totalWinners) required");
                console.log("Example: $env:ARG1=\"0xabcd...\"; $env:ARG2=\"5000\"");
                process.exit(1);
            }
            console.log("Committing winners...");
            console.log("  Merkle Root:", ARG1);
            console.log("  Total Winners:", ARG2);
            const hash = await admin.writeContract({
                address: RAFFLE_ADDRESS,
                abi: RAFFLE_ABI,
                functionName: "commitWinners",
                args: [ARG1 as `0x${string}`, BigInt(ARG2)],
                account: admin.account
            });
            console.log("Tx Hash:", hash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log("Winners committed! Status:", receipt.status);
            break;
        }

        case "close": {
            console.log("Closing raffle...");
            const hash = await admin.writeContract({
                address: RAFFLE_ADDRESS,
                abi: RAFFLE_ABI,
                functionName: "closeRaffle",
                account: admin.account
            });
            console.log("Tx Hash:", hash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log("Raffle closed! Status:", receipt.status);
            break;
        }

        case "withdraw": {
            console.log("Withdrawing prize pool...");
            const hash = await admin.writeContract({
                address: RAFFLE_ADDRESS,
                abi: RAFFLE_ABI,
                functionName: "withdrawPrizePool",
                account: admin.account
            });
            console.log("Tx Hash:", hash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log("Prize pool withdrawn! Status:", receipt.status);
            break;
        }

        case "pause": {
            console.log("Pausing raffle...");
            const hash = await admin.writeContract({
                address: RAFFLE_ADDRESS,
                abi: RAFFLE_ABI,
                functionName: "pause",
                account: admin.account
            });
            console.log("Tx Hash:", hash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log("Raffle paused! Status:", receipt.status);
            break;
        }

        case "unpause": {
            console.log("Unpausing raffle...");
            const hash = await admin.writeContract({
                address: RAFFLE_ADDRESS,
                abi: RAFFLE_ABI,
                functionName: "unpause",
                account: admin.account
            });
            console.log("Tx Hash:", hash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log("Raffle unpaused! Status:", receipt.status);
            break;
        }

        default:
            console.error(`Unknown action: ${action}`);
            console.log("Run without arguments to see available actions.");
            process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error.message || error);
        process.exit(1);
    });
