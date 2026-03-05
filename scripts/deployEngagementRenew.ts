import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";

async function main() {
    // @ts-ignore - hardhat-viem types
    const { viem } = await network.connect();
    const [deployer] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    // Configuration
    const MOCK_USDC = process.env.MOCK_USDC_ADDRESS;
    const USDC = process.env.PROD_USDC_ADDRESS;
    const ORDER_SIGNER = process.env.PROD_ORDER_SIGNER_ADDRESS;
    const TREASURY = process.env.PROD_CSP_TREASURY_ADDRESS;
    const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS || deployer.account.address;

    if (!ORDER_SIGNER) {
        throw new Error("ORDER_SIGNER_ADDRESS is not set in environment");
    }

    if (!TREASURY) {
        throw new Error("TREASURY_ADDRESS is not set in environment");
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
    console.log("║           ENGAGEMENT RENEW - DEPLOY PARAMETERS               ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  Network                                                     ║");
    console.log(`║    Chain ID:    ${String(chainId).padEnd(45)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  Addresses                                                   ║");
    console.log(`║    Deployer:    ${deployer.account.address}   ║`);
    console.log(`║    Admin:       ${(ADMIN_ADDRESS as string).padEnd(45)}║`);
    console.log(`║    OrderSigner: ${ORDER_SIGNER.padEnd(45)}║`);
    console.log(`║    Treasury:    ${TREASURY.padEnd(45)}║`);
    console.log(`║    USDC:        ${usdcAddress}   ║`);
    console.log(`║    USDC Type:   ${usdcType.padEnd(45)}║`);
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  Roles granted to Admin                                      ║");
    console.log("║    ✓ DEFAULT_ADMIN_ROLE                                      ║");
    console.log("║    ✓ ADMIN_ROLE                                              ║");
    console.log("║    ✓ ORDER_SIGNER_ROLE                                       ║");
    console.log("║  Roles granted to OrderSigner                                ║");
    console.log("║    ✓ ORDER_SIGNER_ROLE                                       ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log("║  EIP-712 Domain                                              ║");
    console.log("║    Name:    EngagementRenew                                  ║");
    console.log("║    Version: 1                                                ║");
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    console.log("Deploying EngagementRenew...\n");

    // Deploy
    const engagement = await viem.deployContract("EngagementRenew", [
        usdcAddress,
        ADMIN_ADDRESS as `0x${string}`,
        ORDER_SIGNER as `0x${string}`,
        TREASURY as `0x${string}`
    ]);

    console.log("╔══════════════════════════════════════════════════════════════╗");
    console.log("║                DEPLOY COMPLETED SUCCESSFULLY!                ║");
    console.log("╠══════════════════════════════════════════════════════════════╣");
    console.log(`║  Contract:  ${engagement.address}   ║`);
    console.log("╚══════════════════════════════════════════════════════════════╝\n");

    // Verify deployment
    const treasury = await engagement.read.treasury() as `0x${string}`;
    console.log("Treasury check:", treasury.toLowerCase() === TREASURY.toLowerCase() ? "Correct" : "Mismatch");

    // Verify on explorer (only if not local hardhat)
    if (chainId !== 31337) {
        console.log("\nVerifying contract on explorer...\n");
        
        try {
            // Wait a few blocks for propagation
            console.log("Waiting 30 seconds for propagation...");
            await new Promise(resolve => setTimeout(resolve, 30000));
            
            await verifyContract({
                address: engagement.address,
                constructorArgs: [
                    usdcAddress,
                    ADMIN_ADDRESS,
                    ORDER_SIGNER,
                    TREASURY
                ],
                contract: "contracts/engagement/EngagementRenew.sol:EngagementRenew",
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
                console.log(`   npx hardhat verify --network <network> ${engagement.address} ${usdcAddress} ${ADMIN_ADDRESS} ${ORDER_SIGNER} ${TREASURY}\n`);
            }
        }
    } else {
        console.log("\nLocal network, explorer verification skipped.\n");
    }

    return engagement.address;
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
