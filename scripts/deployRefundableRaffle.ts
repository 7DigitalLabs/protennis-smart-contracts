import hre, { network } from "hardhat";
import * as readline from "readline";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";

function askConfirmation(question: string): Promise<boolean> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
        });
    });
}

async function main() {
    // @ts-ignore - hardhat-viem types
    const { viem } = await network.connect();
    const [deployer] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    // Configuration
    const MOCK_USDC = process.env.MOCK_USDC_ADDRESS;
    const USDC = process.env.USDC_ADDRESS;
    const ORDER_SIGNER = process.env.ORDER_SIGNER_ADDRESS;
    const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS || deployer.account.address;

    if (!ORDER_SIGNER) {
        throw new Error("ORDER_SIGNER_ADDRESS is not set in environment");
    }

    let usdcAddress: `0x${string}`;
    let usdcType: string;

    if (MOCK_USDC && !USDC) {
        usdcAddress = MOCK_USDC as `0x${string}`;
        usdcType = "MockUSDC (Testnet)";
    } else if (USDC) {
        usdcAddress = USDC as `0x${string}`;
        usdcType = "USDC (Mainnet)";
    } else {
        throw new Error("MOCK_USDC_ADDRESS or USDC_ADDRESS must be set in environment");
    }

    const chainId = await publicClient.getChainId();

    // Show deploy parameters
    console.log("\n╔══════════════════════════════════════════════════════════════╗");
    console.log("║           REFUNDABLE RAFFLE - DEPLOY PARAMETERS              ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  Network                                                     ║");
    console.log(`║    Chain ID:    ${String(chainId).padEnd(45)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  Addresses                                                   ║");
    console.log(`║    Deployer:    ${deployer.account.address}   ║`);
    console.log(`║    Admin:       ${(ADMIN_ADDRESS as string).padEnd(45)}║`);
    console.log(`║    OrderSigner: ${ORDER_SIGNER.padEnd(45)}║`);
    console.log(`║    USDC:        ${usdcAddress}   ║`);
    console.log(`║    USDC Type:   ${usdcType.padEnd(45)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  Contract Constants                                          ║");
    console.log("║    Ticket Price:          20 USDC                            ║");
    console.log("║    Max Winners:           50,000                             ║");
    console.log("║    Max Tickets/Order:     100                                ║");
    console.log("║    Default Duration:      7 days                             ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  Roles granted to Admin                                      ║");
    console.log("║    ✓ DEFAULT_ADMIN_ROLE                                      ║");
    console.log("║    ✓ ADMIN_ROLE                                              ║");
    console.log("║    ✓ OPERATOR_ROLE                                           ║");
    console.log("║    ✓ ORDER_SIGNER_ROLE                                       ║");
    console.log("║  Roles granted to OrderSigner                                ║");
    console.log("║    ✓ ORDER_SIGNER_ROLE                                       ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  EIP-712 Domain                                              ║");
    console.log("║    Name:    RefundableRaffle                                 ║");
    console.log("║    Version: 1                                                ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    // Ask for confirmation
    const confirmed = await askConfirmation("Proceed with deployment? (y/n): ");

    if (!confirmed) {
        console.log("\nDeploy cancelled.\n");
        process.exit(0);
    }

    console.log("\nDeploying RefundableRaffle...\n");

    // Deploy
    const raffle = await viem.deployContract("RefundableRaffle", [
        usdcAddress,
        ADMIN_ADDRESS as `0x${string}`,
        ORDER_SIGNER as `0x${string}`
    ]);

    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║                DEPLOY COMPLETED SUCCESSFULLY!                ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Contract:  ${raffle.address}   ║`);
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    // Verify deployment
    const phase = await raffle.read.currentPhase();
    console.log("Phase check:", phase === 0 ? "Inactive (correct)" : "Unexpected phase");

    // Verify on explorer (only if not local hardhat)
    if (chainId !== 31337) {
        console.log("\nVerifying contract on explorer...\n");
        
        try {
            // Wait a few blocks for propagation
            console.log("Waiting 30 seconds for propagation...");
            await new Promise(resolve => setTimeout(resolve, 30000));
            
            
            await verifyContract({
                address: raffle.address,
                constructorArgs: [
                    usdcAddress,
                    ADMIN_ADDRESS,
                    ORDER_SIGNER
                ],
                contract: "contracts/raffle/RefundableRaffle.sol:RefundableRaffle",
            }, hre as any);
            
            console.log("╔══════════════════════════════════════════════════════════════╗");
            console.log("║                CONTRACT VERIFIED SUCCESSFULLY!               ║");
            console.log("╚══════════════════════════════════════════════════════════════╝\n");
        } catch (error: any) {
            if (error.message.includes("Already Verified")) {
                console.log("Contract already verified.\n");
            } else {
                console.error("Error during verification:", error.message);
                console.log("\nYou can verify manually with:");
                console.log(`   npx hardhat verify --network <network name> ${raffle.address} ${usdcAddress} ${ADMIN_ADDRESS} ${ORDER_SIGNER}\n`);
            }
        }
    } else {
        console.log("\nLocal network, explorer verification skipped.\n");
    }

    return raffle.address;
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
