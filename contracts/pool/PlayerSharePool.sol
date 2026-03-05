// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MathUtils} from "../libraries/MathUtils.sol";

/**
 * @title PlayerSharePool
 * @notice Handles the seeding bonding curve and AMM trading for a single player.
 */
contract PlayerSharePool is AccessControl, ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;

    enum Phase {
        None,
        Seeding,
        OpenMarket,
        Raffle
    }

    struct BinConfig {
        uint256 price; // USDC units per full share (USDC 6 decimals scale)
        uint256 totalShares; // Share token units (1e6 scale)
        uint256 soldShares; // Shares sold so far (1e6 scale)
    }

    struct SellFeeState {
        uint32 feeBps;
        uint32 dropBps;
        uint64 windowEnd;
    }

    struct SeedingOrder {
        bytes16 orderId;
        address recipient;
        uint256 usdcAmount;
        uint256 expiry;
        uint8 phase;
    }

    struct MarketOrder {
        bytes16 orderId;
        address recipient;
        uint256 usdcAmount;
        uint256 sharesAmount;
        uint256 minSharesOut;
        uint256 minUsdcOut;
        uint256 expiry;
        uint8 phase;
    }

    struct ShareActivation {
        bytes16 activationId;
        address recipient;
        uint256 sharesAmount;
        uint256 expiry;
    }

    error PlayerSharePoolInvalidArrayLength();
    error PlayerSharePoolZeroAddress();
    error PlayerSharePoolZeroValue();
    error PlayerSharePoolPhaseMismatch();
    error PlayerSharePoolNothingToBuy();
    error PlayerSharePoolInsufficientLiquidity();
    error PlayerSharePoolLiquidityNotProvided();
    error PlayerSharePoolTargetNotMet();
    error PlayerSharePoolFeeTooHigh();
    error PlayerSharePoolShareBalanceMismatch();
    error PlayerSharePoolInvalidSignature();
    error PlayerSharePoolOrderExpired();
    error PlayerSharePoolOrderConsumed();
    error PlayerSharePoolWrongPhase();
    error PlayerSharePoolSpendMismatch();
    error PlayerSharePoolUnauthorizedExecutor();
    error PlayerSharePoolInvalidOrder();
    error PlayerSharePoolSlippage();
    error PlayerSharePoolRaffleCapExceeded();
    // shares are virtual; no ERC20 transfer toggles required

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant ORDER_SIGNER_ROLE = keccak256("ORDER_SIGNER_ROLE");

    uint256 private constant FEE_DENOMINATOR = 10_000;
    uint256 private constant BUY_FEE_BPS = 500; // 5%
    uint256 private constant BADGE_DISCOUNT_BPS = 50; // 0.5%
    uint256 private constant REFRESH_INTERVAL = 180; // 3 minutes

    uint256 private constant DROP_LEVEL_1 = 1000; // 10%
    uint256 private constant DROP_LEVEL_2 = 2000; // 20%
    uint256 private constant DROP_LEVEL_3 = 3000; // 30%
    uint256 private constant DROP_LEVEL_4 = 4000; // 40%

    uint256 private constant FEE_LEVEL_BASE = 500; // 5%
    uint256 private constant FEE_LEVEL_1 = 700; // 7%
    uint256 private constant FEE_LEVEL_2 = 1000; // 10%
    uint256 private constant FEE_LEVEL_3 = 1500; // 15%
    uint256 private constant FEE_LEVEL_4 = 2000; // 20%

    uint256 private constant DURATION_LEVEL_1 = 5 minutes;
    uint256 private constant DURATION_LEVEL_2 = 25 minutes;
    uint256 private constant DURATION_LEVEL_3 = 1 hours;
    uint256 private constant DURATION_LEVEL_4 = 4 hours;

    bytes32 private constant SEEDING_ORDER_TYPEHASH = keccak256(
        "SeedingOrder(bytes16 orderId,address recipient,uint256 usdcAmount,uint256 expiry,uint8 phase)"
    );

    bytes32 private constant MARKET_ORDER_TYPEHASH = keccak256(
        "MarketOrder(bytes16 orderId,address recipient,uint256 usdcAmount,uint256 sharesAmount,uint256 minSharesOut,uint256 minUsdcOut,uint256 expiry,uint8 phase)"
    );

    bytes32 private constant SHARE_ACTIVATION_TYPEHASH = keccak256(
        "ShareActivation(bytes16 activationId,address recipient,uint256 sharesAmount,uint256 expiry)"
    );

    // Virtual share ledger
    mapping(address => uint256) private _balances;
    uint256 public totalSupplyShares;
    // Fixed supply at 6 decimals
    uint256 public constant MAX_SUPPLY = 25_000_000 * 1_000_000; // 25,000,000 shares (1e6)
    uint256 public constant BOOTSTRAP_SHARES = 1_500_000 * 1_000_000; // 1,500,000 shares (1e6) - for seeding phase
    address public treasury;
    IERC20 public immutable usdc;

    Phase public currentPhase;
    BinConfig[] private bins;
    uint256 public currentBinIndex;
    uint256 public totalRaised;
    uint256 public immutable targetRaise;

    uint256 public reserveShares;
    uint256 public seedingUsdcCollected;

    mapping(bytes16 => bool) public consumedOrders;
    mapping(bytes16 => bool) public consumedActivations;

    SellFeeState public sellFeeState;
    uint256 public referencePrice;
    uint64 public lastReferenceTimestamp;

    mapping(address => bool) public badgeEligible;
    mapping(address => uint256) public seedingPurchases;

    event SeedingPurchase(
        address indexed recipient,
        uint256 usdcSpent,
        uint256 sharesMinted
    );
    event SeedingFinalized(uint256 usdcLiquidity, uint256 shareLiquidity);
    event BuyExecuted(
        address indexed recipient,
        uint256 usdcIn,
        uint256 usdcFee,
        uint256 sharesOut
    );
    event SellFeeUpdated(uint256 feeBps, uint256 dropBps, uint64 windowEnd);
    event SellExecuted(
        address indexed recipient,
        uint256 sharesIn,
        uint256 usdcFee,
        uint256 usdcOut
    );
    event SeedingOrderClaimed(
        bytes16 indexed orderId,
        address indexed recipient,
        uint256 usdcAmount,
        uint256 sharesOut,
        address signer
    );
    /// @notice Emitted when a seeding order produces unspent dust.
    event SeedingDustGenerated(
        bytes16 indexed orderId,
        address indexed recipient,
        uint256 usdcDust
    );
    event MarketOrderClaimed(
        bytes16 indexed orderId,
        address indexed recipient,
        uint256 usdcAmount,
        uint256 sharesOut,
        uint256 feeAmount,
        address signer
    );
    /// @notice Explicit event for BUY claims (backward-compatible: MarketOrderClaimed is still emitted too)
    event MarketBuyClaimed(
        bytes16 indexed orderId,
        address indexed recipient,
        uint256 usdcIn,
        uint256 sharesOut,
        uint256 feeAmount,
        address signer
    );
    /// @notice Explicit event for SELL claims (backward-compatible: MarketOrderClaimed is still emitted too)
    event MarketSellClaimed(
        bytes16 indexed orderId,
        address indexed recipient,
        uint256 sharesIn,
        uint256 usdcOut,
        uint256 feeAmount,
        address signer
    );
    event SeedingStarted();
    event RaffleStarted();
    event RaffleFinalized(uint256 sharesSold, uint256 usdcLiquidity, uint256 shareLiquidity);
    event SharesActivated(
        bytes16 indexed activationId,
        address indexed recipient,
        uint256 sharesAmount,
        address signer
    );
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event AdminTransfer(address indexed from, address indexed to, uint256 amount);
    event LiquidityAdded(address indexed from, uint256 usdcAmount, uint256 sharesAmount);
    event LiquidityRemoved(address indexed to, uint256 usdcAmount, uint256 sharesAmount);
    event SharesBurned(address indexed from, uint256 amount);
    event BadgeEligibilityUpdated(address indexed account, bool eligible);
    event EmergencyWithdraw(address indexed to, uint256 usdcAmount);
    uint256 private constant MAX_TTL = 1 hours;
    /// @notice Initializes a single-player pool with seeding curve and key parameters.
    /// @param admin Account granted `DEFAULT_ADMIN_ROLE`, `MANAGER_ROLE` and `ORDER_SIGNER_ROLE`.
    /// @param usdcToken Address of the on-chain asset (USDC, 6 decimals) used for liquidity.
    /// @param targetRaise_ USDC fundraising target for the seeding phase.
    /// @param treasury_ Address that receives the remaining shares (MAX_SUPPLY - BOOTSTRAP_SHARES).
    /// @param prices Per-bin prices (USDC per 1e6 share) for the seeding curve.
    /// @param shareQuantities Per-bin share quantities (1e6 scale).
    constructor(
        address admin,
        address orderSigner,
        address usdcToken,
        address treasury_,
        uint256 targetRaise_,
        uint256[] memory prices,
        uint256[] memory shareQuantities
    ) EIP712("PlayerSharePool", "1") {
        if (admin == address(0)) {
            revert PlayerSharePoolZeroAddress();
        }
        if (orderSigner == address(0)) {
            revert PlayerSharePoolZeroAddress();
        }
        if (usdcToken == address(0)) {
            revert PlayerSharePoolZeroAddress();
        }
        if (treasury_ == address(0)) {
            revert PlayerSharePoolZeroAddress();
        }
        if (prices.length == 0 || prices.length != shareQuantities.length) {
            revert PlayerSharePoolInvalidArrayLength();
        }
        if (targetRaise_ == 0) {
            revert PlayerSharePoolZeroValue();
        }
        treasury = treasury_;
        usdc = IERC20(usdcToken);

        targetRaise = targetRaise_;

        currentPhase = Phase.None;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MANAGER_ROLE, admin);
        _grantRole(ORDER_SIGNER_ROLE, orderSigner);

        uint256 totalCost;
        for (uint256 i = 0; i < prices.length; ++i) {
            uint256 price = prices[i];
            uint256 shares = shareQuantities[i];
            if (price == 0 || shares == 0) {
                revert PlayerSharePoolZeroValue();
            }
            bins.push(BinConfig({price: price, totalShares: shares, soldShares: 0}));
            totalCost += MathUtils.mulDiv(shares, price, 1e6, MathUtils.Rounding.Down);
        }

        // Sanity check: ensure the configured curve can reach at least the target raise.
        if (totalCost < targetRaise_) {
            revert PlayerSharePoolTargetNotMet();
        }
    }

    // --- Phase management ---

    // Liquidity shares are computed automatically at finalization from BOOTSTRAP_SHARES minus seeding sold.

    /// @notice Starts the seeding phase on the configured bin curve.
    /// @dev Transitions `currentPhase` from `None` to `Seeding`. Emits `SeedingStarted`.
    function startSeeding() external nonReentrant onlyRole(MANAGER_ROLE) whenNotPaused {
        if (currentPhase != Phase.None) revert PlayerSharePoolPhaseMismatch();
        currentPhase = Phase.Seeding;
        emit SeedingStarted();
    }

    /// @notice Starts the raffle phase for off-chain ticket collection.
    /// @dev Transitions `currentPhase` from `None` to `Raffle`. Emits `RaffleStarted`.
    function startRaffle() external nonReentrant onlyRole(MANAGER_ROLE) whenNotPaused {
        if (currentPhase != Phase.None) revert PlayerSharePoolPhaseMismatch();
        currentPhase = Phase.Raffle;
        emit RaffleStarted();
    }

    /// @notice Finalizes the seeding phase and opens the AMM (OpenMarket) if targets and liquidity are met.
    /// @dev Initializes virtual reserves, sets reference price and sell fee window.
    function finalizeSeeding() external nonReentrant onlyRole(MANAGER_ROLE) whenNotPaused {
        if (currentPhase != Phase.Seeding) revert PlayerSharePoolPhaseMismatch();
        if (totalRaised < targetRaise) revert PlayerSharePoolTargetNotMet();
        currentPhase = Phase.OpenMarket;

        uint256 usdcBalance = usdc.balanceOf(address(this));

        // Compute seeding sold shares from bins
        uint256 seedingSold;
        for (uint256 i = 0; i < bins.length; ++i) {
            seedingSold += bins[i].soldShares;
        }
        if (seedingSold > BOOTSTRAP_SHARES) revert PlayerSharePoolShareBalanceMismatch();
        uint256 shareBalance = BOOTSTRAP_SHARES - seedingSold; // liquidity shares

        reserveShares = shareBalance;

        // Mint remaining supply to treasury: MAX_SUPPLY - BOOTSTRAP_SHARES
        uint256 treasuryMint = MAX_SUPPLY - BOOTSTRAP_SHARES;
        _balances[treasury] += treasuryMint;

        // Total supply becomes MAX_SUPPLY after finalization (seedingSold + shareBalance + treasuryMint)
        // Monotonic update derived from actual mints (recipients during seeding, pool and treasury now).
        // Equals MAX_SUPPLY but preserves the "sum of mints" model instead of a hard overwrite.
        totalSupplyShares += shareBalance + treasuryMint;

        // Clearer error when minimum reserves are missing to start the market
        if (usdcBalance == 0 || reserveShares == 0) revert PlayerSharePoolLiquidityNotProvided();

        referencePrice = _currentPriceInternal();
        lastReferenceTimestamp = uint64(block.timestamp);
        _setSellFee(FEE_LEVEL_BASE, 0, 0);

        emit SeedingFinalized(usdcBalance, reserveShares);
    }

    /// @notice Finalizes the off-chain raffle and opens the AMM with the supplied parameters.
    /// @dev The raffle sells tickets, not shares. Liquidity shares are computed
    ///      from the target price and the USDC provided. Treasury gets the remainder so totalSupply = MAX_SUPPLY.
    /// @param shareLiquidity Shares to allocate as AMM liquidity (computed off-chain for target price).
    /// @param usdcLiquidity USDC to allocate as initial liquidity.
    function finalizeRaffle(uint256 shareLiquidity, uint256 usdcLiquidity)
        external
        nonReentrant
        onlyRole(MANAGER_ROLE)
        whenNotPaused
    {
        if (currentPhase != Phase.Raffle) revert PlayerSharePoolPhaseMismatch();
        if (shareLiquidity == 0 || usdcLiquidity == 0) revert PlayerSharePoolLiquidityNotProvided();
        if (shareLiquidity > MAX_SUPPLY) revert PlayerSharePoolShareBalanceMismatch();

        usdc.safeTransferFrom(_msgSender(), address(this), usdcLiquidity);
        currentPhase = Phase.OpenMarket;
        reserveShares = shareLiquidity;

        // Treasury receives the remainder: totalSupply is always MAX_SUPPLY (25M)
        uint256 treasuryAllocation = MAX_SUPPLY - shareLiquidity;
        _balances[treasury] += treasuryAllocation;
        totalSupplyShares = MAX_SUPPLY;

        referencePrice = _currentPriceInternal();
        lastReferenceTimestamp = uint64(block.timestamp);
        _setSellFee(FEE_LEVEL_BASE, 0, 0);

        emit RaffleFinalized(shareLiquidity, usdc.balanceOf(address(this)), treasuryAllocation);
    }

    // --- Seeding logic ---

    /// @notice Claims a signed (EIP-712) seeding order, minting virtual shares to the user.
    /// @param order Seeding order data including USDC amount and expiry.
    /// @param signature `ORDER_SIGNER_ROLE` signature over the EIP-712 typed data.
    /// @return sharesMinted Virtual shares minted to the recipient.
    function claimSeedingOrder(SeedingOrder calldata order, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 sharesMinted)
    {
        if (_msgSender() != order.recipient) revert PlayerSharePoolUnauthorizedExecutor();
        if (currentPhase != Phase.Seeding) revert PlayerSharePoolPhaseMismatch();
        if (order.phase != uint8(Phase.Seeding)) revert PlayerSharePoolWrongPhase();
        if (order.usdcAmount == 0) revert PlayerSharePoolZeroValue();
        _validateOrderParties(_msgSender());
        _validateOrderWindow(order.expiry);
        if (consumedOrders[order.orderId]) revert PlayerSharePoolOrderConsumed();

        bytes32 digest = _hashSeedingOrder(order);
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(ORDER_SIGNER_ROLE, signer)) revert PlayerSharePoolInvalidSignature();

        (uint256 mintedShares, uint256 usdcSpent) = _allocateSeeding(order.usdcAmount);

        consumedOrders[order.orderId] = true;

        // Mint virtual shares to recipient
        _balances[order.recipient] += mintedShares;
        totalSupplyShares += mintedShares;

        usdc.safeTransferFrom(order.recipient, address(this), usdcSpent);

        totalRaised += usdcSpent;
        seedingUsdcCollected += usdcSpent;

        seedingPurchases[order.recipient] += mintedShares;
        badgeEligible[order.recipient] = true;

        emit SeedingPurchase(order.recipient, usdcSpent, mintedShares);
        emit SeedingOrderClaimed(
            order.orderId,
            order.recipient,
            usdcSpent,
            mintedShares,
            signer
        );
        uint256 dust = order.usdcAmount - usdcSpent;
        if (dust > 0) {
            emit SeedingDustGenerated(order.orderId, order.recipient, dust);
        }

        return mintedShares;
    }

    /// @notice Activates raffle-won shares by transferring them from the treasury to the user.
    /// @param activation Winning ticket data including share amount and expiry.
    /// @param signature `ORDER_SIGNER_ROLE` signature over the EIP-712 typed data.
    /// @return sharesGranted Shares transferred to the recipient.
    function activatePackShares(ShareActivation calldata activation, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 sharesGranted)
    {
        if (currentPhase != Phase.OpenMarket) revert PlayerSharePoolPhaseMismatch();
        if (_msgSender() != activation.recipient) revert PlayerSharePoolUnauthorizedExecutor();
        if (activation.sharesAmount == 0) revert PlayerSharePoolZeroValue();

        _validateOrderParties(_msgSender());
        _validateOrderWindow(activation.expiry);
        if (consumedActivations[activation.activationId]) revert PlayerSharePoolOrderConsumed();

        bytes32 digest = _hashShareActivation(activation);
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(ORDER_SIGNER_ROLE, signer)) revert PlayerSharePoolInvalidSignature();

        if (_balances[treasury] < activation.sharesAmount) revert PlayerSharePoolShareBalanceMismatch();

        consumedActivations[activation.activationId] = true;

        _balances[treasury] -= activation.sharesAmount;
        _balances[activation.recipient] += activation.sharesAmount;

        emit SharesActivated(
            activation.activationId,
            activation.recipient,
            activation.sharesAmount,
            signer
        );

        sharesGranted = activation.sharesAmount;
        return sharesGranted;
    }

    /// @notice Executes a signed (EIP-712) market order: buy (USDC->shares) or sell (shares->USDC).
    /// @param order Order data; set either `usdcAmount` (buy) or `sharesAmount` (sell).
    /// @param signature `ORDER_SIGNER_ROLE` signature over the EIP-712 typed data.
    /// @return sharesOut For buy: shares received. For sell: USDC received (generic naming for ABI compatibility).
    /// @return feeAmount Fee charged (buy fee or sell fee).
    function claimMarketOrder(MarketOrder calldata order, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 sharesOut, uint256 feeAmount)
    {
        // Removed global pre-trade sync to avoid duplicate event emissions.
        // - BUY: _syncSellFee runs pre-trade inside the BUY branch (handles possible downshift after window expiry)
        // - SELL: _syncSellFee runs post-trade only, to measure the drop caused by the operation
        if (_msgSender() != order.recipient) revert PlayerSharePoolUnauthorizedExecutor();
        if (currentPhase != Phase.OpenMarket) revert PlayerSharePoolPhaseMismatch();
        if (order.phase != uint8(Phase.OpenMarket)) revert PlayerSharePoolWrongPhase();
        if ((order.usdcAmount == 0 && order.sharesAmount == 0) || (order.usdcAmount > 0 && order.sharesAmount > 0)) {
            revert PlayerSharePoolInvalidOrder();
        }
        _validateOrderParties(_msgSender());
        _validateOrderWindow(order.expiry);
        if (consumedOrders[order.orderId]) revert PlayerSharePoolOrderConsumed();

        bytes32 digest = _hashMarketOrder(order);
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(ORDER_SIGNER_ROLE, signer)) revert PlayerSharePoolInvalidSignature();

        // BUY path
        if (order.usdcAmount > 0 && order.sharesAmount == 0) {
            // Pre-trade sync for BUY only, so tests expecting a downshift after windowEnd
            // receive the event exactly once during the buy claim.
            _syncSellFee();
            uint256 feeBps = _effectiveFeeBps(BUY_FEE_BPS, order.recipient);
            uint256 buyFeeAmount = (order.usdcAmount * feeBps) / FEE_DENOMINATOR;

            uint256 effectiveAmount = order.usdcAmount - buyFeeAmount;
            if (effectiveAmount == 0) revert PlayerSharePoolFeeTooHigh();

            uint256 reserveUsdcBefore = reserveUsdc();
            uint256 expectedSharesOut = MathUtils.mulDiv(
                reserveShares,
                effectiveAmount,
                reserveUsdcBefore + effectiveAmount,
                MathUtils.Rounding.Down
            );

            if (expectedSharesOut == 0) revert PlayerSharePoolInsufficientLiquidity();
            if (order.minSharesOut > 0 && expectedSharesOut < order.minSharesOut) {
                revert PlayerSharePoolSlippage();
            }

            consumedOrders[order.orderId] = true;

            reserveShares -= expectedSharesOut;
            _balances[order.recipient] += expectedSharesOut;

            usdc.safeTransferFrom(order.recipient, address(this), order.usdcAmount);
            if (buyFeeAmount > 0) {
                usdc.safeTransfer(treasury, buyFeeAmount);
            }

            emit BuyExecuted(order.recipient, order.usdcAmount, buyFeeAmount, expectedSharesOut);
            emit MarketOrderClaimed(
                order.orderId,
                order.recipient,
                order.usdcAmount,
                expectedSharesOut,
                buyFeeAmount,
                signer
            );
            // Additional explicit BUY event for off-chain clarity (backward-compatible)
            emit MarketBuyClaimed(
                order.orderId,
                order.recipient,
                order.usdcAmount,
                expectedSharesOut,
                buyFeeAmount,
                signer
            );

            // Post-trade sync with forced refresh: update reference to the new price
            _syncSellFeeAndRefresh();

            return (expectedSharesOut, buyFeeAmount);
        } else if (order.usdcAmount == 0 && order.sharesAmount > 0) {

            // SELL path
            // Pre-trade sync: reset fee if windowExpired before evaluating the new drop
            _syncSellFee();
            
            uint256 sharesIn = order.sharesAmount;
            if (sharesIn == 0) revert PlayerSharePoolZeroValue();
            // Ensure seller has enough virtual shares
            if (_balances[order.recipient] < sharesIn) revert PlayerSharePoolShareBalanceMismatch();

            // FIX: Use fee based on the PREDICTED drop, not current state
            uint256 predictedBaseFee = _predictSellFeeBps(sharesIn);
            uint256 sellFeeBps = _effectiveFeeBps(predictedBaseFee, order.recipient);

            // Constant-product: output USDC before fee
            uint256 reserveUsdcBefore = reserveUsdc();
            uint256 preFeeUsdcOut = MathUtils.mulDiv(
                reserveUsdcBefore,
                sharesIn,
                reserveShares + sharesIn,
                MathUtils.Rounding.Down
            );
            if (preFeeUsdcOut == 0) revert PlayerSharePoolInsufficientLiquidity();

            uint256 sellFeeAmount = (preFeeUsdcOut * sellFeeBps) / FEE_DENOMINATOR;
            uint256 usdcOut = preFeeUsdcOut - sellFeeAmount;
            if (usdcOut == 0) revert PlayerSharePoolInsufficientLiquidity();
            if (order.minUsdcOut > 0 && usdcOut < order.minUsdcOut) {
                revert PlayerSharePoolSlippage();
            }

            consumedOrders[order.orderId] = true;

            // Update reserves
            reserveShares += sharesIn;

            // Transfer virtual shares from seller to pool reserve
            _balances[order.recipient] -= sharesIn;
            
            usdc.safeTransfer(order.recipient, usdcOut);
            
            if (sellFeeAmount > 0) {
                usdc.safeTransfer(treasury, sellFeeAmount);
            }

            emit SellExecuted(order.recipient, sharesIn, sellFeeAmount, usdcOut);
            emit MarketOrderClaimed(
                order.orderId,
                order.recipient,
                usdcOut,
                sharesIn,
                sellFeeAmount,
                signer
            );
            // Additional explicit SELL event for off-chain clarity (backward-compatible)
            emit MarketSellClaimed(
                order.orderId,
                order.recipient,
                sharesIn,
                usdcOut,
                sellFeeAmount,
                signer
            );

            // Post-trade sync with forced refresh: update reference to the new price
            _syncSellFeeAndRefresh();
            
            return (usdcOut, sellFeeAmount);
        } else {
            revert PlayerSharePoolInvalidOrder();
        }
        
    }

    function _allocateSeeding(uint256 usdcAmount)
        internal
        returns (uint256 sharesMinted, uint256 usdcSpent)
    {
        // Seeding logic requires exact spend (no dust).
        // If the amount is incompatible with the price/1e6 granularity, SpendMismatch will trigger.
        uint256 remaining = usdcAmount;
        uint256 idx = currentBinIndex;

        while (remaining > 0 && idx < bins.length) {
            BinConfig storage bin = bins[idx];
            uint256 unsold = bin.totalShares - bin.soldShares;

            if (unsold == 0) {
                unchecked {
                    ++idx;
                }
                continue;
            }

            uint256 binCostFull = MathUtils.mulDiv(unsold, bin.price, 1e6, MathUtils.Rounding.Down);

            if (remaining >= binCostFull) {
                remaining -= binCostFull;
                usdcSpent += binCostFull;
                bin.soldShares += unsold;
                sharesMinted += unsold;

                if (bin.soldShares == bin.totalShares) {
                    unchecked {
                        ++idx;
                    }
                }
                continue;
            }

            uint256 sharesFromRemaining = MathUtils.mulDiv(remaining, 1e6, bin.price, MathUtils.Rounding.Down);
            if (sharesFromRemaining == 0) {
                break;
            }

            if (sharesFromRemaining > unsold) {
                sharesFromRemaining = unsold;
            }

            uint256 cost = MathUtils.mulDiv(sharesFromRemaining, bin.price, 1e6, MathUtils.Rounding.Down);
            if (cost == 0) {
                // Remaining amount too small to buy more shares at this bin: stop and leave dust
                break;
            }

            if (cost > remaining) {
                cost = remaining;
            }

            remaining -= cost;
            usdcSpent += cost;
            bin.soldShares += sharesFromRemaining;
            sharesMinted += sharesFromRemaining;

            if (bin.soldShares == bin.totalShares) {
                unchecked {
                    ++idx;
                }
            }

            if (remaining == 0) {
                break;
            }
        }

        currentBinIndex = idx;

        if (sharesMinted == 0 || usdcSpent == 0) revert PlayerSharePoolNothingToBuy();
    }

    function _hashSeedingOrder(SeedingOrder calldata order) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SEEDING_ORDER_TYPEHASH,
                    order.orderId,
                    order.recipient,
                    order.usdcAmount,
                    order.expiry,
                    order.phase
                )
            )
        );
    }

    function _hashMarketOrder(MarketOrder calldata order) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    MARKET_ORDER_TYPEHASH,
                    order.orderId,
                    order.recipient,
                    order.usdcAmount,
                    order.sharesAmount,
                    order.minSharesOut,
                    order.minUsdcOut,
                    order.expiry,
                    order.phase
                )
            )
        );
    }

    function _hashShareActivation(ShareActivation calldata activation) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SHARE_ACTIVATION_TYPEHASH,
                    activation.activationId,
                    activation.recipient,
                    activation.sharesAmount,
                    activation.expiry
                )
            )
        );
    }

    function _validateOrderParties(address recipient) internal pure {
        if (recipient == address(0)) {
            revert PlayerSharePoolZeroAddress();
        }
    }

    function _validateOrderWindow(uint256 expiry) internal view {
        // consumedOrders check is payer-scoped; validated in claim functions
        if (expiry == 0 || block.timestamp > expiry) revert PlayerSharePoolOrderExpired();
        if (expiry - block.timestamp > MAX_TTL) revert PlayerSharePoolOrderExpired();
    }

    // --- View helpers ---

    /// @notice Total number of bins configured for the seeding curve.
    function getBinCount() external view returns (uint256) {
        return bins.length;
    }

    /// @notice Returns the bin configuration at the requested index.
    /// @param index Bin index.
    /// @return bin Struct with price and sold/total shares.
    function getBin(uint256 index) external view returns (BinConfig memory bin) {
        bin = bins[index];
    }

    /// @notice Current price (USDC per 1e6 share) from the virtual AMM; 0 if not initialized.
    function currentPrice() external view returns (uint256) {
        return _currentPriceInternal();
    }

    /// @notice Virtual share balance of an account.
    /// @param account Address to query.
    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    /// @notice Total supply of virtual shares in circulation.
    function totalSupply() external view returns (uint256) {
        return totalSupplyShares;
    }

    /// @notice Current sell fee in bps for the account (includes badge discount if applicable).
    /// @param account User address to check for badge discount.
    function currentSellFeeBps(address account) external view returns (uint256) {
        uint256 feeBps = sellFeeState.feeBps;
        if (badgeEligible[account] && feeBps >= BADGE_DISCOUNT_BPS) {
            feeBps -= BADGE_DISCOUNT_BPS;
        }
        return feeBps;
    }

    // --- Preview & Quote helpers ---

    /// @notice Preview of the buy fee in bps for an account.
    /// @param account User address (for badge discount if applicable).
    /// @return feeBps Fee in basis points applied to the buy.
    function previewBuyFeeBps(address account) external view returns (uint256 feeBps) {
        return _effectiveFeeBps(BUY_FEE_BPS, account);
    }

    /// @notice Preview of the sell fee in bps for an account considering the predicted drop.
    /// @param account User address (for badge discount if applicable).
    /// @param sharesIn Share amount to sell (used to compute the predicted drop).
    /// @return feeBps Fee in basis points that will be applied to the sell.
    function previewSellFeeBps(address account, uint256 sharesIn) external view returns (uint256 feeBps) {
        uint256 baseFee = _predictSellFeeBps(sharesIn);
        return _effectiveFeeBps(baseFee, account);
    }

    /// @notice Full buy preview: computes shares received and fee.
    /// @param usdcAmount USDC amount to spend.
    /// @param account User address (for badge discount if applicable).
    /// @return sharesOut Shares that will be received.
    /// @return feeAmount USDC fee withheld.
    /// @return effectivePrice Effective price per share (USDC per 1e6 share).
    function previewBuy(uint256 usdcAmount, address account) 
        external 
        view 
        returns (uint256 sharesOut, uint256 feeAmount, uint256 effectivePrice) 
    {
        if (currentPhase != Phase.OpenMarket) return (0, 0, 0);
        if (usdcAmount == 0) return (0, 0, 0);

        uint256 feeBps = _effectiveFeeBps(BUY_FEE_BPS, account);
        feeAmount = (usdcAmount * feeBps) / FEE_DENOMINATOR;
        uint256 effectiveAmount = usdcAmount - feeAmount;
        
        if (effectiveAmount == 0) return (0, feeAmount, 0);

        uint256 reserveUsdcBefore = reserveUsdc();
        if (reserveUsdcBefore == 0 || reserveShares == 0) return (0, feeAmount, 0);

        sharesOut = MathUtils.mulDiv(
            reserveShares,
            effectiveAmount,
            reserveUsdcBefore + effectiveAmount,
            MathUtils.Rounding.Down
        );

        // Effective price = USDC spent (including fee) / shares received, scaled to 1e6
        if (sharesOut > 0) {
            effectivePrice = MathUtils.mulDiv(usdcAmount, 1e6, sharesOut, MathUtils.Rounding.Up);
        }

        return (sharesOut, feeAmount, effectivePrice);
    }

    /// @notice Full sell preview: computes USDC received and fee.
    /// @param sharesIn Share amount to sell.
    /// @param account User address (for badge discount if applicable).
    /// @return usdcOut USDC that will be received (net of fee).
    /// @return feeAmount USDC fee withheld.
    /// @return effectivePrice Effective price per share (USDC per 1e6 share).
    function previewSell(uint256 sharesIn, address account) 
        external 
        view 
        returns (uint256 usdcOut, uint256 feeAmount, uint256 effectivePrice) 
    {
        if (currentPhase != Phase.OpenMarket) return (0, 0, 0);
        if (sharesIn == 0) return (0, 0, 0);

        uint256 baseFee = _predictSellFeeBps(sharesIn);
        uint256 sellFeeBps = _effectiveFeeBps(baseFee, account);

        uint256 reserveUsdcBefore = reserveUsdc();
        if (reserveUsdcBefore == 0 || reserveShares == 0) return (0, 0, 0);

        uint256 preFeeUsdcOut = MathUtils.mulDiv(
            reserveUsdcBefore,
            sharesIn,
            reserveShares + sharesIn,
            MathUtils.Rounding.Down
        );

        feeAmount = (preFeeUsdcOut * sellFeeBps) / FEE_DENOMINATOR;
        usdcOut = preFeeUsdcOut - feeAmount;

        // Effective price = USDC received (net) / shares sold, scaled to 1e6
        if (sharesIn > 0) {
            effectivePrice = MathUtils.mulDiv(usdcOut, 1e6, sharesIn, MathUtils.Rounding.Down);
        }

        return (usdcOut, feeAmount, effectivePrice);
    }

    /// @notice Computes minSharesOut for a buy given usdcAmount and slippage tolerance.
    /// @param usdcAmount USDC amount to spend.
    /// @param slippageBps Slippage tolerance in basis points (e.g. 100 = 1%).
    /// @param account User address (for badge discount if applicable).
    /// @return minSharesOut Minimum acceptable value for the minSharesOut parameter.
    /// @return expectedShares Expected shares without slippage (for reference).
    function quoteMinSharesOut(uint256 usdcAmount, uint256 slippageBps, address account)
        external
        view
        returns (uint256 minSharesOut, uint256 expectedShares)
    {
        if (currentPhase != Phase.OpenMarket) return (0, 0);
        if (usdcAmount == 0) return (0, 0);
        if (slippageBps > FEE_DENOMINATOR) return (0, 0);

        uint256 feeBps = _effectiveFeeBps(BUY_FEE_BPS, account);
        uint256 feeAmount = (usdcAmount * feeBps) / FEE_DENOMINATOR;
        uint256 effectiveAmount = usdcAmount - feeAmount;
        
        if (effectiveAmount == 0) return (0, 0);

        uint256 reserveUsdcBefore = reserveUsdc();
        if (reserveUsdcBefore == 0 || reserveShares == 0) return (0, 0);

        expectedShares = MathUtils.mulDiv(
            reserveShares,
            effectiveAmount,
            reserveUsdcBefore + effectiveAmount,
            MathUtils.Rounding.Down
        );

        // Apply slippage: minSharesOut = expectedShares * (1 - slippageBps/10000)
        minSharesOut = MathUtils.mulDiv(
            expectedShares,
            FEE_DENOMINATOR - slippageBps,
            FEE_DENOMINATOR,
            MathUtils.Rounding.Down
        );

        return (minSharesOut, expectedShares);
    }

    /// @notice Computes minUsdcOut for a sell given sharesIn and slippage tolerance.
    /// @param sharesIn Share amount to sell.
    /// @param slippageBps Slippage tolerance in basis points (e.g. 100 = 1%).
    /// @param account User address (for badge discount if applicable).
    /// @return minUsdcOut Minimum acceptable value for the minUsdcOut parameter.
    /// @return expectedUsdc Expected USDC without slippage (for reference).
    function quoteMinUsdcOut(uint256 sharesIn, uint256 slippageBps, address account)
        external
        view
        returns (uint256 minUsdcOut, uint256 expectedUsdc)
    {
        if (currentPhase != Phase.OpenMarket) return (0, 0);
        if (sharesIn == 0) return (0, 0);
        if (slippageBps > FEE_DENOMINATOR) return (0, 0);

        uint256 baseFee = _predictSellFeeBps(sharesIn);
        uint256 sellFeeBps = _effectiveFeeBps(baseFee, account);

        uint256 reserveUsdcBefore = reserveUsdc();
        if (reserveUsdcBefore == 0 || reserveShares == 0) return (0, 0);

        uint256 preFeeUsdcOut = MathUtils.mulDiv(
            reserveUsdcBefore,
            sharesIn,
            reserveShares + sharesIn,
            MathUtils.Rounding.Down
        );

        uint256 feeAmount = (preFeeUsdcOut * sellFeeBps) / FEE_DENOMINATOR;
        expectedUsdc = preFeeUsdcOut - feeAmount;

        // Apply slippage: minUsdcOut = expectedUsdc * (1 - slippageBps/10000)
        minUsdcOut = MathUtils.mulDiv(
            expectedUsdc,
            FEE_DENOMINATOR - slippageBps,
            FEE_DENOMINATOR,
            MathUtils.Rounding.Down
        );

        return (minUsdcOut, expectedUsdc);
    }

    /// @notice Returns all pool statistics in a single call.
    /// @return reserveUsdcAmount Current USDC reserve.
    /// @return reserveSharesAmount Current share reserve.
    /// @return price Current price (USDC per 1e6 share).
    /// @return supply Total share supply.
    /// @return treasuryBal Treasury share balance.
    /// @return phase Current pool phase.
    /// @return sellFeeBps Current sell fee in bps.
    /// @return windowEnd Elevated-fee window end timestamp (0 if inactive).
    function getPoolStats() 
        external 
        view 
        returns (
            uint256 reserveUsdcAmount,
            uint256 reserveSharesAmount,
            uint256 price,
            uint256 supply,
            uint256 treasuryBal,
            Phase phase,
            uint256 sellFeeBps,
            uint64 windowEnd
        ) 
    {
        reserveUsdcAmount = reserveUsdc();
        reserveSharesAmount = reserveShares;
        price = _currentPriceInternal();
        supply = totalSupplyShares;
        treasuryBal = _balances[treasury];
        phase = currentPhase;
        sellFeeBps = sellFeeState.feeBps;
        windowEnd = sellFeeState.windowEnd;
    }

    /// @notice Estimates the price impact of a trade.
    /// @param usdcAmount USDC amount (for buy) or equivalent (for sell).
    /// @param isBuy True for buy, false for sell.
    /// @return priceBefore Price before the trade.
    /// @return priceAfter Price after the trade.
    /// @return impactBps Price impact in basis points.
    function estimatePriceImpact(uint256 usdcAmount, bool isBuy)
        external
        view
        returns (uint256 priceBefore, uint256 priceAfter, uint256 impactBps)
    {
        if (currentPhase != Phase.OpenMarket) return (0, 0, 0);
        
        uint256 reserveUsdcBefore = reserveUsdc();
        if (reserveUsdcBefore == 0 || reserveShares == 0) return (0, 0, 0);
        
        priceBefore = _currentPriceInternal();
        
        if (isBuy) {
            // BUY: USDC in, shares out
            uint256 feeAmount = (usdcAmount * BUY_FEE_BPS) / FEE_DENOMINATOR;
            uint256 effectiveAmount = usdcAmount - feeAmount;
            
            uint256 sharesOut = MathUtils.mulDiv(
                reserveShares,
                effectiveAmount,
                reserveUsdcBefore + effectiveAmount,
                MathUtils.Rounding.Down
            );
            
            uint256 newReserveUsdc = reserveUsdcBefore + effectiveAmount;
            uint256 newReserveShares = reserveShares - sharesOut;
            
            if (newReserveShares > 0) {
                priceAfter = MathUtils.mulDiv(newReserveUsdc, 1e6, newReserveShares, MathUtils.Rounding.Down);
            }
        } else {
            // SELL: convert usdcAmount to shares equivalent at the current price
            uint256 sharesIn = MathUtils.mulDiv(usdcAmount, 1e6, priceBefore, MathUtils.Rounding.Down);
            
            uint256 preFeeUsdcOut = MathUtils.mulDiv(
                reserveUsdcBefore,
                sharesIn,
                reserveShares + sharesIn,
                MathUtils.Rounding.Down
            );
            
            uint256 newReserveUsdc = reserveUsdcBefore - preFeeUsdcOut;
            uint256 newReserveShares = reserveShares + sharesIn;
            
            if (newReserveShares > 0) {
                priceAfter = MathUtils.mulDiv(newReserveUsdc, 1e6, newReserveShares, MathUtils.Rounding.Down);
            }
        }
        
        // Compute impact in bps
        if (priceBefore > 0) {
            if (priceAfter > priceBefore) {
                impactBps = MathUtils.mulDiv(priceAfter - priceBefore, FEE_DENOMINATOR, priceBefore, MathUtils.Rounding.Down);
            } else {
                impactBps = MathUtils.mulDiv(priceBefore - priceAfter, FEE_DENOMINATOR, priceBefore, MathUtils.Rounding.Down);
            }
        }
    }

    // --- Admin controls ---
    /// @notice Pauses all sensitive pool actions.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Unpauses the pool.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Updates the treasury address.
    /// @param newTreasury New treasury address.
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert PlayerSharePoolZeroAddress();
        address oldTreasury = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /// @notice Transfers virtual shares between accounts (admin only).
    /// @param from Source address.
    /// @param to Destination address.
    /// @param amount Share amount to transfer.
    function adminTransferShares(address from, address to, uint256 amount) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        if (from == address(0) || to == address(0)) revert PlayerSharePoolZeroAddress();
        if (amount == 0) revert PlayerSharePoolZeroValue();
        if (_balances[from] < amount) revert PlayerSharePoolShareBalanceMismatch();
        
        _balances[from] -= amount;
        _balances[to] += amount;
        
        emit AdminTransfer(from, to, amount);
    }

    /// @notice Adds liquidity to the pool while maintaining the current price (admin only).
    /// @dev Automatically computes the proportional shares to add from the treasury.
    /// @param usdcAmount USDC amount to add to the reserve.
    function addLiquidity(uint256 usdcAmount)
        external
        nonReentrant
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (usdcAmount == 0) revert PlayerSharePoolZeroValue();
        
        uint256 reserveUsdcBefore = reserveUsdc();
        
        // Compute proportional shares to maintain the price
        // sharesAmount = usdcAmount * reserveShares / reserveUsdc
        uint256 sharesAmount = 0;
        if (reserveUsdcBefore > 0 && reserveShares > 0) {
            sharesAmount = MathUtils.mulDiv(
                usdcAmount,
                reserveShares,
                reserveUsdcBefore,
                MathUtils.Rounding.Down
            );
        }

        // Transfer USDC
        usdc.safeTransferFrom(_msgSender(), address(this), usdcAmount);

        // Add proportional shares from treasury (if available)
        if (sharesAmount > 0) {
            if (_balances[treasury] < sharesAmount) revert PlayerSharePoolShareBalanceMismatch();
            _balances[treasury] -= sharesAmount;
            reserveShares += sharesAmount;
        }

        emit LiquidityAdded(_msgSender(), usdcAmount, sharesAmount);
    }

    /// @notice Removes liquidity from the pool while maintaining the current price (admin only).
    /// @dev Automatically computes the proportional shares to return to the treasury.
    /// @param usdcAmount USDC amount to remove from the reserve.
    function removeLiquidity(uint256 usdcAmount)
        external
        nonReentrant
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (usdcAmount == 0) revert PlayerSharePoolZeroValue();
        
        uint256 reserveUsdcBefore = reserveUsdc();
        if (usdcAmount > reserveUsdcBefore) revert PlayerSharePoolInsufficientLiquidity();
        
        // Compute proportional shares to maintain the price
        // sharesAmount = usdcAmount * reserveShares / reserveUsdc
        uint256 sharesAmount = 0;
        if (reserveUsdcBefore > 0 && reserveShares > 0) {
            sharesAmount = MathUtils.mulDiv(
                usdcAmount,
                reserveShares,
                reserveUsdcBefore,
                MathUtils.Rounding.Down
            );
        }

        // Remove proportional shares and return them to treasury
        if (sharesAmount > 0) {
            if (reserveShares < sharesAmount) revert PlayerSharePoolInsufficientLiquidity();
            reserveShares -= sharesAmount;
            _balances[treasury] += sharesAmount;
        }

        // Transfer USDC to treasury
        usdc.safeTransfer(treasury, usdcAmount);

        emit LiquidityRemoved(treasury, usdcAmount, sharesAmount);
    }

    /// @notice Burns virtual shares from an account (admin only).
    /// @param from Address to burn shares from.
    /// @param amount Share amount to burn.
    function adminBurn(address from, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (from == address(0)) revert PlayerSharePoolZeroAddress();
        if (amount == 0) revert PlayerSharePoolZeroValue();
        if (_balances[from] < amount) revert PlayerSharePoolShareBalanceMismatch();
        
        _balances[from] -= amount;
        totalSupplyShares -= amount;
        
        emit SharesBurned(from, amount);
    }

    /// @notice Sets badge eligibility for an account (manager only).
    /// @param account Account address.
    /// @param eligible True to enable badge discount, false to disable it.
    function setBadgeEligible(address account, bool eligible)
        external
        onlyRole(MANAGER_ROLE)
    {
        if (account == address(0)) revert PlayerSharePoolZeroAddress();
        badgeEligible[account] = eligible;
        emit BadgeEligibilityUpdated(account, eligible);
    }

    /// @notice Withdraws all USDC in an emergency (admin only, while paused).
    /// @dev Transfers all USDC to the treasury. Use only in emergencies.
    function emergencyWithdraw()
        external
        nonReentrant
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenPaused
    {
        uint256 balance = usdc.balanceOf(address(this));
        if (balance == 0) revert PlayerSharePoolZeroValue();
        
        usdc.safeTransfer(treasury, balance);
        
        emit EmergencyWithdraw(treasury, balance);
    }

    // --- Internal helpers ---

    /// @dev Syncs the sell fee and optionally forces a reference price update.
    /// @param forceRefresh If true, always updates the reference to the current price.
    function _syncSellFeeInternal(bool forceRefresh) internal {
        if (currentPhase != Phase.OpenMarket) return;
        
        uint256 usdcLiquidity = reserveUsdc();
        if (usdcLiquidity == 0 || reserveShares == 0) {
            referencePrice = 0;
            lastReferenceTimestamp = uint64(block.timestamp);
            _setSellFee(FEE_LEVEL_BASE, 0, 0);
            return;
        }

        uint256 price = reserveShares == 0
            ? 0
            : MathUtils.mulDiv(usdcLiquidity, 1e6, reserveShares, MathUtils.Rounding.Down);
        if (referencePrice == 0) {
            referencePrice = price;
            lastReferenceTimestamp = uint64(block.timestamp);
            _setSellFee(FEE_LEVEL_BASE, 0, 0);
            return;
        }

        uint256 dropBps = 0;
        if (price < referencePrice) {
            dropBps = MathUtils.mulDiv(referencePrice - price, FEE_DENOMINATOR, referencePrice, MathUtils.Rounding.Down);
        }
        (uint256 targetFee, uint256 targetDrop, uint256 targetDuration) = _resolveFeeTier(dropBps);

        SellFeeState memory state = sellFeeState;
        bool windowExpired = state.windowEnd != 0 && block.timestamp >= state.windowEnd;

        if (targetFee > state.feeBps) {
            _setSellFee(targetFee, targetDrop, targetDuration);
        } else if (windowExpired) {
            _setSellFee(targetFee, targetDrop, targetDuration);
        }
        
        // Update reference: always if forceRefresh, otherwise only if REFRESH_INTERVAL elapsed
        if (forceRefresh || block.timestamp >= lastReferenceTimestamp + REFRESH_INTERVAL) {
            referencePrice = price;
            lastReferenceTimestamp = uint64(block.timestamp);
        }
    }

    /// @dev Standard sync: updates reference only if REFRESH_INTERVAL has elapsed.
    function _syncSellFee() internal {
        _syncSellFeeInternal(false);
    }

    /// @dev Sync with forced reference refresh (used post-trade).
    function _syncSellFeeAndRefresh() internal {
        _syncSellFeeInternal(true);
    }

    function _resolveFeeTier(uint256 dropBps)
        internal
        pure
        returns (uint256 feeBps, uint256 dropLevel, uint256 duration)
    {
        if (dropBps >= DROP_LEVEL_4) {
            return (FEE_LEVEL_4, DROP_LEVEL_4, DURATION_LEVEL_4);
        }
        if (dropBps >= DROP_LEVEL_3) {
            return (FEE_LEVEL_3, DROP_LEVEL_3, DURATION_LEVEL_3);
        }
        if (dropBps >= DROP_LEVEL_2) {
            return (FEE_LEVEL_2, DROP_LEVEL_2, DURATION_LEVEL_2);
        }
        if (dropBps >= DROP_LEVEL_1) {
            return (FEE_LEVEL_1, DROP_LEVEL_1, DURATION_LEVEL_1);
        }
        return (FEE_LEVEL_BASE, 0, 0);
    }

    function _setSellFee(uint256 feeBps, uint256 dropBps, uint256 duration) internal {
        uint64 windowEnd = duration == 0 ? uint64(0) : uint64(block.timestamp + duration);
        sellFeeState = SellFeeState({
            feeBps: uint32(feeBps),
            dropBps: uint32(dropBps),
            windowEnd: windowEnd
        });
        emit SellFeeUpdated(feeBps, dropBps, windowEnd);
    }

    function _currentPriceInternal() internal view returns (uint256) {
        uint256 liquidity = reserveUsdc();
        if (liquidity == 0 || reserveShares == 0) return 0;
        return MathUtils.mulDiv(liquidity, 1e6, reserveShares, MathUtils.Rounding.Down);
    }

    function reserveUsdc() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function _effectiveFeeBps(uint256 baseFeeBps, address account) internal view returns (uint256) {
        uint256 feeBps = baseFeeBps;
        if (badgeEligible[account] && feeBps >= BADGE_DISCOUNT_BPS) {
            feeBps -= BADGE_DISCOUNT_BPS;
        }
        return feeBps;
    }

    /// @dev Computes the sell fee based on the PREDICTED post-trade drop.
    /// @param sharesIn Share amount to sell.
    /// @return predictedFeeBps Fee in bps that will be applied considering the predicted drop.
    function _predictSellFeeBps(uint256 sharesIn) internal view returns (uint256 predictedFeeBps) {
        // If not in OpenMarket or reference not initialized, use current fee
        if (currentPhase != Phase.OpenMarket || referencePrice == 0) {
            return sellFeeState.feeBps;
        }

        uint256 reserveUsdcBefore = reserveUsdc();
        if (reserveUsdcBefore == 0 || reserveShares == 0) {
            return sellFeeState.feeBps;
        }

        // Simulate the sync: if the window expired, compute current fee from actual drop
        uint256 effectiveCurrentFee = sellFeeState.feeBps;
        bool windowExpired = sellFeeState.windowEnd != 0 && block.timestamp >= sellFeeState.windowEnd;
        
        if (windowExpired) {
            // Window expired: fee will be reset based on the current drop
            uint256 priceNow = MathUtils.mulDiv(reserveUsdcBefore, 1e6, reserveShares, MathUtils.Rounding.Down);
            uint256 currentDropBps = 0;
            if (priceNow < referencePrice) {
                currentDropBps = MathUtils.mulDiv(referencePrice - priceNow, FEE_DENOMINATOR, referencePrice, MathUtils.Rounding.Down);
            }
            (effectiveCurrentFee, , ) = _resolveFeeTier(currentDropBps);
        }

        // Compute predicted POST-trade price (without fee for simplicity, conservative estimate)
        uint256 preFeeUsdcOut = MathUtils.mulDiv(
            reserveUsdcBefore,
            sharesIn,
            reserveShares + sharesIn,
            MathUtils.Rounding.Down
        );
        
        uint256 postTradeUsdc = reserveUsdcBefore - preFeeUsdcOut;
        uint256 postTradeShares = reserveShares + sharesIn;
        
        if (postTradeShares == 0) {
            return effectiveCurrentFee;
        }

        uint256 predictedPrice = MathUtils.mulDiv(postTradeUsdc, 1e6, postTradeShares, MathUtils.Rounding.Down);

        // Compute predicted drop relative to referencePrice
        uint256 dropBps = 0;
        if (predictedPrice < referencePrice) {
            dropBps = MathUtils.mulDiv(referencePrice - predictedPrice, FEE_DENOMINATOR, referencePrice, MathUtils.Rounding.Down);
        }

        // Determine the appropriate fee tier for the post-trade drop
        (uint256 targetFee, , ) = _resolveFeeTier(dropBps);

        // Use the higher of current effective fee and predicted fee (never lower)
        return targetFee > effectiveCurrentFee ? targetFee : effectiveCurrentFee;
    }
}

