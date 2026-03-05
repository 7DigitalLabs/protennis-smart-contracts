// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPlayerSharePool
/// @notice Interface for a player's virtual share pool, with seeding and AMM trading.
interface IPlayerSharePool {
    enum Phase {
        None,
        Seeding,
        OpenMarket,
        Raffle
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

    // --- Views ---
    function currentPhase() external view returns (Phase);
    function currentPrice() external view returns (uint256);
    function getBinCount() external view returns (uint256);
    /// @notice Returns the bin at the given `index`.
    function getBin(uint256 index) external view returns (
        uint256 price,
        uint256 totalShares,
        uint256 soldShares
    );
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function currentSellFeeBps(address account) external view returns (uint256);

    // --- Seeding / Market settlement ---

    function claimSeedingOrder(SeedingOrder calldata order, bytes calldata signature)
        external
        returns (uint256 sharesMinted);

    function claimMarketOrder(MarketOrder calldata order, bytes calldata signature)
        external
        returns (uint256 sharesOut, uint256 usdcFee);

    // --- Admin / phase controls ---
    function startSeeding() external;
    function finalizeSeeding() external;
    function pause() external;
    function unpause() external;
}

