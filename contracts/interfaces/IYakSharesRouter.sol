// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IYakSharesRouter
/// @notice Interface for buying PlayerSharePool shares with alternative tokens via YakRouter.
/// @dev Uses the Yield Yak DEX Aggregator for swaps.
/// 
/// YakRouter Addresses:
/// - Avalanche: 0xC4729E56b831d74bBc18797e0e17A295fA77488c
/// - Arbitrum:  0xb32C79a25291265eF240Eb32E9faBbc6DcEE3cE3
/// - Optimism:  0xCd887F78c77b36B0b541E77AfD6F91C0253182A2
interface IYakSharesRouter {
    struct SharesOrder {
        bytes16 orderId;
        address recipient;
        address pool;
        address inputToken;      // No native ETH (use WETH instead)
        uint256 inputAmount;
        uint256 minSharesOut;
        uint256 minUsdcOut;      // Slippage protection for the swap
        uint256 expiry;
    }

    /// @notice Parameters for the swap via YakRouter
    /// @dev Generated off-chain by calling findBestPathWithGas
    struct YakSwapParams {
        uint256 amountOut;       // Expected amount out (slippage already applied)
        address[] path;          // Token path [inputToken, ..., USDC]
        address[] adapters;      // Adapter addresses for each hop
    }

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

    // --- Main Functions ---
    function claimOrder(
        SharesOrder calldata order,
        bytes calldata signature,
        YakSwapParams calldata yakParams
    ) external returns (uint256 sharesOut);

    function previewPurchase(address pool, uint256 usdcAmount) 
        external 
        view 
        returns (uint256 sharesOut, uint256 effectiveUsdc);

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
    );

    // --- Views ---
    function yakRouter() external view returns (address);
    function supportedPools(address pool) external view returns (bool);
    function supportedTokens(address token) external view returns (bool);
    function spreadBps() external view returns (uint256);
    function treasury() external view returns (address);
    function domainSeparator() external view returns (bytes32);
}
