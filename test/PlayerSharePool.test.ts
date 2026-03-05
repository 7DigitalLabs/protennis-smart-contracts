import { network } from "hardhat";
import { describe, it } from "node:test";
import { parseUnits, getAddress, decodeEventLog, type Hex, type WalletClient } from "viem";

const { networkHelpers, viem } = await network.connect();

const SEEDING_ORDER_TYPES = {
    SeedingOrder: [
        { name: "orderId", type: "bytes16" },
        { name: "recipient", type: "address" },
        { name: "usdcAmount", type: "uint256" },
        { name: "expiry", type: "uint256" },
        { name: "phase", type: "uint8" },
    ],
};

const MARKET_ORDER_TYPES = {
    MarketOrder: [
        { name: "orderId", type: "bytes16" },
        { name: "recipient", type: "address" },
        { name: "usdcAmount", type: "uint256" },
        { name: "sharesAmount", type: "uint256" },
        { name: "minSharesOut", type: "uint256" },
        { name: "minUsdcOut", type: "uint256" },
        { name: "expiry", type: "uint256" },
        { name: "phase", type: "uint8" },
    ],
};

const SHARE_ACTIVATION_TYPES = {
    ShareActivation: [
        { name: "activationId", type: "bytes16" },
        { name: "recipient", type: "address" },
        { name: "sharesAmount", type: "uint256" },
        { name: "expiry", type: "uint256" },
    ],
};

const FEE_DENOMINATOR = 10_000n;
const BUY_FEE_BPS = 500n; // 5%
const DEFAULT_USDC_MINT = parseUnits("5000000", 6);
const MAX_UINT256 = (1n << 256n) - 1n;

type Address = `0x${string}`;

type EIP712Domain = {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
};

type SeedingOrderStruct = {
    orderId: `0x${string}`;
    recipient: Address;
    usdcAmount: bigint;
    expiry: bigint;
    phase: number;
};

type MarketOrderStruct = {
    orderId: `0x${string}`;
    recipient: Address;
    usdcAmount: bigint;
    sharesAmount: bigint;
    minSharesOut: bigint;
    minUsdcOut: bigint;
    expiry: bigint;
    phase: number;
};

type ShareActivationStruct = {
    activationId: `0x${string}`;
    recipient: Address;
    sharesAmount: bigint;
    expiry: bigint;
};

// helper
function uuidToBytes16(uuid: string): `0x${string}` {
    const hex = uuid.replace(/-/g, "").toLowerCase();
    if (!/^([0-9a-f]{32})$/.test(hex)) throw new Error("invalid uuid");
    return ("0x" + hex) as `0x${string}`;
}
function uuidWithSuffix(n: number): `0x${string}` {
    const suffix = n.toString(16).padStart(3, "0");
    return uuidToBytes16(`123e4567-e89b-12d3-a456-426614174${suffix}`);
}

async function signSeedingOrder(
    signer: WalletClient,
    domain: EIP712Domain,
    order: SeedingOrderStruct
): Promise<Hex> {
    return signer.signTypedData({
        account: signer.account!,
        domain,
        types: SEEDING_ORDER_TYPES as any,
        primaryType: "SeedingOrder",
        message: order as any,
    });
}

async function signMarketOrder(
    signer: WalletClient,
    domain: EIP712Domain,
    order: MarketOrderStruct
): Promise<Hex> {
    return signer.signTypedData({
        account: signer.account!,
        domain,
        types: MARKET_ORDER_TYPES as any,
        primaryType: "MarketOrder",
        message: order as any,
    });
}

async function signShareActivation(
    signer: WalletClient,
    domain: EIP712Domain,
    activation: ShareActivationStruct
): Promise<Hex> {
    return signer.signTypedData({
        account: signer.account!,
        domain,
        types: SHARE_ACTIVATION_TYPES as any,
        primaryType: "ShareActivation",
        message: activation as any,
    });
}

async function mintAndApproveUsdc(
    usdc: any,
    poolAddress: Address,
    wallets: WalletClient[],
    minter: WalletClient
) {
    for (const wallet of wallets) {
        await usdc.write.mint([wallet.account!.address, DEFAULT_USDC_MINT], { account: minter.account });
        await usdc.write.approve([poolAddress, MAX_UINT256], { account: wallet.account });
    }
}

describe("PlayerSharePool (off-chain settlements)", function () {
    async function deployPoolFixture() {
        const wallets = await viem.getWalletClients();
        const [
            admin,
            recipient,
            recipient2,
            orderSigner,
            marketBuyer,
        ] = wallets;

        const pricePerShare = parseUnits("1", 6);
        const totalShares = parseUnits("100", 6);
        const targetRaise = parseUnits("100", 6);

        const usdc = await viem.deployContract("MockUSDC", []);

        const pool = await viem.deployContract("PlayerSharePool", [
            admin.account.address,
            orderSigner.account.address,
            usdc.address,
            admin.account.address, // treasury
            targetRaise,
            [pricePerShare],
            [totalShares],
        ]);
        
        const poolAddress = pool.address as Address;

        await mintAndApproveUsdc(usdc, poolAddress, wallets.slice(0, 6), admin);

        const orderSignerRole = await pool.read.ORDER_SIGNER_ROLE();
        await pool.write.grantRole([orderSignerRole, orderSigner.account.address], { account: admin.account });

        const publicClient = await viem.getPublicClient();
        const chainId = await publicClient.getChainId();
        const domain: EIP712Domain = {
            name: "PlayerSharePool",
            version: "1",
            chainId: Number(chainId),
            verifyingContract: poolAddress,
        };

        return {
            viem,
            admin,
            recipient,
            recipient2,
            orderSigner,
            marketBuyer,

            pool,
            usdc,
            pricePerShare,
            totalShares,
            targetRaise,
            domain,
        };
    }

    async function deploySeedingBinsFixture() {
        const wallets = await viem.getWalletClients();
        const [
            admin,
            recipient,
            orderSigner,
        ] = wallets;

        // Configurazione dei 10 bin indicati (correzione: terzo bin 48,485)
        const prices = [
            parseUnits("0.0075", 6),
            parseUnits("0.0100", 6),
            parseUnits("0.0125", 6),
            parseUnits("0.0150", 6),
            parseUnits("0.0175", 6),
            parseUnits("0.0200", 6),
            parseUnits("0.0225", 6),
            parseUnits("0.0250", 6),
            parseUnits("0.0275", 6),
            parseUnits("0.0300", 6),
        ];
        const shareCounts = [
            16162n,
            32323n,
            48485n,
            64646n,
            80808n,
            96970n,
            113131n,
            129293n,
            145455n,
            161616n,
        ];
        const shareQuantities = shareCounts.map((s) => parseUnits(s.toString(), 6));

        const targetRaise = parseUnits("20000", 6);

        const usdc = await viem.deployContract("MockUSDC", []);

        const pool = await viem.deployContract("PlayerSharePool", [
            admin.account.address,
            orderSigner.account.address,
            usdc.address,
            admin.account.address,
            targetRaise,
            prices,
            shareQuantities,
        ]);

        const poolAddress = pool.address as Address;

        await mintAndApproveUsdc(usdc, poolAddress, wallets.slice(0, 5), admin);

        const orderSignerRole = await pool.read.ORDER_SIGNER_ROLE();
        await pool.write.grantRole([orderSignerRole, orderSigner.account.address], { account: admin.account });

        const publicClient = await viem.getPublicClient();
        const chainId = await publicClient.getChainId();
        const domain: EIP712Domain = {
            name: "PlayerSharePool",
            version: "1",
            chainId: Number(chainId),
            verifyingContract: poolAddress,
        };

        return {
            viem,
            admin,
            recipient,
            orderSigner,
            pool,
            usdc,
            prices,
            shareQuantities,
            targetRaise,
            domain,
        };
    }

    describe("Seeding orders", function () {
        it("claims a signed seeding order and mints shares", async function () {
            const {
                viem,
                pool,
                admin,
                recipient,
                orderSigner,
                domain,
            } = await networkHelpers.loadFixture(deployPoolFixture);

            await pool.write.startSeeding([], { account: admin.account });

            const usdcAmount = parseUnits("20", 6);
            const sharesOut = usdcAmount; // price 1:1
            const expiry = (BigInt(await networkHelpers.time.latest()) + 3600n);

            const order: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174000"),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };

            const signature = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);

            await viem.assertions.emitWithArgs(
                pool.write.claimSeedingOrder([order, signature], { account: recipient.account }),
                pool,
                "SeedingOrderClaimed",
                [
                    order.orderId,
                    getAddress(order.recipient),
                    order.usdcAmount,
                    sharesOut,
                    getAddress(orderSigner.account.address),
                ]
            );

            if ((await pool.read.balanceOf([order.recipient])) !== sharesOut) throw new Error("balance mismatch");
            if ((await pool.read.totalRaised()) !== usdcAmount) throw new Error("totalRaised mismatch");
            if ((await pool.read.badgeEligible([order.recipient])) !== true) throw new Error("badgeEligible mismatch");
            if ((await pool.read.consumedOrders([order.orderId])) !== true) throw new Error("consumedOrders mismatch");
            if ((await pool.read.seedingUsdcCollected()) !== usdcAmount) throw new Error("seedingUsdcCollected mismatch");
        });

        it("blocks replayed seeding orders", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);

            await pool.write.startSeeding([], { account: admin.account });

            const order: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174001"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("10", 6),
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };

            const signature = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, signature], { account: recipient.account });

            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([order, signature], { account: recipient.account }),
                pool,
                "PlayerSharePoolOrderConsumed"
            );
        });

        it("rejects invalid seeding signatures", async function () {
            const { viem, pool, admin, recipient, domain } = await networkHelpers.loadFixture(deployPoolFixture);

            await pool.write.startSeeding([], { account: admin.account });

            const order: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174002"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("5", 6),
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };

            const wrongSignature = await signSeedingOrder(recipient as unknown as WalletClient, domain, order);

            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([order, wrongSignature], { account: recipient.account }),
                pool,
                "PlayerSharePoolInvalidSignature"
            );
        });

        it("rejects expired seeding orders", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);

            await pool.write.startSeeding([], { account: admin.account });

            const expiry = (BigInt(await networkHelpers.time.latest()) - 1n);
            const order: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174003"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("3", 6),
                expiry,
                phase: 1,
            };

            const signature = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);

            // No time travel needed: expiry is already in the past

            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([order, signature], { account: recipient.account }),
                pool,
                "PlayerSharePoolOrderExpired"
            );
        });

        it("reverts seeding orders once the pool is in open market", async function () {
            const {
                viem,
                pool,
                recipient,
                orderSigner,
                admin,
                targetRaise,
                domain,
            } = await networkHelpers.loadFixture(deployPoolFixture);

            const seedingOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174004"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };

            const signature = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedingOrder);
            // Deposit liquidity in None, then start seeding and claim
            await pool.write.startSeeding([], { account: admin.account });
            await pool.write.claimSeedingOrder([seedingOrder, signature], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([seedingOrder, signature], { account: recipient.account }),
                pool,
                "PlayerSharePoolPhaseMismatch"
            );
        });

        it("UnauthorizedExecutor su claim seeding (caller != order.payer)", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const order: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174005"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            // admin non è recipient
            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([order, sig], { account: admin.account }),
                pool,
                "PlayerSharePoolUnauthorizedExecutor"
            );
        });

        it("Wrong phase nel seeding order (phase != Seeding)", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const order: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174006"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([order, sig], { account: recipient.account }),
                pool,
                "PlayerSharePoolWrongPhase"
            );
        });

        it("startSeeding chiamato due volte → PhaseMismatch", async function () {
            const { viem, pool, admin } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            await viem.assertions.revertWithCustomError(
                pool.write.startSeeding([], { account: admin.account }),
                pool,
                "PlayerSharePoolPhaseMismatch"
            );
        });

        it("emette SeedingPurchase con usdcSpent e sharesMinted corretti", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const k = parseUnits("2", 6);
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x990),
                recipient: recipient.account.address,
                usdcAmount: k,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.emitWithArgs(
                pool.write.claimSeedingOrder([order, sig], { account: recipient.account }),
                pool,
                "SeedingPurchase",
                [
                    getAddress(order.recipient),
                    k, // usdcSpent
                    k, // sharesMinted nel fixture 1:1
                ]
            );
        });

        it("consumedOrders cross-recipient: stesso orderId in seeding bloccato", async function () {
            const { viem, pool, admin, recipient, recipient2, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const id = uuidWithSuffix(0x991);
            const o1: SeedingOrderStruct = { orderId: id, recipient: recipient.account.address, usdcAmount: parseUnits("1", 6), expiry: (BigInt(await networkHelpers.time.latest()) + 3600n), phase: 1 };
            const o2: SeedingOrderStruct = { ...o1, recipient: recipient2.account.address } as any;
            const s1 = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, o1);
            const s2 = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, o2);
            await pool.write.claimSeedingOrder([o1, s1], { account: recipient.account });
            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([o2, s2], { account: recipient2.account }),
                pool,
                "PlayerSharePoolOrderConsumed"
            );
        });
    });

    describe("Seeding bins (10 livelli)", function () {
        it("getBinCount e somma shares/price iniziali corretti", async function () {
            const { pool, shareQuantities, prices } = await networkHelpers.loadFixture(deploySeedingBinsFixture);
            const count = (await pool.read.getBinCount()) as unknown as bigint;
            if (count !== BigInt(prices.length)) throw new Error("getBinCount mismatch");
            let sumShares = 0n;
            for (let i = 0; i < Number(count); i++) {
                const b = (await pool.read.getBin([BigInt(i)])) as any;
                if ((b.soldShares as bigint) !== 0n) throw new Error("soldShares iniziali non zero");
                sumShares += (b.totalShares as bigint);
            }
            const expected = shareQuantities.reduce((a: any, b: any) => (a as bigint) + (b as bigint), 0n) as unknown as bigint;
            if (sumShares !== expected) throw new Error("somma totalShares != attesa");
        });
        it("riempie esattamente i 10 bin e verifica shares e raccolta", async function () {
            const {
                pool,
                admin,
                recipient,
                orderSigner,
                prices,
                shareQuantities,
                domain,
            } = await networkHelpers.loadFixture(deploySeedingBinsFixture);

            await pool.write.startSeeding([], { account: admin.account });

            const WAD = 10n ** 6n;

            let expectedTotalShares = 0n;
            let expectedTotalRaised = 0n;

            const baseExpiry = (BigInt(await networkHelpers.time.latest()) + 3600n);

            for (let i = 0; i < prices.length; i++) {
                const price = prices[i] as unknown as bigint;
                const sharesWei = shareQuantities[i] as unknown as bigint;
                const binCost = (sharesWei * price) / WAD;

                const order: SeedingOrderStruct = {
                    orderId: uuidWithSuffix(7 + i),
                    recipient: recipient.account.address,
                    usdcAmount: binCost,
                    expiry: baseExpiry,
                    phase: 1,
                };
                const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
                await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });

                expectedTotalShares += sharesWei;
                expectedTotalRaised += binCost;
            }

            const recipientBalance = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
            if (recipientBalance !== expectedTotalShares) throw new Error("recipient balance (shares) mismatch");

            const totalRaised = (await pool.read.totalRaised()) as unknown as bigint;
            const seedingCollected = (await pool.read.seedingUsdcCollected()) as unknown as bigint;
            if (totalRaised !== expectedTotalRaised) throw new Error("totalRaised mismatch");
            if (seedingCollected !== expectedTotalRaised) throw new Error("seedingUsdcCollected mismatch");
        });

        it("introspezione bin: currentBinIndex e soldShares dopo parziali", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deploySeedingBinsFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const expiry = (BigInt(await networkHelpers.time.latest()) + 3600n);

            // Compra metà del primo bin
            const bin0 = (await pool.read.getBin([0n])) as any;
            const halfShares = (bin0.totalShares as bigint) / 2n;
            const price = bin0.price as bigint;
            const spend = (halfShares * price) / (10n ** 6n);
            const order: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174008"),
                recipient: recipient.account.address,
                usdcAmount: spend,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });

            const updatedBin0 = (await pool.read.getBin([0n])) as any;
            const idx = (await pool.read.currentBinIndex()) as unknown as bigint;
            if (idx !== 0n) throw new Error("currentBinIndex should remain on bin 0 after partial fill");
            if ((updatedBin0.soldShares as bigint) !== halfShares) throw new Error("soldShares not updated correctly");
        });

        it("dust su bin0: acquisto parziale con resto non spendibile", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deploySeedingBinsFixture);
            await pool.write.startSeeding([], { account: admin.account });

            const bin0 = (await pool.read.getBin([0n])) as any;
            const price0 = bin0.price as bigint;
            const mulDivDown = (a: bigint, b: bigint, den: bigint) => (a * b) / den;
            // Ordine molto piccolo: 10 micro-usdc su bin0.price=7500 -> shares=1,333,333 e cost=9 micro -> dust=1
            const usdcAmount = 10n;
            const expectedShares = mulDivDown(usdcAmount, 1_000_000n, price0);
            const expectedCost = mulDivDown(expectedShares, price0, 1_000_000n);
            const expectedDust = usdcAmount - expectedCost;

            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x900),
                recipient: recipient.account.address,
                usdcAmount,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);

            const txHash = await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            const pc = await viem.getPublicClient();
            const receipt = await pc.waitForTransactionReceipt({ hash: txHash });

            // Verifica che SeedingOrderClaimed riporti usdcSpent e sharesOut attesi
            let okClaim = false;
            for (const log of receipt.logs) {
                try {
                    const ev: any = decodeEventLog({
                        abi: [{ type: "event", name: "SeedingOrderClaimed", inputs: [
                            { indexed: true, name: "orderId", type: "bytes16" },
                            { indexed: true, name: "recipient", type: "address" },
                            { indexed: false, name: "usdcAmount", type: "uint256" },
                            { indexed: false, name: "sharesOut", type: "uint256" },
                            { indexed: false, name: "signer", type: "address" },
                        ], anonymous: false }] as any,
                        data: log.data as any, topics: log.topics as any,
                    });
                    if (ev.eventName === "SeedingOrderClaimed" && ev.args.orderId === order.orderId) {
                        if (ev.args.usdcAmount === expectedCost && ev.args.sharesOut === expectedShares) okClaim = true;
                    }
                } catch {}
            }
            if (!okClaim) throw new Error("SeedingOrderClaimed payload errato (cost/shares)");

            // Verifica SeedingDustGenerated con dust atteso
            const dustAbi = [{ type: "event", name: "SeedingDustGenerated", inputs: [
                { indexed: true, name: "orderId", type: "bytes16" },
                { indexed: true, name: "recipient", type: "address" },
                { indexed: false, name: "usdcDust", type: "uint256" },
            ], anonymous: false } as const];
            let seenDust = false;
            for (const log of receipt.logs) {
                try {
                    const ev2: any = decodeEventLog({ abi: dustAbi as any, data: log.data as any, topics: log.topics as any });
                    if (ev2.eventName === "SeedingDustGenerated" && ev2.args.orderId === order.orderId) {
                        if (ev2.args.usdcDust === expectedDust) seenDust = true;
                    }
                } catch {}
            }
            if (!seenDust) throw new Error("SeedingDustGenerated non emesso o dust != atteso");

            // Stato coerente: currentBinIndex resta 0 (acquisto parziale)
            const idx = (await pool.read.currentBinIndex()) as unknown as bigint;
            if (idx !== 0n) throw new Error("currentBinIndex atteso 0 dopo acquisto parziale su bin0");
        });

        it("nessun dust quando l'ordine combacia esattamente con somma di due bin", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deploySeedingBinsFixture);
            await pool.write.startSeeding([], { account: admin.account });

            const bin0 = (await pool.read.getBin([0n])) as any;
            const bin1 = (await pool.read.getBin([1n])) as any;
            const price0 = bin0.price as bigint;
            const shares0 = bin0.totalShares as bigint;
            const price1 = bin1.price as bigint;
            const shares1 = bin1.totalShares as bigint;
            const mulDivDown = (a: bigint, b: bigint, den: bigint) => (a * b) / den;
            const cost0 = mulDivDown(shares0, price0, 1_000_000n);
            const cost1 = mulDivDown(shares1, price1, 1_000_000n);
            const totalCost = cost0 + cost1;

            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x901),
                recipient: recipient.account.address,
                usdcAmount: totalCost,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            const txHash = await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            const pc = await viem.getPublicClient();
            const receipt = await pc.waitForTransactionReceipt({ hash: txHash });

            // Verifica che NON ci sia SeedingDustGenerated
            const dustAbi = [{ type: "event", name: "SeedingDustGenerated", inputs: [
                { indexed: true, name: "orderId", type: "bytes16" },
                { indexed: true, name: "recipient", type: "address" },
                { indexed: false, name: "usdcDust", type: "uint256" },
            ], anonymous: false } as const];
            let seenDust = false;
            for (const log of receipt.logs) {
                try {
                    const ev2: any = decodeEventLog({ abi: dustAbi as any, data: log.data as any, topics: log.topics as any });
                    if (ev2.eventName === "SeedingDustGenerated") seenDust = true;
                } catch {}
            }
            if (seenDust) throw new Error("Dust inatteso su ordine esatto due bin");

            // Verifica shares e avanzamento indice bin
            const expectedShares = shares0 + shares1;
            const bal = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
            if (bal !== expectedShares) throw new Error("shares allocate != somma bin0+bin1");
            const idx = (await pool.read.currentBinIndex()) as unknown as bigint;
            if (idx !== 2n) throw new Error("currentBinIndex atteso 2 dopo due bin pieni");
        });

        it("NothingToBuy: importo troppo piccolo per generare shares", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deploySeedingBinsFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const tinyOrder: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x902),
                recipient: recipient.account.address,
                usdcAmount: 1n, // 1 micro-usdc, insufficiente al prezzo del bin0
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, tinyOrder);
            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([tinyOrder, sig], { account: recipient.account }),
                pool,
                "PlayerSharePoolNothingToBuy"
            );
        });

        it("seedingPurchases incrementa e badgeEligible=true dopo claim (anche con dust)", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deploySeedingBinsFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const bin0 = (await pool.read.getBin([0n])) as any;
            const price0 = bin0.price as bigint;
            const mulDivDown = (a: bigint, b: bigint, den: bigint) => (a * b) / den;
            const usdcAmount = 10n;
            const expectedShares = mulDivDown(usdcAmount, 1_000_000n, price0);
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x903),
                recipient: recipient.account.address,
                usdcAmount,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            const purchases = (await pool.read.seedingPurchases([recipient.account.address])) as unknown as bigint;
            const badge = (await pool.read.badgeEligible([recipient.account.address])) as unknown as boolean;
            if (purchases !== expectedShares) throw new Error("seedingPurchases non aggiornato");
            if (!badge) throw new Error("badgeEligible non impostato");
        });
    });

    describe("Market orders", function () {
        async function finalizePoolForMarket() {
            const {
                viem,
                pool,
                admin,
                recipient,
                orderSigner,
                marketBuyer,
                targetRaise,
                domain,
            } = await networkHelpers.loadFixture(deployPoolFixture);

            const seedingOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174009"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };

            const signature = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedingOrder);
            await pool.write.startSeeding([], { account: admin.account });
            await pool.write.claimSeedingOrder([seedingOrder, signature], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            return {
                viem,
                pool,
                admin,
                recipient,
                orderSigner,
                marketBuyer,
                domain,
            };
        }

        it("claims a valid market order and updates reserves", async function () {
            const {
                viem,
                pool,
                orderSigner,
                marketBuyer,
                domain,
            } = await finalizePoolForMarket();

            const reserveUsdcBefore = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSharesBefore = (await pool.read.reserveShares()) as unknown as bigint;

            const usdcAmount = parseUnits("10", 6);
            const feeAmount = (usdcAmount * BUY_FEE_BPS) / FEE_DENOMINATOR;
            const effectiveAmount = usdcAmount - feeAmount;
            const expectedSharesOut =
                (reserveSharesBefore * effectiveAmount) /
                (reserveUsdcBefore + effectiveAmount);

            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174010"),
                recipient: marketBuyer.account.address,
                usdcAmount,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };

            const signature = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);

            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([order, signature], { account: marketBuyer.account }),
                pool,
                "BuyExecuted",
                [
                    getAddress(order.recipient),
                    order.usdcAmount,
                    feeAmount,
                    expectedSharesOut,
                ]
            );

            if ((await pool.read.balanceOf([order.recipient])) !== expectedSharesOut) throw new Error("sharesOut mismatch");
            if ((await pool.read.reserveUsdc()) !== (reserveUsdcBefore + effectiveAmount)) throw new Error("reserveUsdc mismatch");
            if ((await pool.read.reserveShares()) !== (reserveSharesBefore - expectedSharesOut)) throw new Error("reserveShares mismatch");
        });

        it("rejects expired market orders", async function () {
            const { viem, pool, recipient, orderSigner, domain } = await finalizePoolForMarket();

            const usdcAmount2 = parseUnits("5", 6);
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174011"),
                recipient: recipient.account.address,
                usdcAmount: usdcAmount2,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) - 1n),
                phase: 2,
            };

            const signature = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);

            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, signature], { account: recipient.account }),
                pool,
                "PlayerSharePoolOrderExpired"
            );
        });

        it("requires a valid market signature", async function () {
            const { viem, pool, recipient, domain, orderSigner } = await finalizePoolForMarket();


            const usdcAmount3 = parseUnits("4", 6);

            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174012"),
                recipient: recipient.account.address,
                usdcAmount: usdcAmount3,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };

            const badSignature = await signMarketOrder(orderSigner as unknown as WalletClient, domain, {
                ...order,
                usdcAmount: usdcAmount3 + 1n,
            });

            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, badSignature], { account: recipient.account }),
                pool,
                "PlayerSharePoolInvalidSignature"
            );
        });

        it("enforces the settler role", async function () {
            const { viem, pool, recipient, orderSigner, marketBuyer, domain } = await finalizePoolForMarket();
            const usdcAmount4 = parseUnits("2", 6);
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174013"),
                recipient: marketBuyer.account.address,
                usdcAmount: usdcAmount4,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const signature = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, signature], { account: recipient.account }),
                pool,
                "PlayerSharePoolUnauthorizedExecutor"
            );
        });

        it("sells shares via market order (sharesAmount) e aggiorna riserve", async function () {
            const {
                viem,
                pool,
                admin,
                recipient,
                orderSigner,
                targetRaise,
                domain,
            } = await networkHelpers.loadFixture(deployPoolFixture);

            // Finalizzo mercato con recipient che possiede shares
            await pool.write.startSeeding([], { account: admin.account });
            const seedOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174014"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedOrder);
            await pool.write.claimSeedingOrder([seedOrder, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const reserveUsdcBefore = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSharesBefore = (await pool.read.reserveShares()) as unknown as bigint;

            // Vende una piccola quota di shares possedute (1e6)
            const sharesIn = parseUnits("1", 6);
            const preFeeUsdcOut = (reserveUsdcBefore * sharesIn) / (reserveSharesBefore + sharesIn);
            const sellFeeBps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const feeAmountSell = (preFeeUsdcOut * sellFeeBps) / FEE_DENOMINATOR;
            const usdcOut = preFeeUsdcOut - feeAmountSell;

            const orderSell: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174015"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesIn,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, orderSell);

            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([orderSell, sig], { account: recipient.account }),
                pool,
                "SellExecuted",
                [
                    getAddress(orderSell.recipient),
                    sharesIn,
                    feeAmountSell,
                    usdcOut,
                ]
            );

            if ((await pool.read.reserveUsdc()) !== (reserveUsdcBefore - preFeeUsdcOut)) throw new Error("reserveUsdc mismatch (sell)");
            if ((await pool.read.reserveShares()) !== (reserveSharesBefore + sharesIn)) throw new Error("reserveShares mismatch (sell)");
        });

        it("rifiuta ordini market invalidi: stable>0 e shares>0 insieme", async function () {
            const { viem, pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seedingOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174016"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedingOrder);
            await pool.write.claimSeedingOrder([seedingOrder, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174017"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: parseUnits("1", 6),
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "PlayerSharePoolInvalidOrder"
            );
        });

        it("rifiuta vendita se recipient non ha shares sufficienti", async function () {
            const { viem, pool, admin, recipient, marketBuyer, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seedingOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174018"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedingOrder);
            await pool.write.claimSeedingOrder([seedingOrder, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            // recipient non possiede shares, prova a vendere
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174019"),
                recipient: marketBuyer.account.address,
                usdcAmount: 0n,
                sharesAmount: parseUnits("1", 6),
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, sig], { account: marketBuyer.account }),
                pool,
                "PlayerSharePoolShareBalanceMismatch"
            );
        });

        it("protegge dal replay anche sugli ordini market (buy)", async function () {
            const { viem, pool, orderSigner, marketBuyer, domain } = await networkHelpers.loadFixture(finalizePoolForMarket);
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174020"),
                recipient: marketBuyer.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimMarketOrder([order, sig], { account: marketBuyer.account });
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, sig], { account: marketBuyer.account }),
                pool,
                "PlayerSharePoolOrderConsumed"
            );
        });

        it("protegge dal replay anche sugli ordini market (sell)", async function () {
            const { viem, pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seedingOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174021"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedingOrder);
            await pool.write.claimSeedingOrder([seedingOrder, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174022"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: parseUnits("1", 6),
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimMarketOrder([order, sig], { account: recipient.account });
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "PlayerSharePoolOrderConsumed"
            );
        });

        it("claimMarketOrder (buy) in fase Seeding viene rifiutato", async function () {
            const { viem, pool, admin, orderSigner, marketBuyer, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174023"),
                recipient: marketBuyer.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, sig], { account: marketBuyer.account }),
                pool,
                "PlayerSharePoolPhaseMismatch"
            );
        });

        it("badge discount su buy: fee ridotta per account con badge", async function () {
            const {
                viem,
                pool,
                admin,
                recipient,
                orderSigner,
                marketBuyer,
                targetRaise,
                domain,
            } = await networkHelpers.loadFixture(deployPoolFixture);

            // recipient ottiene badge via seeding
            await pool.write.startSeeding([], { account: admin.account });
            const seedOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174024"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedOrder);
            await pool.write.claimSeedingOrder([seedOrder, seedSig], { account: recipient.account });

            // finalizza mercato
            await pool.write.finalizeSeeding([], { account: admin.account });

            const usdcAmount = parseUnits("2", 6);

            // nonBadgeBuyer = payer (non ha badge)
            const orderNonBadge: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174025"),
                recipient: marketBuyer.account.address,
                usdcAmount,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sigNonBadge = await signMarketOrder(orderSigner as unknown as WalletClient, domain, orderNonBadge);
            const feeNonBadge = (usdcAmount * BUY_FEE_BPS) / FEE_DENOMINATOR;
            // Calcolo expectedSharesOut per nonBadge
            const rsBefore1 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rshBefore1 = (await pool.read.reserveShares()) as unknown as bigint;
            const eff1 = usdcAmount - feeNonBadge;
            const sharesOut1 = (rshBefore1 * eff1) / (rsBefore1 + eff1);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([orderNonBadge, sigNonBadge], { account: marketBuyer.account }),
                pool,
                "BuyExecuted",
                [
                    getAddress(orderNonBadge.recipient),
                    orderNonBadge.usdcAmount,
                    feeNonBadge,
                    sharesOut1,
                ]
            );

            // badgeBuyer = recipient (ha badge): fee ridotta di 50 bps
            const orderBadge: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174026"),
                recipient: recipient.account.address,
                usdcAmount,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sigBadge = await signMarketOrder(orderSigner as unknown as WalletClient, domain, orderBadge);
            const feeBadge = (usdcAmount * (BUY_FEE_BPS - 50n)) / FEE_DENOMINATOR;
            // Calcolo expectedSharesOut per badge
            const rsBefore2 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rshBefore2 = (await pool.read.reserveShares()) as unknown as bigint;
            const eff2 = usdcAmount - feeBadge;
            const sharesOut2 = (rshBefore2 * eff2) / (rsBefore2 + eff2);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([orderBadge, sigBadge], { account: recipient.account }),
                pool,
                "BuyExecuted",
                [
                    getAddress(orderBadge.recipient),
                    orderBadge.usdcAmount,
                    feeBadge,
                    sharesOut2,
                ]
            );
        });

        it("SellFeeUpdated: drop >10% (fee 700 bps)", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174027"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 1200n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            // Acquisisce un grosso blocco di shares per poter vendere
            const rs0 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const buyLarge: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740AA"),
                recipient: recipient.account.address,
                usdcAmount: rs0 * 2n, // ~2x per ottenere ~2/3 delle shares
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest() + 1200)),
                phase: 2,
            };
            const buyLargeSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, buyLarge);
            await pool.write.claimMarketOrder([buyLarge, buyLargeSig], { account: recipient.account });
            
            await networkHelpers.time.increase(181); // > REFRESH_INTERVAL, per aggiornare reference al prezzo post-buy
            
            // Allineiamo la referencePrice al prezzo corrente PRIMA del sell con un tiny buy (triggera la sync pre-trade)
            const rkRef = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rshRef = (await pool.read.reserveShares()) as unknown as bigint;
            const mulDivDown = (a: bigint, b: bigint, den: bigint) => (a * b) / den;
            const priceRefWanted = mulDivDown(rkRef, 1_000_000n, rshRef);
            const tinyBuy: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740FB"),
                recipient: recipient.account.address,
                usdcAmount: 1n, // 1 wei di stable (6 dec)
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const tinyBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tinyBuy);
            await pool.write.claimMarketOrder([tinyBuy, tinyBuySig], { account: recipient.account });

            const rshAfterSync = (await pool.read.reserveShares()) as unknown as bigint;
            const rkAfterSync = (await pool.read.reserveUsdc()) as unknown as bigint;
            const effectiveSellFeeBps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const targetDrop = 1050n; // 10% + margine
            const computeDropBps = (s: bigint) => {
                const preFeeOut = mulDivDown(rkAfterSync, s, rshAfterSync + s);
                const feeAmount = mulDivDown(preFeeOut, effectiveSellFeeBps, 10_000n);
                const kOut = preFeeOut - feeAmount;
                const rk2 = rkAfterSync - kOut;
                const rs2 = rshAfterSync + s;
                const priceNew = mulDivDown(rk2, 1_000_000n, rs2);
                if (priceRefWanted <= priceNew) return 0n;
                return mulDivDown(priceRefWanted - priceNew, 10_000n, priceRefWanted);
            };
            let lo = 1n, hi = rshAfterSync - 1n, ans = hi;
            while (lo <= hi) {
                const mid = (lo + hi) / 2n;
                const d = computeDropBps(mid);
                if (d >= targetDrop) { ans = mid; hi = mid - 1n; } else { lo = mid + 1n; }
            }
            const sharesIn = ans;
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174028"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesIn,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 1200n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.emit(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "SellFeeUpdated"
            );
            const st = (await pool.read.sellFeeState()) as any;
            if ((st[0]) < 700n) throw new Error("sell fee non aumentata abbastanza (>=700)");
            if ((st[1]) < 1000n) throw new Error("dropBps non aggiornato (>=1000)");
            if ((st[2] as bigint) === 0n) throw new Error("windowEnd atteso > 0");
        });

        it("SellFeeUpdated: drop >20% (fee 1000 bps)", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174029"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const rs0 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const buyLarge: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740AB"),
                recipient: recipient.account.address,
                usdcAmount: rs0 * 2n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const buyLargeSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, buyLarge);
            await pool.write.claimMarketOrder([buyLarge, buyLargeSig], { account: recipient.account });
            {
                await networkHelpers.time.increase(181);
            }

            // Allinea reference con tiny buy
            const rkRef2 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rshRef2 = (await pool.read.reserveShares()) as unknown as bigint;
            const mulDivDown = (a: bigint, b: bigint, den: bigint) => (a * b) / den;
            const priceRefWanted2 = mulDivDown(rkRef2, 1_000_000n, rshRef2);
            const tinyBuy2: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740FC"),
                recipient: recipient.account.address,
                usdcAmount: 1n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const tinyBuySig2 = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tinyBuy2);
            await pool.write.claimMarketOrder([tinyBuy2, tinyBuySig2], { account: recipient.account });

            const rshAfterSync2 = (await pool.read.reserveShares()) as unknown as bigint;
            const rkAfterSync2 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const effectiveSellFeeBps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const targetDrop = 2050n; // 20% + margine
            const computeDropBps = (s: bigint) => {
                const preFeeOut = mulDivDown(rkAfterSync2, s, rshAfterSync2 + s);
                const feeAmount = mulDivDown(preFeeOut, effectiveSellFeeBps, 10_000n);
                const kOut = preFeeOut - feeAmount;
                const rk2 = rkAfterSync2 - kOut;
                const rs2 = rshAfterSync2 + s;
                const priceNew = mulDivDown(rk2, 1_000_000n, rs2);
                if (priceRefWanted2 <= priceNew) return 0n;
                return mulDivDown(priceRefWanted2 - priceNew, 10_000n, priceRefWanted2);
            };
            let lo = 1n, hi = rshAfterSync2 - 1n, ans = hi;
            while (lo <= hi) {
                const mid = (lo + hi) / 2n;
                const d = computeDropBps(mid);
                if (d >= targetDrop) { ans = mid; hi = mid - 1n; } else { lo = mid + 1n; }
            }
            const sharesIn = ans;
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174030"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesIn,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.emit(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "SellFeeUpdated"
            );
            const st = (await pool.read.sellFeeState()) as any;
            if ((st[0]) < 1000n) throw new Error("sell fee non aumentata abbastanza (>=1000)");
            if ((st[1]) < 2000n) throw new Error("dropBps non aggiornato (>=2000)");
            if ((st[2] as bigint) === 0n) throw new Error("windowEnd atteso > 0");
        });

        it("SellFeeUpdated: drop >30% (fee 1500 bps)", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174031"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const rs0 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const buyLarge: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740AC"),
                recipient: recipient.account.address,
                usdcAmount: rs0 * 2n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const buyLargeSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, buyLarge);
            await pool.write.claimMarketOrder([buyLarge, buyLargeSig], { account: recipient.account });
            {
                await networkHelpers.time.increase(181);
            }

            // Allinea reference con tiny buy
            const rkRef3 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rshRef3 = (await pool.read.reserveShares()) as unknown as bigint;
            const mulDivDown = (a: bigint, b: bigint, den: bigint) => (a * b) / den;
            const priceRefWanted3 = mulDivDown(rkRef3, 1_000_000n, rshRef3);
            const tinyBuy3: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740FD"),
                recipient: recipient.account.address,
                usdcAmount: 1n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const tinyBuySig3 = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tinyBuy3);
            await pool.write.claimMarketOrder([tinyBuy3, tinyBuySig3], { account: recipient.account });

            const rshAfterSync3 = (await pool.read.reserveShares()) as unknown as bigint;
            const rkAfterSync3 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const effectiveSellFeeBps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const targetDrop = 3050n; // 30% + margine
            const computeDropBps = (s: bigint) => {
                const preFeeOut = mulDivDown(rkAfterSync3, s, rshAfterSync3 + s);
                const feeAmount = mulDivDown(preFeeOut, effectiveSellFeeBps, 10_000n);
                const kOut = preFeeOut - feeAmount;
                const rk2 = rkAfterSync3 - kOut;
                const rs2 = rshAfterSync3 + s;
                const priceNew = mulDivDown(rk2, 1_000_000n, rs2);
                if (priceRefWanted3 <= priceNew) return 0n;
                return mulDivDown(priceRefWanted3 - priceNew, 10_000n, priceRefWanted3);
            };
            let lo = 1n, hi = rshAfterSync3 - 1n, ans = hi;
            while (lo <= hi) {
                const mid = (lo + hi) / 2n;
                const d = computeDropBps(mid);
                if (d >= targetDrop) { ans = mid; hi = mid - 1n; } else { lo = mid + 1n; }
            }
            const sharesIn = ans;
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174032"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesIn,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.emit(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "SellFeeUpdated"
            );
            const st = (await pool.read.sellFeeState()) as any;
            if ((st[0]) < 1500n) throw new Error("sell fee non aumentata abbastanza (>=1500)");        
            if ((st[1]) < 3000n) throw new Error("dropBps non aggiornato (>=3000)");
            if ((st[2] as bigint) === 0n) throw new Error("windowEnd atteso > 0");
        });

        it("SellFeeUpdated: drop >40% (fee 2000 bps)", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174033"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const rs0 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const buyLarge: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740AD"),
                recipient: recipient.account.address,
                usdcAmount: rs0 * 2n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const buyLargeSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, buyLarge);
            await pool.write.claimMarketOrder([buyLarge, buyLargeSig], { account: recipient.account });
            {
                await networkHelpers.time.increase(181);
            }

            // Allinea reference con tiny buy
            const rkRef4 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rshRef4 = (await pool.read.reserveShares()) as unknown as bigint;
            const mulDivDown = (a: bigint, b: bigint, den: bigint) => (a * b) / den;
            const priceRefWanted4 = mulDivDown(rkRef4, 1_000_000n, rshRef4);
            const tinyBuy4: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740FE"),
                recipient: recipient.account.address,
                usdcAmount: 1n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const tinyBuySig4 = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tinyBuy4);
            await pool.write.claimMarketOrder([tinyBuy4, tinyBuySig4], { account: recipient.account });

            const rshAfterSync4 = (await pool.read.reserveShares()) as unknown as bigint;
            const rkAfterSync4 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const effectiveSellFeeBps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const targetDrop = 4050n; // 40% + margine
            const computeDropBps = (s: bigint) => {
                const preFeeOut = mulDivDown(rkAfterSync4, s, rshAfterSync4 + s);
                const feeAmount = mulDivDown(preFeeOut, effectiveSellFeeBps, 10_000n);
                const kOut = preFeeOut - feeAmount;
                const rk2 = rkAfterSync4 - kOut;
                const rs2 = rshAfterSync4 + s;
                const priceNew = mulDivDown(rk2, 1_000_000n, rs2);
                if (priceRefWanted4 <= priceNew) return 0n;
                return mulDivDown(priceRefWanted4 - priceNew, 10_000n, priceRefWanted4);
            };
            let lo = 1n, hi = rshAfterSync4 - 1n, ans = hi;
            while (lo <= hi) {
                const mid = (lo + hi) / 2n;
                const d = computeDropBps(mid);
                if (d >= targetDrop) { ans = mid; hi = mid - 1n; } else { lo = mid + 1n; }
            }
            const sharesIn = ans;
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174034"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesIn,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.emit(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "SellFeeUpdated"
            );
            const st = (await pool.read.sellFeeState()) as any;
            if ((st[0]) < 2000n) throw new Error("sell fee non aumentata abbastanza (>=2000)");
            if ((st[1]) < 4000n) throw new Error("dropBps non aggiornato (>=4000)");
            if ((st[2] as bigint) === 0n) throw new Error("windowEnd atteso > 0");
        });

        it("MarketOrderClaimed payload (buy)", async function () {
            const { viem, pool, orderSigner, marketBuyer, domain } = await networkHelpers.loadFixture(finalizePoolForMarket);
            const reserveUsdcBefore = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSharesBefore = (await pool.read.reserveShares()) as unknown as bigint;
            const usdcAmount = parseUnits("3", 6);
            const fee = (usdcAmount * BUY_FEE_BPS) / FEE_DENOMINATOR;
            const eff = usdcAmount - fee;
            const expectedSharesOut = (reserveSharesBefore * eff) / (reserveUsdcBefore + eff);
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174035"),
                recipient: marketBuyer.account.address,
                usdcAmount,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([order, sig], { account: marketBuyer.account }),
                pool,
                "MarketOrderClaimed",
                [
                    order.orderId,
                    getAddress(order.recipient),
                    order.usdcAmount,
                    expectedSharesOut,
                    fee,
                    getAddress(orderSigner.account.address),
                ]
            );
        });

        it("MarketOrderClaimed payload (sell)", async function () {
            const { viem, pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174036"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const reserveUsdcBefore = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSharesBefore = (await pool.read.reserveShares()) as unknown as bigint;
            const sharesIn = parseUnits("2", 6);
            const preFeeOut = (reserveUsdcBefore * sharesIn) / (reserveSharesBefore + sharesIn);
            const sellFeeBps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const fee = (preFeeOut * sellFeeBps) / FEE_DENOMINATOR;
            const usdcOut = preFeeOut - fee;
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174037"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesIn,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "MarketOrderClaimed",
                [
                    order.orderId,
                    getAddress(order.recipient),
                    usdcOut,
                    sharesIn,
                    fee,
                    getAddress(orderSigner.account.address),
                ]
            );
        });

        it("UnauthorizedExecutor su market (caller != order.payer) - buy e sell", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(finalizePoolForMarket);
            const buyOrder: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174038"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const buySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, buyOrder);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([buyOrder, buySig], { account: admin.account }),
                pool,
                "PlayerSharePoolUnauthorizedExecutor"
            );

            const sellOrder: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174039"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: 1n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sellSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, sellOrder);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([sellOrder, sellSig], { account: admin.account }),
                pool,
                "PlayerSharePoolUnauthorizedExecutor"
            );
        });

        it("Zero/Zero invalid market order (stable=0, shares=0)", async function () {
            const { viem, pool, recipient, orderSigner, domain } = await networkHelpers.loadFixture(finalizePoolForMarket);
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174040"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "PlayerSharePoolInvalidOrder"
            );
        });

        it("Wrong phase nel market order (phase != OpenMarket)", async function () {
            const { viem, pool, recipient, orderSigner, domain } = await networkHelpers.loadFixture(finalizePoolForMarket);
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174041"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "PlayerSharePoolWrongPhase"
            );
        });

        it("Pause su market: claim durante pausa rifiutato", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(finalizePoolForMarket);
            await pool.write.pause([], { account: admin.account });
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174042"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "EnforcedPause"
            );
            await pool.write.unpause([], { account: admin.account });
        });

        it("consumedOrders settato dopo market claim", async function () {
            const { pool, recipient, orderSigner, domain } = await networkHelpers.loadFixture(finalizePoolForMarket);
            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174043"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimMarketOrder([order, sig], { account: recipient.account });
            if ((await pool.read.consumedOrders([order.orderId])) !== true) throw new Error("consumedOrders non settato");
        });

        it("badge discount su sell: fee ridotta per account con badge", async function () {
            const { viem, pool, admin, recipient, marketBuyer, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            // recipient ottiene badge via seeding
            await pool.write.startSeeding([], { account: admin.account });
            const seedOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174044"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedOrder);
            await pool.write.claimSeedingOrder([seedOrder, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            // marketBuyer compra shares per poi vendere (non ha badge)
            const buyOrder: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174045"),
                recipient: marketBuyer.account.address,
                usdcAmount: parseUnits("3", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const buySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, buyOrder);
            await pool.write.claimMarketOrder([buyOrder, buySig], { account: marketBuyer.account });

            // Vende 0.5 shares dal non-badge e poi 0.5 dal badge
            const sharesIn = parseUnits("0.5", 6);

            // Non-badge sell
            let rs = (await pool.read.reserveUsdc()) as unknown as bigint;
            let rsh = (await pool.read.reserveShares()) as unknown as bigint;
            let preFeeOut = (rs * sharesIn) / (rsh + sharesIn);
            const nonBadgeBps = (await pool.read.currentSellFeeBps([marketBuyer.account.address])) as unknown as bigint;
            const badgeBpsBefore = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            if (!(badgeBpsBefore < nonBadgeBps)) throw new Error("badge non riduce bps su sell");
            const nonBadgeFee = (preFeeOut * nonBadgeBps) / FEE_DENOMINATOR;
            const nonBadgeUsdcOut = preFeeOut - nonBadgeFee;
            const sellOrder1: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174046"),
                recipient: marketBuyer.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesIn,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sellSig1 = await signMarketOrder(orderSigner as unknown as WalletClient, domain, sellOrder1);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([sellOrder1, sellSig1], { account: marketBuyer.account }),
                pool,
                "SellExecuted",
                [
                    getAddress(sellOrder1.recipient),
                    sharesIn,
                    nonBadgeFee,
                    nonBadgeUsdcOut,
                ]
            );

            // Badge sell
            rs = (await pool.read.reserveUsdc()) as unknown as bigint;
            rsh = (await pool.read.reserveShares()) as unknown as bigint;
            preFeeOut = (rs * sharesIn) / (rsh + sharesIn);
            const badgeBps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const badgeFee = (preFeeOut * badgeBps) / FEE_DENOMINATOR;
            const badgeUsdcOut = preFeeOut - badgeFee;
            const sellOrder2: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174047"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesIn,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sellSig2 = await signMarketOrder(orderSigner as unknown as WalletClient, domain, sellOrder2);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([sellOrder2, sellSig2], { account: recipient.account }),
                pool,
                "SellExecuted",
                [
                    getAddress(sellOrder2.recipient),
                    sharesIn,
                    badgeFee,
                    badgeUsdcOut,
                ]
            );
            // la fee in bps per il badge è inferiore; le fee assolute possono variare per via delle riserve mutate
        });

        it("fee non decresce prima della scadenza finestra (windowEnd)", async function () {
            const { viem, pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174048"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 1200n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            // Buy grande per dare molte shares al recipient (evita ShareBalanceMismatch)
            const rs0 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const bigBuy: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740EE"),
                recipient: recipient.account.address,
                usdcAmount: rs0 * 2n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 1200n),
                phase: 2,
            };
            const bigBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, bigBuy);
            await pool.write.claimMarketOrder([bigBuy, bigBuySig], { account: recipient.account });
            {
                await networkHelpers.time.increase(181); // consenti refresh
            }
            // Triggera la sync di reference con un tiny buy (BUY fa _syncSellFee pre-trade)
            const tinyBuyRef: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740F0"),
                recipient: recipient.account.address,
                usdcAmount: 1n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 1200n),
                phase: 2,
            };
            const tinyBuyRefSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tinyBuyRef);
            await pool.write.claimMarketOrder([tinyBuyRef, tinyBuyRefSig], { account: recipient.account });

            // Vendi abbastanza shares per far aumentare fee significativamente (calcola rispetto alle riserve post-sync)
            const rsh = (await pool.read.reserveShares()) as unknown as bigint;
            const rk = (await pool.read.reserveUsdc()) as unknown as bigint;
            const feeBps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const mulDivDown = (a: bigint, b: bigint, den: bigint) => (a * b) / den;
            const priceRef = mulDivDown(rk, 1_000_000n, rsh);
            const dropTarget = 2000n; // 20% con margine di aumento fee
            const computeDrop = (s: bigint) => {
                const pre = mulDivDown(rk, s, rsh + s);
                const fee = mulDivDown(pre, feeBps, 10_000n);
                const kout = pre - fee;
                const rk2 = rk - kout;
                const rs2 = rsh + s;
                const priceNew = mulDivDown(rk2, 1_000_000n, rs2);
                if (priceRef <= priceNew) return 0n;
                return mulDivDown(priceRef - priceNew, 10_000n, priceRef);
            };
            let lo = 1n, hi = rsh - 1n, ans = hi;
            while (lo <= hi) {
                const mid = (lo + hi) / 2n;
                const d = computeDrop(mid);
                if (d >= dropTarget) { ans = mid; hi = mid - 1n; } else { lo = mid + 1n; }
            }
            const sellToRaiseFee: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740EF"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: ans,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 1200n),
                phase: 2,
            };
            const sellSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, sellToRaiseFee);
            // Assicuriamoci che SellFeeUpdated venga emesso: se la reference non è perfettamente allineata, forziamo una tiny sync prima
            // stato fee precedente non utilizzato; manteniamo solo la verifica eventi
            await viem.assertions.emit(
                pool.write.claimMarketOrder([sellToRaiseFee, sellSig], { account: recipient.account }),
                pool,
                "SellFeeUpdated"
            );
            const stateAfterDrop = (await pool.read.sellFeeState()) as any;

            // Piccolo buy: la fee non deve scendere prima della scadenza
            const smallBuy: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174050"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 1200n),
                phase: 2,
            };
            const smallBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, smallBuy);
            await pool.write.claimMarketOrder([smallBuy, smallBuySig], { account: recipient.account });
            const stateBeforeExpiry = (await pool.read.sellFeeState()) as any;
            if ((stateBeforeExpiry[0]) < (stateAfterDrop[0])) throw new Error("fee diminuita prima di windowEnd");

            await networkHelpers.time.increase(4 * 60 * 60 + 1);

            const nowTs2 = BigInt((await (await viem.getPublicClient()).getBlock()).timestamp as unknown as number);
            const smallBuy2: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174051"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTs2 + 3600n,
                phase: 2,
            };
            const smallBuySig2 = await signMarketOrder(orderSigner as unknown as WalletClient, domain, smallBuy2);
            // Dopo windowEnd, la sync può emettere un nuovo SellFeeUpdated (downshift)
            await viem.assertions.emit(
                pool.write.claimMarketOrder([smallBuy2, smallBuySig2], { account: recipient.account }),
                pool,
                "SellFeeUpdated"
            );
            const stateAfterExpiry = (await pool.read.sellFeeState()) as any;
            if ((stateAfterExpiry[0]) > (stateBeforeExpiry[0])) throw new Error("fee non è diminuita dopo windowEnd");
        });

        it("property-based: random buy/sell sequence mantiene invarianti e monotonicità prezzo", async function () {
            const {
                pool,
                admin,
                recipient,
                orderSigner,
                targetRaise,
                domain,
            } = await networkHelpers.loadFixture(deployPoolFixture);

            // Setup: recipient con molte shares via seeding e pool in open market
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174052"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            // PRNG deterministico
            let x = 0x12345678;
            const rnd = () => {
                x ^= x << 13; x ^= x >> 17; x ^= x << 5; return ((x >>> 0) % 1000) / 1000;
            };

            const steps = 25;
            for (let i = 0; i < steps; i++) {
                const priceBefore = (await pool.read.currentPrice()) as unknown as bigint;
                const rsBefore = (await pool.read.reserveUsdc()) as unknown as bigint;
                const rshBefore = (await pool.read.reserveShares()) as unknown as bigint;
                const supplyBefore = (await pool.read.totalSupply()) as unknown as bigint;

                // 60% buy, 40% sell
                const choose = rnd();
                if (choose < 0.6) {
                    // BUY
                    const units = Math.max(1, Math.floor(rnd() * 30)); // 0.1 .. 3.0
                    const usdcAmount = parseUnits((units / 10).toString(), 6);
                    const order: MarketOrderStruct = {
                        orderId: uuidWithSuffix(0x050 + i),
                        recipient: recipient.account.address,
                        usdcAmount,
                        sharesAmount: 0n,
                        minSharesOut: 0n,
                        minUsdcOut: 0n,
                        expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                        phase: 2,
                    };
                    const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
                    await pool.write.claimMarketOrder([order, sig], { account: recipient.account });
                    if ((await pool.read.consumedOrders([order.orderId])) !== true) throw new Error("consumedOrders non settato (buy)");

                    const priceAfter = (await pool.read.currentPrice()) as unknown as bigint;
                    if (!(priceAfter >= priceBefore)) throw new Error("monotonicità prezzo (buy) violata");
                } else {
                    // SELL da recipient (ha shares)
                    const buyerBal = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
                    if (buyerBal === 0n) {
                        i--; // skip e ripeti step
                        continue;
                    }
                    const units = Math.max(1, Math.floor(rnd() * 50)); // 0.01 .. 0.50
                    let sharesAmount = parseUnits((units / 100).toString(), 6);
                    if (sharesAmount > buyerBal) sharesAmount = buyerBal / 2n;
                    if (sharesAmount === 0n) { i--; continue; }
                    const order: MarketOrderStruct = {
                        orderId: uuidWithSuffix(0x150 + i),
                        recipient: recipient.account.address,
                        usdcAmount: 0n,
                        sharesAmount,
                        minSharesOut: 0n,
                        minUsdcOut: 0n,
                        expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                        phase: 2,
                    };
                    const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
                    await pool.write.claimMarketOrder([order, sig], { account: recipient.account });
                    if ((await pool.read.consumedOrders([order.orderId])) !== true) throw new Error("consumedOrders non settato (sell)");

                    const priceAfter = (await pool.read.currentPrice()) as unknown as bigint;
                    if (!(priceAfter <= priceBefore)) throw new Error("monotonicità prezzo (sell) violata");
                }

                // invarianti base
                const rsAfter = (await pool.read.reserveUsdc()) as unknown as bigint;
                const rshAfter = (await pool.read.reserveShares()) as unknown as bigint;
                if (choose < 0.6) {
                    // BUY: stable aumenta, shares diminuiscono, bilancio pool diminuisce
                    if (!(rsAfter > rsBefore)) throw new Error("reserveUsdc non cresce dopo buy");
                    if (!(rshAfter < rshBefore)) throw new Error("reserveShares non cala dopo buy");
                } else {
                    // SELL: stable diminuisce, shares aumentano, bilancio pool aumenta
                    if (!(rsAfter < rsBefore)) throw new Error("reserveUsdc non cala dopo sell");
                    if (!(rshAfter > rshBefore)) throw new Error("reserveShares non cresce dopo sell");
                }
                if (rsAfter <= 0n || rshAfter <= 0n) throw new Error("riserve non positive");
                const supplyAfter = (await pool.read.totalSupply()) as unknown as bigint;
                if (supplyAfter !== supplyBefore) throw new Error("totalSupplyShares dovrebbe restare costante nel market");
            }
        });

        it("front-running: due buy con stesso expiry e ID diversi eseguiti in sequenza usano riserve aggiornate", async function () {
            const { viem, pool, orderSigner, marketBuyer, domain } = await networkHelpers.loadFixture(finalizePoolForMarket);

            const reserveUsdcBefore = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSharesBefore = (await pool.read.reserveShares()) as unknown as bigint;
            const usdcAmount1 = parseUnits("2", 6);
            const fee1 = (usdcAmount1 * BUY_FEE_BPS) / FEE_DENOMINATOR;
            const eff1 = usdcAmount1 - fee1;
            const sharesOut1 = (reserveSharesBefore * eff1) / (reserveUsdcBefore + eff1);

            const expiry = (BigInt(await networkHelpers.time.latest()) + 3600n);
            const order1: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174056"),
                recipient: marketBuyer.account.address,
                usdcAmount: usdcAmount1,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry,
                phase: 2,
            };
            const sig1 = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order1);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([order1, sig1], { account: marketBuyer.account }),
                pool,
                "BuyExecuted",
                [
                    getAddress(order1.recipient),
                    order1.usdcAmount,
                    fee1,
                    sharesOut1,
                ]
            );

            const reserveUsdcMid = (await pool.read.reserveUsdc()) as unknown as bigint; // rsBefore + eff1
            const reserveSharesMid = (await pool.read.reserveShares()) as unknown as bigint; // rshBefore - sharesOut1

            const usdcAmount2 = parseUnits("3", 6);
            const fee2 = (usdcAmount2 * BUY_FEE_BPS) / FEE_DENOMINATOR;
            const eff2 = usdcAmount2 - fee2;
            const sharesOut2 = (reserveSharesMid * eff2) / (reserveUsdcMid + eff2);

            const order2: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174057"),
                recipient: marketBuyer.account.address,
                usdcAmount: usdcAmount2,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry,
                phase: 2,
            };
            const sig2 = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order2);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([order2, sig2], { account: marketBuyer.account }),
                pool,
                "BuyExecuted",
                [
                    getAddress(order2.recipient),
                    order2.usdcAmount,
                    fee2,
                    sharesOut2,
                ]
            );
        });

        it("micro buy con effectiveAmount minimo → InsufficientLiquidity", async function () {
            const [admin, recipient, orderSigner] = await viem.getWalletClients();

            const pricePerShare = 1_000_000n; // 1e6
            const bootstrappedShares = 1_500_000n * 1_000_000n; // BOOTSTRAP_SHARES
            const seedingShares = bootstrappedShares - 1n; // lascia 1 share in riserva
            const targetRaise = (seedingShares * pricePerShare) / 1_000_000n; // = seedingShares

            const usdc = await viem.deployContract("MockUSDC", []);
            const pool = await viem.deployContract("PlayerSharePool", [
                admin.account.address,
                orderSigner.account.address,
                usdc.address,
                admin.account.address, // treasury
                targetRaise,
                [pricePerShare],
                [seedingShares],
            ]);

            await mintAndApproveUsdc(usdc, pool.address as Address, [admin, recipient, orderSigner], admin);

            const publicClient = await viem.getPublicClient();
            const chainId = await publicClient.getChainId();
            const domain: EIP712Domain = {
                name: "PlayerSharePool",
                version: "1",
                chainId: Number(chainId),
                verifyingContract: pool.address as Address,
            };

            await pool.write.startSeeding([], { account: admin.account });
            const expiry = (BigInt(await networkHelpers.time.latest()) + 3600n);
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174058"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry,
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174059"),
                recipient: recipient.account.address,
                usdcAmount: 1n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry,
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "PlayerSharePoolInsufficientLiquidity"
            );
        });

        it("buy rifiutato se minSharesOut non soddisfatto (slippage)", async function () {
            const { viem, pool, orderSigner, marketBuyer, domain } = await finalizePoolForMarket();
            const reserveUsdcBefore = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSharesBefore = (await pool.read.reserveShares()) as unknown as bigint;

            const usdcAmount = parseUnits("5", 6);
            const feeAmount = (usdcAmount * BUY_FEE_BPS) / FEE_DENOMINATOR;
            const effectiveAmount = usdcAmount - feeAmount;
            const expectedSharesOut = (reserveSharesBefore * effectiveAmount) / (reserveUsdcBefore + effectiveAmount);

            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174060"),
                recipient: marketBuyer.account.address,
                usdcAmount,
                sharesAmount: 0n,
                minSharesOut: expectedSharesOut + 1n, // forza slippage
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, sig], { account: marketBuyer.account }),
                pool,
                "PlayerSharePoolSlippage"
            );
        });

        it("sell rifiutato se minStableOut non soddisfatto (slippage)", async function () {
            const { viem, pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seedOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174061"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedOrder);
            await pool.write.claimSeedingOrder([seedOrder, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const reserveUsdcBefore = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSharesBefore = (await pool.read.reserveShares()) as unknown as bigint;
            const sharesIn = parseUnits("1", 6);
            const preFeeUSDCOut = (reserveUsdcBefore * sharesIn) / (reserveSharesBefore + sharesIn);
            const sellFeeBps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const feeAmount = (preFeeUSDCOut * sellFeeBps) / FEE_DENOMINATOR;
            const usdcOut = preFeeUSDCOut - feeAmount;

            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174062"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesIn,
                minSharesOut: 0n,
                minUsdcOut: usdcOut + 1n, // forza slippage
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "PlayerSharePoolSlippage"
            );
        });

        it("buy con minSharesOut esattamente uguale all'atteso passa", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain, viem } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x960),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const rsK = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rsS = (await pool.read.reserveShares()) as unknown as bigint;
            const kIn = parseUnits("4", 6);
            const fee = (kIn * BUY_FEE_BPS) / FEE_DENOMINATOR;
            const eff = kIn - fee;
            const sharesOut = (rsS * eff) / (rsK + eff);
            const order: MarketOrderStruct = {
                orderId: uuidWithSuffix(0x961),
                recipient: recipient.account.address,
                usdcAmount: kIn,
                sharesAmount: 0n,
                minSharesOut: sharesOut,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.emit(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "BuyExecuted"
            );
        });

        it("sell con minUsdcOut esattamente uguale all'atteso passa", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain, viem } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x962),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const rsK = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rsS = (await pool.read.reserveShares()) as unknown as bigint;
            const sharesIn = parseUnits("1.5", 6);
            const sellBps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const pre = (rsK * sharesIn) / (rsS + sharesIn);
            const fee = (pre * sellBps) / FEE_DENOMINATOR;
            const kOut = pre - fee;
            const order: MarketOrderStruct = {
                orderId: uuidWithSuffix(0x963),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesIn,
                minSharesOut: 0n,
                minUsdcOut: kOut,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.emit(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "SellExecuted"
            );
        });

        it("TTL boundary: expiry esattamente MAX_TTL consente claim, MAX_TTL+1 rifiuta (seeding)", async function () {
            const { pool, admin, recipient, orderSigner, domain, viem } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const now = BigInt(await networkHelpers.time.latest());
            const maxTtl = 3600n; // MAX_TTL
            const ok: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x964),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                expiry: now + maxTtl,
                phase: 1,
            };
            const okSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, ok);
            await viem.assertions.emit(
                pool.write.claimSeedingOrder([ok, okSig], { account: recipient.account }),
                pool,
                "SeedingOrderClaimed"
            );
            const tooLong: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x965),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                expiry: now + maxTtl + 60n,
                phase: 1,
            };
            const badSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, tooLong);
            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([tooLong, badSig], { account: recipient.account }),
                pool,
                "PlayerSharePoolOrderExpired"
            );
        });

        it("TTL boundary: expiry esattamente MAX_TTL consente claim, MAX_TTL+1 rifiuta (market)", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain, viem } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x966),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const now = BigInt(await networkHelpers.time.latest());
            const maxTtl = 3600n;
            const ok: MarketOrderStruct = {
                orderId: uuidWithSuffix(0x967),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("2", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: now + maxTtl,
                phase: 2,
            };
            const okSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, ok);
            await viem.assertions.emit(
                pool.write.claimMarketOrder([ok, okSig], { account: recipient.account }),
                pool,
                "BuyExecuted"
            );
            const tooLong: MarketOrderStruct = {
                orderId: uuidWithSuffix(0x968),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("2", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: now + maxTtl + 60n,
                phase: 2,
            };
            const badSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tooLong);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([tooLong, badSig], { account: recipient.account }),
                pool,
                "PlayerSharePoolOrderExpired"
            );
        });

        it("SellFeeUpdated emesso una sola volta per sell che aumenta fee", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x969),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const rs0 = (await pool.read.reserveUsdc()) as unknown as bigint;
            // large buy
            const bigBuy: MarketOrderStruct = {
                orderId: uuidWithSuffix(0x96A),
                recipient: recipient.account.address,
                usdcAmount: rs0 * 2n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const bigBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, bigBuy);
            await pool.write.claimMarketOrder([bigBuy, bigBuySig], { account: recipient.account });
            await networkHelpers.time.increase(181);
            // tiny buy to sync reference
            const tiny: MarketOrderStruct = { orderId: uuidWithSuffix(0x96B), recipient: recipient.account.address, usdcAmount: 1n, sharesAmount: 0n, minSharesOut: 0n, minUsdcOut: 0n, expiry: (BigInt(await networkHelpers.time.latest()) + 3600n), phase: 2 };
            const tinySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tiny);
            await pool.write.claimMarketOrder([tiny, tinySig], { account: recipient.account });
            // craft sell producing >10% drop
            const rsh = (await pool.read.reserveShares()) as unknown as bigint;
            const rk = (await pool.read.reserveUsdc()) as unknown as bigint;
            const bps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const mulDivDown = (a: bigint, b: bigint, den: bigint) => (a * b) / den;
            const targetDrop = 1050n;
            const compute = (s: bigint) => {
                const pre = mulDivDown(rk, s, rsh + s);
                const fee = mulDivDown(pre, bps, 10_000n);
                const kout = pre - fee;
                const rk2 = rk - kout;
                const rs2 = rsh + s;
                const ref = mulDivDown(rk, 1_000_000n, rsh);
                const pn = mulDivDown(rk2, 1_000_000n, rs2);
                if (ref <= pn) return 0n;
                return mulDivDown(ref - pn, 10_000n, ref);
            };
            let lo = 1n, hi = rsh - 1n, ans = hi;
            while (lo <= hi) { const mid = (lo + hi) / 2n; const d = compute(mid); if (d >= targetDrop) { ans = mid; hi = mid - 1n; } else { lo = mid + 1n; } }
            const sell: MarketOrderStruct = { orderId: uuidWithSuffix(0x96C), recipient: recipient.account.address, usdcAmount: 0n, sharesAmount: ans, minSharesOut: 0n, minUsdcOut: 0n, expiry: (BigInt(await networkHelpers.time.latest()) + 3600n), phase: 2 };
            const sellSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, sell);
            const txHash = await pool.write.claimMarketOrder([sell, sellSig], { account: recipient.account });
            const pc = await viem.getPublicClient();
            const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
            let count = 0;
            for (const log of receipt.logs) {
                try {
                    const ev: any = decodeEventLog({ abi: [{ type: "event", name: "SellFeeUpdated", inputs: [
                        { name: "feeBps", type: "uint256", indexed: false },
                        { name: "dropBps", type: "uint256", indexed: false },
                        { name: "windowEnd", type: "uint64", indexed: false },
                    ] } as any], data: log.data as any, topics: log.topics as any });
                    if (ev.eventName === "SellFeeUpdated") count++;
                } catch {}
            }
            if (count !== 1) throw new Error("SellFeeUpdated non emesso una sola volta");
        });

        it("reference refresh a 180s (boundary)", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x96D),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const beforeTs = (await pool.read.lastReferenceTimestamp()) as unknown as bigint;
            await networkHelpers.time.increase(180);
            const nowTs = BigInt((await (await viem.getPublicClient()).getBlock()).timestamp as unknown as number);
            const tiny: MarketOrderStruct = { orderId: uuidWithSuffix(0x96E), recipient: recipient.account.address, usdcAmount: parseUnits("1", 6), sharesAmount: 0n, minSharesOut: 0n, minUsdcOut: 0n, expiry: nowTs + 1200n, phase: 2 };
            const tinySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tiny);
            await pool.write.claimMarketOrder([tiny, tinySig], { account: recipient.account });
            const afterTs = (await pool.read.lastReferenceTimestamp()) as unknown as bigint;
            if (!(afterTs >= beforeTs + 180n)) throw new Error("reference non aggiornata al boundary 180s");
        });

        it("consumedOrders bloccano riuso cross-phases (ID seeding riusato in market)", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain, viem } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const id = uuidWithSuffix(0x970);
            const seed: SeedingOrderStruct = { orderId: id, recipient: recipient.account.address, usdcAmount: targetRaise, expiry: (BigInt(await networkHelpers.time.latest()) + 3600n), phase: 1 };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const mo: MarketOrderStruct = { orderId: id, recipient: recipient.account.address, usdcAmount: parseUnits("1", 6), sharesAmount: 0n, minSharesOut: 0n, minUsdcOut: 0n, expiry: (BigInt(await networkHelpers.time.latest()) + 3600n), phase: 2 };
            const moSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, mo);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([mo, moSig], { account: recipient.account }),
                pool,
                "PlayerSharePoolOrderConsumed"
            );
        });

        it("expiry == prossimo secondo è valido (seeding e market)", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain, viem } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const now = BigInt(await networkHelpers.time.latest());
            const seed: SeedingOrderStruct = { orderId: uuidWithSuffix(0x971), recipient: recipient.account.address, usdcAmount: parseUnits("1", 6), expiry: now + 1n, phase: 1 };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await viem.assertions.emit(
                pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account }),
                pool,
                "SeedingOrderClaimed"
            );
            // prepara market
            const seed2: SeedingOrderStruct = { orderId: uuidWithSuffix(0x972), recipient: recipient.account.address, usdcAmount: targetRaise, expiry: (now + 3600n), phase: 1 };
            const seedSig2 = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed2);
            await pool.write.claimSeedingOrder([seed2, seedSig2], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const now2 = BigInt(await networkHelpers.time.latest());
            const mo: MarketOrderStruct = { orderId: uuidWithSuffix(0x973), recipient: recipient.account.address, usdcAmount: parseUnits("1", 6), sharesAmount: 0n, minSharesOut: 0n, minUsdcOut: 0n, expiry: now2 + 1n, phase: 2 };
            const moSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, mo);
            await viem.assertions.emit(
                pool.write.claimMarketOrder([mo, moSig], { account: recipient.account }),
                pool,
                "BuyExecuted"
            );
        });

        it("startSeeding e finalizeSeeding rifiutati se il pool è in pausa", async function () {
            const { pool, admin, recipient, orderSigner, domain, viem } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.pause([], { account: admin.account });
            await viem.assertions.revertWithCustomError(
                pool.write.startSeeding([], { account: admin.account }),
                pool,
                "EnforcedPause"
            );
            await pool.write.unpause([], { account: admin.account });
            // entra in Seeding e raggiunge target
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = { orderId: uuidWithSuffix(0x974), recipient: recipient.account.address, usdcAmount: parseUnits("1", 6), expiry: (BigInt(await networkHelpers.time.latest()) + 3600n), phase: 1 };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, sig], { account: recipient.account });
            await pool.write.pause([], { account: admin.account });
            await viem.assertions.revertWithCustomError(
                pool.write.finalizeSeeding([], { account: admin.account }),
                pool,
                "EnforcedPause"
            );
            await pool.write.unpause([], { account: admin.account });
        });
    });

    describe("Access control e gestione ruoli", function () {
        it("startSeeding da non-manager → AccessControlUnauthorizedAccount", async function () {
            const { pool, recipient } = await networkHelpers.loadFixture(deployPoolFixture);
            await viem.assertions.revertWithCustomError(
                pool.write.startSeeding([], { account: recipient.account }),
                pool,
                "AccessControlUnauthorizedAccount"
            );
        });

        it("finalizeSeeding da non-manager → AccessControlUnauthorizedAccount", async function () {
            const { pool, recipient } = await networkHelpers.loadFixture(deployPoolFixture);
            await viem.assertions.revertWithCustomError(
                pool.write.finalizeSeeding([], { account: recipient.account }),
                pool,
                "AccessControlUnauthorizedAccount"
            );
        });

        it("pause/unpause da non-admin → AccessControlUnauthorizedAccount", async function () {
            const { pool, recipient } = await networkHelpers.loadFixture(deployPoolFixture);
            await viem.assertions.revertWithCustomError(
                pool.write.pause([], { account: recipient.account }),
                pool,
                "AccessControlUnauthorizedAccount"
            );
            await viem.assertions.revertWithCustomError(
                pool.write.unpause([], { account: recipient.account }),
                pool,
                "AccessControlUnauthorizedAccount"
            );
        });

        it("grant MANAGER_ROLE a nuovo account: può chiamare startSeeding", async function () {
            const { pool, admin, recipient } = await networkHelpers.loadFixture(deployPoolFixture);
            const role = await pool.read.MANAGER_ROLE();
            await pool.write.grantRole([role, recipient.account.address], { account: admin.account });
            await viem.assertions.emit(
                pool.write.startSeeding([], { account: recipient.account }),
                pool,
                "SeedingStarted"
            );
        });

        it("grant e revoke ORDER_SIGNER_ROLE: firma valida/invalidata", async function () {
            const { pool, admin, recipient, recipient2, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const signerRole = await pool.read.ORDER_SIGNER_ROLE();
            // concede ruolo a recipient2
            await pool.write.grantRole([signerRole, recipient2.account.address], { account: admin.account });
            const okOrder: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x980),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const okSig = await signSeedingOrder(recipient2 as unknown as WalletClient, domain, okOrder);
            await viem.assertions.emit(
                pool.write.claimSeedingOrder([okOrder, okSig], { account: recipient.account }),
                pool,
                "SeedingOrderClaimed"
            );
            // revoca ruolo e prova nuova firma → invalid signature
            await pool.write.revokeRole([signerRole, recipient2.account.address], { account: admin.account });
            const badOrder: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x981),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const badSig = await signSeedingOrder(recipient2 as unknown as WalletClient, domain, badOrder);
            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([badOrder, badSig], { account: recipient.account }),
                pool,
                "PlayerSharePoolInvalidSignature"
            );
        });

        it("renounceRole da terzi → AccessControlBadConfirmation", async function () {
            const { pool, admin, recipient } = await networkHelpers.loadFixture(deployPoolFixture);
            const role = await pool.read.MANAGER_ROLE();
            // recipient prova a rinunciare al ruolo del admin
            await viem.assertions.revertWithCustomError(
                pool.write.renounceRole([role, admin.account.address], { account: recipient.account }),
                pool,
                "AccessControlBadConfirmation"
            );
        });

        it("hasRole: admin ha DEFAULT_ADMIN_ROLE e MANAGER_ROLE; orderSigner ha ORDER_SIGNER_ROLE", async function () {
            const { pool, admin, orderSigner } = await networkHelpers.loadFixture(deployPoolFixture);
            const defaultAdmin = await pool.read.DEFAULT_ADMIN_ROLE();
            const manager = await pool.read.MANAGER_ROLE();
            const signer = await pool.read.ORDER_SIGNER_ROLE();
            const isAdmin = (await pool.read.hasRole([defaultAdmin, admin.account.address])) as unknown as boolean;
            const isManager = (await pool.read.hasRole([manager, admin.account.address])) as unknown as boolean;
            const isSigner = (await pool.read.hasRole([signer, orderSigner.account.address])) as unknown as boolean;
            if (!isAdmin || !isManager || !isSigner) throw new Error("ruoli iniziali non assegnati correttamente");
        });
    });

    describe("Phase controls and price dynamics", function () {
        it("disallows seeding claims before startSeeding and allows after", async function () {
            const {
                viem,
                pool,
                admin,
                recipient,
                orderSigner,
                domain,
            } = await networkHelpers.loadFixture(deployPoolFixture);

            const expiry = (BigInt(await networkHelpers.time.latest()) + 3600n);

            const order: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174063"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                expiry,
                phase: 1,
            };

            const signature = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);

            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([order, signature], { account: recipient.account }),
                pool,
                "PlayerSharePoolPhaseMismatch"
            );

            await pool.write.startSeeding([], { account: admin.account });

            await viem.assertions.emitWithArgs(
                pool.write.claimSeedingOrder([order, signature], { account: recipient.account }),
                pool,
                "SeedingOrderClaimed",
                [
                    order.orderId,
                    getAddress(order.recipient),
                    order.usdcAmount,
                    parseUnits("1", 6),
                    getAddress(orderSigner.account.address),
                ]
            );
        });

        it("price increases after an open market buy (x*y=k)", async function () {
            const {
                pool,
                admin,
                recipient,
                orderSigner,
                targetRaise,
                domain,
            } = await networkHelpers.loadFixture(deployPoolFixture);

            // prepare open market
            await pool.write.startSeeding([], { account: admin.account });

            const seedingOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174064"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedingOrder);
            await pool.write.claimSeedingOrder([seedingOrder, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const priceBefore = (await pool.read.currentPrice()) as unknown as bigint;


            const usdcAmount = parseUnits("5", 6);

            const marketOrder: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174065"),
                recipient: recipient.account.address,
                usdcAmount,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const marketSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, marketOrder);
            await pool.write.claimMarketOrder([marketOrder, marketSig], { account: recipient.account });

            const priceAfter = (await pool.read.currentPrice()) as unknown as bigint;
            if (!(priceAfter > priceBefore)) throw new Error("price did not increase after buy");
        });

        it("rispetta pausa: nessun claim durante pausa", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            await pool.write.pause([], { account: admin.account });
            const order: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174066"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await viem.assertions.revertWithCustomError(
                pool.write.claimSeedingOrder([order, sig], { account: recipient.account }),
                pool,
                "EnforcedPause"
            );
            await pool.write.unpause([], { account: admin.account });
        });

        it("finalizeSeeding fallisce se targetRaise non raggiunto o liquidity insufficienti", async function () {
            const { viem, pool, admin } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            await viem.assertions.revertWithCustomError(
                pool.write.finalizeSeeding([], { account: admin.account }),
                pool,
                "PlayerSharePoolTargetNotMet"
            );
        });

        it("refresh referencePrice dopo REFRESH_INTERVAL e sync", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174067"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const tsBefore = (await pool.read.lastReferenceTimestamp()) as unknown as bigint;
            // avanza tempo oltre REFRESH_INTERVAL (180s)
            await networkHelpers.time.increase(181);
            // trigger sync via un piccolo buy
            const nowTs = BigInt((await (await viem.getPublicClient()).getBlock()).timestamp as unknown as number);
            const mo: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174068"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTs + 3600n,
                phase: 2,
            };
            const moSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, mo);
            await pool.write.claimMarketOrder([mo, moSig], { account: recipient.account });
            const refAfter = (await pool.read.referencePrice()) as unknown as bigint;
            const tsAfter = (await pool.read.lastReferenceTimestamp()) as unknown as bigint;
            if (tsAfter < tsBefore) throw new Error("lastReferenceTimestamp non aggiornato");
            if (refAfter === 0n) throw new Error("referencePrice non aggiornato");
        });

        it("somma bilanci utenti + riserve + treasury == totalSupplyShares (MAX_SUPPLY)", async function () {
            const { pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174069"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const total = (await pool.read.totalSupply()) as unknown as bigint;
            const balRecipient = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
            const treasuryAddr = admin.account.address; // in fixture treasury==admin
            const balTreasury = (await pool.read.balanceOf([treasuryAddr as Address])) as unknown as bigint;
            const reserveShares = (await pool.read.reserveShares()) as unknown as bigint;
            if (balRecipient + balTreasury + reserveShares !== total) throw new Error("somma bilanci non uguale a totalSupplyShares");
        });

        it("finalize minta al treasury esattamente MAX_SUPPLY - BOOTSTRAP_SHARES", async function () {
            const { pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            const maxSupply = (await pool.read.MAX_SUPPLY()) as unknown as bigint;
            const bootstrap = (await pool.read.BOOTSTRAP_SHARES()) as unknown as bigint;
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x977),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const balTreasury = (await pool.read.balanceOf([admin.account.address as Address])) as unknown as bigint;
            const expected = maxSupply - bootstrap;
            if (balTreasury !== expected) throw new Error("mint al treasury != MAX_SUPPLY - BOOTSTRAP_SHARES");
        });

        it("eventi di fase: SeedingStarted, SeedingFinalized", async function () {
            const { viem, pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await viem.assertions.emit(
                pool.write.startSeeding([], { account: admin.account }),
                pool,
                "SeedingStarted"
            );
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-42661417406A"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, sig], { account: recipient.account });
            await viem.assertions.emit(
                pool.write.finalizeSeeding([], { account: admin.account }),
                pool,
                "SeedingFinalized",
            );
        });

        it("currentPrice formula dopo finalize", async function () {
            const { pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174071"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const rs = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rsh = (await pool.read.reserveShares()) as unknown as bigint;
            const expected = (rs * (10n ** 6n)) / rsh;
            const price = (await pool.read.currentPrice()) as unknown as bigint;
            if (price !== expected) throw new Error("currentPrice formula errata");
        });
        
        it("currentPrice è 0 prima di finalize e >0 dopo", async function () {
            const { pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            const before = (await pool.read.currentPrice()) as unknown as bigint;
            if (before !== 0n) throw new Error("currentPrice deve essere 0 prima di finalize");
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x975),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const after = (await pool.read.currentPrice()) as unknown as bigint;
            if (!(after > 0n)) throw new Error("currentPrice deve essere > 0 dopo finalize");
        });

        it("SeedingFinalized emette argomenti corretti (usdcLiquidity e shareLiquidity)", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x976),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, sig], { account: recipient.account });
            const bootstrap = (await pool.read.BOOTSTRAP_SHARES()) as unknown as bigint;
            const expectedShareLiquidity = bootstrap - targetRaise; // 1:1 nel fixture
            await viem.assertions.emitWithArgs(
                pool.write.finalizeSeeding([], { account: admin.account }),
                pool,
                "SeedingFinalized",
                [
                    targetRaise,
                    expectedShareLiquidity,
                ]
            );
        });

        it("referencePrice == currentPrice subito dopo finalize", async function () {
            const { pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = { orderId: uuidWithSuffix(0x978), recipient: recipient.account.address, usdcAmount: targetRaise, expiry: (BigInt(await networkHelpers.time.latest()) + 3600n), phase: 1 };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const ref = (await pool.read.referencePrice()) as unknown as bigint;
            const price = (await pool.read.currentPrice()) as unknown as bigint;
            if (ref !== price) throw new Error("referencePrice != currentPrice subito dopo finalize");
        });

        it("totalSupplyShares == MAX_SUPPLY dopo finalize", async function () {
            const { pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = { orderId: uuidWithSuffix(0x97C), recipient: recipient.account.address, usdcAmount: targetRaise, expiry: (BigInt(await networkHelpers.time.latest()) + 3600n), phase: 1 };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            const total = (await pool.read.totalSupply()) as unknown as bigint;
            const max = (await pool.read.MAX_SUPPLY()) as unknown as bigint;
            if (total !== max) throw new Error("totalSupplyShares != MAX_SUPPLY dopo finalize");
        });

        it("finalizeSeeding chiamato due volte → PhaseMismatch", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = { orderId: uuidWithSuffix(0x97D), recipient: recipient.account.address, usdcAmount: targetRaise, expiry: (BigInt(await networkHelpers.time.latest()) + 3600n), phase: 1 };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            await viem.assertions.revertWithCustomError(
                pool.write.finalizeSeeding([], { account: admin.account }),
                pool,
                "PlayerSharePoolPhaseMismatch"
            );
        });

        it("reset fee a base dopo windowEnd e price recovery", async function () {
            const { pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174072"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            // Grande sell per aumentare fee (forceRefresh aggiorna reference al prezzo basso)
            const bigSell: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174073"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: targetRaise / 2n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            
            const bigSellSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, bigSell);
            await pool.write.claimMarketOrder([bigSell, bigSellSig], { account: recipient.account });
            
            // Avanza tempo oltre windowEnd
            await networkHelpers.time.increase(4 * 60 * 60 + 5);
            
            // SEMPLIFICATO: tiny buy sufficiente per triggerare reset (reference già basso dopo big sell)
            const nowTs3 = BigInt(await networkHelpers.time.latest());
            const tinyBuy: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174074"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTs3 + 3600n,
                phase: 2,
            };
            const tinyBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tinyBuy);
            await pool.write.claimMarketOrder([tinyBuy, tinyBuySig], { account: recipient.account });

            const stAny = (await pool.read.sellFeeState()) as any;
            const rawFeeBps = BigInt(stAny[0]!);
            const isBadge = (await pool.read.badgeEligible([recipient.account.address])) as unknown as boolean;
            const feeNow = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const expectedEffective = rawFeeBps - (isBadge && rawFeeBps >= 50n ? 50n : 0n);
            if (rawFeeBps !== 500n) throw new Error(`sell fee base non resettata: ${rawFeeBps} bps`);
            if (feeNow !== expectedEffective) throw new Error("sell fee effettiva non coerente con badge/base");
        });

        it("fee torna a base dopo windowEnd con SELL (sync post-trade)", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            
            // Seed completo per entrare in OpenMarket
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174080"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            // Buy grande per dare shares al recipient
            const reserveUsdcInit = (await pool.read.reserveUsdc()) as unknown as bigint;
            const bigBuy: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174081"),
                recipient: recipient.account.address,
                usdcAmount: reserveUsdcInit * 3n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const bigBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, bigBuy);
            await pool.write.claimMarketOrder([bigBuy, bigBuySig], { account: recipient.account });

            // Attendi refresh interval per aggiornare reference price al nuovo prezzo alto
            await networkHelpers.time.increase(181);

            // Tiny buy per triggerare la sync e aggiornare referencePrice al prezzo attuale (alto)
            const tinyBuy: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174082"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const tinyBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tinyBuy);
            await pool.write.claimMarketOrder([tinyBuy, tinyBuySig], { account: recipient.account });

            // Sell grande per causare drop >= 30% rispetto al nuovo reference (alto) e aumentare fee
            const recipientShares = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
            const sellShares = recipientShares / 2n; // vendiamo metà delle shares

            const bigSell: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174083"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sellShares,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const bigSellSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, bigSell);
            await pool.write.claimMarketOrder([bigSell, bigSellSig], { account: recipient.account });

            const stateAfterBigSell = (await pool.read.sellFeeState()) as any;
            const feeAfterBigSell = BigInt(stateAfterBigSell[0]!);
            const windowEnd = BigInt(stateAfterBigSell[2]!);
            if (feeAfterBigSell <= 500n) throw new Error("fee non aumentata dopo big sell");
            if (windowEnd === 0n) throw new Error("windowEnd atteso > 0 dopo sell con drop");

            // SEMPLIFICATO: con sync POST-trade + forceRefresh, il reference è già aggiornato al prezzo basso
            // Avanza tempo oltre windowEnd
            await networkHelpers.time.increase(4 * 60 * 60 + 10);

            // Tiny buy è sufficiente per triggerare il reset
            const nowTs = BigInt((await (await viem.getPublicClient()).getBlock()).timestamp as unknown as number);
            const tinyBuy2: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174084"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTs + 3600n,
                phase: 2,
            };
            const tinyBuy2Sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tinyBuy2);
            await pool.write.claimMarketOrder([tinyBuy2, tinyBuy2Sig], { account: recipient.account });

            const stateAfterReset = (await pool.read.sellFeeState()) as any;
            const feeAfterReset = BigInt(stateAfterReset[0]!);
            
            if (feeAfterReset !== 500n) {
                throw new Error(`fee non resettata a base: trovato ${feeAfterReset} bps`);
            }
        });

        it("sell fee si riabbassa a base (500 bps) quando windowEnd scade (test esplicito)", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            
            // Setup: seeding -> finalize
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174090"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            // Verifica stato iniziale: fee base = 500 bps, windowEnd = 0
            const stateInit = (await pool.read.sellFeeState()) as any;
            const feeInit = BigInt(stateInit[0]!);
            const windowEndInit = BigInt(stateInit[2]!);
            if (feeInit !== 500n) throw new Error(`fee iniziale attesa 500 bps, trovato ${feeInit}`);
            if (windowEndInit !== 0n) throw new Error(`windowEnd iniziale atteso 0, trovato ${windowEndInit}`);

            // Buy grande per dare shares al recipient + sync reference al prezzo alto
            await networkHelpers.time.increase(181); // REFRESH_INTERVAL
            const reserveUsdcStart = (await pool.read.reserveUsdc()) as unknown as bigint;
            const bigBuy: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174091"),
                recipient: recipient.account.address,
                usdcAmount: reserveUsdcStart * 5n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const bigBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, bigBuy);
            await pool.write.claimMarketOrder([bigBuy, bigBuySig], { account: recipient.account });

            // Grande SELL per causare drop e alzare fee
            // La sync POST-trade del SELL aggiornerà il reference al prezzo basso
            await networkHelpers.time.increase(181); // REFRESH_INTERVAL
            const recipientShares = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
            const sellShares = (recipientShares * 60n) / 100n;
            
            const nowTsSell = BigInt((await (await viem.getPublicClient()).getBlock()).timestamp as unknown as number);
            const bigSell: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174093"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sellShares,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTsSell + 3600n,
                phase: 2,
            };
            const bigSellSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, bigSell);
            await pool.write.claimMarketOrder([bigSell, bigSellSig], { account: recipient.account });

            // Verifica che fee sia aumentata e windowEnd > 0
            const stateAfterSell = (await pool.read.sellFeeState()) as any;
            const feeAfterSell = BigInt(stateAfterSell[0]!);
            const windowEndAfterSell = BigInt(stateAfterSell[2]!);
            if (feeAfterSell <= 500n) throw new Error(`fee non aumentata: ${feeAfterSell} bps (atteso > 500)`);
            if (windowEndAfterSell === 0n) throw new Error("windowEnd atteso > 0 dopo sell con drop");

            // Avanza tempo OLTRE windowEnd
            await networkHelpers.time.increase(4 * 60 * 60 + 60);

            // SEMPLIFICATO: un tiny buy è sufficiente per triggerare il reset
            // - PRE sync: windowExpired=true, prezzo~=reference (basso) → drop=0 → reset a 500
            const nowTs = BigInt((await (await viem.getPublicClient()).getBlock()).timestamp as unknown as number);
            const tinyBuy: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-426614174094"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6), // tiny buy, non serve recovery
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTs + 3600n,
                phase: 2,
            };
            const tinyBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tinyBuy);
            
            await viem.assertions.emit(
                pool.write.claimMarketOrder([tinyBuy, tinyBuySig], { account: recipient.account }),
                pool,
                "SellFeeUpdated"
            );

            // Verifica finale: fee DEVE essere esattamente 500 bps e windowEnd DEVE essere 0
            const stateFinal = (await pool.read.sellFeeState()) as any;
            const feeFinal = BigInt(stateFinal[0]!);
            const windowEndFinal = BigInt(stateFinal[2]!);
            
            if (feeFinal !== 500n) {
                throw new Error(`sell fee non tornata a base: atteso 500 bps, trovato ${feeFinal} bps`);
            }
            if (windowEndFinal !== 0n) {
                throw new Error(`windowEnd non resettato: atteso 0, trovato ${windowEndFinal}`);
            }
        });

        it("SELL dopo windowEnd scaduto: emette due SellFeeUpdated (reset pre-trade + aumento post-trade)", async function () {
            const { viem, pool, admin, recipient, orderSigner, domain, targetRaise } = await networkHelpers.loadFixture(deployPoolFixture);
            
            // Setup: seeding -> finalize
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740C0"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            // Buy grande per dare shares
            const reserveUsdcStart = (await pool.read.reserveUsdc()) as unknown as bigint;
            const bigBuy: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740C1"),
                recipient: recipient.account.address,
                usdcAmount: reserveUsdcStart * 5n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const bigBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, bigBuy);
            await pool.write.claimMarketOrder([bigBuy, bigBuySig], { account: recipient.account });

            // Attendi refresh + sync reference
            await networkHelpers.time.increase(181);
            const tinyBuy: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740C2"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const tinyBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, tinyBuy);
            await pool.write.claimMarketOrder([tinyBuy, tinyBuySig], { account: recipient.account });

            // Primo SELL per alzare la fee e creare windowEnd > 0
            await networkHelpers.time.increase(181);
            const recipientShares = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
            const nowTs1 = BigInt((await (await viem.getPublicClient()).getBlock()).timestamp as unknown as number);
            const firstSell: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740C3"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: recipientShares / 3n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTs1 + 3600n,
                phase: 2,
            };
            const firstSellSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, firstSell);
            await pool.write.claimMarketOrder([firstSell, firstSellSig], { account: recipient.account });

            const stateAfterFirstSell = (await pool.read.sellFeeState()) as any;
            const feeAfterFirstSell = BigInt(stateAfterFirstSell[0]!);
            const windowEndAfterFirstSell = BigInt(stateAfterFirstSell[2]!);
            if (feeAfterFirstSell <= 500n) throw new Error("fee non aumentata dopo primo sell");
            if (windowEndAfterFirstSell === 0n) throw new Error("windowEnd atteso > 0");

            // SEMPLIFICATO: con forceRefresh POST-trade, il reference è già aggiornato al prezzo basso
            // Attendi scadenza windowEnd
            await networkHelpers.time.increase(4 * 60 * 60 + 60);

            // Secondo SELL: dovrebbe emettere DUE SellFeeUpdated
            // 1. PRE-trade: reset perché windowEnd scaduto
            // 2. POST-trade: aumento perché il sell causa nuovo drop
            const nowTs2 = BigInt((await (await viem.getPublicClient()).getBlock()).timestamp as unknown as number);
            const remainingShares = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
            const secondSell: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740C4"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: remainingShares / 2n, // sell grande per causare drop
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTs2 + 3600n,
                phase: 2,
            };
            const secondSellSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, secondSell);
            const txHash = await pool.write.claimMarketOrder([secondSell, secondSellSig], { account: recipient.account });

            // Conta gli eventi SellFeeUpdated
            const pc = await viem.getPublicClient();
            const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
            let count = 0;
            for (const log of receipt.logs) {
                try {
                    const ev: any = decodeEventLog({ abi: [{ type: "event", name: "SellFeeUpdated", inputs: [
                        { name: "feeBps", type: "uint256", indexed: false },
                        { name: "dropBps", type: "uint256", indexed: false },
                        { name: "windowEnd", type: "uint64", indexed: false },
                    ] } as any], data: log.data as any, topics: log.topics as any });
                    if (ev.eventName === "SellFeeUpdated") count++;
                } catch {}
            }

            // Con la nuova logica simmetrica (sync pre + post), dovremmo avere 2 eventi:
            // - PRE: reset a 500 bps (windowEnd scaduto)
            // - POST: aumento dovuto al nuovo drop
            if (count !== 2) {
                throw new Error(`Attesi 2 SellFeeUpdated (reset + aumento), trovati ${count}`);
            }
        });
    });

    describe("Constructor sanity", function () {
        it("reverts se targetRaise > costo totale bins (PlayerSharePoolTargetNotMet)", async function () {
            const [admin, orderSigner] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC", []);
            const targetRaise = parseUnits("1000", 6);
            const prices = [parseUnits("0.1", 6)];
            const shares = [parseUnits("1", 6)]; // costo 0.1 < targetRaise
            await viem.assertions.revertWithCustomError(
                viem.deployContract("PlayerSharePool", [
                    admin.account.address,
                    orderSigner.account.address,
                    usdc.address,
                    admin.account.address,
                    targetRaise,
                    prices,
                    shares,
                ]),
                await viem.getContractAt("PlayerSharePool", admin.account.address),
                "PlayerSharePoolTargetNotMet"
            );
        });

        it("reverts con lunghezza arrays errata (PlayerSharePoolInvalidArrayLength)", async function () {
            const [admin, orderSigner] = await viem.getWalletClients();
            const usdc = await viem.deployContract("MockUSDC", []);
            const targetRaise = parseUnits("1", 6);
            await viem.assertions.revertWithCustomError(
                viem.deployContract("PlayerSharePool", [
                    admin.account.address,
                    orderSigner.account.address,
                    usdc.address,
                    admin.account.address,
                    targetRaise,
                    [],
                    [],
                ]),
                await viem.getContractAt("PlayerSharePool", admin.account.address),
                "PlayerSharePoolInvalidArrayLength"
            );
        });

        it("reverts admin zero address (PlayerSharePoolZeroAddress)", async function () {
            const [admin, orderSigner] = await viem.getWalletClients();
            const zero = getAddress("0x0000000000000000000000000000000000000000");
            const usdc = await viem.deployContract("MockUSDC", []);
            await viem.assertions.revertWithCustomError(
                viem.deployContract("PlayerSharePool", [
                    zero,
                    orderSigner.account.address,
                    usdc.address,
                    zero,
                    parseUnits("1", 6),
                    [parseUnits("0.1", 6)],
                    [parseUnits("1", 6)],
                ]),
                await viem.getContractAt("PlayerSharePool", admin.account.address),
                "PlayerSharePoolZeroAddress"
            );
        });

        it("reverts orderSigner zero address (PlayerSharePoolZeroAddress)", async function () {
            const [admin] = await viem.getWalletClients();
            const zero = getAddress("0x0000000000000000000000000000000000000000");
            const usdc = await viem.deployContract("MockUSDC", []);
            await viem.assertions.revertWithCustomError(
                viem.deployContract("PlayerSharePool", [
                    admin.account.address,
                    zero,
                    usdc.address,
                    admin.account.address,
                    parseUnits("1", 6),
                    [parseUnits("0.1", 6)],
                    [parseUnits("1", 6)],
                ]),
                await viem.getContractAt("PlayerSharePool", admin.account.address),
                "PlayerSharePoolZeroAddress"
            );
        });

        it("reverts treasury zero address (PlayerSharePoolZeroAddress)", async function () {
            const [admin, orderSigner] = await viem.getWalletClients();
            const zero = getAddress("0x0000000000000000000000000000000000000000");
            const usdc = await viem.deployContract("MockUSDC", []);
            await viem.assertions.revertWithCustomError(
                viem.deployContract("PlayerSharePool", [
                    admin.account.address,
                    orderSigner.account.address,
                    usdc.address,
                    zero,
                    parseUnits("1", 6),
                    [parseUnits("0.1", 6)],
                    [parseUnits("1", 6)],
                ]),
                await viem.getContractAt("PlayerSharePool", admin.account.address),
                "PlayerSharePoolZeroAddress"
            );
        });

        it("reverts se un prezzo o uno shares sono zero (PlayerSharePoolZeroValue)", async function () {
            const [admin, orderSigner] = await viem.getWalletClients();
            const targetRaise = parseUnits("1", 6);
            const usdc = await viem.deployContract("MockUSDC", []);
            // prezzo zero
            await viem.assertions.revertWithCustomError(
                viem.deployContract("PlayerSharePool", [
                    admin.account.address,
                    orderSigner.account.address,
                    usdc.address,
                    admin.account.address,
                    targetRaise,
                    [0n],
                    [parseUnits("1", 6)],
                ]),
                await viem.getContractAt("PlayerSharePool", admin.account.address),
                "PlayerSharePoolZeroValue"
            );
            // shares zero
            await viem.assertions.revertWithCustomError(
                viem.deployContract("PlayerSharePool", [
                    admin.account.address,
                    orderSigner.account.address,
                    usdc.address,
                    admin.account.address,
                    targetRaise,
                    [parseUnits("0.1", 6)],
                    [0n],
                ]),
                await viem.getContractAt("PlayerSharePool", admin.account.address),
                "PlayerSharePoolZeroValue"
            );
        });
    });

    describe("Edge cases aggiuntivi e nuovi eventi", function () {
        it("emette dust su seeding non esattamente spendibile (seeding rounding)", async function () {
            const [admin, recipient, orderSigner] = await viem.getWalletClients();

            // Un solo bin con prezzo molto piccolo e non divisibile: 0.000003 per 1e6 share (price=3)
            const price = parseUnits("0.000003", 6);
            const shares = parseUnits("1000", 6); // capacità sufficiente
            // Il costo totale del bin è shares*price/1e6 = 1000e6 * 3 / 1e6 = 0.003 USDC
            // Impostiamo targetRaise < 0.003 per evitare TargetNotMet in constructor
            const targetRaise = parseUnits("0.002", 6);

            const usdc = await viem.deployContract("MockUSDC", []);
            const pool = await viem.deployContract("PlayerSharePool", [
                admin.account.address,
                orderSigner.account.address,
                usdc.address,
                admin.account.address,
                targetRaise,
                [price],
                [shares],
            ]);

            await mintAndApproveUsdc(usdc, pool.address as Address, [admin, recipient, orderSigner], admin);

            const publicClient = await viem.getPublicClient();
            const chainId = await publicClient.getChainId();
            const domain: EIP712Domain = {
                name: "PlayerSharePool",
                version: "1",
                chainId: Number(chainId),
                verifyingContract: pool.address as Address,
            };

            await pool.write.startSeeding([], { account: admin.account });

            // 10 micro-usdc a prezzo 3 micro-usdc / microshare → avanzerà 1 unità che non può comprare 1 microshare
            const order: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740F0"),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("0.000010", 6), // 10
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);

            // Calcolo atteso: remaining=10, price=3 → shares=(10*1e6)/3=3,333,333; cost=floor(3,333,333*3/1e6)=9; dust=1
            const expectedShares = 3_333_333n;
            const expectedCost = 9n;
            const expectedDust = 1n;

            const txHash = await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            const pc = await viem.getPublicClient();
            const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
            // Verifica evento SeedingDustGenerated e stato conseguente
            const dustAbi = [{
                type: "event", name: "SeedingDustGenerated", inputs: [
                    { indexed: true, name: "orderId", type: "bytes16" },
                    { indexed: true, name: "recipient", type: "address" },
                    { indexed: false, name: "usdcDust", type: "uint256" },
                ], anonymous: false
            } as const];
            let seenDust = false;
            for (const log of receipt.logs) {
                try {
                    const ev2: any = decodeEventLog({ abi: dustAbi as any, data: log.data as any, topics: log.topics as any });
                    if (ev2.eventName === "SeedingDustGenerated") {
                        if (ev2.args.orderId === order.orderId && getAddress(ev2.args.recipient) === getAddress(order.recipient)) {
                            if (ev2.args.usdcDust === expectedDust) {
                                seenDust = true;
                            }
                        }
                    }
                } catch {}
            }
            if (!seenDust) throw new Error("SeedingDustGenerated non trovato o payload errato");
            const bal = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
            if (bal !== expectedShares) throw new Error("shares minted != atteso");
            const raised = (await pool.read.seedingUsdcCollected()) as unknown as bigint;
            if (raised !== expectedCost) throw new Error("seedingUsdcCollected != cost atteso");
        });

        it("finalizeSeeding reverte con LiquidityNotProvided se shareBalance==0 (tutto venduto in seeding)", async function () {
            const [admin, recipient, orderSigner] = await viem.getWalletClients();
            const BOOTSTRAP = 1_500_000n * 1_000_000n; // deve combaciare con costante on-chain
            const price = parseUnits("1", 6); // 1 usdc per share piena
            const sharesAll = BOOTSTRAP; // tutto il bootstrap disponibile nei bin
            const targetRaise = (sharesAll * price) / 1_000_000n; // = BOOTSTRAP

            const usdc = await viem.deployContract("MockUSDC", []);
            const pool = await viem.deployContract("PlayerSharePool", [
                admin.account.address,
                orderSigner.account.address,
                usdc.address,
                admin.account.address,
                targetRaise,
                [price],
                [sharesAll],
            ]);

            await mintAndApproveUsdc(usdc, pool.address as Address, [admin, recipient, orderSigner], admin);

            const publicClient = await viem.getPublicClient();
            const chainId = await publicClient.getChainId();
            const domain: EIP712Domain = {
                name: "PlayerSharePool",
                version: "1",
                chainId: Number(chainId),
                verifyingContract: pool.address as Address,
            };

            await pool.write.startSeeding([], { account: admin.account });

            const seedingOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740F1"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise, // compra l'intero BOOTSTRAP
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedingOrder);
            await pool.write.claimSeedingOrder([seedingOrder, sig], { account: recipient.account });

            await viem.assertions.revertWithCustomError(
                pool.write.finalizeSeeding([], { account: admin.account }),
                pool,
                "PlayerSharePoolLiquidityNotProvided"
            );
        });

        it("emette MarketBuyClaimed con payload corretto", async function () {
            const {
                viem,
                pool,
                admin,
                recipient,
                orderSigner,
                marketBuyer,
                targetRaise,
                domain,
            } = await networkHelpers.loadFixture(deployPoolFixture);

            // Finalizza per open market
            const seedingOrder: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a455-426614174072"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 1200n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedingOrder);
            await pool.write.startSeeding([], { account: admin.account });
            await pool.write.claimSeedingOrder([seedingOrder, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const rsK = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rsS = (await pool.read.reserveShares()) as unknown as bigint;
            const kIn = parseUnits("2", 6);
            const fee = (kIn * BUY_FEE_BPS) / FEE_DENOMINATOR;
            const eff = kIn - fee;
            const sharesOut = (rsS * eff) / (rsK + eff);

            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740F2"),
                recipient: marketBuyer.account.address,
                usdcAmount: kIn,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 1200n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);

            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([order, sig], { account: marketBuyer.account }),
                pool,
                "MarketBuyClaimed",
                [
                    order.orderId,
                    getAddress(order.recipient),
                    order.usdcAmount,
                    sharesOut,
                    fee,
                    getAddress(orderSigner.account.address),
                ]
            );
        });

        it("emette MarketSellClaimed con payload corretto", async function () {
            const { viem, pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740F3"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            const rsK = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rsS = (await pool.read.reserveShares()) as unknown as bigint;
            const sharesIn = parseUnits("1", 6);
            const preOut = (rsK * sharesIn) / (rsS + sharesIn);
            const sellBps = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const fee = (preOut * sellBps) / FEE_DENOMINATOR;
            const kOut = preOut - fee;

            const order: MarketOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740F4"),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesIn,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 1200n),
                phase: 2,
            };
            const sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, order);

            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([order, sig], { account: recipient.account }),
                pool,
                "MarketSellClaimed",
                [
                    order.orderId,
                    getAddress(order.recipient),
                    order.sharesAmount,
                    kOut,
                    fee,
                    getAddress(orderSigner.account.address),
                ]
            );
        });

        it("totalSupply aumenta di esattamente (mint pool + mint treasury) al finalize", async function () {
            const { pool, admin, recipient, orderSigner, targetRaise, domain } = await networkHelpers.loadFixture(deployPoolFixture);

            await pool.write.startSeeding([], { account: admin.account });
            const seed: SeedingOrderStruct = {
                orderId: uuidToBytes16("123e4567-e89b-12d3-a456-4266141740F5"),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const seedSig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed);
            await pool.write.claimSeedingOrder([seed, seedSig], { account: recipient.account });

            const tsBefore = (await pool.read.totalSupply()) as unknown as bigint;
            const balTreasuryBefore = (await pool.read.balanceOf([admin.account.address as Address])) as unknown as bigint;
            const reservesBefore = (await pool.read.reserveShares()) as unknown as bigint;

            await pool.write.finalizeSeeding([], { account: admin.account });

            const tsAfter = (await pool.read.totalSupply()) as unknown as bigint;
            const balTreasuryAfter = (await pool.read.balanceOf([admin.account.address as Address])) as unknown as bigint;
            const reservesAfter = (await pool.read.reserveShares()) as unknown as bigint;

            const deltaSupply = tsAfter - tsBefore;
            const mintedPool = reservesAfter - reservesBefore;
            const mintedTreasury = balTreasuryAfter - balTreasuryBefore;
            if (deltaSupply !== mintedPool + mintedTreasury) throw new Error("delta totalSupply != mint pool + mint treasury");
        });
    });
    describe("Share activation", function () {
        async function finalizePoolForActivation() {
            const {
                viem,
                pool,
                admin,
                recipient,
                orderSigner,
                targetRaise,
                domain,
            } = await networkHelpers.loadFixture(deployPoolFixture);

            const seedingOrder: SeedingOrderStruct = {
                orderId: uuidWithSuffix(0x900),
                recipient: recipient.account.address,
                usdcAmount: targetRaise,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };

            const signature = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seedingOrder);

            await pool.write.startSeeding([], { account: admin.account });
            await pool.write.claimSeedingOrder([seedingOrder, signature], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });

            return {
                viem,
                pool,
                admin,
                recipient,
                orderSigner,
                domain,
            };
        }

        it("attiva crate shares con firma valida", async function () {
            const {
                viem,
                pool,
                admin,
                recipient,
                orderSigner,
                domain,
            } = await finalizePoolForActivation();

            const sharesAmount = parseUnits("250", 6);
            const activation: ShareActivationStruct = {
                activationId: uuidWithSuffix(0x910),
                recipient: recipient.account.address,
                sharesAmount,
                expiry: (BigInt(await networkHelpers.time.latest()) + 1800n),
            };
            const signature = await signShareActivation(orderSigner as unknown as WalletClient, domain, activation);

            const treasuryBalBefore = (await pool.read.balanceOf([admin.account.address])) as unknown as bigint;
            const userBalBefore = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;

            await viem.assertions.emitWithArgs(
                pool.write.activatePackShares([activation, signature], { account: recipient.account }),
                pool,
                "SharesActivated",
                [
                    activation.activationId,
                    getAddress(activation.recipient),
                    activation.sharesAmount,
                    getAddress(orderSigner.account.address),
                ]
            );

            const treasuryBalAfter = (await pool.read.balanceOf([admin.account.address])) as unknown as bigint;
            const userBalAfter = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;

            if (treasuryBalBefore - treasuryBalAfter !== sharesAmount) throw new Error("treasury delta mismatch");
            if (userBalAfter - userBalBefore !== sharesAmount) throw new Error("user balance delta mismatch");
            if ((await pool.read.consumedActivations([activation.activationId])) !== true) throw new Error("consumedActivations mismatch");
        });

        it("rifiuta crate shares con firma errata", async function () {
            const {
                viem,
                pool,
                recipient,
                domain,
            } = await finalizePoolForActivation();

            const activation: ShareActivationStruct = {
                activationId: uuidWithSuffix(0x911),
                recipient: recipient.account.address,
                sharesAmount: parseUnits("100", 6),
                expiry: (BigInt(await networkHelpers.time.latest()) + 1200n),
            };

            const badSignature = await signShareActivation(recipient as unknown as WalletClient, domain, activation);

            await viem.assertions.revertWithCustomError(
                pool.write.activatePackShares([activation, badSignature], { account: recipient.account }),
                pool,
                "PlayerSharePoolInvalidSignature"
            );
        });

        it("impedisce il riutilizzo di una activation già consumata", async function () {
            const {
                viem,
                pool,
                recipient,
                orderSigner,
                domain,
            } = await finalizePoolForActivation();

            const activation: ShareActivationStruct = {
                activationId: uuidWithSuffix(0x912),
                recipient: recipient.account.address,
                sharesAmount: parseUnits("75", 6),
                expiry: (BigInt(await networkHelpers.time.latest()) + 900n),
            };
            const signature = await signShareActivation(orderSigner as unknown as WalletClient, domain, activation);

            await pool.write.activatePackShares([activation, signature], { account: recipient.account });

            await viem.assertions.revertWithCustomError(
                pool.write.activatePackShares([activation, signature], { account: recipient.account }),
                pool,
                "PlayerSharePoolOrderConsumed"
            );
        });
    });
    describe("Mega E2E scenario", function () {
        it("seeding -> finalize -> buys/sells + slippage + pause + fee sync + ref refresh", async function () {
            const {
                viem,
                pool,
                admin,
                recipient,
                recipient2,
                orderSigner,
                marketBuyer,
                targetRaise,
                domain,
            } = await networkHelpers.loadFixture(deployPoolFixture);

            // Start seeding and perform multiple seeding claims (recipient gets badge)
            await pool.write.startSeeding([], { account: admin.account });
            const expiry1 = (BigInt(await networkHelpers.time.latest()) + 3600n);

            const seed1: SeedingOrderStruct = {
                orderId: uuidWithSuffix(800),
                recipient: recipient.account.address,
                usdcAmount: parseUnits("60", 6),
                expiry: expiry1,
                phase: 1,
            };
            const sigSeed1 = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed1);
            await viem.assertions.emitWithArgs(
                pool.write.claimSeedingOrder([seed1, sigSeed1], { account: recipient.account }),
                pool,
                "SeedingOrderClaimed",
                [
                    seed1.orderId,
                    getAddress(seed1.recipient),
                    seed1.usdcAmount,
                    seed1.usdcAmount, // price 1:1 in this fixture
                    getAddress(orderSigner.account.address),
                ]
            );

            const seed2: SeedingOrderStruct = {
                orderId: uuidWithSuffix(801),
                recipient: recipient.account.address,
                usdcAmount: targetRaise - parseUnits("60", 6),
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 1,
            };
            const sigSeed2 = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, seed2);
            await viem.assertions.emitWithArgs(
                pool.write.claimSeedingOrder([seed2, sigSeed2], { account: recipient.account }),
                pool,
                "SeedingOrderClaimed",
                [
                    seed2.orderId,
                    getAddress(seed2.recipient),
                    seed2.usdcAmount,
                    seed2.usdcAmount,
                    getAddress(orderSigner.account.address),
                ]
            );

            // Finalize to open market
            await viem.assertions.emit(
                pool.write.finalizeSeeding([], { account: admin.account }),
                pool,
                "SeedingFinalized",
            );

            // Initial buy by marketBuyer (checks fees and reserve updates)
            const reserveKBefore = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSBefore = (await pool.read.reserveShares()) as unknown as bigint;
            const kInBuy1 = parseUnits("10", 6);
            const feeBuy1 = (kInBuy1 * BUY_FEE_BPS) / FEE_DENOMINATOR;
            const eff1 = kInBuy1 - feeBuy1;
            const expSharesOut1 = (reserveSBefore * eff1) / (reserveKBefore + eff1);

            const moBuy1: MarketOrderStruct = {
                orderId: uuidWithSuffix(802),
                recipient: marketBuyer.account.address,
                usdcAmount: kInBuy1,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const moBuy1Sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, moBuy1);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([moBuy1, moBuy1Sig], { account: marketBuyer.account }),
                pool,
                "BuyExecuted",
                [
                    getAddress(moBuy1.recipient),
                    moBuy1.usdcAmount,
                    feeBuy1,
                    expSharesOut1,
                ]
            );

            // Slippage protection: same buy with minSharesOut too high should revert
            const reserveKMid = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSMid = (await pool.read.reserveShares()) as unknown as bigint;
            const kInBuySlippage = parseUnits("3", 6);
            const feeSl = (kInBuySlippage * BUY_FEE_BPS) / FEE_DENOMINATOR;
            const effSl = kInBuySlippage - feeSl;
            const expSharesOutSl = (reserveSMid * effSl) / (reserveKMid + effSl);
            const moBuySl: MarketOrderStruct = {
                orderId: uuidWithSuffix(803),
                recipient: marketBuyer.account.address,
                usdcAmount: kInBuySlippage,
                sharesAmount: 0n,
                minSharesOut: expSharesOutSl + 1n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const moBuySlSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, moBuySl);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([moBuySl, moBuySlSig], { account: marketBuyer.account }),
                pool,
                "PlayerSharePoolSlippage"
            );

            // Pause/unpause blocks market claims
            await pool.write.pause([], { account: admin.account });
            const moWhilePaused: MarketOrderStruct = {
                orderId: uuidWithSuffix(804),
                recipient: marketBuyer.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const moWhilePausedSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, moWhilePaused);
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([moWhilePaused, moWhilePausedSig], { account: marketBuyer.account }),
                pool,
                "EnforcedPause"
            );
            await pool.write.unpause([], { account: admin.account });

            const nowTsUsers = BigInt((await (await viem.getPublicClient()).getBlock()).timestamp as unknown as number);
            const rk1 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rs1 = (await pool.read.reserveShares()) as unknown as bigint;
            const kInBuy2 = parseUnits("7", 6);
            const feeBuy2 = (kInBuy2 * BUY_FEE_BPS) / FEE_DENOMINATOR;
            const effBuy2 = kInBuy2 - feeBuy2;
            const expSharesOut2 = (rs1 * effBuy2) / (rk1 + effBuy2);

            const moBuy2: MarketOrderStruct = {
                orderId: uuidWithSuffix(809),
                recipient: recipient2.account.address,
                usdcAmount: kInBuy2,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTsUsers + 1200n,
                phase: 2,
            };
            const moBuy2Sig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, moBuy2);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([moBuy2, moBuy2Sig], { account: recipient2.account }),
                pool,
                "BuyExecuted",
                [
                    getAddress(moBuy2.recipient),
                    moBuy2.usdcAmount,
                    feeBuy2,
                    expSharesOut2,
                ]
            );

            // userA vende metà delle sue shares
            const userABal = (await pool.read.balanceOf([recipient2.account.address])) as unknown as bigint;
            const sharesInUA = userABal / 2n;
            const rkBeforeUA = (await pool.read.reserveUsdc()) as unknown as bigint;
            const rsBeforeUA = (await pool.read.reserveShares()) as unknown as bigint;
            const sellFeeBpsUA = (await pool.read.currentSellFeeBps([recipient2.account.address])) as unknown as bigint;
            const preFeeOutUA = (rkBeforeUA * sharesInUA) / (rsBeforeUA + sharesInUA);
            const feeSellUA = (preFeeOutUA * sellFeeBpsUA) / FEE_DENOMINATOR;
            const kOutUA = preFeeOutUA - feeSellUA;

            const moSellUA: MarketOrderStruct = {
                orderId: uuidWithSuffix(810),
                recipient: recipient2.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesInUA,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTsUsers + 1200n,
                phase: 2,
            };
            const moSellUASig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, moSellUA);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([moSellUA, moSellUASig], { account: recipient2.account }),
                pool,
                "SellExecuted",
                [
                    getAddress(moSellUA.recipient),
                    sharesInUA,
                    feeSellUA,
                    kOutUA,
                ]
            );

            // Sell some shares from recipient (badge discount applies)
            const reserveKBeforeSellSmall = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSBeforeSellSmall = (await pool.read.reserveShares()) as unknown as bigint;
            const sharesInSmall = parseUnits("5", 6);
            const effSellFeeBpsSmall = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const preFeeOutSmall = (reserveKBeforeSellSmall * sharesInSmall) / (reserveSBeforeSellSmall + sharesInSmall);
            const feeSellSmall = (preFeeOutSmall * effSellFeeBpsSmall) / FEE_DENOMINATOR;
            const kOutSmall = preFeeOutSmall - feeSellSmall;

            const moSellSmall: MarketOrderStruct = {
                orderId: uuidWithSuffix(805),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesInSmall,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const moSellSmallSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, moSellSmall);
            await viem.assertions.emitWithArgs(
                pool.write.claimMarketOrder([moSellSmall, moSellSmallSig], { account: recipient.account }),
                pool,
                "SellExecuted",
                [
                    getAddress(moSellSmall.recipient),
                    sharesInSmall,
                    feeSellSmall,
                    kOutSmall,
                ]
            );

            // Large buy to concentrate shares with recipient (reduce pool reserves)
            const rs0 = (await pool.read.reserveUsdc()) as unknown as bigint;
            const moBigBuy: MarketOrderStruct = {
                orderId: uuidWithSuffix(806),
                recipient: recipient.account.address,
                usdcAmount: rs0 * 2n,
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: (BigInt(await networkHelpers.time.latest()) + 3600n),
                phase: 2,
            };
            const moBigBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, moBigBuy);
            await pool.write.claimMarketOrder([moBigBuy, moBigBuySig], { account: recipient.account });

            // After REFRESH_INTERVAL, trigger reference update via a tiny buy
            const tsBefore = (await pool.read.lastReferenceTimestamp()) as unknown as bigint;
            await networkHelpers.time.increase(181);
            await networkHelpers.mine(1);
            const nowTs2 = BigInt((await (await viem.getPublicClient()).getBlock()).timestamp as unknown as number);
            const moTinyBuy: MarketOrderStruct = {
                orderId: uuidWithSuffix(807),
                recipient: marketBuyer.account.address,
                usdcAmount: parseUnits("1", 6),
                sharesAmount: 0n,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTs2 + 1200n,
                phase: 2,
            };
            const moTinyBuySig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, moTinyBuy);
            await pool.write.claimMarketOrder([moTinyBuy, moTinyBuySig], { account: marketBuyer.account });
            const tsAfter = (await pool.read.lastReferenceTimestamp()) as unknown as bigint;
            if (tsAfter < tsBefore) throw new Error("lastReferenceTimestamp non aggiornato dopo tiny buy");

            // Compute a sell that enforces drop > 10% and check fee tier increases
            const rshAfterBuy = (await pool.read.reserveShares()) as unknown as bigint;
            const rkBeforeDrop = (await pool.read.reserveUsdc()) as unknown as bigint;
            const effSellFeeBpsNow = (await pool.read.currentSellFeeBps([recipient.account.address])) as unknown as bigint;
            const mulDivDown = (a: bigint, b: bigint, den: bigint) => (a * b) / den;
            const computeDropBps = (s: bigint) => {
                const preFeeOut = mulDivDown(rkBeforeDrop, s, rshAfterBuy + s);
                const feeAmount = mulDivDown(preFeeOut, effSellFeeBpsNow, 10_000n);
                const kOut = preFeeOut - feeAmount;
                const rk2 = rkBeforeDrop - kOut;
                const rs2 = rshAfterBuy + s;
                const priceRef = mulDivDown(rkBeforeDrop, 1_000_000n, rshAfterBuy);
                const priceNew = mulDivDown(rk2, 1_000_000n, rs2);
                if (priceRef <= priceNew) return 0n;
                return mulDivDown(priceRef - priceNew, 10_000n, priceRef);
            };
            const targetDrop = 1050n;
            let lo = 1n, hi = rshAfterBuy - 1n, ans = hi;
            while (lo <= hi) {
                const mid = (lo + hi) / 2n;
                const d = computeDropBps(mid);
                if (d >= targetDrop) { ans = mid; hi = mid - 1n; } else { lo = mid + 1n; }
            }
            // Ensure seller has enough shares: cap to recipient balance if needed
            const sellerBal = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
            const sharesInDrop = ans > sellerBal ? sellerBal - 1n : ans;

            const nowTs3 = BigInt((await (await viem.getPublicClient()).getBlock()).timestamp as unknown as number);
            const moDropSell: MarketOrderStruct = {
                orderId: uuidWithSuffix(808),
                recipient: recipient.account.address,
                usdcAmount: 0n,
                sharesAmount: sharesInDrop,
                minSharesOut: 0n,
                minUsdcOut: 0n,
                expiry: nowTs3 + 1200n,
                phase: 2,
            };
            const moDropSellSig = await signMarketOrder(orderSigner as unknown as WalletClient, domain, moDropSell);
            await viem.assertions.emit(
                pool.write.claimMarketOrder([moDropSell, moDropSellSig], { account: recipient.account }),
                pool,
                "SellFeeUpdated"
            );
            const st = (await pool.read.sellFeeState()) as any;
            if (st[0] < 700n) throw new Error("sell fee non aumentata almeno al tier 700 bps");
            if (st[2] === 0n) throw new Error("windowEnd atteso > 0 dopo sell con drop");

            // Replay protection on used orderId
            await viem.assertions.revertWithCustomError(
                pool.write.claimMarketOrder([moBuy1, moBuy1Sig], { account: marketBuyer.account }),
                pool,
                "PlayerSharePoolOrderConsumed"
            );
        });
    });

    describe("Admin functions", function () {
        it("setTreasury updates treasury address", async function () {
            const { pool, admin, recipient } = await networkHelpers.loadFixture(deployPoolFixture);
            
            const oldTreasury = await pool.read.treasury();
            const newTreasury = recipient.account.address;
            
            await viem.assertions.emit(
                pool.write.setTreasury([newTreasury], { account: admin.account }),
                pool,
                "TreasuryUpdated"
            );
            
            const updatedTreasury = await pool.read.treasury();
            if (updatedTreasury !== getAddress(newTreasury)) {
                throw new Error("Treasury not updated");
            }
        });

        it("setTreasury reverts for non-admin", async function () {
            const { pool, recipient } = await networkHelpers.loadFixture(deployPoolFixture);
            
            await viem.assertions.revertWithCustomError(
                pool.write.setTreasury([recipient.account.address], { account: recipient.account }),
                pool,
                "AccessControlUnauthorizedAccount"
            );
        });

        it("adminTransferShares transfers shares between accounts", async function () {
            const { pool, admin, recipient, orderSigner, domain, usdc } = await networkHelpers.loadFixture(deployPoolFixture);
            
            // Complete seeding to have shares in treasury
            await pool.write.startSeeding([], { account: admin.account });
            
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(900),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            const treasuryAddr = await pool.read.treasury();
            const treasuryBalBefore = (await pool.read.balanceOf([treasuryAddr])) as unknown as bigint;
            const transferAmount = parseUnits("1000", 6);
            
            if (treasuryBalBefore < transferAmount) {
                throw new Error("Treasury balance too low for test");
            }
            
            const recipientBalBefore = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
            
            await viem.assertions.emit(
                pool.write.adminTransferShares([treasuryAddr, recipient.account.address, transferAmount], { account: admin.account }),
                pool,
                "AdminTransfer"
            );
            
            const recipientBalAfter = (await pool.read.balanceOf([recipient.account.address])) as unknown as bigint;
            if (recipientBalAfter !== recipientBalBefore + transferAmount) {
                throw new Error("Transfer amount mismatch");
            }
        });

        it("adminBurn burns shares and reduces total supply", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            
            // Setup: complete seeding (need to reach targetRaise of 100 USDC)
            await pool.write.startSeeding([], { account: admin.account });
            
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(901),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            const treasuryAddr = await pool.read.treasury();
            const treasuryBalBefore = (await pool.read.balanceOf([treasuryAddr])) as unknown as bigint;
            const totalSupplyBefore = (await pool.read.totalSupply()) as unknown as bigint;
            const burnAmount = parseUnits("500", 6);
            
            await viem.assertions.emit(
                pool.write.adminBurn([treasuryAddr, burnAmount], { account: admin.account }),
                pool,
                "SharesBurned"
            );
            
            const treasuryBalAfter = (await pool.read.balanceOf([treasuryAddr])) as unknown as bigint;
            const totalSupplyAfter = (await pool.read.totalSupply()) as unknown as bigint;
            
            if (treasuryBalAfter !== treasuryBalBefore - burnAmount) {
                throw new Error("Burn amount mismatch in balance");
            }
            if (totalSupplyAfter !== totalSupplyBefore - burnAmount) {
                throw new Error("Burn amount mismatch in total supply");
            }
        });

        it("setBadgeEligible updates badge status", async function () {
            const { pool, admin, recipient } = await networkHelpers.loadFixture(deployPoolFixture);
            
            const eligibleBefore = await pool.read.badgeEligible([recipient.account.address]);
            if (eligibleBefore !== false) {
                throw new Error("Should start as not eligible");
            }
            
            await viem.assertions.emit(
                pool.write.setBadgeEligible([recipient.account.address, true], { account: admin.account }),
                pool,
                "BadgeEligibilityUpdated"
            );
            
            const eligibleAfter = await pool.read.badgeEligible([recipient.account.address]);
            if (eligibleAfter !== true) {
                throw new Error("Should be eligible after set");
            }
            
            // Disable
            await pool.write.setBadgeEligible([recipient.account.address, false], { account: admin.account });
            const eligibleFinal = await pool.read.badgeEligible([recipient.account.address]);
            if (eligibleFinal !== false) {
                throw new Error("Should be not eligible after disable");
            }
        });

        it("emergencyWithdraw transfers all USDC to treasury when paused", async function () {
            const { pool, admin, recipient, orderSigner, domain, usdc } = await networkHelpers.loadFixture(deployPoolFixture);
            
            // Setup: complete seeding to have USDC in pool
            await pool.write.startSeeding([], { account: admin.account });
            
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(902),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            const poolUsdcBefore = (await usdc.read.balanceOf([pool.address])) as unknown as bigint;
            const treasuryAddr = await pool.read.treasury();
            const treasuryUsdcBefore = (await usdc.read.balanceOf([treasuryAddr])) as unknown as bigint;
            
            // Must pause first
            await pool.write.pause([], { account: admin.account });
            
            await viem.assertions.emit(
                pool.write.emergencyWithdraw([], { account: admin.account }),
                pool,
                "EmergencyWithdraw"
            );
            
            const poolUsdcAfter = (await usdc.read.balanceOf([pool.address])) as unknown as bigint;
            const treasuryUsdcAfter = (await usdc.read.balanceOf([treasuryAddr])) as unknown as bigint;
            
            if (poolUsdcAfter !== 0n) {
                throw new Error("Pool should have 0 USDC after emergency withdraw");
            }
            if (treasuryUsdcAfter !== treasuryUsdcBefore + poolUsdcBefore) {
                throw new Error("Treasury should receive all USDC");
            }
        });

        it("emergencyWithdraw reverts when not paused", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            
            await pool.write.startSeeding([], { account: admin.account });
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(903),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            await viem.assertions.revertWithCustomError(
                pool.write.emergencyWithdraw([], { account: admin.account }),
                pool,
                "ExpectedPause"
            );
        });
    });

    describe("Liquidity management", function () {
        it("addLiquidity adds USDC and proportional shares maintaining price", async function () {
            const { pool, admin, recipient, orderSigner, domain, usdc } = await networkHelpers.loadFixture(deployPoolFixture);
            
            // Setup: complete seeding
            await pool.write.startSeeding([], { account: admin.account });
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(904),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            const priceBefore = (await pool.read.currentPrice()) as unknown as bigint;
            const reserveUsdcBefore = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSharesBefore = (await pool.read.reserveShares()) as unknown as bigint;
            
            const addAmount = parseUnits("50", 6);
            
            await viem.assertions.emit(
                pool.write.addLiquidity([addAmount], { account: admin.account }),
                pool,
                "LiquidityAdded"
            );
            
            const priceAfter = (await pool.read.currentPrice()) as unknown as bigint;
            const reserveUsdcAfter = (await pool.read.reserveUsdc()) as unknown as bigint;
            const reserveSharesAfter = (await pool.read.reserveShares()) as unknown as bigint;
            
            // Price should remain approximately the same (within 0.1% tolerance)
            const priceDiff = priceBefore > priceAfter ? priceBefore - priceAfter : priceAfter - priceBefore;
            const tolerance = priceBefore / 1000n; // 0.1%
            if (priceDiff > tolerance) {
                throw new Error(`Price changed too much: before=${priceBefore}, after=${priceAfter}`);
            }
            
            // Liquidity should increase
            if (reserveUsdcAfter <= reserveUsdcBefore) {
                throw new Error("USDC reserve should increase");
            }
            if (reserveSharesAfter <= reserveSharesBefore) {
                throw new Error("Shares reserve should increase");
            }
        });

        it("removeLiquidity removes USDC and proportional shares maintaining price", async function () {
            const { pool, admin, recipient, orderSigner, domain, usdc } = await networkHelpers.loadFixture(deployPoolFixture);
            
            // Setup: complete seeding
            await pool.write.startSeeding([], { account: admin.account });
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(905),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            const priceBefore = (await pool.read.currentPrice()) as unknown as bigint;
            const reserveUsdcBefore = (await pool.read.reserveUsdc()) as unknown as bigint;
            
            const removeAmount = parseUnits("20", 6);
            
            await viem.assertions.emit(
                pool.write.removeLiquidity([removeAmount], { account: admin.account }),
                pool,
                "LiquidityRemoved"
            );
            
            const priceAfter = (await pool.read.currentPrice()) as unknown as bigint;
            const reserveUsdcAfter = (await pool.read.reserveUsdc()) as unknown as bigint;
            
            // Price should remain approximately the same
            const priceDiff = priceBefore > priceAfter ? priceBefore - priceAfter : priceAfter - priceBefore;
            const tolerance = priceBefore / 1000n; // 0.1%
            if (priceDiff > tolerance) {
                throw new Error(`Price changed too much: before=${priceBefore}, after=${priceAfter}`);
            }
            
            // USDC should decrease
            if (reserveUsdcAfter >= reserveUsdcBefore) {
                throw new Error("USDC reserve should decrease");
            }
        });

        it("removeLiquidity reverts if removing more than available", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            
            await pool.write.startSeeding([], { account: admin.account });
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(906),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            const hugeAmount = parseUnits("1000000", 6);
            
            await viem.assertions.revertWithCustomError(
                pool.write.removeLiquidity([hugeAmount], { account: admin.account }),
                pool,
                "PlayerSharePoolInsufficientLiquidity"
            );
        });
    });

    describe("View functions", function () {
        it("getPoolStats returns correct values", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            
            await pool.write.startSeeding([], { account: admin.account });
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(907),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            const stats = await pool.read.getPoolStats() as any;
            const [reserveUsdcAmount, reserveSharesAmount, price, supply, treasuryBal, phase, sellFeeBps, windowEnd] = stats;
            
            // Verify consistency
            const directReserveUsdc = await pool.read.reserveUsdc();
            const directReserveShares = await pool.read.reserveShares();
            const directPrice = await pool.read.currentPrice();
            const directSupply = await pool.read.totalSupply();
            
            if (reserveUsdcAmount !== directReserveUsdc) throw new Error("reserveUsdc mismatch");
            if (reserveSharesAmount !== directReserveShares) throw new Error("reserveShares mismatch");
            if (price !== directPrice) throw new Error("price mismatch");
            if (supply !== directSupply) throw new Error("totalSupply mismatch");
            if (phase !== 2) throw new Error("phase should be OpenMarket (2)");
        });

        it("estimatePriceImpact calculates buy impact correctly", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            
            await pool.write.startSeeding([], { account: admin.account });
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(908),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            const buyAmount = parseUnits("10", 6);
            const result = await pool.read.estimatePriceImpact([buyAmount, true]) as any;
            const [priceBefore, priceAfter, impactBps] = result;
            
            if (priceBefore === 0n) throw new Error("priceBefore should not be 0");
            if (priceAfter <= priceBefore) throw new Error("priceAfter should be > priceBefore for buy");
            if (impactBps === 0n) throw new Error("impactBps should not be 0 for meaningful trade");
        });

        it("estimatePriceImpact calculates sell impact correctly", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            
            await pool.write.startSeeding([], { account: admin.account });
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(909),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            const sellValueUsdc = parseUnits("10", 6);
            const result = await pool.read.estimatePriceImpact([sellValueUsdc, false]) as any;
            const [priceBefore, priceAfter, impactBps] = result;
            
            if (priceBefore === 0n) throw new Error("priceBefore should not be 0");
            if (priceAfter >= priceBefore) throw new Error("priceAfter should be < priceBefore for sell");
            if (impactBps === 0n) throw new Error("impactBps should not be 0 for meaningful trade");
        });

        it("previewBuy returns correct values", async function () {
            const { pool, admin, recipient, orderSigner, domain, marketBuyer } = await networkHelpers.loadFixture(deployPoolFixture);
            
            await pool.write.startSeeding([], { account: admin.account });
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(910),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            const buyAmount = parseUnits("10", 6);
            // Use marketBuyer who doesn't have badge (didn't participate in seeding)
            const result = await pool.read.previewBuy([buyAmount, marketBuyer.account.address]) as any;
            const [sharesOut, feeAmount, effectivePrice] = result;
            
            // Fee should be 5% of buyAmount (no badge discount for marketBuyer)
            const expectedFee = (buyAmount * BUY_FEE_BPS) / FEE_DENOMINATOR;
            if (feeAmount !== expectedFee) {
                throw new Error(`Fee mismatch: expected ${expectedFee}, got ${feeAmount}`);
            }
            
            if (sharesOut === 0n) throw new Error("sharesOut should not be 0");
            if (effectivePrice === 0n) throw new Error("effectivePrice should not be 0");
        });

        it("quoteMinSharesOut applies slippage correctly", async function () {
            const { pool, admin, recipient, orderSigner, domain } = await networkHelpers.loadFixture(deployPoolFixture);
            
            await pool.write.startSeeding([], { account: admin.account });
            const usdcAmount = parseUnits("100", 6);
            const expiry = BigInt(await networkHelpers.time.latest()) + 3600n;
            const order: SeedingOrderStruct = {
                orderId: uuidWithSuffix(911),
                recipient: recipient.account.address,
                usdcAmount,
                expiry,
                phase: 1,
            };
            const sig = await signSeedingOrder(orderSigner as unknown as WalletClient, domain, order);
            await pool.write.claimSeedingOrder([order, sig], { account: recipient.account });
            await pool.write.finalizeSeeding([], { account: admin.account });
            
            const buyAmount = parseUnits("10", 6);
            const slippageBps = 100n; // 1%
            const result = await pool.read.quoteMinSharesOut([buyAmount, slippageBps, recipient.account.address]) as any;
            const [minSharesOut, expectedShares] = result;
            
            // minSharesOut should be expectedShares * (1 - 1%)
            const expectedMin = (expectedShares * (FEE_DENOMINATOR - slippageBps)) / FEE_DENOMINATOR;
            if (minSharesOut !== expectedMin) {
                throw new Error(`Slippage calculation wrong: expected ${expectedMin}, got ${minSharesOut}`);
            }
        });
    });
});

