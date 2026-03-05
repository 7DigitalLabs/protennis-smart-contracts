import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert";
import { parseUnits, getAddress, toHex, keccak256, type WalletClient, type Address } from "viem";

const { viem } = await network.connect();

const MAX_UINT256 = (1n << 256n) - 1n;

// Helper per generare bytes16 orderId
function generateOrderId(): `0x${string}` {
    const randomBytes = new Uint8Array(16);
    crypto.getRandomValues(randomBytes);
    return toHex(randomBytes) as `0x${string}`;
}

// Helper per firmare un ordine EIP-712
async function signDepositOrder(
    raffle: any,
    signer: WalletClient,
    order: { orderId: `0x${string}`; recipient: Address; usdcAmount: bigint; expiry: bigint }
) {
    const domain = {
        name: "RefundableRaffle",
        version: "1",
        chainId: 31337, // hardhat
        verifyingContract: raffle.address as Address
    };

    const types = {
        DepositOrder: [
            { name: "orderId", type: "bytes16" },
            { name: "recipient", type: "address" },
            { name: "usdcAmount", type: "uint256" },
            { name: "expiry", type: "uint256" }
        ]
    };

    const signature = await signer.signTypedData({
        account: signer.account!,
        domain,
        types,
        primaryType: "DepositOrder",
        message: order
    });

    return signature;
}

async function mintAndApproveUsdc(
    usdc: any,
    raffleAddress: Address,
    wallets: WalletClient[],
    amount: bigint
) {
    for (const wallet of wallets) {
        await usdc.write.mint([wallet.account!.address, amount], { account: wallet.account });
        await usdc.write.approve([raffleAddress, MAX_UINT256], { account: wallet.account });
    }
}

async function advanceTime(seconds: number) {
    const testClient = await viem.getTestClient();
    await testClient.increaseTime({ seconds });
    await testClient.mine({ blocks: 1 });
}

async function getBlockTimestamp(): Promise<bigint> {
    const publicClient = await viem.getPublicClient();
    const block = await publicClient.getBlock();
    return block.timestamp;
}

describe("RefundableRaffle", async () => {
    async function deployFixture() {
        const wallets = await viem.getWalletClients();
        const [admin, user1, user2, user3] = wallets;

        const usdc = await viem.deployContract("MockUSDC", []);

        const raffle = await viem.deployContract("RefundableRaffle", [
            usdc.address,
            admin.account!.address,
            admin.account!.address // orderSigner
        ]);

        const raffleAddress = raffle.address as Address;

        // Mint e approva per gli utenti
        await mintAndApproveUsdc(usdc, raffleAddress, [user1, user2, user3], parseUnits("100000", 6));

        return {
            usdc,
            raffle,
            raffleAddress,
            admin,
            user1,
            user2,
            user3
        };
    }

    describe("Initialization", () => {
        it("should initialize with correct state", async () => {
            const { raffle, usdc } = await deployFixture();

            const phase = await raffle.read.currentPhase();
            assert.strictEqual(phase, 0); // Inactive

            const usdcAddr = await raffle.read.usdc() as Address;
            assert.strictEqual(getAddress(usdcAddr), getAddress(usdc.address as Address));

            const totalTickets = await raffle.read.totalTickets();
            assert.strictEqual(totalTickets, 0n);
        });

        it("should grant all roles correctly", async () => {
            const { raffle, admin } = await deployFixture();

            const ADMIN_ROLE = await raffle.read.ADMIN_ROLE();
            const OPERATOR_ROLE = await raffle.read.OPERATOR_ROLE();
            const ORDER_SIGNER_ROLE = await raffle.read.ORDER_SIGNER_ROLE();

            assert.strictEqual(await raffle.read.hasRole([ADMIN_ROLE, admin.account!.address]), true);
            assert.strictEqual(await raffle.read.hasRole([OPERATOR_ROLE, admin.account!.address]), true);
            assert.strictEqual(await raffle.read.hasRole([ORDER_SIGNER_ROLE, admin.account!.address]), true);
        });
    });

    describe("Phase Management", () => {
        it("should allow admin to start deposit phase", async () => {
            const { raffle, admin } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });

            const phase = await raffle.read.currentPhase();
            assert.strictEqual(phase, 1); // Deposit

            const depositEndTime = (await raffle.read.depositEndTime()) as bigint;
            assert.ok(depositEndTime > 0n);
        });

        it("should reject startDeposit from non-admin", async () => {
            const { raffle, user1 } = await deployFixture();

            await assert.rejects(
                raffle.write.startDeposit([0n], { account: user1.account })
            );
        });

        it("should schedule deposit phase for future", async () => {
            const { raffle, admin } = await deployFixture();

            const blockTime = await getBlockTimestamp();
            const futureStart = blockTime + 86400n; // Domani

            await raffle.write.startDeposit([futureStart], { account: admin.account });

            const phase = await raffle.read.currentPhase();
            assert.strictEqual(phase, 1); // Deposit (ma non ancora attivo)

            const depositStartTime = (await raffle.read.depositStartTime()) as bigint;
            assert.strictEqual(depositStartTime, futureStart);

            const depositEndTime = (await raffle.read.depositEndTime()) as bigint;
            assert.ok(depositEndTime > depositStartTime);
        });

        it("should reject deposits before scheduled start", async () => {
            const { raffle, admin, user1 } = await deployFixture();

            const blockTime = await getBlockTimestamp();
            const futureStart = blockTime + 86400n; // Domani

            await raffle.write.startDeposit([futureStart], { account: admin.account });

            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: parseUnits("100", 6),
                expiry: blockTime + 86400n * 30n
            };
            const signature = await signDepositOrder(raffle, admin, order);

            // Deposito fallisce perché scheduled start è nel futuro
            await assert.rejects(
                raffle.write.executeDepositOrder([order, signature], { account: user1.account })
            );

            // Avanza al tempo di start
            await advanceTime(86400 + 1);

            // Ora funziona
            await raffle.write.executeDepositOrder([order, signature], { account: user1.account });

            const userInfo = await raffle.read.getUserInfo([user1.account!.address]) as any;
            assert.strictEqual(userInfo.ticketCount, 5n);
        });

        it("should allow setting deposit duration", async () => {
            const { raffle, admin } = await deployFixture();

            // Default è 7 giorni
            const defaultDuration = await raffle.read.depositDuration() as bigint;
            assert.strictEqual(defaultDuration, BigInt(7 * 24 * 60 * 60));

            // Cambia a 14 giorni
            await raffle.write.setDepositDuration([BigInt(14 * 24 * 60 * 60)], { account: admin.account });

            const newDuration = await raffle.read.depositDuration() as bigint;
            assert.strictEqual(newDuration, BigInt(14 * 24 * 60 * 60));
        });
    });

    describe("Deposit Orders", () => {
        it("should execute signed deposit order", async () => {
            const { raffle, admin, user1 } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });

            const blockTime = await getBlockTimestamp();
            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: parseUnits("100", 6), // 5 tickets
                expiry: blockTime + 3600n
            };

            const signature = await signDepositOrder(raffle, admin, order);

            await raffle.write.executeDepositOrder([order, signature], { account: user1.account });

            const userInfo = await raffle.read.getUserInfo([user1.account!.address]) as any;
            assert.strictEqual(userInfo.depositedAmount, parseUnits("100", 6));
            assert.strictEqual(userInfo.ticketCount, 5n);

            const totalTickets = await raffle.read.totalTickets();
            assert.strictEqual(totalTickets, 5n);
        });

        it("should reject order with invalid signature", async () => {
            const { raffle, admin, user1, user2 } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });

            const blockTime = await getBlockTimestamp();
            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: parseUnits("100", 6),
                expiry: blockTime + 3600n
            };

            // Firma con user2 che non ha ORDER_SIGNER_ROLE
            const signature = await signDepositOrder(raffle, user2, order);

            await assert.rejects(
                raffle.write.executeDepositOrder([order, signature], { account: user1.account })
            );
        });

        it("should reject expired order", async () => {
            const { raffle, admin, user1 } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });

            const blockTime = await getBlockTimestamp();
            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: parseUnits("100", 6),
                expiry: blockTime - 100n // già scaduto
            };

            const signature = await signDepositOrder(raffle, admin, order);

            await assert.rejects(
                raffle.write.executeDepositOrder([order, signature], { account: user1.account })
            );
        });

        it("should reject already consumed order", async () => {
            const { raffle, admin, user1 } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });

            const blockTime = await getBlockTimestamp();
            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: parseUnits("100", 6),
                expiry: blockTime + 3600n
            };

            const signature = await signDepositOrder(raffle, admin, order);

            await raffle.write.executeDepositOrder([order, signature], { account: user1.account });

            // Prova a eseguire lo stesso ordine di nuovo
            await assert.rejects(
                raffle.write.executeDepositOrder([order, signature], { account: user1.account })
            );
        });

        it("should reject if recipient mismatch", async () => {
            const { raffle, admin, user1, user2 } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });

            const blockTime = await getBlockTimestamp();
            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: parseUnits("100", 6),
                expiry: blockTime + 3600n
            };

            const signature = await signDepositOrder(raffle, admin, order);

            // user2 prova a eseguire l'ordine di user1
            await assert.rejects(
                raffle.write.executeDepositOrder([order, signature], { account: user2.account })
            );
        });

        it("should track ticket ownership correctly", async () => {
            const { raffle, admin, user1 } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });

            const blockTime = await getBlockTimestamp();
            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: parseUnits("100", 6), // 5 tickets
                expiry: blockTime + 3600n
            };

            const signature = await signDepositOrder(raffle, admin, order);
            await raffle.write.executeDepositOrder([order, signature], { account: user1.account });

            // Verifica ticket ownership (ticket iniziano da 1)
            for (let i = 1; i <= 5; i++) {
                const owner = await raffle.read.ticketOwner([BigInt(i)]) as Address;
                assert.strictEqual(getAddress(owner), getAddress(user1.account!.address));
            }

            // Verifica user tickets (ticket iniziano da 1)
            const userTickets = await raffle.read.getUserTickets([user1.account!.address]) as bigint[];
            assert.strictEqual(userTickets.length, 5);
            assert.strictEqual(userTickets[0], 1n);
            assert.strictEqual(userTickets[4], 5n);
        });

        it("should enforce max tickets per order (100)", async () => {
            const { raffle, admin, user1 } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });

            const blockTime = await getBlockTimestamp();
            // MAX_TICKETS_PER_ORDER = 100, quindi max 2000 USDC per ordine
            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: parseUnits("2020", 6), // 101 ticket, supera il max
                expiry: blockTime + 3600n
            };

            const signature = await signDepositOrder(raffle, admin, order);

            await assert.rejects(
                raffle.write.executeDepositOrder([order, signature], { account: user1.account })
            );
        });
    });

    describe("Drawing Phase", () => {
        it("should allow closing deposits after 7 days", async () => {
            const { raffle, admin, user1 } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });

            // Usa timestamp blockchain + buffer lungo
            const blockTime = await getBlockTimestamp();
            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: parseUnits("100", 6),
                expiry: blockTime + 86400n * 30n // 30 giorni
            };
            const signature = await signDepositOrder(raffle, admin, order);
            await raffle.write.executeDepositOrder([order, signature], { account: user1.account });

            // Avanza il tempo di 7 giorni
            await advanceTime(7 * 24 * 60 * 60 + 1);

            await raffle.write.closeDeposits([], { account: admin.account });

            const phase = await raffle.read.currentPhase();
            assert.strictEqual(phase, 2); // Drawing
        });

        it("should reject closing deposits before 7 days", async () => {
            const { raffle, admin } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });

            await assert.rejects(
                raffle.write.closeDeposits([], { account: admin.account })
            );
        });

        it("should commit winners with merkle root", async () => {
            const { raffle, admin, user1 } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });
            
            const blockTime = await getBlockTimestamp();
            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: parseUnits("100", 6), // 5 tickets
                expiry: blockTime + 86400n * 30n
            };
            const signature = await signDepositOrder(raffle, admin, order);
            await raffle.write.executeDepositOrder([order, signature], { account: user1.account });

            await advanceTime(7 * 24 * 60 * 60 + 1);
            await raffle.write.closeDeposits([], { account: admin.account });

            const merkleRoot = keccak256(toHex("fake-merkle-root"));
            await raffle.write.commitWinners([merkleRoot, 3n], { account: admin.account });

            const phase = await raffle.read.currentPhase();
            assert.strictEqual(phase, 3); // Claiming

            const refundsRoot = await raffle.read.refundsRoot();
            assert.strictEqual(refundsRoot, merkleRoot);

            const drawnCount = await raffle.read.drawnWinnersCount();
            assert.strictEqual(drawnCount, 3n);
        });
    });

    describe("Admin Functions", () => {
        it("should allow admin to close raffle", async () => {
            const { raffle, admin, user1 } = await deployFixture();

            await raffle.write.startDeposit([0n], { account: admin.account });
            
            const blockTime = await getBlockTimestamp();
            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: parseUnits("100", 6),
                expiry: blockTime + 86400n * 30n
            };
            const signature = await signDepositOrder(raffle, admin, order);
            await raffle.write.executeDepositOrder([order, signature], { account: user1.account });

            await advanceTime(7 * 24 * 60 * 60 + 1);
            await raffle.write.closeDeposits([], { account: admin.account });

            const merkleRoot = keccak256(toHex("merkle-root"));
            await raffle.write.commitWinners([merkleRoot, 5n], { account: admin.account });

            await raffle.write.closeRaffle([], { account: admin.account });

            const phase = await raffle.read.currentPhase();
            assert.strictEqual(phase, 4); // Closed
        });

        it("should allow admin to pause/unpause", async () => {
            const { raffle, admin } = await deployFixture();

            await raffle.write.pause([], { account: admin.account });
            const paused = await raffle.read.paused();
            assert.strictEqual(paused, true);

            await raffle.write.unpause([], { account: admin.account });
            const unpaused = await raffle.read.paused();
            assert.strictEqual(unpaused, false);
        });
    });

    describe("Edge Cases", () => {
        it("should transfer correct USDC amounts", async () => {
            const { raffle, usdc, admin, user1 } = await deployFixture();

            const depositAmount = parseUnits("100", 6);
            const initialBalance = await usdc.read.balanceOf([user1.account!.address]) as bigint;

            await raffle.write.startDeposit([0n], { account: admin.account });

            const blockTime = await getBlockTimestamp();
            const order = {
                orderId: generateOrderId(),
                recipient: user1.account!.address,
                usdcAmount: depositAmount,
                expiry: blockTime + 3600n
            };
            const signature = await signDepositOrder(raffle, admin, order);
            await raffle.write.executeDepositOrder([order, signature], { account: user1.account });

            const afterDepositBalance = await usdc.read.balanceOf([user1.account!.address]) as bigint;
            assert.strictEqual(afterDepositBalance, initialBalance - depositAmount);

            const raffleBalance = await usdc.read.balanceOf([raffle.address]) as bigint;
            assert.strictEqual(raffleBalance, depositAmount);
        });
    });
});
