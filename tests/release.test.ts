/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Checks release naming and that release preparation refuses archives that do not belong to the version.
 * The build jobs validate each archive's contents, so these tests cover what only the release job checks.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { writeNativeArchive } from "../binaries/artifact/archive.ts";
import {
  type ArtifactManifest,
  artifactManifestName,
  type ArtifactTarget,
} from "../binaries/artifact/artifact.ts";
import { prepareRelease } from "../binaries/release.ts";
import { sources } from "../binaries/sources/sources.ts";
import {
  nativeArchiveName,
  nativeReleaseTag,
  nativeVersion,
  packagingRevision,
} from "../binaries/sources/version.ts";
import { createCandidate, hostRequirementsFixture, reviewedFixture } from "./candidate.ts";

const postgresql = sources.find(source => source.id === "postgresql")!.version;
const temporary: string[] = [];
afterEach(async () => {
  for (const created of temporary.splice(0)) {
    await rm(created, { recursive: true, force: true });
  }
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "portable-postgres-release-"));
  temporary.push(path);
  return path;
}

/**
 * Writes a candidate archive under its release name, the way a build job hands it to the release job.
 * A reviewed archive carries a review that passes release validation, and `pins` stand in for an earlier
 * build's source versions.
 */
async function archive(
  assets: string,
  target: ArtifactTarget,
  options: {
    revision?: number;
    reviewed?: boolean;
    /** Source versions that the archive records instead of the pins, as an earlier build would. */
    pins?: Record<string, string>;
    /** Changes the manifest after the candidate was validated, as a broken or foreign build tool would. */
    alter?: (manifest: ArtifactManifest) => void;
  } = {},
) {
  const { revision = packagingRevision, reviewed = false, pins = {}, alter } = options;
  const candidate = await directory();
  await createCandidate(candidate, target, {
    packagingRevision: revision,
    ...reviewed ? await review(target) : {},
  });
  const metadata = join(candidate, artifactManifestName);
  const manifest = JSON.parse(await readFile(metadata, "utf8")) as ArtifactManifest;
  for (const source of manifest.sources) source.version = pins[source.id] ?? source.version;
  alter?.(manifest);
  await writeFile(metadata, JSON.stringify(manifest, null, 2) + "\n");
  await writeNativeArchive(candidate, join(assets, nativeArchiveName(target)));
}

/** Reviews a fixture candidate; every fixture candidate of a target has the same files. */
async function review(target: ArtifactTarget) {
  const manifest = await createCandidate(await directory(), target);
  return {
    licenseInventory: reviewedFixture(manifest),
    hostRequirements: hostRequirementsFixture(target),
  };
}

/** A reviewed archive needs a second candidate for its review. */
const reviewedArchives = 30_000;

it("release names keep the PostgreSQL version recognizable", () => {
  expect(nativeVersion()).toBe(`${postgresql}-r${packagingRevision}`);
  expect(nativeReleaseTag()).toBe(`native-v${postgresql}-r${packagingRevision}`);
  expect(nativeArchiveName("windows-x64")).toBe(
    `portable-postgres-${postgresql}-r${packagingRevision}-windows-x64.tar.gz`,
  );
});

it("rejects an unexpected native archive alongside a current dry-run target", async () => {
  const assets = await directory();
  await archive(assets, "windows-x64");
  const stale = "portable-postgres-18.0-r1-linux-x64-glibc.tar.gz";
  await writeFile(join(assets, stale), "");
  await expect(prepareRelease(assets, join(assets, "release"), "vegardit/portable-postgres", {
    requireAllTargets: false,
  })).rejects.toThrow(stale);
});

it("a dry run prepares checksums, descriptor, and notes from the archives present", async () => {
  const assets = await directory();
  await archive(assets, "windows-x64");
  // Only project archives are release inputs. Other downloads may share this directory.
  await writeFile(join(assets, "other-project.tar.gz"), "unrelated");
  const prepared = await prepareRelease(assets, join(assets, "release"),
    "vegardit/portable-postgres", {
    requireAllTargets: false,
  });
  const name = nativeArchiveName("windows-x64");
  expect(prepared.tag).toBe(nativeReleaseTag());
  expect(prepared.assets).toContain(name);
  const archiveBytes = await readFile(join(assets, "release", name));
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  await expect(readFile(join(assets, "release", "SHA256SUMS"), "utf8")).resolves.toBe(
    `${digest}  ${name}\n`,
  );
  const descriptor = JSON.parse(
    await readFile(join(assets, "release", `portable-postgres-${nativeVersion()}.json`), "utf8"),
  );
  expect(descriptor.archives["windows-x64"]).toMatchObject({
    sha256: digest,
    size: archiveBytes.length,
    url:
      `https://github.com/vegardit/portable-postgres/releases/download/${nativeReleaseTag()}/${name}`,
  });
  await expect(readFile(join(assets, "release", "release-notes.md"), "utf8")).resolves.toContain(
    "| vector |",
  );
});

it("the release notes point to the conditions for the Microsoft code in a Windows archive", async () => {
  const assets = await directory();
  await archive(assets, "windows-x64");
  await prepareRelease(assets, join(assets, "release"), "vegardit/portable-postgres", {
    requireAllTargets: false,
  });
  // The release page is where people download, so it must not leave these conditions to the archive alone.
  await expect(readFile(join(assets, "release", "release-notes.md"), "utf8")).resolves.toContain(
    "The Windows archive contains Microsoft runtime code that the linker copies into every program. "
      + "Read `notices/msvc-runtime.txt` in the archive before you redistribute it.",
  );
});

// Linux candidates need executable permissions, which only a POSIX host can validate.
it.skipIf(process.platform === "win32")(
  "the release notes of a Linux archive name no Microsoft code",
  async () => {
    const assets = await directory();
    await archive(assets, "linux-x64-glibc");
    await prepareRelease(assets, join(assets, "release"), "vegardit/portable-postgres", {
      requireAllTargets: false,
    });
    await expect(readFile(join(assets, "release", "release-notes.md"), "utf8")).resolves.not
      .toContain(
        "Microsoft",
      );
  },
);

it("a real release needs every target", async () => {
  const assets = await directory();
  await archive(assets, "windows-x64", { reviewed: true });
  await expect(
    prepareRelease(assets, join(assets, "release"), "vegardit/portable-postgres", {
      requireAllTargets: true,
    }),
  ).rejects.toThrow("Missing release archives for linux-x64-glibc, macos-arm64");
}, reviewedArchives);

// Linux candidates need executable permissions, which only a POSIX host can validate.
it.skipIf(process.platform === "win32")(
  "a real release needs a macOS archive even when every buildable target is reviewed",
  async () => {
    const assets = await directory();
    await archive(assets, "windows-x64", { reviewed: true });
    await archive(assets, "linux-x64-glibc", { reviewed: true });
    await expect(
      prepareRelease(assets, join(assets, "release"), "vegardit/portable-postgres", {
        requireAllTargets: true,
      }),
    ).rejects.toThrow("Missing release archives for macos-arm64");
  },
  reviewedArchives,
);

// The permission checks apply to Linux archives, which only a POSIX host can validate.
it("a real release refuses archives whose review is still pending", async () => {
  const assets = await directory();
  // The review is reported before missing targets, so a pending archive is named even without the others.
  await archive(assets, "windows-x64");
  await expect(
    prepareRelease(assets, join(assets, "release"), "vegardit/portable-postgres", {
      requireAllTargets: true,
    }),
  ).rejects.toThrow(
    nativeArchiveName("windows-x64") + " has not passed the licence and host review",
  );
});

it("an archive built from other source pins is refused under the current release name", async () => {
  const assets = await directory();
  // An extension update keeps an unreleased revision, so an earlier build carries the same name.
  await archive(assets, "windows-x64", { pins: { pgvector: "0.8.0" } });
  await expect(
    prepareRelease(assets, join(assets, "release"), "vegardit/portable-postgres", {
      requireAllTargets: false,
    }),
  ).rejects.toThrow(
    nativeArchiveName("windows-x64")
      + " was built from other source pins than this checkout: pgvector",
  );
});

it("release preparation writes its assets to a new directory and leaves the downloads as they are", async () => {
  const assets = await directory();
  await archive(assets, "windows-x64");
  const name = nativeArchiveName("windows-x64");
  const downloaded = await readFile(join(assets, name));
  const output = join(assets, "release");
  const prepared = await prepareRelease(assets, output, "vegardit/portable-postgres", {
    requireAllTargets: false,
  });
  await expect(readFile(join(assets, name))).resolves.toEqual(downloaded);
  // The release notes become the release description, not an asset.
  expect((await readdir(output)).toSorted()).toEqual(
    [...prepared.assets, "release-notes.md"].toSorted(),
  );
  await expect(readFile(join(output, name))).resolves.toEqual(downloaded);
  // A second preparation never mixes its assets into an earlier output.
  await expect(
    prepareRelease(assets, output, "vegardit/portable-postgres", { requireAllTargets: false }),
  ).rejects.toThrow("EEXIST");
});

it("a failed release preparation removes its output, so that it can be retried", async () => {
  const assets = await directory();
  await archive(assets, "windows-x64", { reviewed: true });
  const output = join(assets, "release");
  const prepare = () =>
    prepareRelease(assets, output, "vegardit/portable-postgres", { requireAllTargets: true });
  // The missing targets are found only after the archive and its manifest were written.
  await expect(prepare()).rejects.toThrow("Missing release archives");
  await expect(readdir(output)).rejects.toThrow("ENOENT");
  await expect(prepare()).rejects.toThrow("Missing release archives");
}, reviewedArchives);

it("an uncompressed tar under the release name is refused", async () => {
  const assets = await directory();
  await archive(assets, "windows-x64");
  // The format and every consumer expect gzip, although the parser would read a plain tar as well.
  const name = nativeArchiveName("windows-x64");
  await writeFile(join(assets, name), gunzipSync(await readFile(join(assets, name))));
  await expect(
    prepareRelease(assets, join(assets, "release"), "vegardit/portable-postgres", {
      requireAllTargets: false,
    }),
  ).rejects.toThrow(name + " is not a gzip archive");
});

it("an archive from another packaging revision is refused", async () => {
  const assets = await directory();
  await archive(assets, "windows-x64", { revision: packagingRevision + 1 });
  await expect(
    prepareRelease(assets, join(assets, "release"), "vegardit/portable-postgres", {
      requireAllTargets: false,
    }),
  ).rejects.toThrow(`describes windows-x64 ${postgresql}-r${packagingRevision + 1}`);
});

it("a manifest key that this version does not know reaches the published manifest", async () => {
  const assets = await directory();
  await archive(assets, "windows-x64", {
    alter: manifest => Object.assign(manifest, { addedByLaterFormat: { kept: true } }),
  });
  await prepareRelease(assets, join(assets, "release"), "vegardit/portable-postgres", {
    requireAllTargets: false,
  });
  const published = JSON.parse(
    await readFile(
      join(assets, "release",
        `portable-postgres-${nativeVersion()}-windows-x64.native-artifact.json`),
      "utf8",
    ),
  );
  expect(published.addedByLaterFormat).toEqual({ kept: true });
});

it("an archive whose manifest does not have the manifest's shape is refused, even in a dry run", async () => {
  const assets = await directory();
  await archive(assets, "windows-x64", {
    // No check of release preparation reads the host evidence, so only shape validation can refuse this.
    alter: manifest => Object.assign(manifest, { hostEvidence: "none" }),
  });
  await expect(
    prepareRelease(assets, join(assets, "release"), "vegardit/portable-postgres", {
      requireAllTargets: false,
    }),
  ).rejects.toThrow("Native artifact");
});
