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
  type ArtifactManifest,
  artifactManifestName,
  parseArtifactManifest,
  validateArtifact,
  verifyArtifactArchive,
} from "./artifact/artifact.ts";
import { compareTargets } from "./artifact/compare.ts";
import { artifactTargets, isArtifactTarget } from "./artifact/runtime-layout.ts";

const [mode, targetOrArchive, pathOrDigest] = process.argv.slice(2);
if (mode === "archive") {
  if (!targetOrArchive || !pathOrDigest) {
    throw new Error("Expected archive path and trusted SHA-256.");
  }
  await verifyArtifactArchive(resolve(targetOrArchive), pathOrDigest);
  console.log("Archive bytes match the independently supplied SHA-256.");
} else if (mode === "compare") {
  if (!targetOrArchive || !pathOrDigest) {
    throw new Error("Expected two installation paths or --require-all-targets <downloads>.");
  }
  const readManifest = async (path: string): Promise<ArtifactManifest> =>
    parseArtifactManifest(await readFile(join(resolve(path), artifactManifestName), "utf8"));
  // Each hosted upload has its target in its directory name. Require both the upload and its identity.
  const [first, ...others] = targetOrArchive === "--require-all-targets"
    ? await Promise.all(artifactTargets.map(async target => {
      const manifest = await readManifest(join(pathOrDigest, "manifest-" + target));
      if (manifest.target !== target) {
        throw new Error(`Manifest describes ${manifest.target}, expected ${target}`);
      }
      return manifest;
    }))
    : await Promise.all([targetOrArchive, pathOrDigest].map(readManifest));
  const differences = compareTargets(first!, ...others);
  for (const difference of differences) console.error(difference);
  if (differences.length > 0) throw new Error("The installations ship different contents.");
  console.log(
    "The installations ship the same PostgreSQL version, source pins, and extension files.",
  );
} else {
  if (
    (mode !== "candidate" && mode !== "release") || !isArtifactTarget(targetOrArchive)
    || !pathOrDigest
  ) {
    throw new Error(
      `Expected candidate|release, ${artifactTargets.join("|")}, and installation path.`,
    );
  }
  const manifest = await validateArtifact(resolve(pathOrDigest), targetOrArchive, { mode });
  console.log(
    "Validated " + mode + " artifact: " + manifest.target + ", PostgreSQL "
      + manifest.postgresqlVersion,
  );
}
