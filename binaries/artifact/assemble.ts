/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

import { chmod, cp, lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { type ArtifactTarget, includesRuntimePath } from "./runtime-layout.ts";

/**
 * Assembles the selected runtime payload from a platform's development installation into `destination`,
 * and sets runtime permissions on everything there. Notices are not taken from the installation:
 * packaging writes the current pins' notices into the destination first, so the reused installation stays
 * unchanged and an earlier pin's notice never ships.
 */
export async function assembleRuntime(
  prefix: string,
  destination: string,
  target: ArtifactTarget,
): Promise<void> {
  for (const directory of ["bin", "lib", "share"]) {
    await cp(join(prefix, directory), join(destination, directory), {
      recursive: true,
      verbatimSymlinks: true,
      filter: path => includesRuntimePath(relative(prefix, path).split(sep).join("/"), target),
    });
  }
  // Upstream archives can use group-writable modes. Establish runtime permissions independently of the builder umask.
  if (process.platform !== "win32") await setReadablePermissions(destination);
}

/**
 * Gives a directory tree the modes of an installed one, whatever the umask that created it: 0755 for
 * directories and executables, 0644 for other regular files. Symbolic links keep their own.
 */
export async function setReadablePermissions(directory: string): Promise<void> {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await setReadablePermissions(path);
    else if (entry.isFile()) {
      await chmod(path, (await lstat(path)).mode & 0o111 ? 0o755 : 0o644);
    }
  }
}
