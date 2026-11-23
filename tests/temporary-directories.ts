/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Tracks the directories created by one test suite for its explicit afterEach cleanup. */
export function temporaryDirectories(defaultLabel: string): {
  directory: (label?: string) => Promise<string>;
  cleanup: () => Promise<void>;
} {
  const owned = new Set<string>();
  return {
    async directory(label = defaultLabel): Promise<string> {
      const path = await mkdtemp(join(tmpdir(), `portable-postgres-${label}-`));
      owned.add(path);
      return path;
    },
    async cleanup(): Promise<void> {
      for (const path of owned) {
        await rm(path, { recursive: true, force: true });
        owned.delete(path);
      }
    },
  };
}
