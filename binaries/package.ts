/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Records native builds and packages their candidates the same way for every target. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeNativeArchive } from "./artifact/archive.ts";
import type { ArtifactTarget, HostEvidence } from "./artifact/artifact.ts";
import { assembleRuntime } from "./artifact/assemble.ts";
import { copySourceNotices } from "./artifact/notices.ts";
import { readTrackedReview, writeReviewedManifest } from "./artifact/review.ts";
import { readOptionalText } from "./files.ts";
import { sources } from "./sources/sources.ts";
import { nativeArchiveName, packagingRevision } from "./sources/version.ts";
import { root } from "./paths.ts";

const recordName = "last-build.json";

/**
 * A finished native build: its development installation, work directory, and the recipe that produced them.
 * `toolchainEvidence` describes the compiler as the build used it, so reassembly cannot describe a newer one.
 */
export type NativeBuild = {
  developmentInstallation: string;
  buildWork: string;
  recipe: string;
  toolchainEvidence?: HostEvidence[];
};

/** A native build and the candidate assembled from it once packaging has succeeded. */
export type BuildRecord = NativeBuild & {
  inputs: Array<{ id: string; sha256: string }>;
  installation?: string;
  archive?: string;
};

const sourceIdentity = (): Array<{ id: string; sha256: string }> =>
  sources.map(({ id, sha256 }) => ({ id, sha256 }));

/** The host and build container can see the same checkout under different absolute paths. */
function mapRecordPaths(record: BuildRecord, map: (path: string) => string): BuildRecord {
  return {
    ...record,
    buildWork: map(record.buildWork),
    developmentInstallation: map(record.developmentInstallation),
    ...(record.installation === undefined ? {} : { installation: map(record.installation) }),
    ...(record.archive === undefined ? {} : { archive: map(record.archive) }),
  };
}

/** How long a writer waits for the record lock before it reports the lock as left behind. */
const recordLockWaitMs = 60_000;

/**
 * Runs `update` while no other build or assembly of this output writes its record. A reassembly decides
 * from the record whether to replace it, so a fresh build must not record itself between the two steps.
 * The lock is a directory, whose creation fails atomically while another process holds it.
 */
async function withRecordLock<T>(output: string, update: () => Promise<T>): Promise<T> {
  await mkdir(output, { recursive: true });
  const lock = join(output, recordName + ".lock");
  const deadline = Date.now() + recordLockWaitMs;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() > deadline) {
        throw new Error(
          `Another build or assembly still holds ${lock}. If none is running, an interrupted one`
            + " left it behind; remove it and retry.",
          { cause: error },
        );
      }
      // A holder only reads and replaces one small file.
      await delay(50);
    }
  }
  try {
    return await update();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Replaces the record; callers hold the record lock. */
async function writeRecord(output: string, record: BuildRecord): Promise<void> {
  // Tests and reassembly read the record while another build may be writing it, so replace it atomically.
  const staging = join(output, `${recordName}.${randomUUID()}.partial`);
  const portable = mapRecordPaths(record, path => relative(output, path) || ".");
  await writeFile(staging, JSON.stringify(portable, null, 2));
  await rename(staging, join(output, recordName));
}

/**
 * Identifies the files that shape a development installation: build scripts, SQL installers, and tool pins.
 * Reassembly reuses an installation only when these are unchanged; packaging-only changes stay reusable.
 */
export async function recipeIdentity(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(relative(root, path).replaceAll("\\", "/") + "\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Records a finished native build before packaging, so a later reassembly never uses an older build. */
export async function recordBuild(output: string, build: NativeBuild): Promise<void> {
  await withRecordLock(output, () => writeRecord(output, { ...build, inputs: sourceIdentity() }));
}

/**
 * The record as written, with its paths relative to `output`, or `undefined` when there is none. Any other
 * failure propagates: a record that cannot be read may name a newer build that packaging must not replace.
 */
async function readRecord(output: string): Promise<Partial<BuildRecord> | undefined> {
  const text = await readOptionalText(join(output, recordName));
  return text === undefined ? undefined : JSON.parse(text) as Partial<BuildRecord>;
}

/** Returns the last native build for reassembly; its source inputs and recipe must still be current. */
export async function readBuild(output: string, recipe: string): Promise<BuildRecord> {
  const candidate = await readRecord(output);
  if (
    typeof candidate?.buildWork !== "string"
    || typeof candidate.developmentInstallation !== "string"
    || JSON.stringify(candidate.inputs) !== JSON.stringify(sourceIdentity())
    || candidate.recipe !== recipe
  ) {
    throw new Error(
      "A fresh build with the current source inputs and build recipe is required before reassembly.",
    );
  }
  // resolve also accepts the absolute paths in earlier records.
  return mapRecordPaths(candidate as BuildRecord, path => resolve(output, path));
}

/**
 * Returns the toolchain evidence that the build recorded. Licence reviews are bound to it, and reassembly
 * may run on another host than the build, so it must never measure a toolchain of its own.
 */
export function recordedToolchain(build: NativeBuild): HostEvidence[] {
  if (build.toolchainEvidence === undefined) {
    throw new Error("A fresh build is required: the recorded build lacks its toolchain evidence.");
  }
  return build.toolchainEvidence;
}

/** Returns the last packaged candidate; a build whose packaging failed has none. */
export async function lastCandidate(output: string): Promise<string> {
  const record = await readRecord(output);
  if (typeof record?.installation !== "string") {
    throw new TypeError("No packaged candidate is recorded in " + join(output, recordName));
  }
  return resolve(output, record.installation);
}

/** Assembles a fresh candidate from a development installation, describes it, and archives it. */
export async function packageCandidate(options: {
  target: ArtifactTarget;
  output: string;
  sourceRoot: string;
  /**
   * The target's tracked licence review. The candidate claims only the parts that still match it, and a
   * missing file leaves its review pending.
   */
  reviewFile: string;
  build: NativeBuild;
  /** The project's notices for linked toolchain code, shipped next to the source notices. */
  toolchainNotices?: readonly string[];
  /** Inspects the assembled candidate; a rejected runtime dependency must stop packaging. */
  hostEvidence: (candidate: string) => Promise<HostEvidence[]>;
}): Promise<string> {
  const { output, build } = options;
  // Read before assembly, so that a malformed review file stops packaging before the slow part.
  const tracked = await readTrackedReview(options.reviewFile);
  await mkdir(output, { recursive: true });
  // A fresh directory prevents stale build files from leaking into a later candidate.
  const candidate = await mkdtemp(join(output, "candidate installation-"));
  // The notices go straight into the candidate, before assembly sets the runtime permissions. Reassembly
  // only reads the development installation, which another assembly of the same build may be reading too.
  await copySourceNotices(options.sourceRoot, candidate, options.toolchainNotices);
  await assembleRuntime(build.developmentInstallation, candidate);
  await writeReviewedManifest(candidate, {
    target: options.target,
    packagingRevision,
    hostEvidence: await options.hostEvidence(candidate),
  }, tracked);
  // The archive keeps its release name, so each build gets its own directory instead of a unique file name.
  const archiveDirectory = join(output, "archive-" + basename(candidate).split("-").at(-1));
  await mkdir(archiveDirectory);
  const archive = join(archiveDirectory, nativeArchiveName(options.target));
  await writeNativeArchive(candidate, archive);
  // A fresh build records itself before packaging, and each one has its own work directory, so a record
  // that names another one belongs to a build that started after this reassembly read the record; the
  // tests and the next reassembly must use that build.
  const newer = await withRecordLock(output, async () => {
    const recorded = (await readRecord(output))?.buildWork;
    if (typeof recorded === "string" && resolve(output, recorded) !== resolve(build.buildWork)) {
      return resolve(output, recorded);
    }
    await writeRecord(output, {
      ...build,
      inputs: sourceIdentity(),
      installation: candidate,
      archive,
    });
    return undefined;
  });
  if (newer !== undefined) {
    console.warn(
      `Kept the record of a newer build in ${newer}; this candidate is not recorded as the last one: `
        + candidate,
    );
  }
  return candidate;
}
