/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Reads files whose absence is an expected state, such as a target without a tracked review yet, and rewrites
 * tracked JSON files.
 */
import { open, readFile, rename, rm } from "node:fs/promises";

/**
 * The text of a file, or `undefined` when there is none. Any other failure propagates: a file that exists
 * but cannot be read may hold exactly what the caller must not overlook.
 */
export async function readOptionalText(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
}

/**
 * Replaces an existing JSON file atomically and keeps its line endings, so a checkout shows only the changed
 * values and the formatter, which expects the platform's line endings, still accepts it.
 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  const staging = path + ".partial";
  const handle = await open(staging, "w");
  try {
    try {
      const eol = (await readFile(path, "utf8")).includes("\r\n") ? "\r\n" : "\n";
      await handle.writeFile(JSON.stringify(value, null, 2).replaceAll("\n", eol) + eol);
    } finally {
      await handle.close();
    }
    await rename(staging, path);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}
