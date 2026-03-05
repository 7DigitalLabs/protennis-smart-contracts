// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IEngagementRenew
/// @notice Interface for the EngagementRenew contract
interface IEngagementRenew {
    // ============ Structs ============

    struct EngagementOrder {
        bytes16 orderId;
        address payer;
        bytes32 playerId;
        uint256 usdcAmount;
        uint256 expiry;
    }

    struct PlayerEngagement {
        uint256 totalPaid;
        uint256 renewCount;
        uint256 lastRenewTime;
    }

    // ============ Events ============

    event EngagementRenewed(
        bytes16 indexed orderId,
        address indexed payer,
        bytes32 indexed playerId,
        uint256 usdcAmount,
        uint256 timestamp
    );

    event FundsWithdrawn(address indexed to, uint256 amount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    // ============ Errors ============

    error ZeroAddress();
    error UnauthorizedExecutor();
    error OrderExpired();
    error OrderAlreadyConsumed();
    error InvalidSignature();
    error InvalidAmount();

    // ============ Functions ============

    function renewEngagement(EngagementOrder calldata order, bytes calldata signature) external;
    function getPlayerEngagement(bytes32 playerId) external view returns (PlayerEngagement memory);
    function isOrderConsumed(bytes16 orderId) external view returns (bool);
    function domainSeparator() external view returns (bytes32);
    function setTreasury(address newTreasury) external;
    function pause() external;
    function unpause() external;
}
