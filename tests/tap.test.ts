/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Guards native validation against silently accepted pgTAP failures and incomplete plans. */
import { expect, it } from "vitest";
import { assertTap } from "../binaries/tap.ts";

it("accepts a complete passing TAP plan", () => {
  expect(() => assertTap("1..1\nok 1 - passed\n", 1)).not.toThrow();
});

it("rejects a failed assertion even when SQL completed", () => {
  expect(() => assertTap("1..1\nnot ok 1 - failed\n", 1)).toThrow("TAP proof failed");
  expect(() => assertTap("1..1\nnot ok 1 - failed\n", 1, 1)).not.toThrow();
});

it("rejects an incomplete plan and skipped assertions", () => {
  expect(() => assertTap("1..2\nok 1 - passed\n", 2)).toThrow("TAP proof failed");
  expect(() => assertTap("1..1\nok 1 - skipped # SKIP\n", 1)).toThrow("TAP proof failed");
});

it("rejects a bail-out even after the expected deliberate failure", () => {
  expect(() => assertTap("1..1\nnot ok 1 - expected\nBail out! stopped\n", 1, 1)).toThrow(
    "TAP proof failed",
  );
  expect(() => assertTap("1..1\nok 1 - passed\nBail out! stopped\n", 1)).toThrow(
    "TAP proof failed",
  );
});
