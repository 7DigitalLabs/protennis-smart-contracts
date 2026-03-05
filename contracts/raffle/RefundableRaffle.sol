// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IRefundableRaffle} from "../interfaces/IRefundableRaffle.sol";

/// @title RefundableRaffle
/// @author Fantasy Team
/// @notice Refundable raffle: deposit USDC, get tickets, winners receive crates,
///         non-winners are fully refunded.
/// @dev Every 20 USDC = 1 ticket. 50,000 winning tickets drawn off-chain, verified on-chain via Merkle proof.
contract RefundableRaffle is IRefundableRaffle, AccessControl, ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;
    using MerkleProof for bytes32[];

    // ============ EIP-712 Constants ============

    bytes32 private constant DEPOSIT_ORDER_TYPEHASH = keccak256(
        "DepositOrder(bytes16 orderId,address recipient,uint256 usdcAmount,uint256 expiry)"
    );

    // ============ Constants ============

    /// @notice Admin role for raffle management
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    
    /// @notice Operator role for daily operations
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Role for signing deposit orders
    bytes32 public constant ORDER_SIGNER_ROLE = keccak256("ORDER_SIGNER_ROLE");

    /// @notice Ticket price in USDC (20 USDC with 6 decimals)
    uint256 public constant TICKET_PRICE = 20 * 1e6;

    /// @notice Number of winning tickets to draw
    uint256 public constant WINNING_TICKETS_COUNT = 50_000;

    /// @notice Maximum tickets per single order
    uint256 public constant MAX_TICKETS_PER_ORDER = 100;

    /// @notice Default deposit phase duration (7 days)
    uint256 public constant DEFAULT_DEPOSIT_DURATION = 7 days;

    // ============ State Variables ============

    /// @notice USDC token used for deposits
    IERC20 public immutable usdc;

    /// @notice Current raffle phase
    Phase public override currentPhase;

    /// @notice Refunds Merkle root. Leaves = keccak256(bytes.concat(keccak256(abi.encode(user, losingTicketCount))))
    bytes32 public refundsRoot;

    /// @notice Total number of winning tickets drawn
    uint256 public override drawnWinnersCount;

    /// @notice Total tickets issued
    uint256 public override totalTickets;

    /// @notice Total USDC deposited
    uint256 public totalDeposited;

    /// @notice Total refundable USDC (computed after drawing)
    uint256 public totalRefundable;

    /// @notice Total USDC allocated for prizes (retained)
    uint256 public totalPrizePool;

    /// @notice Mapping user -> info
    mapping(address => UserInfo) private _userInfo;

    /// @notice List of all participants for iteration (on-chain backup)
    address[] public participants;

    /// @notice Mapping to prevent duplicates in participants
    mapping(address => bool) private _isParticipant;

    /// @notice Deposit start timestamp (scheduled)
    uint256 public depositStartTime;

    /// @notice Deposit end timestamp
    uint256 public depositEndTime;

    /// @notice Deposit phase duration (configurable)
    uint256 public depositDuration;

    /// @notice Mapping orderId => true if already executed
    mapping(bytes16 => bool) public consumedOrders;

    /// @notice Mapping ticketId => owner (on-chain backup)
    mapping(uint256 => address) public ticketOwner;

    /// @notice Mapping user => owned ticketId array (on-chain backup)
    mapping(address => uint256[]) private _userTickets;

    // ============ Constructor ============

    /// @notice Initializes the raffle with the USDC token.
    /// @param _usdc USDC contract address.
    /// @param _admin Initial admin address.
    constructor(address _usdc, address _admin, address _orderSigner) 
        EIP712("RefundableRaffle", "1") 
    {
        if (_usdc == address(0) || _admin == address(0) || _orderSigner == address(0)) revert ZeroAddress();
        
        usdc = IERC20(_usdc);
        
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(OPERATOR_ROLE, _admin);
        _grantRole(ORDER_SIGNER_ROLE, _admin);
        _grantRole(ORDER_SIGNER_ROLE, _orderSigner);
        
        currentPhase = Phase.Inactive;
        depositDuration = DEFAULT_DEPOSIT_DURATION;
    }

    // ============ Modifiers ============

    /// @notice Ensures the current phase matches the specified one.
    modifier onlyPhase(Phase _phase) {
        if (currentPhase != _phase) revert InvalidPhase();
        _;
    }

    // ============ User Functions ============

    /// @inheritdoc IRefundableRaffle
    /// @dev Executes a deposit order signed by the backend.
    function executeDepositOrder(DepositOrder calldata order, bytes calldata signature)
        external 
        override 
        nonReentrant 
        whenNotPaused 
        onlyPhase(Phase.Deposit) 
        returns (uint256 ticketsMinted)
    {
        // Order validations
        if (msg.sender != order.recipient) revert UnauthorizedExecutor();
        if (block.timestamp < depositStartTime) revert DepositNotStarted();
        if (block.timestamp >= depositEndTime) revert DepositPeriodEnded();
        if (block.timestamp > order.expiry) revert OrderExpired();
        if (consumedOrders[order.orderId]) revert OrderAlreadyConsumed();
        if (order.usdcAmount < TICKET_PRICE) revert DepositTooSmall();
        
        // Verify signature
        bytes32 digest = _hashDepositOrder(order);
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(ORDER_SIGNER_ROLE, signer)) revert InvalidSignature();
        
        UserInfo storage user = _userInfo[order.recipient];

        // Compute tickets (only whole multiples of TICKET_PRICE)
        uint256 ticketsToMint = order.usdcAmount / TICKET_PRICE;
        uint256 effectiveDeposit = ticketsToMint * TICKET_PRICE;
        
        if (ticketsToMint == 0) revert DepositTooSmall();
        if (ticketsToMint > MAX_TICKETS_PER_ORDER) revert ExceedsMaxTicketsPerOrder();
        


        // Mark order as consumed
        consumedOrders[order.orderId] = true;

        // Transfer USDC
        usdc.safeTransferFrom(order.recipient, address(this), effectiveDeposit);

        // Compute ticket range for this order (tickets start at 1)
        uint256 firstTicketId = totalTickets + 1;
        uint256 lastTicketId = totalTickets + ticketsToMint;
        
        // Assign each ticket to the user (on-chain backup)
        for (uint256 i = 0; i < ticketsToMint; i++) {
            uint256 ticketId = firstTicketId + i;
            ticketOwner[ticketId] = order.recipient;
            _userTickets[order.recipient].push(ticketId);
        }
        
        // Update state
        user.depositedAmount += effectiveDeposit;
        user.ticketCount += ticketsToMint;
        totalTickets += ticketsToMint;
        totalDeposited += effectiveDeposit;

        // Add to participants list if new (on-chain backup)
        if (!_isParticipant[order.recipient]) {
            _isParticipant[order.recipient] = true;
            participants.push(order.recipient);
        }

        // Emit order event
        emit OrderCreated(order.orderId, order.recipient, effectiveDeposit, ticketsToMint, firstTicketId, lastTicketId);
        
        return ticketsToMint;
    }

    /// @inheritdoc IRefundableRaffle
    /// @dev Only losers can claim a refund. Winners are handled off-chain.
    ///      The Merkle tree contains (user, losingTicketCount) for eligible refund recipients.
    /// @param losingTicketCount Number of losing tickets to refund.
    /// @param merkleProof Proof to verify data in the Merkle tree.
    function claimRefund(
        uint256 losingTicketCount,
        bytes32[] calldata merkleProof
    ) 
        external 
        override 
        nonReentrant 
        onlyPhase(Phase.Claiming) 
    {
        UserInfo storage user = _userInfo[msg.sender];
        
        if (user.ticketCount == 0) revert NoTickets();
        if (user.claimed) revert AlreadyClaimed();
        if (losingTicketCount == 0) revert InvalidAmount();
        
        // Verify Merkle proof
        // Leaf = keccak256(bytes.concat(keccak256(abi.encode(user, losingTicketCount))))
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, losingTicketCount))));
        if (!merkleProof.verify(refundsRoot, leaf)) {
            revert InvalidMerkleProof();
        }
        
        // Sanity check: losing tickets cannot exceed the user's total tickets
        if (losingTicketCount > user.ticketCount) revert InvalidAmount();
        
        user.claimed = true;
        
        // Compute and transfer refund (1 ticket = TICKET_PRICE USDC)
        uint256 refundUsdc = losingTicketCount * TICKET_PRICE;
        usdc.safeTransfer(msg.sender, refundUsdc);
        emit RefundClaimed(msg.sender, refundUsdc);
    }

    // ============ View Functions ============

    /// @inheritdoc IRefundableRaffle
    function getUserInfo(address user) external view override returns (UserInfo memory) {
        return _userInfo[user];
    }

    /// @notice Returns the number of participants.
    function getParticipantCount() external view returns (uint256) {
        return participants.length;
    }

    /// @notice Returns a participant by index.
    function getParticipant(uint256 index) external view returns (address) {
        return participants[index];
    }

    /// @notice Returns all ticketIds owned by a user.
    function getUserTickets(address user) external view returns (uint256[] memory) {
        return _userTickets[user];
    }

    /// @notice Returns a specific user ticketId by index.
    function getUserTicketAt(address user, uint256 index) external view returns (uint256) {
        return _userTickets[user][index];
    }

    /// @notice Checks whether a Merkle proof is valid for a user.
    /// @param user User address.
    /// @param losingTicketCount Number of losing tickets.
    /// @param merkleProof The proof to verify.
    /// @return True if the proof is valid.
    function verifyMerkleProof(
        address user,
        uint256 losingTicketCount,
        bytes32[] calldata merkleProof
    ) external view returns (bool) {
        // NOTE: uses double hashing for compatibility with @openzeppelin/merkle-tree
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(user, losingTicketCount))));
        return merkleProof.verify(refundsRoot, leaf);
    }

    // ============ Admin Functions ============

    /// @inheritdoc IRefundableRaffle
    /// @dev If startTime == 0, the raffle starts immediately.
    ///      If startTime > block.timestamp, the raffle is scheduled for that time.
    function startDeposit(uint256 startTime) 
        external 
        override 
        onlyRole(ADMIN_ROLE) 
        onlyPhase(Phase.Inactive) 
    {
        uint256 effectiveStart = startTime == 0 ? block.timestamp : startTime;
        if (effectiveStart < block.timestamp) revert InvalidAmount();
        
        Phase oldPhase = currentPhase;
        currentPhase = Phase.Deposit;
        depositStartTime = effectiveStart;
        depositEndTime = effectiveStart + depositDuration;
        
        emit DepositScheduled(effectiveStart, depositEndTime);
        emit PhaseChanged(oldPhase, Phase.Deposit);
    }

    /// @inheritdoc IRefundableRaffle
    function setDepositDuration(uint256 duration) 
        external 
        override 
        onlyRole(ADMIN_ROLE) 
        onlyPhase(Phase.Inactive) 
    {
        if (duration == 0) revert InvalidAmount();
        depositDuration = duration;
        emit DepositDurationChanged(duration);
    }

    /// @notice Updates the deposit end timestamp.
    /// @dev Can only be called during the Deposit phase. The new endTime must be in the future.
    /// @param newEndTime New deposit end timestamp.
    function setDepositEndTime(uint256 newEndTime) 
        external 
        onlyRole(ADMIN_ROLE) 
        onlyPhase(Phase.Deposit) 
    {
        if (newEndTime <= block.timestamp) revert InvalidAmount();
        depositEndTime = newEndTime;
        emit DepositEndTimeChanged(newEndTime);
    }

    /// @inheritdoc IRefundableRaffle
    function closeDeposits() 
        external 
        override 
        onlyRole(OPERATOR_ROLE) 
        onlyPhase(Phase.Deposit) 
    {
        if (block.timestamp < depositEndTime) revert InvalidPhase();
        
        Phase oldPhase = currentPhase;
        currentPhase = Phase.Drawing;
        
        emit PhaseChanged(oldPhase, Phase.Drawing);
    }

    /// @inheritdoc IRefundableRaffle
    function commitWinners(bytes32 merkleRoot, uint256 totalWinners) 
        external 
        override 
        onlyRole(OPERATOR_ROLE) 
        onlyPhase(Phase.Drawing) 
    {
        if (merkleRoot == bytes32(0)) revert InvalidAmount();
        if (totalWinners > WINNING_TICKETS_COUNT) revert InvalidAmount();
        if (totalWinners > totalTickets) revert InvalidAmount();
        
        refundsRoot = merkleRoot;
        drawnWinnersCount = totalWinners;
        
        Phase oldPhase = currentPhase;
        currentPhase = Phase.Claiming;
        
        totalPrizePool = totalWinners * TICKET_PRICE;
        totalRefundable = totalDeposited - totalPrizePool;
        
        emit WinnersDrawn(totalWinners, merkleRoot);
        emit PhaseChanged(oldPhase, Phase.Claiming);
    }

    /// @inheritdoc IRefundableRaffle
    function closeRaffle() 
        external 
        override 
        onlyRole(ADMIN_ROLE) 
        onlyPhase(Phase.Claiming) 
    {
        Phase oldPhase = currentPhase;
        currentPhase = Phase.Closed;
        
        emit PhaseChanged(oldPhase, Phase.Closed);
    }

    /// @notice Cancels the raffle and refunds all participants.
    /// @dev If there are not enough funds, closes without refunding.
    ///      Can only be called during the Deposit or Drawing phase.
    function cancelRaffle() 
        external 
        onlyRole(ADMIN_ROLE) 
    {
        if (currentPhase != Phase.Deposit && currentPhase != Phase.Drawing) {
            revert InvalidPhase();
        }
        
        Phase oldPhase = currentPhase;
        uint256 balance = usdc.balanceOf(address(this));
        
        // If enough funds are available, refund everyone
        if (balance >= totalDeposited) {
            uint256 participantCount = participants.length;
            for (uint256 i = 0; i < participantCount; i++) {
                address participant = participants[i];
                UserInfo storage user = _userInfo[participant];
                
                if (user.depositedAmount > 0 && !user.claimed) {
                    uint256 refund = user.depositedAmount;
                    user.claimed = true;
                    usdc.safeTransfer(participant, refund);
                }
            }
            emit RaffleCancelled(true, totalDeposited);
        } else {
            // Not enough funds, close without refunding
            emit RaffleCancelled(false, 0);
        }
        
        currentPhase = Phase.Closed;
        emit PhaseChanged(oldPhase, Phase.Closed);
    }

    /// @inheritdoc IRefundableRaffle
    function withdrawPrizePool() 
        external 
        override 
        onlyRole(ADMIN_ROLE) 
    {
        if (currentPhase != Phase.Claiming && currentPhase != Phase.Closed) {
            revert InvalidPhase();
        }
        
        uint256 balance = usdc.balanceOf(address(this));
        if (balance > totalRefundable) {
            uint256 withdrawable = balance - totalRefundable;
            usdc.safeTransfer(msg.sender, withdrawable);
        }
    }

    /// @notice Pauses the raffle.
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /// @notice Unpauses the raffle.
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Withdraws unclaimed USDC after closure (emergency).
    /// @param to Recipient.
    /// @param amount Amount to withdraw.
    function emergencyWithdraw(address to, uint256 amount) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        if (to == address(0)) revert ZeroAddress();
        usdc.safeTransfer(to, amount);
    }

    // ============ Internal Functions ============

    /// @notice Generates the EIP-712 hash for a DepositOrder.
    function _hashDepositOrder(DepositOrder calldata order) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    DEPOSIT_ORDER_TYPEHASH,
                    order.orderId,
                    order.recipient,
                    order.usdcAmount,
                    order.expiry
                )
            )
        );
    }

    /// @notice Returns the EIP-712 domain separator (for off-chain verification).
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

}

