import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { keccak256, encodePacked, getAddress } from "viem";

/**
 * Script to generate the winners' Merkle tree off-chain.
 * 
 * Flow:
 * 1. Read all participants and their tickets from the contract
 * 2. Draw 50000 winners with Fisher-Yates using the seed
 * 3. Calculate for each participant: winningCount and refundAmount
 * 4. Generate the Merkle tree
 * 5. Save root and proofs for each user
 */

const TICKET_PRICE = 20n * 10n ** 6n; // 20 USDC (6 decimals)
const WINNING_TICKETS_COUNT = 50_000;

interface ParticipantData {
    address: string;
    ticketIds: number[];
    depositedAmount: bigint;
}

interface WinnerData {
    address: string;
    winningCount: number;
    refundAmount: bigint;
}

/**
 * Partial Fisher-Yates shuffle to draw exactly k unique winners.
 * Uses the same algorithm as the contract to guarantee determinism.
 */
function drawWinners(
    totalTickets: number,
    seedHash: `0x${string}`,
    maxWinners: number
): Set<number> {
    const winners = new Set<number>();
    const shuffleState = new Map<number, number>();

    const getShuffleValue = (index: number): number => {
        return shuffleState.get(index) ?? index;
    };

    const actualWinners = Math.min(maxWinners, totalTickets);
    const n = totalTickets;

    for (let i = 0; i < actualWinners; i++) {
        // Exact replica of the Solidity logic
        const hash = keccak256(
            encodePacked(["bytes32", "uint256"], [seedHash, BigInt(i)])
        );
        const hashBigInt = BigInt(hash);
        const j = i + Number(hashBigInt % BigInt(n - i));

        const valueAtI = getShuffleValue(i);
        const valueAtJ = getShuffleValue(j);

        shuffleState.set(i, valueAtJ);
        shuffleState.set(j, valueAtI);

        // The ticket at position i is a winner
        winners.add(valueAtJ);
    }

    return winners;
}

/**
 * Calculates winning data for each participant.
 */
function calculateWinnerData(
    participants: ParticipantData[],
    winningTicketIds: Set<number>
): WinnerData[] {
    const results: WinnerData[] = [];

    for (const participant of participants) {
        const winningCount = participant.ticketIds.filter((id) =>
            winningTicketIds.has(id)
        ).length;

        const losingTickets = participant.ticketIds.length - winningCount;
        const refundAmount = BigInt(losingTickets) * TICKET_PRICE;

        results.push({
            address: getAddress(participant.address),
            winningCount,
            refundAmount,
        });
    }

    return results;
}

/**
 * Generates the Merkle tree from winner data using @openzeppelin/merkle-tree.
 * The contract uses the same format: keccak256(bytes.concat(keccak256(abi.encode(...))))
 */
function generateMerkleTree(winnerData: WinnerData[]) {
    const leaves = winnerData.map((w) => [
        w.address,
        w.winningCount.toString(),
        w.refundAmount.toString(),
    ]);

    return StandardMerkleTree.of(leaves, ["address", "uint256", "uint256"]);
}

/**
 * Generates a proof for a single user.
 */
function getProofForUser(
    tree: StandardMerkleTree<string[]>,
    userAddress: string,
    winningCount: number,
    refundAmount: bigint
): string[] {
    const leaf = [
        getAddress(userAddress),
        winningCount.toString(),
        refundAmount.toString(),
    ];

    for (const [i, v] of tree.entries()) {
        if (v[0] === leaf[0] && v[1] === leaf[1] && v[2] === leaf[2]) {
            return tree.getProof(i);
        }
    }

    throw new Error(`User ${userAddress} not found in tree`);
}

// ============ Usage Example ============

async function main() {
    // Demo data -- replace with real seed from env in production
    const seed = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    const seedHash = keccak256(seed as `0x${string}`);

    // Simulate 100 participants with 10 tickets each
    const participants: ParticipantData[] = [];
    let ticketCounter = 0;

    for (let i = 0; i < 100; i++) {
        const ticketIds: number[] = [];
        for (let j = 0; j < 10; j++) {
            ticketIds.push(ticketCounter++);
        }
        participants.push({
            address: `0x${(i + 1).toString(16).padStart(40, "0")}`,
            ticketIds,
            depositedAmount: BigInt(ticketIds.length) * TICKET_PRICE,
        });
    }

    const totalTickets = ticketCounter;
    console.log(`Total tickets: ${totalTickets}`);
    console.log(`Seed hash: ${seedHash}`);

    // Draw winners (max 50000 or totalTickets)
    const winningTicketIds = drawWinners(
        totalTickets,
        seedHash,
        WINNING_TICKETS_COUNT
    );
    console.log(`Winning tickets drawn: ${winningTicketIds.size}`);

    // Calculate data for each participant
    const winnerData = calculateWinnerData(participants, winningTicketIds);
    console.log(`Participants with calculated data: ${winnerData.length}`);

    // Generate Merkle tree
    const tree = generateMerkleTree(winnerData);
    console.log(`Merkle root: ${tree.root}`);

    // Example: generate proof for the first user
    const firstUser = winnerData[0];
    const proof = getProofForUser(
        tree,
        firstUser.address,
        firstUser.winningCount,
        firstUser.refundAmount
    );

    console.log(`\nExample claim for ${firstUser.address}:`);
    console.log(`  winningCount: ${firstUser.winningCount}`);
    console.log(`  refundAmount: ${firstUser.refundAmount}`);
    console.log(`  proof: ${JSON.stringify(proof)}`);

    // Save data for later use
    const output = {
        root: tree.root,
        totalWinners: winningTicketIds.size,
        participants: winnerData.map((w) => ({
            ...w,
            refundAmount: w.refundAmount.toString(),
            proof: getProofForUser(tree, w.address, w.winningCount, w.refundAmount),
        })),
    };

    console.log("\n--- OUTPUT JSON ---");
    console.log(JSON.stringify(output, null, 2));
}

main().catch(console.error);
