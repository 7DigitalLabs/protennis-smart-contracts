// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title EngagementRenew
/// @author Fantasy Team
/// @notice Contract for renewing player engagements via USDC payment.
/// @dev Orders are signed off-chain and verified on-chain via EIP-712.
contract EngagementRenew is AccessControl, ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;

    // ============ EIP-712 Constants ============

    bytes32 private constant ENGAGEMENT_ORDER_TYPEHASH = keccak256(
        "EngagementOrder(bytes16 orderId,address payer,bytes32 playerId,uint256 usdcAmount,uint256 expiry)"
    );

    // ============ Roles ============

    /// @notice Admin role
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Role for signing orders
    bytes32 public constant ORDER_SIGNER_ROLE = keccak256("ORDER_SIGNER_ROLE");

    // ============ Structs ============

    /// @notice Engagement order structure
    /// @param orderId Unique order ID (generated off-chain)
    /// @param payer Address that pays and executes the order
    /// @param playerId Player ID (bytes32 for flexibility)
    /// @param usdcAmount USDC amount to pay (6 decimals)
    /// @param expiry Order expiration timestamp
    struct EngagementOrder {
        bytes16 orderId;
        address payer;
        bytes32 playerId;
        uint256 usdcAmount;
        uint256 expiry;
    }

    /// @notice Engagement info per player
    struct PlayerEngagement {
        uint256 totalPaid;
        uint256 renewCount;
        uint256 lastRenewTime;
    }

    // ============ Errors ============

    error ZeroAddress();
    error UnauthorizedExecutor();
    error OrderExpired();
    error OrderAlreadyConsumed();
    error InvalidSignature();
    error InvalidAmount();

    // ============ Events ============

    /// @notice Emitted when an engagement is renewed
    event EngagementRenewed(
        bytes16 indexed orderId,
        address indexed payer,
        bytes32 indexed playerId,
        uint256 usdcAmount,
        uint256 timestamp
    );

    /// @notice Emitted when funds are withdrawn
    event FundsWithdrawn(address indexed to, uint256 amount);

    /// @notice Emitted when the treasury is updated
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    // ============ State Variables ============

    /// @notice USDC token
    IERC20 public immutable usdc;

    /// @notice Treasury address for receiving funds
    address public treasury;

    /// @notice Mapping orderId => consumed
    mapping(bytes16 => bool) public consumedOrders;

    /// @notice Mapping playerId => engagement info
    mapping(bytes32 => PlayerEngagement) public playerEngagements;

    /// @notice Total USDC collected
    uint256 public totalCollected;

    // ============ Constructor ============

    /// @notice Initializes the contract
    /// @param _usdc USDC token address
    /// @param _admin Admin address
    /// @param _orderSigner Address authorized to sign orders
    /// @param _treasury Treasury address
    constructor(
        address _usdc,
        address _admin,
        address _orderSigner,
        address _treasury
    ) EIP712("EngagementRenew", "1") {
        if (_usdc == address(0) || _admin == address(0) || _orderSigner == address(0) || _treasury == address(0)) {
            revert ZeroAddress();
        }

        usdc = IERC20(_usdc);
        treasury = _treasury;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(ORDER_SIGNER_ROLE, _admin);
        _grantRole(ORDER_SIGNER_ROLE, _orderSigner);
    }

    // ============ External Functions ============

    /// @notice Renews a player's engagement by executing a signed order
    /// @param order Engagement order signed off-chain
    /// @param signature EIP-712 signature of the order
    function renewEngagement(
        EngagementOrder calldata order,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        // Validations
        if (msg.sender != order.payer) revert UnauthorizedExecutor();
        if (block.timestamp > order.expiry) revert OrderExpired();
        if (consumedOrders[order.orderId]) revert OrderAlreadyConsumed();
        if (order.usdcAmount == 0) revert InvalidAmount();

        // Verify signature
        bytes32 digest = _hashEngagementOrder(order);
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(ORDER_SIGNER_ROLE, signer)) revert InvalidSignature();

        // Mark order as consumed
        consumedOrders[order.orderId] = true;

        // Transfer USDC to treasury
        usdc.safeTransferFrom(order.payer, treasury, order.usdcAmount);

        // Update player state
        PlayerEngagement storage engagement = playerEngagements[order.playerId];
        engagement.totalPaid += order.usdcAmount;
        engagement.renewCount += 1;
        engagement.lastRenewTime = block.timestamp;

        // Update total
        totalCollected += order.usdcAmount;

        emit EngagementRenewed(
            order.orderId,
            order.payer,
            order.playerId,
            order.usdcAmount,
            block.timestamp
        );
    }

    // ============ View Functions ============

    /// @notice Returns engagement info for a player
    /// @param playerId Player ID
    function getPlayerEngagement(bytes32 playerId) external view returns (PlayerEngagement memory) {
        return playerEngagements[playerId];
    }

    /// @notice Checks whether an order has already been consumed
    /// @param orderId Order ID
    function isOrderConsumed(bytes16 orderId) external view returns (bool) {
        return consumedOrders[orderId];
    }

    /// @notice Returns the EIP-712 domain separator
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ============ Admin Functions ============

    /// @notice Updates the treasury address
    /// @param newTreasury New treasury address
    function setTreasury(address newTreasury) external onlyRole(ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        
        address oldTreasury = treasury;
        treasury = newTreasury;
        
        emit TreasuryUpdated(oldTreasury, newTreasury);
    }

    /// @notice Pauses the contract
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /// @notice Unpauses the contract
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Withdraws tokens locked by mistake (emergency)
    /// @param token Token address
    /// @param to Recipient
    /// @param amount Amount
    function emergencyWithdraw(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit FundsWithdrawn(to, amount);
    }

    // ============ Internal Functions ============

    /// @notice Generates the EIP-712 hash for an EngagementOrder
    function _hashEngagementOrder(EngagementOrder calldata order) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ENGAGEMENT_ORDER_TYPEHASH,
                    order.orderId,
                    order.payer,
                    order.playerId,
                    order.usdcAmount,
                    order.expiry
                )
            )
        );
    }
}
