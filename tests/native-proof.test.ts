/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Guards the shared server settings and the TAP results of native and clean-consumer proofs. */
import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { temporaryDirectories } from "./temporary-directories.ts";
import {
  isPortFailure,
  plannedAssertions,
  portFailures,
  serverSettings,
  textsearchSettings,
} from "../binaries/native-proof.ts";
import { root } from "../binaries/paths.ts";

const proofScripts = ["binaries/linux/smoke.sh", "binaries/windows/test.ts"];
const { directory, cleanup } = temporaryDirectories("consumer-tap");
afterEach(cleanup);

it.each([["linux-x64-glibc", "linux/amd64"], ["linux-arm64-glibc", "linux/arm64"]])(
  "%s retains the Docker platform even when the consumer fails",
  async (target, platform) => {
    const output = await directory();
    const archive = join(output, "fixture.tar.gz");
    await writeFile(archive, "fixture");
    const argv = process.argv;
    vi.resetModules();
    try {
      process.argv = [process.execPath, "test-clean.ts", target, archive];
      vi.spyOn(await import("../binaries/paths.ts"), "outputRoot", "get").mockReturnValue(output);
      const docker = vi.spyOn(await import("../binaries/process.ts"), "capture")
        .mockImplementation((_, args) => {
          if (args[0] === "create") return "fixture-container";
          if (args[0] === "inspect") return "1";
          if (args[0] === "logs") {
            return "Native proof evidence: /tmp/portable-postgres-proof.fixture/logs";
          }
          return "";
        });
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(import("../binaries/linux/test-clean.ts")).rejects.toThrow(
        "exited unsuccessfully",
      );
      const proof = (await readdir(output)).find(name => name.startsWith("consumer-proof-"))!;
      const record = JSON.parse(await readFile(join(output, proof, "consumer.json"), "utf8"));
      expect(record).toMatchObject({ target, platform });
      const args = docker.mock.calls[0]![1];
      expect(args[0]).toBe("create");
      expect(args.slice(1, 3)).toEqual(["--platform", record.platform]);
    } finally {
      process.argv = argv;
      vi.restoreAllMocks();
      vi.resetModules();
    }
  },
);

it("checks the TAP files from the clean consumer after its tools are restored", async () => {
  const proof = await directory();
  const log = join(proof, "consumer.log");
  await writeFile(log, `NATIVE_PROOF_DIRECTORY=${proof}\n`);
  const check = () => spawnSync(process.execPath, [join(root, "binaries/native-proof.ts"), log], {
    encoding: "utf8",
  });
  const count = plannedAssertions(await readFile(join(root, "tests/native/tap.sql"), "utf8"));
  const passed = [`1..${count}`, ...Array.from({ length: count }, (_, i) => `ok ${i + 1}`)].join(
    "\n",
  );
  const failed = "1..1\nnot ok 1 - deliberate\n";
  await writeFile(join(proof, "results.tap"), passed + " # SKIP\n");
  await writeFile(join(proof, "failure.tap"), failed);
  expect(check().stderr).toContain("TAP proof failed");
  await writeFile(join(proof, "results.tap"), passed + "\n");
  await writeFile(join(proof, "failure.tap"), failed + "Bail out!\n");
  expect(check().stderr).toContain("TAP proof failed");
  await writeFile(join(proof, "failure.tap"), failed);
  expect(check().status).toBe(0);
});

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
  expect(settings).toContain("ssl");
  for (const script of proofScripts) {
    // A script can append a setting after a literal \n. SQL and library names can also mention ssl.
    const text = (await readFile(join(root, script), "utf8")).replaceAll("\\n", "\n");
    for (const setting of settings) {
      const assignment = new RegExp(`\\b${RegExp.escape(setting)}\\s*=`, "i");
      expect(text, `${script} restates ${setting}`).not.toMatch(assignment);
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
