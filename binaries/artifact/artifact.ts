/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Defines and validates language-neutral runtime metadata; candidate checks never imply release license approval. */
import {
  chmod,
  lstat,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileSha256 } from "../hash.ts";
import { sources } from "../sources/sources.ts";
import {
  compareOrdinal,
  maxNoticeExamples,
  nonblankText as text,
  type NoticeSignatureExample,
} from "./notice-scan.ts";
import {
  cpuTypeArm64,
  fileTypes,
  hasMachOMagic,
  plainArm64Subtypes,
  platformMacOS,
  readMachO,
} from "./macho.ts";
import { additionalNoticeName } from "./notices.ts";
import { dataOnlyElf, dataOnlyPe } from "./data-library.ts";
import { isLinuxTarget, linuxTargets } from "../linux/target.ts";
import * as z from "zod";
import {
  type ArtifactTarget,
  artifactTargets,
  clientLibraryPath,
  corePrograms,
  bundledExtensions,
  extensionLibraries,
  includesRuntimePath,
  isMacOSClientLibrary,
  isIcuLibrary,
  librarySource,
  compressionLibraries,
  opensslLibraries,
  isIcuDataLibrary,
  mingwEvidence,
  mingwSourcePrefix,
  mingwNotice,
  mingwRuntimeDlls,
  moduleSuffix,
  requiredModules,
  requiredIcuLibraries,
  sqlOnlyExtensions,
  unaccentRules,
} from "./runtime-layout.ts";

export const artifactManifestName = "native-artifact.json";
export type { ArtifactTarget } from "./runtime-layout.ts";

/**
 * glibc's startup sources add the GCC linking exception to the LGPL; SPDX lists glibc's wording of it as a
 * reference text. This is not GCC's own runtime, whose GPL license stays forbidden.
 */
const glibcStartupLicense = "LGPL-2.1-or-later WITH GCC-exception-2.0";
const compilerRtLicense = "Apache-2.0 WITH LLVM-exception";

const linuxCompilerRt = {
  id: "compiler-rt",
  evidence: "Clang major version",
  licenses: [compilerRtLicense],
};
const linuxCxx = {
  id: "llvm-cxx-runtime",
  evidence: "Clang major version",
  licenses: [compilerRtLicense],
  notice: "notices/llvm-cxx-runtime.txt",
};
const glibcToolchain = [
  linuxCompilerRt,
  // Scrt1.o, crti.o, crtn.o and members of libc_nonshared.a are linked statically into every ELF image.
  { id: "glibc-startup", evidence: "glibc", licenses: [glibcStartupLicense] },
  linuxCxx,
];
const muslToolchain = [
  linuxCompilerRt,
  {
    id: "musl-startup",
    evidence: "musl startup package",
    licenses: ["MIT"],
    notice: "notices/musl-startup.txt",
  },
  { ...linuxCxx, evidence: "LLVM C++ runtime version" },
];

/**
 * Toolchain code linked into native images besides the source's own code. Each part has its own review,
 * covering the images to which it contributes. Reviews bind the host evidence naming the toolchain line.
 * A part with a `notice` retains the project's notice or upstream license texts, which the review binds too.
 */
export const toolchainComponents: Record<
  ArtifactTarget,
  ReadonlyArray<{ id: string; evidence: string; licenses: readonly string[]; notice?: string }>
> = {
  "linux-x64-glibc": glibcToolchain,
  "linux-arm64-glibc": glibcToolchain,
  "linux-x64-musl": muslToolchain,
  "linux-arm64-musl": muslToolchain,
  "windows-x64": [
    {
      id: "mingw-runtime",
      evidence: mingwEvidence,
      // docs/native-artifact.md maps the pinned DLLs and linked members to these grants.
      licenses: [
        compilerRtLicense,
        "MIT",
        "BSD-3-Clause",
        "BSL-1.0",
        "LicenseRef-Public-Domain",
        "ZPL-2.1",
        "ISC",
        "BSD-2-Clause",
        "LicenseRef-MinGW-gdtoa",
        "LicenseRef-MinGW-printf",
      ],
      notice: "notices/" + mingwNotice,
    },
  ],
  // Apple's linker copies no toolchain code: the images link compiler-rt and the C runtime dynamically
  // through libSystem, which is a host library. The link audit (binaries/macos/links.ts) refuses any static
  // input from the SDK or toolchain, so a build that starts copying one fails until it is reviewed here.
  "macos-arm64": [],
};

/** Returns the archive paths of the project's notices that the target's toolchain components ship. */
export function toolchainNotices(target: ArtifactTarget): string[] {
  return toolchainComponents[target].flatMap(part =>
    part.notice === undefined ? [] : [part.notice]
  );
}

/** Returns the host evidence entry that a toolchain component's review is bound to. */
export function toolchainEvidence(id: string, target?: ArtifactTarget): string {
  const parts = target === undefined
    ? Object.values(toolchainComponents).flat()
    : toolchainComponents[target];
  const part = parts.find(candidate => candidate.id === id);
  if (part === undefined) throw new Error("Unknown toolchain component: " + id);
  return part.evidence;
}

/** The LLVM C++ runtime is statically linked only into ICU's Linux code libraries. */
export function toolchainImages(
  id: string,
  images: readonly string[],
  target: ArtifactTarget,
): string[] {
  // The generated locale-data library has no executable code or linked CRT startup.
  const codeImages = images.filter(path => !isIcuDataLibrary(path, target));
  return id === "llvm-cxx-runtime"
    ? codeImages.filter(path => isIcuLibrary(path, target))
    : codeImages;
}

/** Host libraries that every release review must name for its target. */
export const requiredHostLibraries: Record<ArtifactTarget, readonly string[]> = {
  "linux-x64-glibc": ["glibc"],
  "linux-arm64-glibc": ["glibc"],
  "linux-x64-musl": ["musl"],
  "linux-arm64-musl": ["musl"],
  "windows-x64": ["ucrtbase.dll"],
  "macos-arm64": ["/usr/lib/libSystem.B.dylib"],
};

/**
 * The host evidence in which a build records what its packaged images need from the host: the imported
 * system DLLs on Windows, the glibc symbol or musl build baseline on Linux, and the imported system
 * libraries on macOS, whose minimum OS is measured separately (`macOSMinimumEvidence`).
 */
export const hostMeasurementEvidence: Record<ArtifactTarget, string> = {
  "linux-x64-glibc": "ELF glibc symbol requirements",
  "linux-arm64-glibc": "ELF glibc symbol requirements",
  "linux-x64-musl": "ELF musl baseline",
  "linux-arm64-musl": "ELF musl baseline",
  "windows-x64": "PE host library imports",
  "macos-arm64": "Mach-O host library imports",
};

/**
 * The highest `LC_BUILD_VERSION` minimum macOS of any packaged image. The review states it as the
 * requirement of libSystem, which every image loads, so a raised minimum reopens the host review.
 */
export const macOSMinimumEvidence = "Mach-O minimum macOS version";

/** PostgreSQL's macOS review covers code emitted by Apple's parser generators. */
export const macOSParserEvidence = "PostgreSQL parser generators";

export type ArtifactOptions = {
  target: ArtifactTarget;
  packagingRevision: number;
  hostEvidence: HostEvidence[];
  hostRequirements?: HostRequirements | null;
  licenseInventory?: LicenseInventory;
  /** Every pinned source's scan, with an empty array for a source that yielded no signatures. */
  noticeSignatures: Readonly<Record<string, NoticeSignatureExample[]>>;
};

const executableNames = ["postgres", "initdb", "pg_ctl", "psql"] as const;
const permittedLicenses = new Set([
  "PostgreSQL",
  "Apache-2.0",
  compilerRtLicense,
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Zlib",
  "CC0-1.0",
  "Unicode-3.0",
  "LicenseRef-IANA-tzdata",
  "LicenseRef-Public-Domain",
]);
const permittedHostLicenses = new Set([
  ...permittedLicenses,
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LicenseRef-Microsoft-Windows",
  "LicenseRef-Apple-macOS",
]);

/**
 * Licenses required for code shipped by each source. Toolchain components have their own required licenses,
 * and host libraries have a separate allowlist. The `LicenseRef-` texts ship as retained notices.
 */
export const sourceComponentLicenses: ReadonlyMap<string, readonly string[]> = new Map([
  ["postgresql", [
    // Henry Spencer's regex package and the Tcl code in regc_locale.c.
    "Spencer-99",
    "TCL",
    // Ryu (src/common/d2s.c, f2s.c), which PostgreSQL uses under the Boost license.
    "BSL-1.0",
    // GEQO (src/backend/optimizer/geqo), pg_dump, rbtree.c, and the JIS X 0213 conversion tables.
    "LicenseRef-GEQO-Whitley",
    "LicenseRef-pg-dump-Warner",
    "LicenseRef-rbtree-Niemann",
    "LicenseRef-X0213",
  ]],
  // Paul Vixie's cron code and the Berkeley bitstring.h.
  ["pg_cron", ["Vixie-Cron", "BSD-4.3TAHOE"]],
  // ICU retains its older license and the IPADIC dictionary's additional terms in its full data library.
  ["icu", ["ICU", "NAIST-2003"]],
]);

const errorPrefix = "Native artifact: ";

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(errorPrefix + message);
}

/**
 * Reports whether a path contains a control character: C0, DEL or C1. An installation and an archive are
 * checked with this same rule, so that a payload that one accepts the other never refuses.
 */
export function hasControlCharacter(path: string): boolean {
  return /\p{Cc}/u.test(path);
}

function safePath(path: string): void {
  requireCondition(
    !/[<>:"\\|?*]/.test(path) && !hasControlCharacter(path),
    "unsafe path: " + path,
  );
  requireCondition(path.length > 0 && !path.startsWith("/"), "path must be relative: " + path);
  for (const part of path.split("/")) {
    requireCondition(
      part !== "" && part !== "." && part !== ".." && !/[. ]$/.test(part),
      "unsafe path: " + path,
    );
    requireCondition(
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      "reserved path: " + path,
    );
  }
}

function validatePayloadPath(path: string): void {
  safePath(path);
  requireCondition(/^(bin|lib|share|notices)\//.test(path), "unexpected payload path: " + path);
  requireCondition(
    !/(^|\/)(include|pgxs|node_modules|_refs)(\/|$)/i.test(path)
      && !/\.(a|lib|o|obj|pdb|exp|h|py|pl|sh|in)$/i.test(path)
      && !/(timescaledb[-_]tsl|partman_bgw|pg_prove)/i.test(path),
    "excluded component or development file: " + path,
  );
}

/**
 * Reports whether a file starts like a PE, ELF or Mach-O image; the bytes decide, not the file name. Every
 * Mach-O form counts, so that a 32-bit or universal image is found and then refused as the wrong machine.
 */
export async function isNativeImage(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await file.read(header);
    return bytesRead >= 2 && header.toString("latin1", 0, 2) === "MZ"
      || bytesRead === 4 && header.equals(Buffer.from([0x7F, 0x45, 0x4C, 0x46]))
      || bytesRead === 4 && hasMachOMagic(header);
  } finally {
    await file.close();
  }
}

function validateMachine(binary: Buffer, target: ArtifactTarget, path: string): void {
  if (target === "windows-x64") {
    const pe = binary.length >= 64 ? binary.readUInt32LE(60) : -1;
    requireCondition(
      binary.subarray(0, 2).toString() === "MZ" && pe >= 64 && pe + 6 <= binary.length
        && binary.subarray(pe, pe + 4).equals(Buffer.from([80, 69, 0, 0]))
        && binary.readUInt16LE(pe + 4) === 0x86_64,
      "expected a Windows x64 PE image: " + path,
    );
  } else if (target === "macos-arm64") {
    let image;
    try {
      image = readMachO(binary);
    } catch {
      requireCondition(false, "expected a macOS arm64 Mach-O image: " + path);
    }
    requireCondition(
      image.cpuType === cpuTypeArm64
        && plainArm64Subtypes.has(image.cpuSubtype)
        && (Object.values(fileTypes) as number[]).includes(image.fileType),
      "expected a macOS arm64 Mach-O image: " + path,
    );
    // An iOS or simulator image has the same CPU type; only the build platform tells them apart.
    requireCondition(image.platform === platformMacOS, "expected a macOS build platform: " + path);
    requireCondition(image.signed, "unsigned Mach-O image: " + path);
    if (path.startsWith("bin/")) {
      requireCondition(image.fileType === fileTypes.execute,
        "expected a Mach-O executable: " + path);
    } else if (isMacOSClientLibrary(path) || librarySource(path, target)) {
      requireCondition(image.fileType === fileTypes.dylib,
        "expected a Mach-O client dylib: " + path);
    } else if (path.startsWith("lib/")) {
      // PostgreSQL loads server and extension modules with dlopen, which accepts dylibs and bundles.
      requireCondition(
        image.fileType === fileTypes.dylib || image.fileType === fileTypes.bundle,
        "expected a Mach-O loadable module: " + path,
      );
    }
  } else {
    requireCondition(
      binary.length >= 20 && binary.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))
        && binary[4] === 2 && binary[5] === 1
        && binary.readUInt16LE(18) === linuxTargets[target].machine,
      `expected a ${target} ELF image: ${path}`,
    );
    const { libc, loader } = linuxTargets[target];
    if (path.startsWith("bin/")) {
      const interpreter = elfInterpreter(binary);
      // Glibc loader paths can vary by distribution. The musl loader name identifies a mismatch.
      const compatible = libc === "musl"
        ? interpreter === "/lib/" + loader
        : !/^ld-musl-.+\.so\.1$/.test(posix.basename(interpreter ?? ""));
      requireCondition(
        compatible,
        `expected the ${target} ELF interpreter: ${path}`,
      );
    }
  }
}

/** Reads the interpreter from a 64-bit little-endian ELF program header table. */
function elfInterpreter(binary: Buffer): string | undefined {
  if (binary.length < 64) return undefined;
  const table = Number(binary.readBigUInt64LE(32));
  const entrySize = binary.readUInt16LE(54);
  const count = binary.readUInt16LE(56);
  if (table < 64 || entrySize !== 56 || table + count * entrySize > binary.length) return undefined;
  for (let index = 0; index < count; index++) {
    const entry = table + index * entrySize;
    if (binary.readUInt32LE(entry) !== 3) continue; // PT_INTERP
    const offset = Number(binary.readBigUInt64LE(entry + 8));
    const size = Number(binary.readBigUInt64LE(entry + 32));
    if (size < 2 || offset + size > binary.length || binary[offset + size - 1] !== 0) {
      return undefined;
    }
    return binary.toString("utf8", offset, offset + size - 1);
  }
  return undefined;
}

/** Checks path containment on the validation host. Pass resolved paths when following links. */
export function insideInstallation(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && !child.startsWith(".." + sep) && child !== "..");
}

/** Required payload paths in manifest order, including notices the matching upstream pin requires. */
function sourceNotices(source: SourcePin, requiredFiles: readonly string[] = []): string[] {
  const notices = ["notices/" + source.id + ".txt"];
  const additional = new Set([
    ...(source.noticeFiles ?? []),
    ...requiredFiles,
    // The project's own copies of texts that the source needs but does not contain.
    ...(source.projectNotices ?? []).map(notice => notice.file),
  ]);
  if (source.id === "timescaledb" || source.id === "pg_textsearch") additional.add("NOTICE");
  for (const file of additional) {
    safePath(file);
    notices.push("notices/" + additionalNoticeName(source.id, file));
  }
  requireCondition(
    new Set(notices).size === notices.length,
    "colliding source notice paths: " + source.id,
  );
  return notices;
}

/**
 * Refuses group- or world-writable and set-ID modes, which content hashes and the executable flag miss.
 * Linux and macOS archives carry POSIX modes alike.
 */
export function validateLinuxPermissions(mode: number, entry: string): void {
  requireCondition((mode & 0o022) === 0, "writable " + entry);
  // Content hashes and the executable flag do not capture setuid or setgid bits.
  requireCondition((mode & 0o6000) === 0, "setuid or setgid " + entry);
}

export function requireValidationHost(target: ArtifactTarget): void {
  requireCondition(
    target === "windows-x64" || process.platform !== "win32",
    "validating a Linux or macOS installation requires a POSIX host to read executable permissions",
  );
}

async function scan(installation: string, target: ArtifactTarget): Promise<ContentEntry[]> {
  const root = await realpath(installation);
  const entries: ContentEntry[] = [];
  const names = new Set<string>();
  const checkLinuxPermissions = target !== "windows-x64";
  async function visit(directory: string, prefix: string): Promise<void> {
    const directoryInfo = await lstat(directory);
    if (checkLinuxPermissions) {
      validateLinuxPermissions(directoryInfo.mode, "directory: " + (prefix || "."));
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      if (path === artifactManifestName) {
        requireCondition(entry.isFile(), "metadata must be a regular file");
        continue;
      }
      safePath(path);
      const key = path.toLowerCase();
      requireCondition(!names.has(key), "case-colliding path: " + path);
      names.add(key);
      const fullPath = join(directory, entry.name);
      const info = await lstat(fullPath);
      if (!info.isDirectory()) validatePayloadPath(path);
      requireCondition(includesRuntimePath(path, target), "excluded runtime path: " + path);
      if (info.isDirectory()) {
        requireCondition(
          /^(bin|lib|share|notices)(\/|$)/.test(path),
          "unexpected directory: " + path,
        );
        requireCondition(
          !/(^|\/)(include|pgxs|_refs|node_modules)(\/|$)/i.test(path),
          "excluded directory: " + path,
        );
        requireCondition(
          !/^(?:bin|lib|share\/extension|share\/tsearch_data)\//.test(path),
          "unexpected runtime directory: " + path,
        );
        await visit(fullPath, path);
      } else if (info.isSymbolicLink()) {
        requireCondition(target !== "windows-x64", "Windows links have not been proven");
        const link = await readlink(fullPath);
        requireCondition(
          !link.startsWith("/") && !link.includes("\\") && !link.includes(":"),
          "unsafe link: " + path,
        );
        const normalized = posix.normalize(posix.join(posix.dirname(path), link));
        safePath(normalized);
        requireCondition(
          insideInstallation(root, await realpath(fullPath)),
          "link escapes installation: " + path,
        );
        requireCondition(
          (await lstat(join(root, normalized))).isFile(),
          "links must resolve directly to files: " + path,
        );
        entries.push({ path, kind: "symlink", target: link });
      } else {
        requireCondition(info.isFile() && info.nlink === 1, "special or hard-linked file: " + path);
        if (checkLinuxPermissions) {
          validateLinuxPermissions(info.mode, "file: " + path);
          // POSIX bin/ contains only core programs. Their owner needs execute access to run them.
          if (path.startsWith("bin/")) {
            requireCondition((info.mode & 0o100) !== 0, "nonexecutable program: " + path);
          }
        }
        entries.push({
          path,
          kind: "file",
          sha256: await fileSha256(fullPath),
          executable: target !== "windows-x64" && (info.mode & 0o111) !== 0,
        });
      }
    }
  }
  await visit(root, "");
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
}

function controlVersion(contents: string): string {
  const version = (/^\s*default_version\s*=\s*'([^']+)'/m.exec(contents))?.[1];
  requireCondition(
    version && /^[\d.]+$/.test(version),
    "missing or unsafe extension default version",
  );
  return version;
}

function hasInstallPath(sql: string[], name: string, version: string): boolean {
  const reachable = new Set<string>();
  const upgrades: Array<[string, string]> = [];
  for (const path of sql) {
    const parts = posix.basename(path, ".sql").slice(name.length + 2).split("--");
    if (parts.length === 1) reachable.add(parts[0]!);
    if (parts.length === 2) upgrades.push([parts[0]!, parts[1]!]);
  }
  // One pass per upgrade script is enough to follow the longest upgrade chain.
  for (const _ of upgrades) {
    for (const [from, to] of upgrades) if (reachable.has(from)) reachable.add(to);
  }
  return reachable.has(version);
}

async function extensionLayout(
  installation: string,
  target: ArtifactTarget,
  inputs: SourcePin[],
): Promise<Extension[]> {
  const paths = await readdir(join(installation, "share/extension"));
  const extensions: Extension[] = [];
  const installedExtensions: ReadonlyArray<readonly [string, string]> = [
    ["postgresql", "plpgsql"],
    ...bundledExtensions,
  ];
  for (const [sourceId, name] of installedExtensions) {
    const source = inputs.find(candidate => candidate.id === sourceId);
    requireCondition(source, "missing source: " + sourceId);
    const control = "share/extension/" + name + ".control";
    const version = controlVersion(await readFile(join(installation, control), "utf8"));
    const sql = paths.filter(path => path.startsWith(name + "--") && path.endsWith(".sql"))
      .map(path => "share/extension/" + path).sort();
    requireCondition(
      hasInstallPath(sql, name, version),
      "no SQL installation path to " + name + " " + version,
    );
    const libraries = extensionLibraries(sourceId, name, source.version, target);
    for (const path of libraries) {
      const info = await lstat(join(installation, path)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      });
      requireCondition(info?.isFile() === true, "missing library: " + path);
    }
    // PL/pgSQL is a required part of PostgreSQL. The manifest lists the extensions that the project selected.
    if (name !== "plpgsql") {
      extensions.push({ sourceId, name, version, control, sql, libraries });
    }
  }
  return extensions;
}

function sha256(message: string): z.ZodString {
  return z.string(message).regex(/^[a-f0-9]{64}$/, message);
}

/** Applies a path rule that the scan of an installation uses too, so that both judge a path alike. */
function pathChecked(check: (path: string) => void): z.ZodString {
  return z.string().check(context => {
    try {
      check(context.value);
    } catch (error) {
      context.issues.push({
        code: "custom",
        input: context.value,
        message: (error as Error).message.slice(errorPrefix.length),
      });
    }
  });
}

const contentEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    path: pathChecked(validatePayloadPath),
    kind: z.literal("file"),
    sha256: sha256("invalid file SHA-256"),
    executable: z.boolean("invalid executable flag"),
  }),
  z.object({ path: pathChecked(validatePayloadPath), kind: z.literal("symlink"), target: text }),
], "unsupported entry kind");

/** SQL installation versions can differ from source releases and can require an upgrade chain. */
const extensionSchema = z.object({
  sourceId: text,
  name: text,
  version: text,
  control: text,
  sql: z.array(text),
  libraries: z.array(text),
});
type Extension = z.infer<typeof extensionSchema>;

const sourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "unsafe source ID"),
  version: z.string().regex(/^\d+(?:\.\d+)+$/, "invalid source release version"),
  url: z.string().refine(
    value => URL.canParse(value) && new URL(value).protocol === "https:",
    "source URL must use HTTPS",
  ),
  sha256: sha256("invalid source SHA-256"),
  license: text,
  licenseFile: pathChecked(safePath),
  noticeFiles: z.array(pathChecked(safePath)).exactOptional(),
  /** Pinned project copies of license texts that the source needs but does not contain. */
  projectNotices: z.array(z.object({
    file: pathChecked(safePath),
    origin: text,
    covers: text,
    sha256: sha256("invalid project notice SHA-256"),
    // The source facts that the build checks before compiling (verifyNoticeAnchors); recorded, not rechecked here.
    anchors: z.array(z.record(z.string(), z.string())).exactOptional(),
  })).exactOptional(),
  notice: pathChecked(safePath),
  notices: z.array(text),
  /**
   * The notice signatures that the build's scan found in the source tree, each with example files. The
   * source's review component must list exactly these signatures, so new license text reopens it.
   */
  noticeSignatures: z.array(z.object({
    signature: text,
    files: z.array(text).max(maxNoticeExamples, "expected at most three example paths"),
  })).check(
    unique(entry => entry.signature, entry => "duplicate notice signature: " + entry.signature),
  ),
});
type SourcePin = Omit<z.infer<typeof sourceSchema>, "notice" | "notices" | "noticeSignatures">;

function sameSourceArchive(left: SourcePin, right: SourcePin): boolean {
  return left.id === right.id && left.version === right.version && left.sha256 === right.sha256;
}

/** Whether the archive records the source identity and required notices of the release checkout. */
export function matchesReleaseSource(
  built: ArtifactManifest["sources"][number],
  pin: SourcePin,
): boolean {
  // Compare known notice fields structurally so a later manifest can still carry additional metadata.
  const notices = sourceSchema.shape.projectNotices;
  return sameSourceArchive(built, pin)
    && isDeepStrictEqual(built.notices, sourceNotices(pin))
    && isDeepStrictEqual(notices.parse(built.projectNotices ?? []),
      notices.parse(pin.projectNotices ?? []));
}

const hostEvidenceSchema = z.object({ component: text, version: text, evidence: text });
/** An observed builder/consumer version is evidence, not an inferred supported minimum. */
export type HostEvidence = z.infer<typeof hostEvidenceSchema>;

/** A host library as a drafted review lists it: the fields that a reviewer fills in may still be empty. */
const draftedHostLibrarySchema = z.object({
  name: text,
  requirement: z.string(),
  license: z.string(),
  evidence: z.string(),
  /**
   * Set on a library that the build measured; a reviewer can add others, such as one that another loads.
   * The field accepts any value and `measuredFlag` checks it on the library, because only the library
   * knows the name that tells a reviewer which entry of a review file to correct.
   */
  measured: z.custom<boolean>().exactOptional(),
});
const measuredFlag = {
  holds: (library: { measured?: unknown }): boolean =>
    library.measured === undefined || typeof library.measured === "boolean",
  message: {
    error: (issue: { input?: unknown }): string =>
      "invalid measured flag: " + String((issue.input as { name: unknown }).name),
  },
};

/**
 * Refuses a second entry under one key. The release gate and the review merge both use the first entry
 * for a key, so a second one would be published, or dropped from a review, without being checked.
 */
function unique<T>(
  key: (entry: T) => string,
  message: (entry: T) => string,
): (payload: z.core.ParsePayload<T[]>) => void {
  return payload => {
    const keys = new Set<string>();
    for (const entry of payload.value) {
      if (keys.has(key(entry))) {
        payload.issues.push({ code: "custom", input: payload.value, message: message(entry) });
        return;
      }
      keys.add(key(entry));
    }
  };
}

/** Library names compare case-insensitively, as Windows resolves DLL names and as the release gate matches them. */
const uniqueLibraryNames = unique<{ name: string }>(
  library => library.name.toLowerCase(),
  library => "duplicate host library: " + library.name,
);

/** Host requirements in a review file may stay pending, with the fields of a draft still empty. */
export const reviewedHostRequirementsSchema = z.object({
  status: z.enum(["pending", "verified"], "invalid host prerequisite review status"),
  os: z.string(),
  cpu: z.string(),
  libraries: z.array(draftedHostLibrarySchema.refine(measuredFlag.holds, measuredFlag.message))
    .check(uniqueLibraryNames),
});

/**
 * Host libraries stay outside the archive and need their own resolved prerequisites and review evidence.
 * A manifest records only verified requirements, with every field filled in; unresolved ones are `null`.
 */
const hostRequirementsSchema = z.object({
  status: z.literal("verified", "host prerequisite review is unresolved"),
  os: text,
  cpu: text,
  libraries: z.array(
    draftedHostLibrarySchema.extend({ requirement: text, license: text, evidence: text })
      .refine(measuredFlag.holds, measuredFlag.message),
  ).check(uniqueLibraryNames),
});
export type HostRequirements = z.infer<typeof hostRequirementsSchema>;

/**
 * Every shipped file must be assigned to a reviewed component before release validation can pass.
 * A review stays valid across rebuilds and source updates while the license texts it read, identified
 * by `noticeSha256`, and the reviewed `toolchain` line of the toolchain component stay the same.
 */
export const licenseInventorySchema = z.object({
  status: z.enum(["pending", "verified"], "invalid license review status"),
  components: z.array(z.object({
    id: text,
    licenses: z.array(text),
    status: z.enum(["pending", "verified"], "invalid component review status"),
    files: z.array(text),
    notices: z.array(text),
    noticeSha256: z.record(z.string(), sha256("invalid reviewed notice SHA-256")),
    /** The notice signatures of the source's tree that the review covered; see the manifest's sources. */
    noticeSignatures: z.array(text).exactOptional(),
    toolchain: text.exactOptional(),
    evidence: z.array(text),
  })).check(
    unique(component => component.id, component => "duplicate license component: " + component.id),
  ),
});
export type LicenseInventory = z.infer<typeof licenseInventorySchema>;

/** Source components carry their scan results even when empty. Other components can omit this field. */
export function sourceReviewGap(
  inventory: LicenseInventory,
  sourceIds: ReadonlySet<string>,
): string | undefined {
  const missing = inventory.components.find(part =>
    part.noticeSignatures === undefined && sourceIds.has(part.id)
  );
  return missing === undefined
    ? undefined
    : "missing reviewed notice signatures for source: " + missing.id;
}

/**
 * The manifest's shape and the rules that its content alone decides; checks against an installation follow
 * in `inspectArtifact`. Plain objects let a manifest carry keys that this version does not know, and callers
 * keep the object they passed in, so such keys survive a rewrite of the manifest.
 */
const manifestSchema = z.object({
  format: z.literal("portable-postgres-native", "unsupported artifact format"),
  formatVersion: z.literal(1, "unsupported artifact format"),
  packagingRevision: z.int("invalid packaging revision").min(1, "invalid packaging revision"),
  target: z.enum(artifactTargets, "unsupported target"),
  postgresqlVersion: z.string().regex(/^18\.\d+$/, "PostgreSQL 18 is required"),
  executables: z.record(z.enum(executableNames), text),
  extensions: z.array(extensionSchema),
  sources: z.array(sourceSchema).check(unique(source => source.id, () => "duplicate source ID")),
  hostEvidence: z.array(hostEvidenceSchema),
  hostRequirements: hostRequirementsSchema.nullable(),
  buildProfile: z.object({
    timescaledb: z.literal("apache-only", "excluded build profile"),
    telemetry: z.literal(false, "excluded build profile"),
    pgPartman: z.literal("sql-only", "excluded build profile"),
    pgTap: z.literal("sql-only", "excluded build profile"),
  }),
  licenseInventory: licenseInventorySchema,
  files: z.array(contentEntrySchema),
});
/** Format version and packaging revision belong to the native product, independently of any wrapper version. */
export type ArtifactManifest = z.infer<typeof manifestSchema>;
type ContentEntry = ArtifactManifest["files"][number];

/** Describes the first problem that a schema found, with the place of the value that it rejected. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]!;
  const place = issue.path.map(key => typeof key === "number" ? `[${key}]` : "." + String(key))
    .join("").replace(/^\./, "");
  return issue.message + (place === "" ? "" : " (at " + place + ")");
}

function validateShape(value: unknown): asserts value is ArtifactManifest {
  const result = manifestSchema.safeParse(value);
  requireCondition(result.success, result.success ? "" : firstIssue(result.error));
  const { extensions } = result.data;
  const ids = new Set(result.data.sources.map(source => source.id));
  const gap = sourceReviewGap(result.data.licenseInventory, ids);
  if (gap !== undefined) throw new Error(errorPrefix + gap);
  // PostgreSQL links ICU, OpenSSL, zlib and LZ4 in every build, and pgcrypto calls OpenSSL and zlib.
  // A manifest cannot opt out of their runtime and license checks by leaving out a pin.
  for (const id of ["postgresql", "icu", "openssl", "zlib", "lz4"]) {
    requireCondition(ids.has(id), "missing source: " + id);
  }
  requireCondition(extensions.length === bundledExtensions.length,
    "expected all " + bundledExtensions.length + " extensions");
  for (const [index, [id, name]] of bundledExtensions.entries()) {
    requireCondition(ids.has(id), "missing source: " + id);
    const entry = extensions[index]!;
    requireCondition(entry.sourceId === id && entry.name === name,
      "extension layout/version mismatch: " + name);
  }
}

/** Parses manifest text into the object as written; whoever reads a manifest from outside must use this. */
export function parseArtifactManifest(json: string): ArtifactManifest {
  const manifest: unknown = JSON.parse(json);
  validateShape(manifest);
  return manifest;
}

/** The SHA-256 of each regular payload file; reviews compare license notices by these hashes. */
export function payloadHashes(manifest: Pick<ArtifactManifest, "files">): Map<string, string> {
  return new Map(
    manifest.files.flatMap(file => file.kind === "file" ? [[file.path, file.sha256]] : []),
  );
}

function validateLicenses(manifest: ArtifactManifest, images: string[]): void {
  requireCondition(
    manifest.licenseInventory.status === "verified",
    "release license inventory is unresolved",
  );
  requireCondition(manifest.hostRequirements !== null, "minimum host requirements are unresolved");
  const toolchainParts = toolchainComponents[manifest.target];
  const covered = new Set<string>();
  const inventory = new Set(manifest.files.map(file => file.path));
  const hashes = payloadHashes(manifest);
  const components = new Map<string, LicenseInventory["components"][number]>();
  // The manifest schema has refused a second component under one ID.
  for (const component of manifest.licenseInventory.components) {
    components.set(component.id, component);
    requireCondition(
      component.status === "verified" && component.licenses.length > 0
        && component.evidence.length > 0,
      "unresolved license component: " + component.id,
    );
    const toolchain = toolchainParts.find(part => part.id === component.id);
    for (const license of component.licenses) {
      requireCondition(
        !/(^|[^A-Z])A?GPL(?:[-\s.(]|$)/i.test(license),
        "forbidden GPL/AGPL license: " + license,
      );
      requireCondition(
        permittedLicenses.has(license)
          || toolchain?.licenses.includes(license)
          || sourceComponentLicenses.get(component.id)?.includes(license) === true,
        "unresolved or unapproved license: " + license,
      );
    }
    for (const notice of component.notices) {
      // Only a regular payload file has bytes that the review can bind to a digest.
      const digest = hashes.get(notice);
      requireCondition(digest !== undefined, "missing regular license notice: " + notice);
      // A source update keeps its review only while the license texts that the review read are unchanged.
      requireCondition(
        component.noticeSha256[notice] === digest,
        "license notice changed since review: " + component.id + ": " + notice,
      );
    }
    for (const file of component.files) {
      requireCondition(inventory.has(file), "invalid license coverage: " + file);
      covered.add(file);
    }
  }
  // A source component covering an image says nothing about the runtime code linked into it. Checked before
  // global coverage, so that a missing toolchain review is reported rather than its uncovered notice.
  const nativeImages = new Set(images);
  function requireReviewedToolchain(id: string, evidence: string): void {
    const line = manifest.hostEvidence.find(entry => entry.component === evidence);
    requireCondition(line, "missing toolchain evidence: " + evidence);
    const reviewed = components.get(id)?.toolchain;
    requireCondition(reviewed === line.version,
      `toolchain changed since review: ${id} was reviewed for ${
        reviewed ?? "no toolchain"
      }, built with ${line.version}`);
  }
  if (manifest.target === "macos-arm64") {
    requireReviewedToolchain("postgresql", macOSParserEvidence);
  }
  if (manifest.target === "windows-x64") {
    for (const source of manifest.sources) {
      if (!sqlOnlyExtensions.has(source.id)) {
        requireReviewedToolchain(source.id, mingwSourcePrefix + source.id);
      }
    }
  }
  for (const part of toolchainParts) {
    const toolchain = components.get(part.id);
    requireCondition(toolchain, "unreviewed toolchain component: " + part.id);
    requireReviewedToolchain(part.id, part.evidence);
    for (const license of part.licenses) {
      requireCondition(toolchain.licenses.includes(license),
        "toolchain component " + part.id + " must carry " + license);
    }
    // Its license describes only the linked code and the project's notice for it.
    for (const file of toolchain.files) {
      requireCondition(
        nativeImages.has(file) || file === part.notice,
        "toolchain component " + part.id + " covers a file that is not a native image: " + file,
      );
    }
    if (part.notice !== undefined) {
      requireCondition(
        toolchain.files.includes(part.notice) && toolchain.notices.includes(part.notice),
        "missing toolchain notice for " + part.id + ": " + part.notice,
      );
    }
    for (const image of toolchainImages(part.id, images, manifest.target)) {
      requireCondition(
        toolchain.files.includes(image),
        "missing toolchain coverage for " + part.id + ": " + image,
      );
    }
  }
  for (const file of inventory) {
    requireCondition(covered.has(file), "unreviewed payload file: " + file);
  }
  // Global coverage also counts toolchain components, components added by hand, and other sources, none
  // of which built the image; the source that built it must still be credited with it. Extensions build
  // the libraries in their layout, which are checked with their other files below, and PostgreSQL's own
  // build makes every other image except the separately built runtime libraries.
  const extensionImages = new Set(manifest.extensions.flatMap(extension => extension.libraries));
  const postgresql = new Set(components.get("postgresql")?.files);
  for (const image of images) {
    const owner = librarySource(image, manifest.target) ?? "postgresql";
    requireCondition(
      extensionImages.has(image) || (owner === "postgresql"
        ? postgresql.has(image)
        : components.get(owner)?.files.includes(image)),
      "missing license coverage for " + owner + ": " + image,
    );
  }
  for (const source of manifest.sources) {
    const component = components.get(source.id);
    requireCondition(component, "unreviewed source component: " + source.id);
    requireCondition(
      permittedLicenses.has(source.license),
      "unresolved or forbidden source license: " + source.license,
    );
    for (const notice of source.notices) {
      requireCondition(
        component.notices.includes(notice),
        "missing license notice for " + source.id + ": " + notice,
      );
    }
    // A permitted license in its place would pass every other rule and misdescribe the reviewed code.
    for (const license of sourceComponentLicenses.get(source.id) ?? []) {
      requireCondition(
        component.licenses.includes(license),
        "source component " + source.id + " must carry " + license,
      );
    }
    const scanned = source.noticeSignatures.map(entry => entry.signature).sort(compareOrdinal);
    requireCondition(
      isDeepStrictEqual(component.noticeSignatures?.toSorted(compareOrdinal), scanned),
      "reviewed notice signatures differ from the source tree: " + source.id,
    );
  }
  for (const extension of manifest.extensions) {
    // Global coverage can hide a missing contribution when another component lists the same file.
    const files = new Set(components.get(extension.sourceId)!.files);
    for (const path of [extension.control, ...extension.sql, ...extension.libraries]) {
      requireCondition(
        files.has(path),
        "missing license coverage for " + extension.sourceId + ": " + path,
      );
    }
  }
  for (const library of manifest.hostRequirements.libraries) {
    requireCondition(
      !/(^|[^A-Z])A?GPL(?:[-\s.(]|$)/i.test(library.license),
      "forbidden linked host license",
    );
    requireCondition(
      permittedHostLicenses.has(library.license),
      "unresolved host library license: " + library.license,
    );
  }
  // The published requirements must still describe this build, not the one the review was written for.
  // Drafts fall back to the required libraries alone, but a release must compare against a measurement.
  const required = [
    hostMeasurementEvidence[manifest.target],
    ...manifest.target === "macos-arm64" ? [macOSMinimumEvidence] : [],
  ];
  for (const measurement of required) {
    requireCondition(
      manifest.hostEvidence.some(entry => entry.component === measurement),
      "missing host measurement: " + measurement,
    );
  }
  const measurements = measuredHostRequirements(manifest);
  for (const measured of measurements) {
    // macOS install names are mixed case, such as /usr/lib/libSystem.B.dylib.
    const library = manifest.hostRequirements.libraries.find(candidate =>
      candidate.name.toLowerCase() === measured.name.toLowerCase()
    );
    requireCondition(library, "unresolved host library prerequisite: " + measured.name);
    requireCondition(
      measured.requirement === "" || library.requirement === measured.requirement,
      "host requirement changed since review: " + measured.name + " requires "
        + measured.requirement,
    );
  }
  // A manual entry can describe an indirect import. Only a measured entry expires with its import.
  for (const library of manifest.hostRequirements.libraries) {
    if (library.measured === true) {
      requireCondition(
        measurements.some(entry => entry.name.toLowerCase() === library.name.toLowerCase()),
        "obsolete measured host library: " + library.name,
      );
    }
  }
}

/**
 * Host libraries that a review must name for this build: the required ones and every library the
 * packaged files import, with the requirement in the form a review states it when the build measured one.
 */
export function measuredHostRequirements(
  manifest: Pick<ArtifactManifest, "target" | "hostEvidence">,
): Array<{ name: string; requirement: string }> {
  const measurement = manifest.hostEvidence.find(entry =>
    entry.component === hostMeasurementEvidence[manifest.target]
  );
  const observed = isLinuxTarget(manifest.target)
    ? []
    : measurement?.version.split(", ") ?? [];
  const libc = isLinuxTarget(manifest.target) ? linuxTargets[manifest.target].libc : undefined;
  const macOS = manifest.target === "macos-arm64"
    ? manifest.hostEvidence.find(entry => entry.component === macOSMinimumEvidence)
    : undefined;
  const requirement = (name: string): string =>
    name === libc && measurement
      ? measurement.version + (libc === "musl" ? " (tested baseline)" : " or newer")
      : name === "/usr/lib/libSystem.B.dylib" && macOS
        ? "macOS " + macOS.version + " or newer"
        : "";
  const required = requiredHostLibraries[manifest.target];
  return [...new Set([...required, ...observed])].map(name => ({
    name,
    requirement: requirement(name),
  }));
}

/** Writes metadata to a newly assembled candidate; source license declarations do not approve its payload. */
export async function writeArtifactManifest(
  installation: string,
  options: ArtifactOptions,
): Promise<ArtifactManifest> {
  return writeDescribedManifest(installation, await describeArtifact(installation, options));
}

/**
 * Describes a newly assembled candidate as its manifest would, without writing anything. Only the
 * validation in `writeDescribedManifest` checks the candidate, so the description may be of a candidate
 * that this validation then refuses.
 */
export async function describeArtifact(
  installation: string,
  options: ArtifactOptions,
): Promise<ArtifactManifest> {
  requireValidationHost(options.target);
  const rootInfo = await lstat(installation);
  requireCondition(
    rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
    "installation root must be a real directory",
  );
  const suffix = options.target === "windows-x64" ? ".exe" : "";
  const sourceInputs = sources.map(({ upstream: _upstream, ...source }) => {
    const noticeSignatures = options.noticeSignatures[source.id];
    requireCondition(noticeSignatures !== undefined,
      "missing notice scan for source: " + source.id);
    return {
      ...source,
      notice: "notices/" + source.id + ".txt",
      notices: sourceNotices(source),
      noticeSignatures,
    };
  });
  const manifest: ArtifactManifest = {
    format: "portable-postgres-native",
    formatVersion: 1,
    packagingRevision: options.packagingRevision,
    target: options.target,
    postgresqlVersion: sources.find(source => source.id === "postgresql")!.version,
    executables: Object.fromEntries(
      executableNames.map(name => [name, "bin/" + name + suffix]),
    ) as ArtifactManifest["executables"],
    extensions: await extensionLayout(installation, options.target, sources),
    sources: sourceInputs,
    hostEvidence: options.hostEvidence,
    hostRequirements: options.hostRequirements ?? null,
    buildProfile: {
      timescaledb: "apache-only",
      telemetry: false,
      pgPartman: "sql-only",
      pgTap: "sql-only",
    },
    licenseInventory: options.licenseInventory ?? { status: "pending", components: [] },
    files: await scan(installation, options.target),
  };
  validateShape(manifest);
  return manifest;
}

/** Writes the manifest that `describeArtifact` returned, possibly with a review added, and validates it. */
export async function writeDescribedManifest(
  installation: string,
  manifest: ArtifactManifest,
): Promise<ArtifactManifest> {
  validateShape(manifest);
  await writeFile(
    join(installation, artifactManifestName),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o644 },
  );
  // The creation mode is masked by the builder's umask; assembly sets every other file's mode the same way.
  if (process.platform !== "win32") await chmod(join(installation, artifactManifestName), 0o644);
  // Only the validator checks image machine types, permissions and the extension layout; an archive
  // must never be packed from a candidate that fails them. The repeated hashing costs about a second.
  await validateArtifact(installation, manifest.target, { mode: "candidate" });
  return manifest;
}

/** Checks an extracted installation. Release mode is the default and refuses incomplete license/host evidence. */
export async function validateArtifact(
  installation: string,
  expectedTarget: ArtifactTarget,
  options: { mode?: "candidate" | "release" } = {},
): Promise<ArtifactManifest> {
  const mode: string = options.mode ?? "release";
  requireCondition(mode === "candidate" || mode === "release", "invalid validation mode");
  const { manifest, images } = await inspectArtifact(installation, expectedTarget);
  if (mode === "release") validateLicenses(manifest, images);
  return manifest;
}

/**
 * Returns why release validation would reject this candidate with the given review, or `undefined` when
 * it would pass. A review tool uses it so that it never reports coverage that the release then refuses.
 */
export async function releaseLicenseGap(
  installation: string,
  target: ArtifactTarget,
  review: Pick<ArtifactManifest, "licenseInventory" | "hostRequirements">,
): Promise<string | undefined> {
  const { manifest, images } = await inspectArtifact(installation, target);
  try {
    const reviewed = { ...manifest, ...review };
    validateShape(reviewed);
    validateLicenses(reviewed, images);
    return undefined;
  } catch (error) {
    return (error as Error).message.replace(errorPrefix, "");
  }
}

/** Runs every candidate check and returns the manifest with the native images it found by their bytes. */
async function inspectArtifact(
  installation: string,
  expectedTarget: ArtifactTarget,
): Promise<{ manifest: ArtifactManifest; images: string[] }> {
  const rootInfo = await lstat(installation);
  requireCondition(
    rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
    "installation root must be a real directory",
  );
  const metadata = await lstat(join(installation, artifactManifestName));
  requireCondition(
    metadata.isFile() && !metadata.isSymbolicLink(),
    "metadata must be a regular file",
  );
  // Like any payload file, a second name outside the installation could change it after validation.
  requireCondition(metadata.nlink === 1, "hard-linked file: " + artifactManifestName);
  const manifest = parseArtifactManifest(
    await readFile(join(installation, artifactManifestName), "utf8"),
  );
  requireCondition(manifest.target === expectedTarget, "wrong target: expected " + expectedTarget);
  requireValidationHost(expectedTarget);
  if (expectedTarget !== "windows-x64") {
    validateLinuxPermissions(metadata.mode, "metadata");
    // Consumers other than the extracting account must be able to discover the programs.
    requireCondition((metadata.mode & 0o444) === 0o444, "unreadable metadata");
  }
  const postgres = manifest.sources.find(source => source.id === "postgresql")!;
  requireCondition(
    postgres.version === manifest.postgresqlVersion,
    "PostgreSQL source/version mismatch",
  );
  const suffix = expectedTarget === "windows-x64" ? ".exe" : "";
  for (const name of executableNames) {
    requireCondition(
      manifest.executables[name] === "bin/" + name + suffix,
      "nonportable executable path: " + name,
    );
  }
  const current = await scan(installation, expectedTarget);
  requireCondition(
    current.length === manifest.files.length && current.every((file, index) => {
      const expected = manifest.files[index]!;
      return file.path === expected.path && (file.kind === "file"
        ? expected.kind === "file" && file.sha256 === expected.sha256
          && file.executable === expected.executable
        : expected.kind === "symlink" && file.target === expected.target);
    }),
    "payload inventory/hash/permission mismatch",
  );
  const entries = new Map(current.map(file => [file.path, file]));
  requireCondition(entries.get(unaccentRules)?.kind === "file",
    "missing unaccent dictionary: " + unaccentRules);
  const icu = manifest.sources.find(source => source.id === "icu")!;
  for (const path of opensslLibraries(expectedTarget)) {
    requireCondition(entries.get(path)?.kind === "file",
      "missing OpenSSL runtime library: " + path);
  }
  for (const path of Object.values(compressionLibraries(expectedTarget))) {
    requireCondition(entries.get(path)?.kind === "file", "missing runtime library: " + path);
  }
  for (const path of requiredIcuLibraries(expectedTarget, icu.version)) {
    requireCondition(entries.has(path), "missing ICU runtime library: " + path);
  }
  const images: string[] = [];
  for (const file of current) {
    const path = join(installation, file.path);
    // Native names must be images of the target; any other image is found by its bytes, wherever it lies.
    if (
      /\.(exe|dll|dylib|so(?:\.\d+)*)$/i.test(file.path)
      || Object.values(manifest.executables).includes(file.path)
      || (file.path.startsWith("bin/") && file.kind === "file" && file.executable)
      || (file.kind === "file" && await isNativeImage(path))
    ) {
      validateMachine(await readFile(path), expectedTarget, file.path);
      // A library name alone cannot exempt executable code from the linked-runtime license review.
      if (isIcuDataLibrary(file.path, expectedTarget)
        && expectedTarget !== "macos-arm64")
      {
        const data = await readFile(path);
        requireCondition(expectedTarget === "windows-x64" ? dataOnlyPe(data) : dataOnlyElf(data),
          "ICU data library contains executable code: " + file.path);
      }
      // A symlink is checked through its target, but only the target is an image that needs coverage.
      if (file.kind === "file") images.push(file.path);
    }
  }
  for (const name of corePrograms) {
    const path = "bin/" + name + suffix;
    const file = entries.get(path);
    requireCondition(
      file?.kind === "file" && (expectedTarget === "windows-x64" || file.executable),
      "nonexecutable program: " + path,
    );
  }
  for (const source of manifest.sources) {
    const pinned: SourcePin | undefined = sources.find(candidate =>
      sameSourceArchive(candidate, source)
    );
    // The upstream pin requires the declaration. The artifact's packaging revision supplies its digest.
    for (const notice of pinned?.projectNotices ?? []) {
      requireCondition(
        source.projectNotices?.some(recorded => recorded.file === notice.file),
        "missing project notice pin: notices/" + additionalNoticeName(source.id, notice.file),
      );
    }
    requireCondition(
      source.notice === "notices/" + source.id + ".txt"
        && isDeepStrictEqual(source.notices, sourceNotices(source, pinned?.noticeFiles)),
      "incorrect source notices: " + source.id,
    );
    for (const notice of source.notices) {
      requireCondition(entries.get(notice)?.kind === "file", "missing source notice: " + notice);
    }
    // The manifest pins each project notice's bytes; the review only binds whatever bytes it read.
    for (const notice of source.projectNotices ?? []) {
      const path = "notices/" + additionalNoticeName(source.id, notice.file);
      const entry = entries.get(path);
      requireCondition(
        entry?.kind === "file" && entry.sha256 === notice.sha256,
        "project notice differs from its pin: " + path,
      );
    }
  }
  if (expectedTarget === "windows-x64") {
    for (const dll of mingwRuntimeDlls) {
      requireCondition(entries.get(dll)?.kind === "file", "missing MinGW runtime DLL: " + dll);
    }
  }
  for (const notice of toolchainNotices(expectedTarget)) {
    requireCondition(entries.get(notice)?.kind === "file", "missing toolchain notice: " + notice);
  }
  // These checks cover the layout, not whether the runtime starts. A missing bootstrap file such as
  // share/postgres.bki surfaces when CI runs initdb on every archive, which it does before uploading it.
  const libpq = clientLibraryPath(expectedTarget);
  requireCondition(entries.has(libpq), "missing PostgreSQL client library: " + libpq);
  for (const module of requiredModules) {
    const path = "lib/" + module + moduleSuffix(expectedTarget);
    requireCondition(entries.get(path)?.kind === "file", "missing library: " + path);
  }
  const layout = await extensionLayout(installation, expectedTarget, manifest.sources);
  for (const [index, extension] of layout.entries()) {
    const expected = manifest.extensions[index]!;
    requireCondition(
      extension.sourceId === expected.sourceId && extension.name === expected.name
        && extension.version === expected.version && extension.control === expected.control
        && JSON.stringify(extension.sql) === JSON.stringify(expected.sql)
        && JSON.stringify(extension.libraries) === JSON.stringify(expected.libraries),
      "extension layout/version mismatch",
    );
  }
  return { manifest, images };
}

/** Verifies the entire archive against a digest obtained independently through a trusted descriptor. */
export async function verifyArtifactArchive(
  archive: string,
  expectedSha256: string,
): Promise<void> {
  requireCondition(/^[a-f0-9]{64}$/.test(expectedSha256), "invalid trusted archive SHA-256");
  requireCondition(await fileSha256(archive) === expectedSha256, "archive integrity mismatch");
}
