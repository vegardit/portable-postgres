/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Locates the repository and its ignored build directories for every build-tool module. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walks up to the package root, so compiled copies under dist/ still find the scripts and SQL fixtures. */
function packageRoot(start: string): string {
  for (let directory = start;; directory = dirname(directory)) {
    if (existsSync(join(directory, "package.json"))) return directory;
    if (dirname(directory) === directory) throw new Error("No package.json above " + start);
  }
}

export const root = packageRoot(import.meta.dirname);
export const workRoot = join(root, "binaries", "work");
export const outputRoot = join(root, "binaries", "output");
