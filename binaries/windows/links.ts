/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Checks what the linker copied into each PE image of a Windows candidate. build.cmd has every link write a
 * `/MAP` file beside its output, which names the library member behind every public and static symbol.
 * The link output must be byte-identical to the packaged image, so a map always describes the image it is
 * checked for. Static Microsoft code may only come from the reviewed Visual Studio toolset libraries and members that the
 * `msvc-runtime` notice names; import stubs may come from any Microsoft library.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, relative, sep } from "node:path";
import { z } from "zod";
import { readOptionalText } from "../files.ts";
import { fileSha256 } from "../hash.ts";
import { linkEnvironmentFile } from "./link-recipe.ts";
import { dataOnlyPe } from "../artifact/data-library.ts";
import { isIcuDataLibrary } from "../artifact/runtime-layout.ts";

export { linkEnvironmentFile } from "./link-recipe.ts";

/**
 * The only Microsoft libraries whose static members may be linked: the dynamic CRT's startup and support code,
 * which `notices/msvc-runtime.txt` names, from the Visual Studio toolset folder. The reviewed C++ helpers
 * are listed separately below. Their static CRT (`libcmt`,
 * `libvcruntime`) and debug (`msvcrtd`, `vcruntimed`) siblings live in the same folder and fail.
 */
const admittedStaticLibraries = new Set(["msvcrt", "vcruntime"]);
// ICU's standard-library use links these two support members even with the dynamic C++ runtime.
// Further members require a notice and licence review before they can be admitted here.
const admittedStlMembers = new Set(["vector_algorithms.obj", "xonce2.obj"]);

export type LinkEnvironment = { toolsetLibrary: string; sdkVersion: string; libraryPath: string[] };

/** Reads the `NAME=value` lines that build.cmd writes after vcvars64.bat. */
export function parseLinkEnvironment(text: string): LinkEnvironment {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\w+)=(.*)$/.exec(line.trimEnd());
    if (match) values.set(match[1]!, match[2]!);
  }
  const value = (name: string): string => {
    const found = values.get(name);
    if (!found) throw new Error(`The link environment records no ${name}.`);
    return found;
  };
  return {
    toolsetLibrary: join(value("VCToolsInstallDir"), "lib", "x64"),
    sdkVersion: value("WindowsSDKVersion").replace(/\\$/, ""),
    // vcvars64.bat writes some directories with doubled separators.
    libraryPath: value("LIB").split(";").filter(Boolean).map(directory => normalize(directory)),
  };
}

/** Returns the members that a map attributes to each library, by the library's base name as the map spells it. */
export function mapContributions(text: string): Map<string, Set<string>> {
  const contributions = new Map<string, Set<string>>();
  let inSymbols = false;
  for (const line of text.split(/\r?\n/)) {
    // The publics header reads "Address  Publics by Value  Rva+Base  Lib:Object".
    if (/Publics by Value|^\s*Static symbols/.test(line)) inSymbols = true;
    if (/^\s*entry point at/.test(line) || /^\s*Exports\s*$/.test(line)) inSymbols = false;
    if (!inSymbols || !/^\s*[0-9a-f]{4}:[0-9a-f]{8}\s/i.test(line)) continue;
    // A drive prefix belongs to an object that was linked by its absolute path, not to a library.
    const field = /^\s*\S+\s+\S+\s+[\da-f]{16}\s+(?:[fi]\s+)*(.+?)\s*$/i.exec(line)?.[1];
    if (!field) throw new Error("Unrecognized link map symbol: " + line);
    const origin = field.replace(/^[A-Za-z]:(?=[\\/])/, "");
    // A library's base name has no colon, but a member's path may have a drive letter.
    const separator = origin.indexOf(":");
    // `<linker-defined>`, `<common>`, `<absolute>` and the image's own objects carry no library.
    if (separator <= 0 || origin.startsWith("<")) continue;
    const library = origin.slice(0, separator);
    const member = origin.slice(separator + 1);
    const members = contributions.get(library) ?? new Set<string>();
    members.add(member.slice(Math.max(member.lastIndexOf("\\"), member.lastIndexOf("/")) + 1));
    contributions.set(library, members);
  }
  return contributions;
}

/**
 * Classifies the members of a COFF archive (`.lib`) by the name a map uses for them, the part after the last
 * path separator. A name is import data only when every member of that name is: a short import record, or
 * an import descriptor whose sections are all `.idata$` or `.debug$`. Any other member makes it code or data
 * copied into the image, whatever its name ends with.
 */
export function archiveMembers(archive: Buffer): Map<string, "import" | "static"> {
  if (archive.toString("latin1", 0, 8) !== "!<arch>\n") throw new Error("Not a COFF archive");
  const kinds = new Map<string, "import" | "static">();
  let longNames: Buffer | undefined;
  for (let offset = 8; offset + 60 <= archive.length;) {
    const header = archive.toString("latin1", offset, offset + 60);
    const rawName = header.slice(0, 16).trimEnd();
    const size = Number(header.slice(48, 58).trim());
    if (!Number.isSafeInteger(size) || offset + 60 + size > archive.length) {
      throw new Error("Truncated COFF archive member at offset " + offset);
    }
    const body = archive.subarray(offset + 60, offset + 60 + size);
    offset += 60 + size + (size % 2);
    // The two linker members are symbol indexes, and "//" holds the long member names.
    if (rawName === "/") continue;
    if (rawName === "//") {
      longNames = body;
      continue;
    }
    let name = rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
    if (/^\/\d+$/.test(rawName)) {
      if (longNames === undefined) {
        throw new Error("A COFF archive member names a missing long name");
      }
      const start = Number(rawName.slice(1));
      const end = longNames.indexOf(0, start);
      name = longNames.toString("latin1", start, end === -1 ? longNames.length : end);
    }
    name = name.slice(Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/")) + 1).toLowerCase();
    const kind = isImportMember(body) ? "import" : "static";
    if (kinds.get(name) !== "static") kinds.set(name, kind);
  }
  return kinds;
}

function isImportMember(body: Buffer): boolean {
  if (body.length < 20) return false;
  // A short import record: Sig1 0, Sig2 0xFFFF and version 0; a later version marks an anonymous object.
  if (body.readUInt16LE(0) === 0 && body.readUInt16LE(2) === 0xFF_FF) {
    return body.readUInt16LE(4) === 0;
  }
  const sections = body.readUInt16LE(2);
  const table = 20 + body.readUInt16LE(16);
  if (sections === 0 || table + sections * 40 > body.length) return false;
  for (let index = 0; index < sections; index++) {
    const at = table + index * 40;
    const name = body.toString("latin1", at, at + 8).replace(/\0+$/, "");
    if (!name.startsWith(".idata$") && !name.startsWith(".debug$")) return false;
  }
  return true;
}

/** Recognizes a PE image by its MZ header and PE signature, whatever its file name. */
function isPeImage(data: Buffer): boolean {
  if (data.length < 64 || data.toString("latin1", 0, 2) !== "MZ") return false;
  const pe = data.readUInt32LE(60);
  return pe + 4 <= data.length && data.readUInt32LE(pe) === 0x45_50;
}

/** Configure probes link throwaway programs; their maps describe nothing that ships. */
const probeDirectory = /(?:^|[\\/])(?:meson-private|CMakeFiles)(?:[\\/]|$)/i;

async function filesBelow(directory: string, skipProbes = false): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()
      && !(skipProbes && probeDirectory.test(relative(directory, entry.parentPath))))
    {
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files;
}

/** Per-image build evidence. The recipe identity covers its producer and its classification rules. */
const imageEvidence = z.object({
  mapHash: z.string().regex(/^[a-f0-9]{64}$/),
  staticMembers: z.record(z.string(), z.array(z.string())),
});
type ImageEvidence = z.infer<typeof imageEvidence>;

/** The distinct admitted members across the candidate, for the build summary. */
export type WindowsLinkSummary = { images: number; staticMicrosoftCode: Map<string, Set<string>> };

function pathKey(path: string): string {
  return normalize(path).toLowerCase();
}

function libraryKey(path: string): string {
  return basename(path, extname(path)).toLowerCase();
}

const linkRecord = z.object({
  imageHash: z.string(),
  mapHash: z.string(),
  libraries: z.array(z.string()),
});

function linkedLibraries(inputs: string[]): Map<string, Set<string>> {
  const libraries = new Map<string, Set<string>>();
  for (const path of inputs) {
    const key = libraryKey(path);
    const paths = libraries.get(key) ?? new Set<string>();
    paths.add(pathKey(path));
    libraries.set(key, paths);
  }
  return libraries;
}

type LibraryIndex = {
  projects: Set<string>;
  projectNames: Set<string>;
  installed: Map<string, Map<string, string>>;
  toolset: string;
  memberKinds: Map<string, ReturnType<typeof archiveMembers>>;
};

/** Build-time lookup. Missing optional components are normal, but unreadable directories cannot establish uniqueness. */
async function buildLibraryIndex(buildWork: string, buildFiles: string[]): Promise<LibraryIndex> {
  const text = await readOptionalText(join(buildWork, linkEnvironmentFile));
  if (text === undefined) throw new Error("The build recorded no link environment; rebuild it.");
  const environment = parseLinkEnvironment(text);
  const projects = new Set(buildFiles.filter(path => /\.(?:lib|a)$/i.test(path)).map(pathKey));
  const projectNames = new Set([...projects].map(libraryKey));
  const installed = new Map<string, Map<string, string>>();
  for (const directory of new Map(environment.libraryPath.map(path => [pathKey(path), path]))
    .values())
  {
    const entries = await readdir(directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.filter(name => /\.lib$/i.test(name))) {
      const key = libraryKey(entry);
      const paths = installed.get(key) ?? new Map<string, string>();
      const path = join(directory, entry);
      paths.set(pathKey(path), path);
      installed.set(key, paths);
    }
  }
  return {
    projects,
    projectNames,
    installed,
    toolset: pathKey(environment.toolsetLibrary),
    memberKinds: new Map(),
  };
}

type LinkOutput = { map: string; output: string };

async function classifyImage(
  name: string,
  link: LinkOutput & { libraries: string[] },
  image: { timestamp: number; dataOnly: boolean },
  map: Buffer,
  index: LibraryIndex,
  problems: string[],
): Promise<ImageEvidence["staticMembers"]> {
  const text = map.toString("latin1");
  const { timestamp, dataOnly } = image;
  const membersByLibrary = mapContributions(text);
  const stamp = /^\s*Timestamp is ([a-f\d]+)\b/im.exec(text)?.[1];
  if (text.split(/\r?\n/, 1)[0]?.trim().toLowerCase() !== libraryKey(link.output)
    || !stamp || Number.parseInt(stamp, 16) !== timestamp
    || (membersByLibrary.size === 0 && !dataOnly) || !/^\s*entry point at\s+/im.test(text))
  {
    throw new Error("Incomplete or mismatched link map for " + name + ": " + link.map);
  }
  const actual = linkedLibraries(link.libraries);
  const staticMembers: ImageEvidence["staticMembers"] = {};
  for (const [library, members] of membersByLibrary) {
    const key = library.toLowerCase();
    const installed = index.installed.get(key);
    const project = index.projectNames.has(key);
    const paths = actual.get(key);
    const locations = [...installed?.values() ?? [], ...project ? ["the build tree"] : []];
    const prefix = name + " links " + [...members].sort().join(", ") + " from " + library;
    if (locations.length === 0) {
      problems.push(prefix + ", which found neither in LIB nor in the build.");
      continue;
    }
    if (locations.length > 1 || (paths && paths.size > 1)) {
      problems.push(
        prefix + ", which is ambiguous: " + [...new Set([...locations, ...paths ?? []])].join(", "),
      );
      continue;
    }
    const resolved = paths?.values().next().value;
    if (resolved && project && index.projects.has(resolved)) continue;
    const path = resolved && installed?.get(resolved);
    if (!path) {
      problems.push(
        prefix + ": unexpected or missing linker input " + (resolved ?? library + ".lib"),
      );
      continue;
    }
    let kinds = index.memberKinds.get(path);
    if (!kinds) {
      kinds = archiveMembers(await readFile(path));
      index.memberKinds.set(path, kinds);
    }
    for (const member of [...members].sort()) {
      const kind = kinds.get(member.toLowerCase());
      if (kind === "import") continue;
      if (kind === "static" && pathKey(dirname(path)) === index.toolset
        && (admittedStaticLibraries.has(key)
          || (key === "msvcprt" && admittedStlMembers.has(member.toLowerCase()))))
      {
        (staticMembers[path] ??= []).push(member);
      } else {
        problems.push(kind === undefined
          ? name + " links " + member + " from " + path + ", which has no member of that name."
          : name + " links the static member " + member + " of " + path
            + ", which the licence gate does not admit.");
      }
    }
  }
  return staticMembers;
}

/** A fresh build seals the checked maps and classifications. Reassembly verifies them without consulting the host SDK. */
export async function auditWindowsLinks(
  installation: string,
  buildWork: string,
  mode: "build" | "assemble" = "build",
): Promise<WindowsLinkSummary> {
  const images = new Map<string, { hash: string; timestamp: number; dataOnly: boolean }>();
  for (const file of await filesBelow(installation)) {
    const data = await readFile(file);
    if (isPeImage(data)) {
      images.set(relative(installation, file).split(sep).join("/"), {
        hash: createHash("sha256").update(data).digest("hex"),
        timestamp: data.readUInt32LE(data.readUInt32LE(60) + 8),
        dataOnly: isIcuDataLibrary(relative(installation, file).split(sep).join("/"), "windows-x64")
          && dataOnlyPe(data),
      });
    }
  }
  if (images.size === 0) throw new Error("No PE image found in " + installation);

  const evidenceFile = join(buildWork, "windows-link-evidence.json");
  let saved: Record<string, ImageEvidence> | undefined;
  if (mode === "assemble") {
    const text = await readOptionalText(evidenceFile);
    if (text === undefined) {
      throw new Error(
        "The build has no sealed link evidence. If the build is still running, retry when it finishes. Otherwise, rebuild.",
      );
    }
    saved = z.record(z.string(), imageEvidence).parse(JSON.parse(text));
  }
  const buildFiles = await filesBelow(buildWork, true);
  const index = saved ? undefined : await buildLibraryIndex(buildWork, buildFiles);
  const byPath = new Map(buildFiles.map(file => [pathKey(file), file]));
  const records = new Map<string, LinkOutput[]>();
  for (const map of buildFiles.filter(file => /\.map$/i.test(file))) {
    const stem = map.slice(0, -4);
    for (const extension of [".dll", ".exe"]) {
      const output = byPath.get(pathKey(stem + extension));
      if (!output) continue;
      const hash = await fileSha256(output);
      records.set(hash, [...records.get(hash) ?? [], { map, output }]);
    }
  }

  const problems: string[] = [];
  const evidence: Record<string, ImageEvidence> = {};
  const staticMicrosoftCode = new Map<string, Set<string>>();
  for (const [name, { hash, timestamp, dataOnly }] of images) {
    const matches = records.get(hash) ?? [];
    if (matches.length !== 1) {
      problems.push(
        (matches.length > 0 ? "Ambiguous link records for " : "No link record for ") + name,
      );
      continue;
    }
    const link = matches[0]!;
    const map = await readFile(link.map);
    const mapHash = createHash("sha256").update(map).digest("hex");
    let entry = saved?.[hash];
    if (index) {
      const text = await readOptionalText(link.output + ".link.json");
      if (text === undefined) {
        problems.push("No recorded link inputs for " + name);
        continue;
      }
      const record = linkRecord.parse(JSON.parse(text));
      if (record.imageHash !== hash || record.mapHash !== mapHash) {
        problems.push("Link output or map changed since linking " + name);
        continue;
      }
      entry = {
        mapHash,
        staticMembers: await classifyImage(name, { ...link, libraries: record.libraries }, {
          timestamp,
          dataOnly,
        }, map, index, problems),
      };
      evidence[hash] = entry;
    }
    if (entry?.mapHash !== mapHash) {
      problems.push("Missing or changed recorded link map for " + name);
      continue;
    }
    for (const [library, members] of Object.entries(entry.staticMembers)) {
      const all = staticMicrosoftCode.get(library) ?? new Set<string>();
      for (const member of members) all.add(member);
      staticMicrosoftCode.set(library, all);
    }
  }
  if (problems.length > 0) {
    throw new Error("The Windows link check failed:\n" + problems.join("\n"));
  }
  if (!saved) {
    // Readers can reassemble this build as soon as recordBuild returns. Publish only a complete audit.
    const staging = evidenceFile + "." + randomUUID() + ".partial";
    await writeFile(staging, JSON.stringify(evidence));
    await rename(staging, evidenceFile);
  }
  return { images: images.size, staticMicrosoftCode };
}
