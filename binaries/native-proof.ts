/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Inputs shared by the native proofs: smoke.sh on Linux and macOS, and the Windows proof. smoke.sh runs
 * without Node in the clean consumer, so the shared parts are plain files under tests/native that both read.
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./paths.ts";
import { assertTap } from "./tap.ts";

export const nativeTests = join(root, "tests/native");

/** Both proofs append these settings to the postgresql.conf that initdb wrote. */
export const serverSettings = join(nativeTests, "server.conf");

/** Both proofs append these settings as well before the run that preloads pg_textsearch alone. */
export const textsearchSettings = join(nativeTests, "textsearch.conf");

/**
 * Startup log messages that mean the chosen port was unusable. A port in a Hyper-V or WSL excluded
 * range fails with a permission error, which lacks the hint PostgreSQL adds for a port in use.
 * smoke.sh greps for the same messages.
 */
export const portFailures = ["could not bind", "could not create any TCP/IP sockets"];

export function isPortFailure(serverLog: string): boolean {
  return portFailures.some(message => serverLog.includes(message));
}

/** Returns the assertion count that a pgTAP script declares, so no caller restates it. */
export function plannedAssertions(sql: string): number {
  const plans = [...sql.matchAll(/\bplan\((\d+)\)/g)];
  if (plans.length !== 1) throw new Error("Expected exactly one pgTAP plan in the script");
  return Number(plans[0]![1]);
}

async function plan(file: string): Promise<number> {
  return plannedAssertions(await readFile(join(nativeTests, file), "utf8"));
}

/** Checks the output of tap.sql and of tap-failure.sql, whose every assertion fails on purpose. */
export async function assertNativeTap(results: string, failures: string): Promise<void> {
  assertTap(results, await plan("tap.sql"));
  const deliberate = await plan("tap-failure.sql");
  assertTap(failures, deliberate, deliberate);
}

/**
 * Runs smoke.sh on a POSIX installation and interprets its passing and intentionally failing pgTAP
 * assertions. The script is plain Bash 3.2, which is what macOS ships.
 */
export async function runShellProof(installation: string): Promise<void> {
  const result = spawnSync("bash", [join(root, "binaries/linux/smoke.sh"), installation], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`Native SQL proof failed (${result.status})`);
  await checkShellProof(result.stdout);
}

/** Reads the two transcripts produced by smoke.sh, including in a consumer without Node.js. */
export async function assertNativeTapFiles(directory: string): Promise<void> {
  await assertNativeTap(
    await readFile(join(directory, "results.tap"), "utf8"),
    await readFile(join(directory, "failure.tap"), "utf8"),
  );
}

async function checkShellProof(output: string): Promise<void> {
  const proof = (/^NATIVE_PROOF_DIRECTORY=(.+)$/m.exec(output))?.[1];
  if (!proof) throw new Error("Native proof did not report its evidence directory");
  await assertNativeTapFiles(proof);
  console.log(
    "Native proof passed, including detection of the deliberately failing pgTAP assertion.",
  );
}

if (import.meta.main) {
  const log = process.argv[2];
  if (!log) throw new Error("Expected the consumer proof log");
  await checkShellProof(await readFile(log, "utf8"));
}
