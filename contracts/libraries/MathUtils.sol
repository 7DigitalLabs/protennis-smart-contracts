// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MathUtils
/// @notice High-precision multiply/divide operations with controlled rounding.
library MathUtils {
    error MathUtilsDivisionByZero();

    enum Rounding {
        Down,
        Up
    }

    /// @notice Computes floor(a*b/denominator) with overflow handling via 512-bit math.
    /// @dev Reverts if `denominator == 0`. Returns 0 if a==0 or b==0.
    function mulDiv(
        uint256 a,
        uint256 b,
        uint256 denominator
    ) internal pure returns (uint256 result) {
        if (denominator == 0) revert MathUtilsDivisionByZero();
        if (a == 0 || b == 0) return 0;

        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            if (prod1 == 0) {
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }

            if (denominator <= prod1) revert MathUtilsDivisionByZero();

            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }

            prod0 |= prod1 * twos;

            uint256 inverse = (3 * denominator) ^ 2;

            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;

            assembly {
                result := mul(prod0, inverse)
            }
            return result;
        }
    }

    /// @notice Computes ceil(a*b/denominator). Shortcut for `denominator==1`.
    function mulDivRoundingUp(
        uint256 a,
        uint256 b,
        uint256 denominator
    ) internal pure returns (uint256 result) {
        if (denominator == 0) revert MathUtilsDivisionByZero();
        if (a == 0 || b == 0) return 0;

        result = mulDiv(a, b, denominator);
        if (denominator == 1) return result;
        if (mulmod(a, b, denominator) != 0) {
            result += 1;
        }
    }

    /// @notice Computes a*b/denominator with selectable rounding.
    function mulDiv(
        uint256 a,
        uint256 b,
        uint256 denominator,
        Rounding rounding
    ) internal pure returns (uint256) {
        if (rounding == Rounding.Down) {
            return mulDiv(a, b, denominator);
        } else {
            return mulDivRoundingUp(a, b, denominator);
        }
    }
}

