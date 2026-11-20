/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Runs the native Linux proof and interprets its passing and intentionally failing pgTAP assertions. */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateArtifact } from "../artifact/artifact.ts";
import { assertNativeTap } from "../native-proof.ts";
import { lastCandidate } from "../package.ts";
import { outputRoot, root } from "../paths.ts";

const installation = resolve(
  process.argv[2] ?? await lastCandidate(join(outputRoot, "linux-x64")),
);
await validateArtifact(installation, "linux-x64-glibc", { mode: "candidate" });
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
const proof = (/^NATIVE_PROOF_DIRECTORY=(.+)$/m.exec(result.stdout))?.[1];
if (!proof) throw new Error("Native proof did not report its evidence directory");
await assertNativeTap(
  await readFile(join(proof, "results.tap"), "utf8"),
  await readFile(join(proof, "failure.tap"), "utf8"),
);
console.log(
  "Native proof passed, including detection of the deliberately failing pgTAP assertion.",
);
