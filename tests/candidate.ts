/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Writes minimal candidate installations whose layout passes candidate validation; the files are not real programs. */
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type ArtifactManifest,
  type ArtifactOptions,
  type ArtifactTarget,
  type HostEvidence,
  type LicenseInventory,
  writeArtifactManifest,
} from "../binaries/artifact/artifact.ts";
import { additionalNoticeName } from "../binaries/artifact/notices.ts";
import { type Review, writeReviewedManifest } from "../binaries/artifact/review.ts";
import { corePrograms, requiredModules } from "../binaries/artifact/runtime-layout.ts";
import { sources } from "../binaries/sources/sources.ts";

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
    id: "msvc-runtime",
    evidence: "Visual Studio product line",
    notice: "notices/msvc-runtime.txt",
  }],
  "linux-x64-glibc": [
    { id: "compiler-rt", evidence: "Clang major version" },
    { id: "glibc-startup", evidence: "glibc" },
  ],
};

/** The licences that the fixture reviews give each toolchain component; two are admitted only there. */
export const toolchainLicenses: Record<string, string> = {
  "compiler-rt": "Apache-2.0 WITH LLVM-exception",
  "glibc-startup": "LGPL-2.1-or-later WITH GCC-exception-2.0",
  "msvc-runtime": "LicenseRef-Microsoft-VisualStudio-2026-Linked-CRT-Code",
};

/** Release validation admits only reviewed Visual Studio lines and editions, so Windows fixtures name real ones. */
const fixtureLines: Record<string, string> = {
  "compiler-rt": "fixture-1",
  "glibc-startup": "fixture-1",
  "msvc-runtime": "18",
};

/**
 * What each build measures about its host needs, with the result that the fixture reviews accept. Stated
 * literally for the same reason as the toolchain evidence.
 */
export const hostMeasurements: Record<ArtifactTarget, HostEvidence> = {
  "windows-x64": {
    component: "PE host library imports",
    version: "vcruntime140.dll, ucrtbase.dll",
    evidence: "Contract test",
  },
  "linux-x64-glibc": {
    component: "ELF glibc symbol requirements",
    version: "GLIBC_2.35",
    evidence: "Contract test",
  },
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
      ? [{
        component: "Visual Studio edition",
        version: "Microsoft.VisualStudio.Product.Enterprise",
        evidence: "Contract test",
      }]
      : [],
    hostMeasurements[target],
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
        "hostEvidence" | "hostRequirements" | "licenseInventory" | "packagingRevision"
      >
    >
    & {
      /** Replaces or adds payload files, such as a changed licence notice, before the manifest is written. */
      files?: Record<string, string>;
      /** Adds symbolic links, path to link text, before the manifest is written. */
      links?: Record<string, string>;
      /** Deletes payload files, such as a source notice, before the manifest is written. */
      remove?: readonly string[];
      /** Writes the manifest from a tracked review as packaging does, reconciled with this candidate. */
      trackedReview?: Review;
    } = {},
): Promise<ArtifactManifest> {
  const { files, links, remove, trackedReview, ...artifactOptions } = options;
  for (const directory of ["bin", "lib", "share/extension", "notices"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const binary = target === "windows-x64" ? peFixture() : elfFixture();
  const executableSuffix = target === "windows-x64" ? ".exe" : "";
  const librarySuffix = target === "windows-x64" ? ".dll" : ".so";
  for (const name of corePrograms) {
    const executable = join(root, "bin", name + executableSuffix);
    await writeFile(executable, binary);
    if (target === "linux-x64-glibc") await chmod(executable, 0o755);
  }
  await writeFile(
    join(root, target === "windows-x64" ? "bin/libpq.dll" : "lib/libpq.so.5"),
    binary,
  );
  for (const module of requiredModules) {
    await writeFile(join(root, "lib", module + librarySuffix), binary);
  }
  await writeFile(join(root, "share/extension/plpgsql.control"), "default_version = '1.0'\n");
  await writeFile(join(root, "share/extension/plpgsql--1.0.sql"), "fixture");
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
    if (source.id === "postgresql") continue;
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
    if (source.id !== "pg_partman" && source.id !== "pgtap") {
      await writeFile(join(root, "lib", name + librarySuffix), binary);
    }
    if (source.id === "timescaledb") {
      await writeFile(join(root, "lib/timescaledb-" + source.version + librarySuffix), binary);
    }
  }
  for (const part of toolchainParts[target]) {
    if (part.notice !== undefined) await writeFile(join(root, part.notice), "test-only notice");
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
  if (target === "linux-x64-glibc") {
    // The positive fixture must be valid even when the container uses a permissive builder umask.
    for (const directory of ["bin", "lib", "share", "share/extension", "notices"]) {
      await chmod(join(root, directory), 0o755);
    }
    for (const directory of ["bin", "lib", "share/extension", "notices"]) {
      for (const file of await readdir(join(root, directory))) {
        await chmod(join(root, directory, file), directory === "bin" ? 0o755 : 0o644);
      }
    }
  }
  const manifestOptions = {
    target,
    packagingRevision: 1,
    hostEvidence: fixtureEvidence(target),
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
    const extension = manifest.extensions.find(candidate => candidate.sourceId === source.id);
    const files = extension ? [extension.control, ...extension.sql, ...extension.libraries] : [];
    return {
      id: source.id,
      licenses: ["MIT"],
      status: "verified",
      evidence: ["Owned contract-test fixture"],
      files: [...source.notices, ...files],
      notices: [...source.notices],
      noticeSha256: noticeHashes(manifest, source.notices),
    };
  });
  const toolchainNotices = toolchainParts[manifest.target].flatMap(part =>
    part.notice === undefined ? [] : [part.notice]
  );
  const assigned = new Set([
    ...components.flatMap(component => component.files),
    ...toolchainNotices,
  ]);
  const postgres = components.find(component => component.id === "postgresql")!;
  postgres.files.push(...manifest.files.map(file => file.path).filter(path => !assigned.has(path)));
  for (const part of toolchainParts[manifest.target]) {
    const notices = part.notice === undefined ? [] : [part.notice];
    components.push({
      id: part.id,
      licenses: [toolchainLicenses[part.id]!],
      status: "verified",
      evidence: ["Owned contract-test fixture"],
      // The notice comes first, so that tests removing the last file remove an image.
      files: [...notices, ...nativeImages(manifest)],
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
        licenses: [toolchainLicenses[component.id] ?? "MIT"],
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
        license: library.name === "glibc" ? "LGPL-2.1-or-later" : "LicenseRef-Microsoft-Windows",
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

/** Every fixture binary has the same bytes, so the native images are exactly the files with that hash. */
export function nativeImages(manifest: ArtifactManifest): string[] {
  const binary = manifest.target === "windows-x64" ? peFixture() : elfFixture();
  const sha256 = createHash("sha256").update(binary).digest("hex");
  return manifest.files.flatMap(file =>
    file.kind === "file" && file.sha256 === sha256 ? [file.path] : []
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
  return {
    status: "verified",
    os: "Contract-test fixture",
    cpu: "x64 fixture",
    libraries: [
      {
        name: "vcruntime140.dll",
        requirement: "fixture",
        license: "LicenseRef-Microsoft-Windows",
        evidence: "fixture",
      },
      {
        name: "ucrtbase.dll",
        requirement: "fixture",
        license: "LicenseRef-Microsoft-Windows",
        evidence: "fixture",
      },
    ],
  };
}
