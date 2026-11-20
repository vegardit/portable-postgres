/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Inputs shared by the Linux and Windows native proofs. smoke.sh runs without Node in the clean
 * consumer, so the shared parts are plain files under tests/native that both proofs read.
 */
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
