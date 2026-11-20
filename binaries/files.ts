/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Reads files whose absence is an expected state, such as a target without a tracked review yet. */
import { readFile } from "node:fs/promises";

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
