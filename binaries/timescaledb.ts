/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks compiled TimescaleDB translation units for TSL paths and explicit Timescale License declarations. */
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

function declaresTimescaleLicense(source: string): boolean {
  // Upstream's c_license_header-timescale.h declares the licence in the leading C comment.
  // Source code or a later comment can quote the same sentence.
  const header = /^\s*\/\*([\s\S]*?)\*\//.exec(source)?.[1];
  return header?.replaceAll(/[\s*]+/g, " ").includes(
    "This file and its contents are licensed under the Timescale License.",
  ) ?? false;
}

/** Checks the files named by CMake, since a change of path or licence can affect an Apache-only build. */
export async function requireApacheOnlyTimescaleDB(
  buildDirectory: string,
  sourceDirectory: string,
): Promise<void> {
  const database = join(buildDirectory, "compile_commands.json");
  const entries: unknown = JSON.parse(await readFile(database, "utf8"));
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("The TimescaleDB build compiled nothing, according to " + database);
  }
  // Windows compares paths without regard to case.
  const key = (path: string): string => process.platform === "win32" ? path.toLowerCase() : path;
  const tsl = key(resolve(sourceDirectory, "tsl") + sep);
  const restricted: string[] = [];
  for (const entry of entries as Array<{ directory: string; file: string }>) {
    const path = resolve(entry.directory, entry.file);
    if (key(path).startsWith(tsl) || declaresTimescaleLicense(await readFile(path, "utf8"))) {
      restricted.push(path);
    }
  }
  if (restricted.length > 0) {
    throw new Error(
      "The Apache-only TimescaleDB build compiled code under the Timescale License:\n"
        + restricted.join("\n"),
    );
  }
}
