/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Measures the shipped ELF glibc requirements and checks the Linux runtime's linked libraries. */
import { execFileSync } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { type LinuxTarget, linuxTargets, nativeLinuxTarget } from "./target.ts";
import baseline from "./base.json" with { type: "json" };
import { compareVersions } from "../sources/version.ts";

const glibcLibraries = new Set([
  "libc.so.6",
  "libdl.so.2",
  "libm.so.6",
  "libpthread.so.0",
  "libresolv.so.2",
  "librt.so.1",
]);

/** Returns the path of every regular file in the installation that is an ELF image, wherever it lies. */
export async function elfImages(installation: string): Promise<string[]> {
  const elfMagic = Buffer.from([0x7F, 0x45, 0x4C, 0x46]);
  const images: string[] = [];
  for (const entry of await readdir(installation, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const file = await open(path, "r");
    const header = Buffer.alloc(elfMagic.length);
    try {
      await file.read(header);
    } finally {
      await file.close();
    }
    if (header.equals(elfMagic)) images.push(path);
  }
  return images;
}

/** Runs readelf with these options on an ELF image and returns what it prints. */
export function readelf(image: string, ...options: string[]): string {
  // Use the reader from the compiler toolchain so it recognizes the DWARF that this Clang emits.
  return execFileSync("llvm-readelf-" + baseline.llvm, [...options, image], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 30_000,
  });
}

export async function inspectLinuxRuntime(
  installation: string,
  target: LinuxTarget,
): Promise<string> {
  const bundled = new Set(
    (await readdir(join(installation, "lib"), { withFileTypes: true }))
      .filter(entry => entry.isFile() || entry.isSymbolicLink()).map(entry => entry.name),
  );
  let maximum = "0";
  const libraries = new Set<string>();
  for (const path of await elfImages(installation)) {
    const info = readelf(path, "--wide", "--dynamic", "--version-info");
    const name = relative(installation, path);
    const requirements = info.split("Version needs section")[1] ?? "";
    for (const [, version = ""] of requirements.matchAll(/\bName: GLIBC_([\w.]+)/g)) {
      if (!/^\d+(?:\.\d+)+$/.test(version) || compareVersions(version, baseline.glibc) > 0) {
        throw new Error(
          `${name} needs GLIBC_${version}, outside the glibc ${baseline.glibc} baseline`,
        );
      }
      if (compareVersions(version, maximum) > 0) maximum = version;
    }
    for (const [, library = ""] of info.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)) {
      if (library !== linuxTargets[target].loader && !glibcLibraries.has(library)
        && !bundled.has(library))
      {
        throw new Error(`${name} needs an unreviewed runtime library: ${library}`);
      }
      libraries.add(library);
    }
  }
  if (maximum === "0") throw new Error("No glibc version requirements found in the installation");
  console.log(`Highest required glibc symbol version: GLIBC_${maximum}`);
  console.log(`Linked libraries: ${[...libraries].sort().join(", ")}`);
  return maximum;
}

if (import.meta.main) {
  const installation = process.argv[2];
  if (!installation) throw new Error("Usage: node binaries/linux/abi.ts <installation>");
  await inspectLinuxRuntime(installation, nativeLinuxTarget());
}
