/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Packs the source bundle of a release: the recipes, the project's patches, and the pinned source archives that its
 * archives are built from, in one asset.
 * Some bundled code may be sold only with its buildable source (pg_cron's cron code, under Paul Vixie's license),
 * and the release tag alone points to upstream archives that may move, so each release carries its own copy.
 */
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { extract } from "tar";
import { writeNativeArchive } from "./artifact/archive.ts";
import { capture } from "./process.ts";

/** Where the builds look for source archives, relative to the repository root; see `fetchSources`. */
export const bundledDownloads = "binaries/work/downloads";

export function sourceBundleName(version: string): string {
  return `portable-postgres-${version}-sources.tar.gz`;
}

/**
 * Writes `file`: the repository's committed files at HEAD under one top directory, `directory`, with the given
 * source archives, already verified against their pins, in the download cache that the builds read. A build from
 * the extracted bundle then finds every source in place and verifies it again instead of downloading it.
 * Build tools are installed separately. For example, the Windows recipe downloads flex and bison together from a
 * URL pinned in tools.json and verifies the archive's SHA-256.
 *
 * The release checks its archives against the working tree's source pins, but the bundle carries the commit's,
 * so a repository whose tracked files have uncommitted changes is refused. The archive packer writes sorted
 * entries with one fixed time, so the same commit and sources always give the same bundle.
 */
export async function writeSourceBundle(options: {
  repository: string;
  directory: string;
  archives: Iterable<string>;
  file: string;
}): Promise<void> {
  const { repository, directory, archives, file } = options;
  const changed = capture("git", [
    "-C",
    repository,
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (changed.trim() !== "") {
    throw new Error(
      "A source bundle holds the committed files, so commit or revert these changes first:\n"
        + changed.trimEnd(),
    );
  }
  const work = await mkdtemp(join(tmpdir(), "portable-postgres-sources-"));
  try {
    const exported = join(work, "repository.tar");
    // Line endings follow .gitattributes alone, as in a Linux checkout, whichever host packs the bundle.
    capture("git", [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "-C",
      repository,
      "archive",
      "--format=tar",
      `--prefix=${directory}/`,
      "-o",
      exported,
      "HEAD",
    ]);
    const tree = join(work, "tree");
    await mkdir(tree);
    await extract({ file: exported, cwd: tree });
    const downloads = join(tree, directory, bundledDownloads);
    await mkdir(downloads, { recursive: true });
    for (const archive of archives) await copyFile(archive, join(downloads, basename(archive)));
    await writeNativeArchive(tree, file);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
