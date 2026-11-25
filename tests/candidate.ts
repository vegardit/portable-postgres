/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Writes minimal candidate installations whose layout passes candidate validation; the files are not real programs. */
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ArtifactManifest,
  type ArtifactOptions,
  type ArtifactTarget,
  type HostEvidence,
  type LicenseInventory,
  sourceComponentLicenses,
  toolchainImages,
  writeArtifactManifest,
} from "../binaries/artifact/artifact.ts";
import {
  noticeSignatureExamples,
  type SourceNoticeScan,
  sourceNoticesFile,
} from "../binaries/artifact/notice-scan.ts";
import { additionalNoticeName, projectNoticeRoot } from "../binaries/artifact/notices.ts";
import { type Review, writeReviewedManifest } from "../binaries/artifact/review.ts";
import {
  clientLibraryPath,
  contribExtensions,
  corePrograms,
  moduleSuffix,
  requiredModules,
  requiredIcuLibraries,
  librarySource,
  compressionLibraries,
  opensslLibraries,
  isIcuDataLibrary,
  sqlOnlyExtensions,
  mingwRuntimeDlls,
} from "../binaries/artifact/runtime-layout.ts";
import { sources } from "../binaries/sources/sources.ts";

/** The notice scan of the fixture sources: one signature each, in its licence file. */
export function fixtureNoticeScan(): SourceNoticeScan {
  return Object.fromEntries(sources.map(source => [
    source.id,
    { [`Copyright (c) YYYY ${source.id} fixture authors`]: [source.licenseFile] },
  ]));
}

/** Stores the fixture scan in a build's work directory, where a fresh build stores its scan. */
export async function writeFixtureNoticeScan(buildWork: string): Promise<void> {
  await mkdir(buildWork, { recursive: true });
  await writeFile(join(buildWork, sourceNoticesFile), JSON.stringify(fixtureNoticeScan()));
}

export function peFixture(): Buffer {
  // A header fixture tests format/architecture discovery; only native integration proves executable behavior.
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.set([80, 69, 0, 0], 64);
  bytes.writeUInt16LE(0x86_64, 68);
  return bytes;
}

/** Fills an empty directory with the extracted sources' licence and notice files, as a build leaves them. */
export async function sourceTree(sourceRoot: string): Promise<string> {
  for (const source of sources) {
    for (const file of [source.licenseFile, ...source.noticeFiles ?? []]) {
      await mkdir(dirname(join(sourceRoot, source.id, file)), { recursive: true });
      await writeFile(join(sourceRoot, source.id, file), "fixture");
    }
  }
  return sourceRoot;
}

export function elfFixture(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.set([127, 69, 76, 70, 2, 1]);
  bytes.writeUInt16LE(62, 18);
  return bytes;
}

/** An LC_CODE_SIGNATURE command pointing to the fixture's opaque signature data. */
export function machOSignatureCommand(dataOffset: number, dataSize: number): Buffer {
  const command = Buffer.alloc(16);
  command.writeUInt32LE(0x1D, 0);
  command.writeUInt32LE(command.length, 4);
  command.writeUInt32LE(dataOffset, 8);
  command.writeUInt32LE(dataSize, 12);
  return command;
}

/** A 64-bit Mach-O header with the platform, deployment version, and signature that validation reads. */
export function machOFixture(
  options: {
    cpuType?: number;
    cpuSubtype?: number;
    fileType?: number;
    platform?: number;
    signed?: boolean;
    minimumOS?: number;
    signatureOffset?: number;
    signatureSize?: number;
  } = {},
): Buffer {
  const signed = options.signed ?? true;
  const bytes = Buffer.alloc(128);
  bytes.writeUInt32LE(0xFE_ED_FA_CF, 0);
  bytes.writeUInt32LE(options.cpuType ?? 0x01_00_00_0C, 4);
  bytes.writeUInt32LE(options.cpuSubtype ?? 0, 8);
  bytes.writeUInt32LE(options.fileType ?? 2, 12); // MH_EXECUTE by default.
  bytes.writeUInt32LE(signed ? 2 : 1, 16);
  bytes.writeUInt32LE(signed ? 40 : 24, 20);
  // LC_BUILD_VERSION: platform, minimum OS 15.0 (xxxx.yy.zz), SDK 15.5, no tool entries.
  bytes.writeUInt32LE(0x32, 32);
  bytes.writeUInt32LE(24, 36);
  bytes.writeUInt32LE(options.platform ?? 1, 40);
  bytes.writeUInt32LE(options.minimumOS ?? 0x00_0F_00_00, 44);
  bytes.writeUInt32LE(0x00_0F_05_00, 48);
  if (signed) {
    machOSignatureCommand(options.signatureOffset ?? 72, options.signatureSize ?? 16)
      .copy(bytes, 56);
  }
  return bytes;
}

function fixtureImages(
  target: ArtifactTarget,
): { executable: Buffer; client: Buffer; module: Buffer; data: Buffer } {
  if (target === "macos-arm64") {
    return {
      executable: machOFixture(),
      client: machOFixture({ fileType: 6 }), // MH_DYLIB
      module: machOFixture({ fileType: 8 }), // MH_BUNDLE
      data: machOFixture({ fileType: 6 }),
    };
  }
  const image = target === "windows-x64" ? peFixture() : elfFixture();
  const data = Buffer.alloc(target === "windows-x64" ? 512 : 120);
  image.copy(data);
  if (target === "windows-x64") {
    data.writeUInt16LE(1, 70);
    data.writeUInt16LE(240, 84);
    data.writeUInt32LE(0x40_00_00_40, 364);
  } else {
    data.writeBigUInt64LE(64n, 32);
    data.writeUInt16LE(56, 54);
    data.writeUInt16LE(1, 56);
    data.writeUInt32LE(1, 64);
    data.writeUInt32LE(4, 68);
  }
  return { executable: image, client: image, module: image, data };
}

/**
 * The toolchain components every native image needs, the host evidence each review is bound to, and the
 * project's notice that a component ships. Stated literally so that a renamed entry in the build fails
 * the contract tests instead of matching.
 */
export const toolchainParts: Record<
  ArtifactTarget,
  Array<{ id: string; evidence: string; notice?: string }>
> = {
  "windows-x64": [{
    id: "mingw-runtime",
    evidence: "CLANG64 packages and linked objects",
    notice: "notices/mingw-runtime.txt",
  }],
  "linux-x64-glibc": [
    { id: "compiler-rt", evidence: "Clang major version" },
    { id: "glibc-startup", evidence: "glibc" },
    {
      id: "llvm-cxx-runtime",
      evidence: "Clang major version",
      notice: "notices/llvm-cxx-runtime.txt",
    },
  ],
  "macos-arm64": [],
};

/** The licence sets used by verified toolchain fixtures. */
export const toolchainLicenses: Record<string, string[]> = {
  "compiler-rt": ["Apache-2.0 WITH LLVM-exception"],
  "glibc-startup": ["LGPL-2.1-or-later WITH GCC-exception-2.0"],
  "mingw-runtime": [
    "Apache-2.0 WITH LLVM-exception",
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
  "llvm-cxx-runtime": ["Apache-2.0 WITH LLVM-exception"],
};

/** The toolchain identities recorded by the fixture builds. */
const fixtureLines: Record<string, string> = {
  "compiler-rt": "fixture-1",
  "glibc-startup": "fixture-1",
  "mingw-runtime": "fixture-1",
  "llvm-cxx-runtime": "fixture-1",
};

/**
 * What each build measures about its host needs, with the result that the fixture reviews accept. Stated
 * literally for the same reason as the toolchain evidence.
 */
export const hostMeasurements: Record<ArtifactTarget, HostEvidence> = {
  "windows-x64": {
    component: "PE host library imports",
    version: "ucrtbase.dll",
    evidence: "Contract test",
  },
  "linux-x64-glibc": {
    component: "ELF glibc symbol requirements",
    version: "GLIBC_2.35",
    evidence: "Contract test",
  },
  "macos-arm64": {
    component: "Mach-O host library imports",
    version: "/usr/lib/libSystem.B.dylib",
    evidence: "Contract test",
  },
};

/** The minimum macOS that a macOS build measures besides its imports. */
export const macOSMinimum: HostEvidence = {
  component: "Mach-O minimum macOS version",
  version: "15.0",
  evidence: "Contract test",
};

export const parserGenerators: HostEvidence = {
  component: "PostgreSQL parser generators",
  version: "Xcode 16.4 (16F6), bison (GNU Bison) 2.3, flex 2.6.4",
  evidence: "Contract test",
};

export function fixtureEvidence(target: ArtifactTarget): HostEvidence[] {
  return [
    { component: "fixture", version: "1", evidence: "Contract test, not a supported host" },
    ...toolchainParts[target].map(part => ({
      component: part.evidence,
      version: fixtureLines[part.id]!,
      evidence: "Contract test",
    })),
    ...target === "windows-x64"
      ? sources.filter(source => !sqlOnlyExtensions.has(source.id)).map(source => ({
        component: "CLANG64 packages and linked objects: " + source.id,
        version: source.id + "-1",
        evidence: "Contract test",
      }))
      : [],
    hostMeasurements[target],
    ...target === "macos-arm64" ? [macOSMinimum, parserGenerators] : [],
  ];
}

/** Host evidence whose measurement reports another result, as a rebuild of changed sources would. */
export function remeasured(
  evidence: readonly HostEvidence[],
  target: ArtifactTarget,
  version: string,
): HostEvidence[] {
  const { component } = hostMeasurements[target];
  return evidence.map(entry => entry.component === component ? { ...entry, version } : entry);
}

/** Fills an empty directory with a candidate for the target and writes its manifest. */
export async function createCandidate(
  root: string,
  target: ArtifactTarget = "windows-x64",
  options:
    & Partial<
      Pick<
        ArtifactOptions,
        | "hostEvidence"
        | "hostRequirements"
        | "licenseInventory"
        | "noticeSignatures"
        | "packagingRevision"
      >
    >
    & {
      /** Replaces or adds text or binary payload files before the manifest is written. */
      files?: Record<string, string | Buffer>;
      /** Adds symbolic links, path to link text, before the manifest is written. */
      links?: Record<string, string>;
      /** Deletes payload files, such as a source notice, before the manifest is written. */
      remove?: readonly string[];
      /** Writes the manifest from a tracked review as packaging does, reconciled with this candidate. */
      trackedReview?: Review;
    } = {},
): Promise<ArtifactManifest> {
  const { files, links, remove, trackedReview, ...artifactOptions } = options;
  const payloadDirectories = ["bin", "lib", "share/extension", "share/tsearch_data", "notices"];
  for (const directory of payloadDirectories) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const images = fixtureImages(target);
  const executableSuffix = target === "windows-x64" ? ".exe" : "";
  const librarySuffix = moduleSuffix(target);
  for (const name of corePrograms) {
    const executable = join(root, "bin", name + executableSuffix);
    await writeFile(executable, images.executable);
    if (target !== "windows-x64") await chmod(executable, 0o755);
  }
  await writeFile(join(root, clientLibraryPath(target)), images.client);
  for (const module of requiredModules) {
    await writeFile(join(root, "lib", module + librarySuffix), images.module);
  }
  await writeFile(join(root, "share/extension/plpgsql.control"), "default_version = '1.0'\n");
  await writeFile(join(root, "share/extension/plpgsql--1.0.sql"), "fixture");
  await writeFile(join(root, "share/tsearch_data/unaccent.rules"), "fixture");
  // PostgreSQL's own build installs the selected contrib modules, each with a library.
  for (const name of contribExtensions) {
    await writeFile(
      join(root, "share/extension", name + ".control"),
      "default_version = '1.1'\n",
    );
    await writeFile(join(root, "share/extension", name + "--1.0.sql"), "fixture");
    await writeFile(join(root, "share/extension", name + "--1.0--1.1.sql"), "fixture");
    await writeFile(join(root, "lib", name + librarySuffix), images.module);
  }
  for (const source of sources) {
    await writeFile(join(root, "notices", source.id + ".txt"), "test-only license evidence");
    const additional = new Set(source.noticeFiles);
    if (source.id === "timescaledb" || source.id === "pg_textsearch") additional.add("NOTICE");
    for (const notice of additional) {
      await writeFile(
        join(root, "notices", additionalNoticeName(source.id, notice)),
        "test-only notice",
      );
    }
    // Candidate validation compares project notices with their pinned bytes, so these are the real texts.
    for (const notice of "projectNotices" in source ? source.projectNotices : []) {
      await writeFile(
        join(root, "notices", additionalNoticeName(source.id, notice.file)),
        await readFile(join(projectNoticeRoot, source.id, notice.file)),
      );
    }
    if (source.id === "icu") {
      for (const path of requiredIcuLibraries(target, source.version))
        await writeFile(join(root, path),
          isIcuDataLibrary(path, target) ? images.data : images.client);
      continue;
    }
    if (source.id === "zlib" || source.id === "lz4") {
      await writeFile(join(root, compressionLibraries(target)[source.id]), images.client);
      continue;
    }
    if (source.id === "postgresql") continue;
    if (source.id === "openssl") {
      for (const path of opensslLibraries(target)) await writeFile(join(root, path), images.client);
      continue;
    }
    const name = source.id === "pgvector" ? "vector" : source.id;
    // pg_cron and plpgsql_check expose SQL versions independently from their source release.
    const version = source.id === "pg_cron"
      ? "1.6"
      : source.id === "plpgsql_check"
        ? "2.10"
        : source.version;
    await writeFile(
      join(root, "share/extension", name + ".control"),
      "default_version = '" + version + "'\n",
    );
    if (name === "pg_cron") {
      await writeFile(join(root, "share/extension/pg_cron--1.0.sql"), "fixture");
      await writeFile(join(root, "share/extension/pg_cron--1.0--1.6.sql"), "fixture");
    } else {
      await writeFile(join(root, "share/extension", name + "--" + version + ".sql"), "fixture");
    }
    if (!sqlOnlyExtensions.has(source.id)) {
      await writeFile(join(root, "lib", name + librarySuffix), images.module);
    }
    if (source.id === "timescaledb") {
      await writeFile(join(root, "lib/timescaledb-" + source.version + librarySuffix),
        images.module);
    }
  }
  if (target === "windows-x64") {
    for (const dll of mingwRuntimeDlls) await writeFile(join(root, dll), images.client);
  }
  for (const part of toolchainParts[target]) {
    if (part.notice !== undefined) {
      await writeFile(join(root, part.notice), "Owned runtime notice fixture");
    }
  }
  for (const [path, content] of Object.entries(files ?? {})) {
    await writeFile(join(root, path), content);
  }
  for (const [path, link] of Object.entries(links ?? {})) {
    await symlink(link, join(root, path));
  }
  for (const path of remove ?? []) {
    await rm(join(root, path));
  }
  if (target !== "windows-x64") {
    // The positive fixture must be valid even when the container uses a permissive builder umask.
    await chmod(join(root, "share"), 0o755);
    for (const directory of payloadDirectories) {
      await chmod(join(root, directory), 0o755);
      for (const file of await readdir(join(root, directory))) {
        await chmod(join(root, directory, file), directory === "bin" ? 0o755 : 0o644);
      }
    }
  }
  const manifestOptions = {
    target,
    packagingRevision: 1,
    hostEvidence: fixtureEvidence(target),
    noticeSignatures: noticeSignatureExamples(fixtureNoticeScan()),
    ...artifactOptions,
  };
  return trackedReview === undefined
    ? writeArtifactManifest(root, manifestOptions)
    : writeReviewedManifest(root, manifestOptions, trackedReview);
}

/** A review that passes release validation for a fixture candidate. */
export function reviewedFixture(manifest: ArtifactManifest): LicenseInventory {
  // These fixtures contain only our test bytes. This is not review evidence for native binaries.
  const components: LicenseInventory["components"] = manifest.sources.map(source => {
    const extensions = manifest.extensions.filter(candidate => candidate.sourceId === source.id);
    const files = extensions.length > 0
      ? extensions.flatMap(extension => [
        extension.control,
        ...extension.sql,
        ...extension.libraries,
      ])
      : manifest.files.filter(file => librarySource(file.path, manifest.target) === source.id)
        .map(file => file.path);
    return {
      id: source.id,
      licenses: ["MIT", ...sourceComponentLicenses.get(source.id) ?? []],
      ...manifest.target === "windows-x64" && !sqlOnlyExtensions.has(source.id)
        ? {
          toolchain:
            manifest.hostEvidence.find(entry =>
              entry.component === "CLANG64 packages and linked objects: " + source.id
            )!.version,
        }
        : {},
      status: "verified",
      evidence: ["Owned contract-test fixture"],
      files: [...source.notices, ...files],
      notices: [...source.notices],
      noticeSha256: noticeHashes(manifest, source.notices),
      noticeSignatures: source.noticeSignatures.map(entry => entry.signature),
    };
  });
  const toolchainNotices = toolchainParts[manifest.target].flatMap(part =>
    part.notice === undefined ? [] : [part.notice]
  );
  const assigned = new Set([
    ...components.flatMap(component => component.files),
    ...toolchainNotices,
    ...mingwRuntimeDlls,
  ]);
  const postgres = components.find(component => component.id === "postgresql")!;
  postgres.files.push(...manifest.files.map(file => file.path).filter(path => !assigned.has(path)));
  if (manifest.target === "macos-arm64") postgres.toolchain = parserGenerators.version;
  for (const part of toolchainParts[manifest.target]) {
    const notices = part.notice === undefined ? [] : [part.notice];
    components.push({
      id: part.id,
      licenses: [...toolchainLicenses[part.id]!],
      status: "verified",
      evidence: ["Owned contract-test fixture"],
      // The notice comes first, so that tests removing the last file remove an image.
      files: [...notices, ...toolchainImages(part.id, nativeImages(manifest), manifest.target)],
      notices,
      noticeSha256: noticeHashes(manifest, notices),
      toolchain: manifest.hostEvidence.find(entry => entry.component === part.evidence)!.version,
    });
  }
  return { status: "verified", components };
}

/** Completes a draft the way a reviewer would; the fixture licences say nothing about real binaries. */
export function complete(draft: Review): Review {
  return {
    licenseInventory: {
      status: "verified",
      components: draft.licenseInventory.components.map(component => ({
        ...component,
        licenses: [
          ...toolchainLicenses[component.id] ?? ["MIT"],
          ...sourceComponentLicenses.get(component.id) ?? [],
        ],
        status: "verified",
        evidence: ["Owned contract-test fixture"],
      })),
    },
    hostRequirements: {
      status: "verified",
      os: "Contract-test fixture",
      cpu: "x64 fixture",
      libraries: draft.hostRequirements.libraries.map(library => ({
        ...library,
        requirement: library.requirement || "fixture",
        license: library.name === "glibc"
          ? "LGPL-2.1-or-later"
          : library.name.startsWith("/usr/lib/")
            ? "LicenseRef-Apple-macOS"
            : "LicenseRef-Microsoft-Windows",
        evidence: "fixture",
      })),
    },
  };
}

/** A review approves the licence texts that it read, identified by the hashes of the shipped notices. */
export function noticeHashes(
  manifest: ArtifactManifest,
  notices: string[],
): Record<string, string> {
  return Object.fromEntries(notices.map(notice => {
    const file = manifest.files.find(entry => entry.path === notice);
    return [notice, file?.kind === "file" ? file.sha256 : ""];
  }));
}

/** Recognizes native fixture files by the hashes of their placeholder images. */
export function nativeImages(manifest: ArtifactManifest): string[] {
  const images = new Set(Object.values(fixtureImages(manifest.target)));
  const hashes = new Set(
    [...images].map(image => createHash("sha256").update(image).digest("hex")),
  );
  return manifest.files.flatMap(file =>
    file.kind === "file" && hashes.has(file.sha256) ? [file.path] : []
  );
}

/** Reviewed host requirements that match the fixture measurements. */
export function hostRequirementsFixture(
  target: ArtifactTarget = "windows-x64",
): NonNullable<ArtifactManifest["hostRequirements"]> {
  if (target === "linux-x64-glibc") {
    return {
      status: "verified",
      os: "Contract-test fixture",
      cpu: "x64 fixture",
      libraries: [{
        name: "glibc",
        requirement: "GLIBC_2.35 or newer",
        license: "LGPL-2.1-or-later",
        evidence: "fixture",
      }],
    };
  }
  if (target === "macos-arm64") {
    return {
      status: "verified",
      os: "Contract-test fixture",
      cpu: "arm64 fixture",
      libraries: [{
        name: "/usr/lib/libSystem.B.dylib",
        requirement: "macOS 15.0 or newer",
        license: "LicenseRef-Apple-macOS",
        evidence: "fixture",
      }],
    };
  }
  return {
    status: "verified",
    os: "Contract-test fixture",
    cpu: "x64 fixture",
    libraries: [
      {
        name: "ucrtbase.dll",
        requirement: "fixture",
        license: "LicenseRef-Microsoft-Windows",
        evidence: "fixture",
      },
    ],
  };
}
