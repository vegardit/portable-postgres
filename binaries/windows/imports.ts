/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Reads the DLL imports of every packaged PE file and rejects any outside the bundle and the reviewed host set. */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import baseline from "./base.json" with { type: "json" };

/** Returns the lowercase DLL names in a PE32+ image's import and delay-import tables, or null for other files. */
export function readPeImports(image: Buffer): string[] | null {
  if (image.length < 64 || image.toString("latin1", 0, 2) !== "MZ") return null;
  const pe = image.readUInt32LE(60);
  if (pe + 24 > image.length || image.readUInt32LE(pe) !== 0x45_50) return null;
  const sectionCount = image.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const optionalSize = image.readUInt16LE(pe + 20);
  if (image.readUInt16LE(optional) !== 0x2_0B) throw new Error("Expected a PE32+ image");
  const directoryCount = image.readUInt32LE(optional + 108);
  const sections = optional + optionalSize;
  function offsetOf(address: number): number {
    for (let index = 0; index < sectionCount; index++) {
      const section = sections + index * 40;
      const start = image.readUInt32LE(section + 12);
      const size = Math.max(image.readUInt32LE(section + 8), image.readUInt32LE(section + 16));
      if (address >= start && address < start + size) {
        return address - start + image.readUInt32LE(section + 20);
      }
    }
    throw new Error("PE address lies outside every section: 0x" + address.toString(16));
  }
  const names = new Set<string>();
  // Import descriptors are 20 bytes with the name address at 12; delay-load descriptors are 32 bytes with it at 4.
  for (const [directory, size, nameField] of [[1, 20, 12], [13, 32, 4]] as const) {
    if (directory >= directoryCount) continue;
    const table = image.readUInt32LE(optional + 112 + directory * 8);
    if (table === 0) continue;
    for (let entry = offsetOf(table);; entry += size) {
      const nameAddress = image.readUInt32LE(entry + nameField);
      if (nameAddress === 0) break;
      const start = offsetOf(nameAddress);
      names.add(image.toString("latin1", start, image.indexOf(0, start)).toLowerCase());
    }
  }
  return [...names].sort();
}

/** Checks the whole candidate and returns the host DLLs it needs; every import must be bundled or reviewed. */
export async function inspectWindowsRuntime(installation: string): Promise<string[]> {
  const images = new Map<string, string[]>();
  // Windows resolves an import from the program's own directory, which is bin/ for every program here,
  // and then from system directories. PostgreSQL loads lib/ modules by full path with LoadLibrary, which
  // does not add their directory to that search, so a DLL elsewhere in the bundle never satisfies an import.
  const bundled = new Set<string>();
  const programs = join(installation, "bin");
  for (const entry of await readdir(installation, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const imports = readPeImports(await readFile(path));
    if (!imports) continue;
    images.set(relative(installation, path), imports);
    if (entry.parentPath === programs) bundled.add(entry.name.toLowerCase());
  }
  if (images.size === 0) throw new Error("No PE files found in the installation");
  const reviewed = new Set(baseline.hostLibraries);
  const host = new Set<string>();
  for (const [name, imports] of images) {
    for (const library of imports) {
      if (bundled.has(library)) continue;
      if (!reviewed.has(library)) {
        throw new Error(`${name} needs an unreviewed runtime library: ${library}`);
      }
      host.add(library);
    }
  }
  console.log(`Host libraries imported by ${images.size} PE files: ${[...host].sort().join(", ")}`);
  return [...host].sort();
}
