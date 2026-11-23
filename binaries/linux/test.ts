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

const installation = resolve(
  process.argv[2] ?? await lastCandidate(join(outputRoot, "linux-x64")),
);
await validateArtifact(installation, "linux-x64-glibc", { mode: "candidate" });
await runShellProof(installation);
