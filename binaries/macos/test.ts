/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Runs the native macOS proof, the same smoke.sh as on Linux, and interprets its pgTAP assertions. */
import { join, resolve } from "node:path";
import { validateArtifact } from "../artifact/artifact.ts";
import { runShellProof } from "../native-proof.ts";
import { lastCandidate } from "../package.ts";
import { outputRoot } from "../paths.ts";

const installation = resolve(
  process.argv[2] ?? await lastCandidate(join(outputRoot, "macos-arm64")),
);
await validateArtifact(installation, "macos-arm64", { mode: "candidate" });
await runShellProof(installation);
