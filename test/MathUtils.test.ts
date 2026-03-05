import { describe, it } from "node:test";
import { network } from "hardhat";

describe("MathUtils", () => {
    async function deployFixture() {
        const { viem } = await network.connect();
        const mock = await viem.deployContract("MathUtilsMock", []);
        return { viem, mock };
    }

    it("mulDiv: zeri => 0, denom 0 => revert", async () => {
        const { viem, mock } = await (await network.connect()).networkHelpers.loadFixture(deployFixture);

        if ((await mock.read.mulDiv([0n, 123n, 5n])) !== 0n) throw new Error("mulDiv 0*b != 0");
        if ((await mock.read.mulDiv([123n, 0n, 5n])) !== 0n) throw new Error("mulDiv a*0 != 0");

        await viem.assertions.revertWithCustomError(
            mock.read.mulDiv([1n, 1n, 0n]) as any,
            mock as any,
            "MathUtilsDivisionByZero"
        );
    });

    it("mulDivRoundingUp: round-up corretto e short-circuit per denom==1", async () => {
        const { mock } = await (await network.connect()).networkHelpers.loadFixture(deployFixture);

        // 5*2/3 = 3.333.. => up => 4
        if ((await mock.read.mulDivUp([5n, 2n, 3n])) !== 4n) throw new Error("round up fail");
        // denom=1 => valore pieno
        if ((await mock.read.mulDivUp([7n, 8n, 1n])) !== 56n) throw new Error("denom==1 fail");
        // zeri
        if ((await mock.read.mulDivUp([0n, 99n, 7n])) !== 0n) throw new Error("up zero fail");
    });

    it("mulDiv(rounding): Down/Up equivalgono alle funzioni base", async () => {
        const { mock } = await (await network.connect()).networkHelpers.loadFixture(deployFixture);
        // Down
        if ((await mock.read.mulDivRound([7n, 5n, 3n, 0])) !== 11n) throw new Error("round down mismatch");
        // Up
        if ((await mock.read.mulDivRound([7n, 5n, 3n, 1])) !== 12n) throw new Error("round up mismatch");
    });
});


