/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Checks what Apple's linker copied into each native image of a macOS candidate. build.sh links through a
 * compiler wrapper that stores each link's map under the output's LC_UUID, which relocation and signing
 * keep. The UUID ties an image to the link that produced it, so an image without a map, such as one linked
 * outside the build or rebuilt by hand before a reassembly, is refused.
 */
import { readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { readMachO } from "../artifact/macho.ts";
import { machOImages } from "./runtime.ts";

/** The directory in a build's work directory where build.sh stores the linker maps. */
export const linkRecordsDirectory = "link-records";

const linkDirectoryLine = /^# link directory: (\/.*)$/;

/**
 * Returns the inputs of one linker map: each object file, static library member or library stub, with a
 * relative path resolved against the directory the link ran in. `undefined` when the map is incomplete.
 */
export function mapInputs(map: string): string[] | undefined {
  const lines = map.split("\n");
  const directory = linkDirectoryLine.exec(lines[0] ?? "")?.[1];
  const start = lines.indexOf("# Object files:");
  const end = lines.indexOf("# Sections:", start + 1);
  if (directory === undefined || start === -1 || end === -1) return undefined;
  const inputs: string[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const input = /^\[\s*\d+\]\s(.+)$/.exec(line)?.[1];
    if (input === undefined) return undefined;
    if (input === "linker synthesized") {
      inputs.push(input);
      continue;
    }
    // An archive member appears as archive(member); only the archive path is resolved.
    const member = /^(.*\.a)(\(.+\))$/.exec(input);
    const path = member?.[1] ?? input;
    inputs.push(posix.normalize(posix.isAbsolute(path) ? path : posix.join(directory, path))
      + (member?.[2] ?? ""));
  }
  return inputs.length === 0 ? undefined : inputs;
}

/**
 * Requires a linker map in `records` for every Mach-O image in the installation, wherever it lies, and
 * refuses any input that comes neither from the build's work directory nor is a library stub. A stub
 * (`.tbd`) names a dynamic library and adds no code; that library then surfaces as a host import. Any other
 * input from outside the build, such as compiler-rt's static builtins, would be toolchain code that no
 * license review covers (`toolchainComponents` in artifact.ts lists none for macOS).
 * During packaging, candidateImages is the complete image list for this assembly.
 */
export async function auditLinks(
  installation: string,
  records: string,
  candidateImages?: readonly string[],
): Promise<void> {
  const images = candidateImages ?? await machOImages(installation);
  if (images.length === 0) throw new Error("No native image found in " + installation);
  // Maps describe the original link, even if the saved SDK now lives under a different checkout path.
  const buildRoot = (await readFile(join(records, "build-root"), "utf8")).trimEnd();
  if (!posix.isAbsolute(buildRoot) || posix.normalize(buildRoot) !== buildRoot
    || buildRoot === "/")
  {
    throw new Error("Invalid original build root in " + records);
  }
  const work = buildRoot + "/";
  const foreign = new Set<string>();
  for (const path of images) {
    const name = relative(installation, path).split(sep).join("/");
    const { uuid } = readMachO(await readFile(path));
    const map = uuid === undefined
      ? undefined
      : await readFile(join(records, uuid + ".map"), "utf8").catch(() => undefined);
    const inputs = map === undefined ? undefined : mapInputs(map);
    if (inputs === undefined) throw new Error("No linker record for " + name);
    for (const input of inputs) {
      if (input === "linker synthesized" || input.startsWith(work) || input.endsWith(".tbd")) {
        continue;
      }
      foreign.add(`${name}: ${input}`);
    }
  }
  if (foreign.size > 0) {
    throw new Error(
      "A link copied code from outside the build that no license review covers:\n"
        + [...foreign].sort().join("\n"),
    );
  }
}
