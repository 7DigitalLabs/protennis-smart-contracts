/**
 * Backend integration example for AltCurrencyBroker with Odos Router V3
 * 
 * Odos Router V3:
 * - Unified address: 0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05 (all chains)
 * - Audited by Zellic (2025)
 * - API: https://api.odos.xyz
 * 
 * Flow:
 * 1. The user requests a purchase with ETH/WETH/another token
 * 2. The backend calls the Odos API (/sor/quote/v2 + /sor/assemble)
 * 3. The backend generates the EIP-712 signed order with swap data
 * 4. The frontend calls claimBrokerOrder with order + signature + odosParams
 */

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// --- Types ---

interface BrokerOrder {
    orderId: `0x${string}`;
    recipient: `0x${string}`;
    pool: `0x${string}`;
    inputToken: `0x${string}`;
    inputAmount: bigint;
    minSharesOut: bigint;
    minUsdcOut: bigint;
    expiry: bigint;
}

interface OdosSwapParams {
    swapData: `0x${string}`;     // transaction.data from the Odos API
    valueToSend: bigint;         // transaction.value (0 for ERC20, inputAmount for ETH)
}

interface OdosQuoteResponse {
    pathId: string;
    outAmounts: string[];
    gasEstimate: number;
}

interface OdosAssembleResponse {
    transaction: {
        to: string;
        data: string;
        value: string;
        gas: number;
    };
}

// --- Config ---

const ODOS_API_URL = "https://api.odos.xyz";
const CHAIN_ID = 8453; // Base

// Odos Router V3 - Unified address across all chains
const ODOS_ROUTER_V3 = "0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05" as const;

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const; // Base USDC
const ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// EIP-712 Type definitions - Updated with minUsdcOut
const BROKER_ORDER_TYPES = {
    BrokerOrder: [
        { name: "orderId", type: "bytes16" },
        { name: "recipient", type: "address" },
        { name: "pool", type: "address" },
        { name: "inputToken", type: "address" },
        { name: "inputAmount", type: "uint256" },
        { name: "minSharesOut", type: "uint256" },
        { name: "minUsdcOut", type: "uint256" },
        { name: "expiry", type: "uint256" },
    ],
} as const;

// --- Odos API V3 Integration ---

/**
 * Gets a quote from Odos for the swap.
 * API: POST /sor/quote/v2
 */
async function getOdosQuote(
    inputToken: `0x${string}`,
    inputAmount: bigint,
    userAddress: `0x${string}`,
    slippagePercent: number = 0.5
): Promise<OdosQuoteResponse> {
    const response = await fetch(`${ODOS_API_URL}/sor/quote/v2`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chainId: CHAIN_ID,
            inputTokens: [
                {
                    tokenAddress: inputToken,
                    amount: inputAmount.toString(),
                },
            ],
            outputTokens: [
                {
                    tokenAddress: USDC_ADDRESS,
                    proportion: 1,
                },
            ],
            userAddr: userAddress,
            slippageLimitPercent: slippagePercent,
            referralCode: 0,
            disableRFQs: true,  // More reliable
            compact: true,      // Optimized calldata for L2
        }),
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Odos quote failed: ${JSON.stringify(error)}`);
    }

    return response.json() as Promise<OdosQuoteResponse>;
}

/**
 * Assembles the swap transaction from Odos.
 * API: POST /sor/assemble
 * 
 * IMPORTANT: userAddr must be the BROKER contract address,
 * not the end user, because the broker executes the swap.
 */
async function assembleOdosSwap(
    pathId: string,
    brokerAddress: `0x${string}`
): Promise<OdosAssembleResponse> {
    const response = await fetch(`${ODOS_API_URL}/sor/assemble`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            userAddr: brokerAddress,
            pathId: pathId,
            simulate: false,
        }),
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Odos assemble failed: ${JSON.stringify(error)}`);
    }

    return response.json() as Promise<OdosAssembleResponse>;
}

// --- Order Generation ---

/**
 * Generates a unique orderId (bytes16).
 */
function generateOrderId(): `0x${string}` {
    const uuid = crypto.randomUUID().replace(/-/g, "");
    return `0x${uuid}` as `0x${string}`;
}

/**
 * Calculates minimum shares given the pool price and expected USDC.
 */
function calculateMinShares(
    usdcAmount: bigint,
    poolPrice: bigint,
    spreadBps: bigint,
    slippageBps: bigint = 100n // 1% default
): bigint {
    // Apply spread
    const effectiveUsdc = (usdcAmount * (10000n - spreadBps)) / 10000n;
    
    // Calculate shares
    const expectedShares = (effectiveUsdc * 1_000_000n) / poolPrice;
    
    // Apply slippage
    const minShares = (expectedShares * (10000n - slippageBps)) / 10000n;
    
    return minShares;
}

/**
 * Calculates minimum USDC with slippage.
 */
function calculateMinUsdc(
    usdcQuote: bigint,
    slippageBps: bigint = 50n // 0.5% default
): bigint {
    return (usdcQuote * (10000n - slippageBps)) / 10000n;
}

/**
 * Signs a broker order with EIP-712.
 */
async function signBrokerOrder(
    order: BrokerOrder,
    signerPrivateKey: `0x${string}`,
    brokerAddress: `0x${string}`,
    chainId: number
): Promise<`0x${string}`> {
    const account = privateKeyToAccount(signerPrivateKey);
    
    const client = createWalletClient({
        account,
        chain: base,
        transport: http(),
    });

    const domain = {
        name: "AltCurrencyBroker",
        version: "1",
        chainId: chainId,
        verifyingContract: brokerAddress,
    };

    const signature = await client.signTypedData({
        domain,
        types: BROKER_ORDER_TYPES,
        primaryType: "BrokerOrder",
        message: {
            orderId: order.orderId,
            recipient: order.recipient,
            pool: order.pool,
            inputToken: order.inputToken,
            inputAmount: order.inputAmount,
            minSharesOut: order.minSharesOut,
            minUsdcOut: order.minUsdcOut,
            expiry: order.expiry,
        },
    });

    return signature;
}

// --- Main Example ---

async function createBrokerOrderForUser(params: {
    userAddress: `0x${string}`;
    poolAddress: `0x${string}`;
    inputToken: `0x${string}`;
    inputAmount: bigint;
    poolPrice: bigint; // Current pool price (from pool.currentPrice())
    brokerAddress: `0x${string}`;
    signerPrivateKey: `0x${string}`;
    spreadBps?: bigint;
    slippageBps?: bigint;
}) {
    const {
        userAddress,
        poolAddress,
        inputToken,
        inputAmount,
        poolPrice,
        brokerAddress,
        signerPrivateKey,
        spreadBps = 100n,
        slippageBps = 50n, // 0.5%
    } = params;

    const isETH = inputToken === ETH_ADDRESS;

    console.log("1. Getting Odos V3 quote...");
    
    // IMPORTANT: userAddr must be the broker, not the user,
    // because the broker executes the swap on the user's behalf
    const quote = await getOdosQuote(inputToken, inputAmount, brokerAddress);
    const usdcQuote = BigInt(quote.outAmounts[0]);
    console.log(`   Quote: ${inputAmount} ${isETH ? 'ETH' : 'tokens'} -> ${usdcQuote} USDC`);

    console.log("2. Assembling Odos V3 swap transaction...");
    const assembled = await assembleOdosSwap(quote.pathId, brokerAddress);
    console.log(`   Router: ${assembled.transaction.to}`);
    console.log(`   Gas estimate: ${assembled.transaction.gas}`);

    console.log("3. Calculating slippage protections...");
    const minUsdcOut = calculateMinUsdc(usdcQuote, slippageBps);
    const minSharesOut = calculateMinShares(usdcQuote, poolPrice, spreadBps, slippageBps);
    console.log(`   Min USDC out: ${minUsdcOut}`);
    console.log(`   Min shares out: ${minSharesOut}`);

    console.log("4. Creating order...");
    const order: BrokerOrder = {
        orderId: generateOrderId(),
        recipient: userAddress,
        pool: poolAddress,
        inputToken: inputToken,
        inputAmount: inputAmount,
        minSharesOut: minSharesOut,
        minUsdcOut: minUsdcOut,
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour
    };

    console.log("5. Signing order...");
    const signature = await signBrokerOrder(
        order,
        signerPrivateKey,
        brokerAddress,
        CHAIN_ID
    );

    // OdosSwapParams for the contract
    const odosParams: OdosSwapParams = {
        swapData: assembled.transaction.data as `0x${string}`,
        valueToSend: isETH ? inputAmount : 0n,
    };

    console.log("\n" + "=".repeat(60));
    console.log("ORDER READY FOR FRONTEND (Odos Router V3)");
    console.log("=".repeat(60));
    console.log("\nOrder:", order);
    console.log("\nSignature:", signature);
    console.log("\nOdosParams:", odosParams);

    return { order, signature, odosParams };
}

// --- Example Usage ---

/*
// ============================================================
// BACKEND API ENDPOINT
// ============================================================

app.post("/api/broker/create-order", async (req, res) => {
    const { userAddress, poolAddress, inputToken, inputAmount } = req.body;

    // Get current pool price
    const pool = await getContract({ address: poolAddress, abi: PlayerSharePoolABI });
    const poolPrice = await pool.read.currentPrice();

    // Create order with Odos V3 quote
    const result = await createBrokerOrderForUser({
        userAddress,
        poolAddress,
        inputToken,
        inputAmount: BigInt(inputAmount),
        poolPrice,
        brokerAddress: BROKER_ADDRESS,
        signerPrivateKey: ORDER_SIGNER_PRIVATE_KEY,
    });

    res.json({
        order: {
            orderId: result.order.orderId,
            recipient: result.order.recipient,
            pool: result.order.pool,
            inputToken: result.order.inputToken,
            inputAmount: result.order.inputAmount.toString(),
            minSharesOut: result.order.minSharesOut.toString(),
            minUsdcOut: result.order.minUsdcOut.toString(),
            expiry: result.order.expiry.toString(),
        },
        signature: result.signature,
        odosParams: {
            swapData: result.odosParams.swapData,
            valueToSend: result.odosParams.valueToSend.toString(),
        },
    });
});

// ============================================================
// FRONTEND - Purchase with ETH
// ============================================================

async function buySharesWithETH(orderData) {
    const broker = getContract({ 
        address: BROKER_ADDRESS, 
        abi: AltCurrencyBrokerABI 
    });
    
    // For native ETH, send msg.value
    const tx = await broker.write.claimBrokerOrder(
        [orderData.order, orderData.signature, orderData.odosParams],
        { value: BigInt(orderData.order.inputAmount) }
    );
    
    console.log("Transaction:", tx);
}

// ============================================================
// FRONTEND - Purchase with ERC20 (WETH, USDT, etc.)
// ============================================================

async function buySharesWithERC20(orderData) {
    const broker = getContract({ 
        address: BROKER_ADDRESS, 
        abi: AltCurrencyBrokerABI 
    });
    const token = getContract({ 
        address: orderData.order.inputToken, 
        abi: ERC20ABI 
    });
    
    // 1. Approve the broker for the input token
    await token.write.approve([
        BROKER_ADDRESS, 
        BigInt(orderData.order.inputAmount)
    ]);
    
    // 2. Execute the order (no msg.value for ERC20)
    const tx = await broker.write.claimBrokerOrder(
        [orderData.order, orderData.signature, orderData.odosParams],
        { value: 0n }
    );
    
    console.log("Transaction:", tx);
}
*/

export {
    createBrokerOrderForUser,
    getOdosQuote,
    assembleOdosSwap,
    signBrokerOrder,
    generateOrderId,
    calculateMinShares,
    calculateMinUsdc,
    ODOS_ROUTER_V3,
    type BrokerOrder,
    type OdosSwapParams,
};
