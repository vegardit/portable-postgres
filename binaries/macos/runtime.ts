/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Measures what the packaged Mach-O images need from the host and checks that they stay relocatable. */
import { open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { insideInstallation } from "../artifact/artifact.ts";
import {
  hasMachOMagic,
  platformMacOS,
  readMachO,
} from "../artifact/macho.ts";
import { compareVersions } from "../sources/version.ts";

/** Returns every regular file in the installation that starts like a Mach-O image, wherever it lies. */
export async function machOImages(installation: string): Promise<string[]> {
  const images: string[] = [];
  for (const entry of await readdir(installation, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const file = await open(path, "r");
    const header = Buffer.alloc(4);
    try {
      await file.read(header);
    } finally {
      await file.close();
    }
    if (hasMachOMagic(header)) images.push(path);
  }
  return images.sort();
}

/** dyld skips absent search locations. An unreadable location is an audit failure. */
async function existingPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** System locations whose libraries ship with macOS; everything else must come from the archive. */
const systemLibrary = /^\/(?:usr\/lib|System\/Library)\//;

/**
 * Checks the load commands of every packaged image and returns the system libraries they import and the
 * highest minimum macOS any of them declares. A bundled library must be loaded as `@rpath/<name>` from
 * `lib/`, a search path must be relative to the image, and no image may need a newer macOS than `floor`.
 * During packaging, candidateImages is the complete image list for this assembly.
 */
export async function inspectMacOSRuntime(
  installation: string,
  floor: string,
  candidateImages?: readonly string[],
): Promise<{ imports: string[]; minimumOS: string }> {
  const root = await realpath(installation);
  const bundled = new Set(
    (await readdir(join(installation, "lib"), { withFileTypes: true }))
      .filter(entry => entry.isFile() || entry.isSymbolicLink()).map(entry => entry.name),
  );
  const imports = new Set<string>();
  let minimumOS = "0";
  const images = candidateImages ?? await machOImages(installation);
  if (images.length === 0) throw new Error("No native image found in " + installation);
  for (const path of images) {
    const name = relative(installation, path).split(sep).join("/");
    const image = readMachO(await readFile(path));
    if (image.platform !== platformMacOS || image.minimumOS === undefined) {
      throw new Error(`${name} declares no macOS build version`);
    }
    if (compareVersions(image.minimumOS, floor) > 0) {
      throw new Error(`${name} needs macOS ${image.minimumOS}, newer than the ${floor} floor`);
    }
    if (compareVersions(image.minimumOS, minimumOS) > 0) minimumOS = image.minimumOS;
    if (image.id !== undefined && image.id !== "@rpath/" + name.split("/").at(-1)) {
      throw new Error(`${name} has a non-relocatable install name: ${image.id}`);
    }
    const searchDirectories: string[] = [];
    for (const rpath of image.rpaths) {
      const lookup = dirname(path) + "/" + rpath.slice("@loader_path/".length);
      if (rpath.startsWith("@loader_path/") && insideInstallation(installation, lookup)) {
        const directory = await existingPath(lookup);
        if (directory === undefined) continue;
        if (insideInstallation(root, directory)) {
          searchDirectories.push(directory);
          continue;
        }
      }
      throw new Error(`${name} searches libraries outside the installation: ${rpath}`);
    }
    for (const library of image.dylibs) {
      const bundledName = /^@rpath\/([^/]+)$/.exec(library)?.[1];
      if (bundledName !== undefined && bundled.has(bundledName)) {
        const expected = await realpath(join(root, "lib", bundledName));
        // dyld stops at the first match, so a later lib/ entry cannot correct an earlier match.
        let loaded: string | undefined;
        for (const directory of searchDirectories) {
          loaded = await existingPath(join(directory, bundledName));
          if (loaded !== undefined) break;
        }
        if (loaded !== expected || !insideInstallation(root, expected)) {
          throw new Error(`${name} cannot reach the bundled library: ${library}`);
        }
        continue;
      }
      if (systemLibrary.test(library) && !library.split("/").includes("..")) {
        // A successful load of Apple's zlib can hide a link against the wrong SDK library.
        if (bundled.has(basename(library))) {
          throw new Error(`${name} uses the system copy of a bundled library: ${library}`);
        }
        imports.add(library);
        continue;
      }
      throw new Error(`${name} needs an unreviewed runtime library: ${library}`);
    }
  }
  console.log(`Highest required macOS: ${minimumOS}`);
  console.log(`System libraries: ${[...imports].sort().join(", ")}`);
  return { imports: [...imports].sort(), minimumOS };
}
