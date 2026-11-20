/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Guards that the Linux and Windows native proofs keep sharing one server setup and TAP plan. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  isPortFailure,
  plannedAssertions,
  portFailures,
  serverSettings,
  textsearchSettings,
} from "../binaries/native-proof.ts";
import { root } from "../binaries/paths.ts";

const proofScripts = ["binaries/linux/smoke.sh", "binaries/windows/test.ts"];

it("retries startup for any port the server could not use", () => {
  const inUse = [
    `LOG:  could not bind IPv4 address "127.0.0.1": Address already in use`,
    `HINT:  Is another postmaster already running on port 5432? If not, wait a few seconds and retry.`,
    `FATAL:  could not create any TCP/IP sockets`,
  ].join("\n");
  // Windows reports a port in a Hyper-V or WSL excluded range as a permission error without the hint.
  const excluded = [
    `LOG:  could not bind IPv4 address "127.0.0.1": Permission denied`,
    `FATAL:  could not create any TCP/IP sockets`,
  ].join("\n");
  expect(isPortFailure(inUse)).toBe(true);
  expect(isPortFailure(excluded)).toBe(true);
  expect(isPortFailure(`FATAL:  could not load library "timescaledb"`)).toBe(false);
});

it("smoke.sh retries on the same port failures as the Windows proof", async () => {
  const smoke = await readFile(join(root, "binaries/linux/smoke.sh"), "utf8");
  expect(smoke).toContain(`grep -Eq '${portFailures.join("|")}'`);
});

it("both proofs take every server setting from the shared configuration", async () => {
  const settings =
    (await Promise.all([serverSettings, textsearchSettings].map(file => readFile(file, "utf8"))))
      .join("\n")
      .split(/\r?\n/)
      .filter(line => line.trim() !== "" && !line.startsWith("#"))
      .map(line => line.split("=")[0]!.trim());
  expect(settings).toContain("shared_preload_libraries");
  for (const script of proofScripts) {
    const text = await readFile(join(root, script), "utf8");
    for (const setting of settings) {
      expect(text, `${script} restates ${setting}`).not.toContain(setting);
    }
  }
});

it("reads the assertion count from the pgTAP plan", () => {
  expect(plannedAssertions("BEGIN;\nSELECT plan(3);\nSELECT ok(true);\n")).toBe(3);
  expect(() => plannedAssertions("SELECT ok(true);")).toThrow("exactly one pgTAP plan");
  expect(() => plannedAssertions("SELECT plan(1);\nSELECT plan(2);")).toThrow(
    "exactly one pgTAP plan",
  );
});
