// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {MathUtils} from "../libraries/MathUtils.sol";

/// @title IYakRouter
/// @notice Minimal interface for YakRouter (Yield Yak DEX Aggregator)
/// @dev See: https://github.com/yieldyak/yak-aggregator
interface IYakRouter {
    struct Trade {
        uint256 amountIn;
        uint256 amountOut;
        address[] path;
        address[] adapters;
    }

    /// @notice Executes a swap without splitting
    /// @param _trade Trade struct with amountIn, amountOut, path, adapters
    /// @param _to Output recipient
    /// @param _fee Fee in bps (0 if not applicable)
    function swapNoSplit(
        Trade calldata _trade,
        address _to,
        uint256 _fee
    ) external;

    /// @notice Finds the best path considering gas costs
    function findBestPathWithGas(
        uint256 _amountIn,
        address _tokenIn,
        address _tokenOut,
        uint256 _maxSteps,
        uint256 _gasPrice
    ) external view returns (
        uint256[] memory amounts,
        address[] memory adapters,
        address[] memory path,
        uint256 gasEstimate
    );
}

/// @title IPlayerSharePool
/// @notice Minimal interface for PlayerSharePool admin functions
interface IPlayerSharePoolAdmin {
    function adminTransferShares(address from, address to, uint256 amount) external;
    function currentPrice() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function treasury() external view returns (address);
}

/**
 * @title YakSharesRouter
 * @notice Allows purchasing PlayerSharePool shares by paying with alternative tokens.
 * @dev Uses YakRouter (Yield Yak DEX Aggregator) to swap the input token into USDC.
 * 
 * YakRouter Addresses:
 * - Avalanche: 0xC4729E56b831d74bBc18797e0e17A295fA77488c
 * - Arbitrum:  0xb32C79a25291265eF240Eb32E9faBbc6DcEE3cE3
 * - Optimism:  0xCd887F78c77b36B0b541E77AfD6F91C0253182A2
 * 
 * Flow:
 * 1. Backend calls findBestPathWithGas to obtain the optimal path
 * 2. Backend generates an EIP-712 signed order with Trade struct
 * 3. User calls claimOrder with order + signature + yakParams
 * 4. Contract executes swapNoSplit via YakRouter
 * 5. Contract transfers shares from the treasury to the user
 * 6. USDC goes to the treasury
 */
contract YakSharesRouter is AccessControl, ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;

    // --- Errors ---
    error RouterZeroAddress();
    error RouterZeroValue();
    error RouterOrderExpired();
    error RouterOrderConsumed();
    error RouterInvalidSignature();
    error RouterUnauthorizedExecutor();
    error RouterInsufficientOutput();
    error RouterSlippageExceeded();
    error RouterInsufficientTreasuryShares();
    error RouterPoolNotSupported();
    error RouterTokenNotSupported();
    error RouterSwapFailed();

    // --- Roles ---
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant ORDER_SIGNER_ROLE = keccak256("ORDER_SIGNER_ROLE");

    // --- Constants ---
    uint256 private constant FEE_DENOMINATOR = 10_000;
    uint256 private constant MAX_TTL = 1 hours;
    address private constant ETH = address(0);

    // --- EIP-712 TypeHash ---
    bytes32 private constant SHARES_ORDER_TYPEHASH = keccak256(
        "SharesOrder(bytes16 orderId,address recipient,address pool,address inputToken,uint256 inputAmount,uint256 minSharesOut,uint256 minUsdcOut,uint256 expiry)"
    );

    // --- Structs ---
    struct SharesOrder {
        bytes16 orderId;
        address recipient;
        address pool;
        address inputToken;      // Token paid by the user (no native ETH on Yak)
        uint256 inputAmount;     // Amount of tokens to spend
        uint256 minSharesOut;    // Minimum guaranteed shares
        uint256 minUsdcOut;      // Minimum USDC from swap (slippage protection)
        uint256 expiry;
    }

    /// @notice Parameters for the swap via YakRouter
    /// @dev Generated off-chain by calling findBestPathWithGas
    struct YakSwapParams {
        uint256 amountOut;       // Expected amount out (slippage already applied)
        address[] path;          // Token path [inputToken, ..., USDC]
        address[] adapters;      // Adapter addresses for each hop
    }

    // --- State ---
    IYakRouter public immutable yakRouter;
    IERC20 public immutable usdc;
    address public treasury;
    
    /// @notice Spread/fee in bps retained by the router (e.g. 100 = 1%)
    uint256 public spreadBps;

    /// @notice Supported pools: poolAddress => enabled
    mapping(address => bool) public supportedPools;

    /// @notice Supported tokens for purchases: tokenAddress => enabled
    mapping(address => bool) public supportedTokens;

    /// @notice Already consumed orders
    mapping(bytes16 => bool) public consumedOrders;

    // --- Events ---
    event SharesPurchased(
        bytes16 indexed orderId,
        address indexed buyer,
        address indexed pool,
        address inputToken,
        uint256 inputAmount,
        uint256 usdcReceived,
        uint256 sharesOut,
        address signer
    );
    event PoolSupportUpdated(address indexed pool, bool supported);
    event TokenSupportUpdated(address indexed token, bool supported);
    event SpreadUpdated(uint256 oldSpread, uint256 newSpread);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event EmergencyWithdraw(address indexed token, address indexed to, uint256 amount);

    /// @notice Initializes the router with base parameters.
    /// @param _admin Admin account with all initial roles.
    /// @param _orderSigner Account authorized to sign orders.
    /// @param _yakRouter YakRouter address on the chain.
    /// @param _usdc USDC token address (swap output).
    /// @param _treasury Treasury address that holds shares and receives USDC.
    /// @param _spreadBps Initial spread in basis points.
    constructor(
        address _admin,
        address _orderSigner,
        address _yakRouter,
        address _usdc,
        address _treasury,
        uint256 _spreadBps
    ) EIP712("YakSharesRouter", "1") {
        if (_admin == address(0)) revert RouterZeroAddress();
        if (_orderSigner == address(0)) revert RouterZeroAddress();
        if (_yakRouter == address(0)) revert RouterZeroAddress();
        if (_usdc == address(0)) revert RouterZeroAddress();
        if (_treasury == address(0)) revert RouterZeroAddress();

        yakRouter = IYakRouter(_yakRouter);
        usdc = IERC20(_usdc);
        treasury = _treasury;
        spreadBps = _spreadBps;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(OPERATOR_ROLE, _admin);
        _grantRole(ORDER_SIGNER_ROLE, _orderSigner);
    }

    // =============================================================
    //                        MAIN FUNCTIONS
    // =============================================================

    /// @notice Executes a signed order: swaps token to USDC via YakRouter, transfers shares.
    /// @param order Order with input token, target pool, minimum shares.
    /// @param signature EIP-712 signature from ORDER_SIGNER_ROLE.
    /// @param yakParams Swap data (generated off-chain by findBestPathWithGas).
    /// @return sharesOut Amount of shares transferred to the user.
    function claimOrder(
        SharesOrder calldata order,
        bytes calldata signature,
        YakSwapParams calldata yakParams
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 sharesOut)
    {
        // --- Validations ---
        if (msg.sender != order.recipient) revert RouterUnauthorizedExecutor();
        if (order.inputAmount == 0) revert RouterZeroValue();
        if (order.minSharesOut == 0) revert RouterZeroValue();
        if (order.minUsdcOut == 0) revert RouterZeroValue();
        // YakRouter does not support native ETH directly
        if (order.inputToken == ETH) revert RouterTokenNotSupported();
        if (!supportedPools[order.pool]) revert RouterPoolNotSupported();
        if (!supportedTokens[order.inputToken]) revert RouterTokenNotSupported();
        
        _validateOrderWindow(order.expiry);
        if (consumedOrders[order.orderId]) revert RouterOrderConsumed();

        // Verify signature
        bytes32 digest = _hashOrder(order);
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(ORDER_SIGNER_ROLE, signer)) revert RouterInvalidSignature();

        consumedOrders[order.orderId] = true;

        // --- Input token transfer and swap ---
        IERC20(order.inputToken).safeTransferFrom(msg.sender, address(this), order.inputAmount);
        
        uint256 usdcReceived = _swapViaYak(
            order.inputToken,
            order.inputAmount,
            yakParams
        );

        // Verify USDC slippage
        if (usdcReceived < order.minUsdcOut) revert RouterInsufficientOutput();

        // --- Calculate shares ---
        // Apply spread
        uint256 spreadAmount = (usdcReceived * spreadBps) / FEE_DENOMINATOR;
        uint256 effectiveUsdc = usdcReceived - spreadAmount;

        // Calculate shares based on the pool's current price
        IPlayerSharePoolAdmin pool = IPlayerSharePoolAdmin(order.pool);
        uint256 currentPrice = pool.currentPrice();
        if (currentPrice == 0) revert RouterInsufficientOutput();

        // shares = (effectiveUsdc * 1e6) / price
        sharesOut = MathUtils.mulDiv(effectiveUsdc, 1e6, currentPrice, MathUtils.Rounding.Down);

        // Verify shares slippage
        if (sharesOut < order.minSharesOut) revert RouterSlippageExceeded();

        // Verify that the treasury has sufficient shares
        address poolTreasury = pool.treasury();
        if (pool.balanceOf(poolTreasury) < sharesOut) revert RouterInsufficientTreasuryShares();

        // --- Transfer shares from treasury to user ---
        pool.adminTransferShares(poolTreasury, order.recipient, sharesOut);

        // --- Transfer USDC to treasury ---
        usdc.safeTransfer(treasury, usdcReceived);

        emit SharesPurchased(
            order.orderId,
            order.recipient,
            order.pool,
            order.inputToken,
            order.inputAmount,
            effectiveUsdc,
            sharesOut,
            signer
        );

        return sharesOut;
    }

    /// @notice Purchase preview: calculates estimated shares given equivalent USDC.
    /// @param pool PlayerSharePool address.
    /// @param usdcAmount Equivalent USDC after the swap.
    /// @return sharesOut Estimated shares.
    /// @return effectiveUsdc USDC net of spread.
    function previewPurchase(address pool, uint256 usdcAmount) 
        external 
        view 
        returns (uint256 sharesOut, uint256 effectiveUsdc) 
    {
        if (!supportedPools[pool] || usdcAmount == 0) return (0, 0);

        uint256 spreadAmount = (usdcAmount * spreadBps) / FEE_DENOMINATOR;
        effectiveUsdc = usdcAmount - spreadAmount;

        IPlayerSharePoolAdmin sharePool = IPlayerSharePoolAdmin(pool);
        uint256 currentPrice = sharePool.currentPrice();
        if (currentPrice == 0) return (0, effectiveUsdc);

        sharesOut = MathUtils.mulDiv(effectiveUsdc, 1e6, currentPrice, MathUtils.Rounding.Down);
    }

    /// @notice Query helper to get the best path on-chain (gas expensive, use off-chain)
    function queryBestPath(
        uint256 amountIn,
        address tokenIn,
        address tokenOut,
        uint256 maxSteps,
        uint256 gasPrice
    ) external view returns (
        uint256[] memory amounts,
        address[] memory adapters,
        address[] memory path,
        uint256 gasEstimate
    ) {
        return yakRouter.findBestPathWithGas(amountIn, tokenIn, tokenOut, maxSteps, gasPrice);
    }

    // =============================================================
    //                      INTERNAL FUNCTIONS
    // =============================================================

    /// @dev Executes the swap via YakRouter.swapNoSplit
    function _swapViaYak(
        address inputToken,
        uint256 inputAmount,
        YakSwapParams calldata yakParams
    ) internal returns (uint256 usdcReceived) {
        uint256 balanceBefore = usdc.balanceOf(address(this));

        // Approve YakRouter for the input token
        IERC20(inputToken).approve(address(yakRouter), inputAmount);

        // Build the Trade struct
        IYakRouter.Trade memory trade = IYakRouter.Trade({
            amountIn: inputAmount,
            amountOut: yakParams.amountOut,
            path: yakParams.path,
            adapters: yakParams.adapters
        });

        // Execute the swap (fee = 0, no extra fee)
        try yakRouter.swapNoSplit(trade, address(this), 0) {
            usdcReceived = usdc.balanceOf(address(this)) - balanceBefore;
        } catch {
            revert RouterSwapFailed();
        }

        // Reset approval for safety
        IERC20(inputToken).approve(address(yakRouter), 0);

        return usdcReceived;
    }

    function _validateOrderWindow(uint256 expiry) internal view {
        if (expiry == 0 || block.timestamp > expiry) revert RouterOrderExpired();
        if (expiry - block.timestamp > MAX_TTL) revert RouterOrderExpired();
    }

    function _hashOrder(SharesOrder calldata order) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SHARES_ORDER_TYPEHASH,
                    order.orderId,
                    order.recipient,
                    order.pool,
                    order.inputToken,
                    order.inputAmount,
                    order.minSharesOut,
                    order.minUsdcOut,
                    order.expiry
                )
            )
        );
    }

    // =============================================================
    //                      ADMIN FUNCTIONS
    // =============================================================

    /// @notice Enables/disables a PlayerSharePool for purchases.
    function setPoolSupported(address pool, bool supported) 
        external 
        onlyRole(OPERATOR_ROLE) 
    {
        if (pool == address(0)) revert RouterZeroAddress();
        supportedPools[pool] = supported;
        emit PoolSupportUpdated(pool, supported);
    }

    /// @notice Enables/disables a token for purchases.
    function setTokenSupported(address token, bool supported) 
        external 
        onlyRole(OPERATOR_ROLE) 
    {
        supportedTokens[token] = supported;
        emit TokenSupportUpdated(token, supported);
    }

    /// @notice Updates the router spread.
    function setSpread(uint256 _spreadBps) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        require(_spreadBps <= 500, "Spread too high");
        uint256 oldSpread = spreadBps;
        spreadBps = _spreadBps;
        emit SpreadUpdated(oldSpread, _spreadBps);
    }

    /// @notice Updates the treasury address.
    function setTreasury(address _treasury) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        if (_treasury == address(0)) revert RouterZeroAddress();
        address oldTreasury = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    /// @notice Pauses the contract.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Unpauses the contract.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Withdraws stuck tokens in emergency (admin only, paused only).
    function emergencyWithdraw(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenPaused
    {
        if (to == address(0)) revert RouterZeroAddress();
        
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 toSend = amount == 0 ? balance : amount;
        IERC20(token).safeTransfer(to, toSend);
        emit EmergencyWithdraw(token, to, toSend);
    }

    // =============================================================
    //                      VIEW FUNCTIONS
    // =============================================================

    /// @notice Returns the EIP-712 domain separator for off-chain verification.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
