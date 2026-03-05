// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MathUtils } from "../libraries/MathUtils.sol";

/// @notice Mock wrapper per testare `MathUtils`.
contract MathUtilsMock {
    function mulDiv(uint256 a, uint256 b, uint256 denominator) external pure returns (uint256) {
        return MathUtils.mulDiv(a, b, denominator);
    }

    function mulDivUp(uint256 a, uint256 b, uint256 denominator) external pure returns (uint256) {
        return MathUtils.mulDivRoundingUp(a, b, denominator);
    }

    function mulDivRound(uint256 a, uint256 b, uint256 denominator, MathUtils.Rounding r)
        external pure returns (uint256)
    {
        return MathUtils.mulDiv(a, b, denominator, r);
    }
}


