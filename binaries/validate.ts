/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Validates and compares local extracted candidates or release artifacts without executing their native programs. */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  artifactManifestName,
  parseArtifactManifest,
  validateArtifact,
  verifyArtifactArchive,
} from "./artifact/artifact.ts";
import { compareTargets } from "./artifact/compare.ts";

const [mode, targetOrArchive, pathOrDigest] = process.argv.slice(2);
if (mode === "archive") {
  if (!targetOrArchive || !pathOrDigest) {
    throw new Error("Expected archive path and trusted SHA-256.");
  }
  await verifyArtifactArchive(resolve(targetOrArchive), pathOrDigest);
  console.log("Archive bytes match the independently supplied SHA-256.");
} else if (mode === "compare") {
  if (!targetOrArchive || !pathOrDigest) throw new Error("Expected two installation paths.");
  const [left, right] = await Promise.all(
    [targetOrArchive, pathOrDigest].map(async path =>
      parseArtifactManifest(await readFile(join(resolve(path), artifactManifestName), "utf8"))
    ),
  );
  const differences = compareTargets(left!, right!);
  for (const difference of differences) console.error(difference);
  if (differences.length > 0) throw new Error("The two installations ship different contents.");
  console.log(
    "Both installations ship the same PostgreSQL version, source pins, and extension files.",
  );
} else {
  if (
    (mode !== "candidate" && mode !== "release")
    || (targetOrArchive !== "windows-x64" && targetOrArchive !== "linux-x64-glibc") || !pathOrDigest
  ) {
    throw new Error(
      "Expected candidate|release, windows-x64|linux-x64-glibc, and installation path.",
    );
  }
  const manifest = await validateArtifact(resolve(pathOrDigest), targetOrArchive, { mode });
  console.log(
    "Validated " + mode + " artifact: " + manifest.target + ", PostgreSQL "
      + manifest.postgresqlVersion,
  );
}
