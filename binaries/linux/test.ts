/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Runs the native Linux proof and interprets its passing and intentionally failing pgTAP assertions. */
import { join, resolve } from "node:path";
import { validateArtifact } from "../artifact/artifact.ts";
import { runShellProof } from "../native-proof.ts";
import { lastCandidate } from "../package.ts";
import { outputRoot } from "../paths.ts";
import { linuxTargets, nativeLinuxTarget } from "./target.ts";

const target = nativeLinuxTarget();
const installation = resolve(
  process.argv[2] ?? await lastCandidate(join(outputRoot, linuxTargets[target].output)),
);
await validateArtifact(installation, target, { mode: "candidate" });
await runShellProof(installation);
