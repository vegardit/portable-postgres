/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks that a release's source bundle holds the committed recipes and the pinned source archives. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list } from "tar";
import { afterEach, expect, it } from "vitest";
import { capture } from "../binaries/process.ts";
import { bundledDownloads, writeSourceBundle } from "../binaries/source-bundle.ts";
import { cachedArchivePath } from "../binaries/sources/sources.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const created of temporary.splice(0)) {
    await rm(created, { recursive: true, force: true });
  }
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "portable-postgres-bundle-"));
  temporary.push(path);
  return path;
}

/** A repository with one commit, and an untracked file that a bundle must leave out. */
async function repository(): Promise<string> {
  const path = await directory();
  const git = (...args: string[]) => capture("git", ["-C", path, ...args]);
  git("init", "-q");
  await mkdir(join(path, "binaries"));
  await writeFile(join(path, "binaries", "recipe.sh"), "echo build\n");
  await writeFile(join(path, "README.md"), "committed\n");
  git("add", ".");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c",
    "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
  await writeFile(join(path, "untracked.txt"), "not committed\n");
  return path;
}

/** Reads every entry of a bundle by name. */
async function entries(file: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  await list({
    file,
    onReadEntry: entry => {
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => chunks.push(chunk));
      entry.on("end", () => found.set(entry.path, Buffer.concat(chunks).toString("utf8")));
    },
  });
  return found;
}

it("a source bundle holds the committed files and the source archives where the build looks for them", async () => {
  const source = await repository();
  const cache = await directory();
  const archive = cachedArchivePath(cache, "fixture", "ab".repeat(32));
  await writeFile(archive, "upstream source\n");
  const bundle = join(await directory(), "sources.tar.gz");
  await writeSourceBundle({
    repository: source,
    directory: "top",
    archives: [archive],
    file: bundle,
  });

  const found = await entries(bundle);
  expect(found.get("./top/README.md")).toBe("committed\n");
  expect(found.get("./top/binaries/recipe.sh")).toBe("echo build\n");
  expect(found.get(`./top/${bundledDownloads}/fixture-${"ab".repeat(32)}.archive`)).toBe(
    "upstream source\n",
  );
  expect([...found.keys()].some(path => path.includes("untracked"))).toBe(false);

  // The same commit and sources give the same bytes.
  const again = join(await directory(), "sources.tar.gz");
  await writeSourceBundle({
    repository: source,
    directory: "top",
    archives: [archive],
    file: again,
  });
  expect((await readFile(again)).equals(await readFile(bundle))).toBe(true);
});

it("a source bundle is refused while tracked files have uncommitted changes", async () => {
  const source = await repository();
  await writeFile(join(source, "README.md"), "edited\n");
  const bundle = join(await directory(), "sources.tar.gz");
  await expect(
    writeSourceBundle({ repository: source, directory: "top", archives: [], file: bundle }),
  )
    .rejects.toThrow("commit or revert these changes first:\n M README.md");
});
