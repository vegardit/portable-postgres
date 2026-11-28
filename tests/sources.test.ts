/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Verifies source archive integrity and checks that Node can import the build tools directly. */
import { createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { fetchSources, verifyArchive } from "../binaries/sources/sources.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

const { directory: createDirectory, cleanup } = temporaryDirectories("source");
afterEach(cleanup);

it("accepts pinned bytes and rejects a changed source archive", async () => {
  const directory = await createDirectory();
  const archive = join(directory, "source.archive");
  await writeFile(archive, "reviewed source");
  const digest = createHash("sha256").update("reviewed source").digest("hex");
  await expect(verifyArchive(archive, digest)).resolves.toBeUndefined();
  await writeFile(archive, "altered source");
  await expect(verifyArchive(archive, digest)).rejects.toThrow("integrity check failed");
});

it("a rejected source download leaves other attempts alone", async () => {
  const directory = await createDirectory();
  const otherAttempt = "source.archive.other.partial";
  await writeFile(join(directory, otherAttempt), "another download");
  const input = { id: "source", version: "1", url: "data:text/plain,reviewed" };
  await expect(fetchSources(directory, [{ ...input, sha256: "0".repeat(64) }])).rejects.toThrow(
    "integrity check failed",
  );
  await expect(readdir(directory)).resolves.toEqual([otherAttempt]);

  const sha256 = createHash("sha256").update("reviewed").digest("hex");
  const paths = await fetchSources(directory, [{ ...input, sha256 }]);
  await expect(verifyArchive(paths.get("source")!, sha256)).resolves.toBeUndefined();
});

it("keeps archives of different pins side by side and returns each verified path", async () => {
  const directory = await createDirectory();
  const pin = (content: string) => ({
    id: "source",
    version: content,
    url: "data:text/plain," + content,
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  const first = pin("first");
  const second = pin("second");
  const firstPaths = await fetchSources(directory, [first]);
  const secondPaths = await fetchSources(directory, [second]);
  // A build that verified the first pin must still find its bytes after another build fetched the second.
  expect(firstPaths.get("source")).not.toBe(secondPaths.get("source"));
  await expect(verifyArchive(firstPaths.get("source")!, first.sha256)).resolves.toBeUndefined();
  await expect(verifyArchive(secondPaths.get("source")!, second.sha256)).resolves
    .toBeUndefined();
  // A cached pin is reused instead of downloaded again.
  expect((await fetchSources(directory, [first])).get("source")).toBe(firstPaths.get("source"));
});

it("Node imports the TypeScript drivers and finds their checkout inputs from another directory", async () => {
  const binaries = new URL("../binaries/", import.meta.url);
  const script = `
    import assert from "node:assert/strict";
    import { existsSync } from "node:fs";
    import { join, sep } from "node:path";
    const load = file => import(new URL(file, process.argv[1]));
    const { root } = await load("paths.ts");
    assert.equal(root, process.argv[2]);
    const linux = await load("linux/build.ts");
    const windows = await load("windows/build.ts");
    const macos = await load("macos/build.ts");
    const { pinFiles } = await load("sources/update.ts");
    for (const driver of [linux, windows, macos]) assert.equal(typeof driver.build, "function");
    assert.deepEqual(pinFiles, {
      sources: join(root, "binaries/sources/sources.json"),
      revision: join(root, "binaries/sources/revision.json"),
    });
    for (const path of [
      ...linux.linuxRecipes.glibc, ...linux.linuxRecipes.musl,
      ...windows.windowsRecipe, ...macos.macOSRecipe, ...Object.values(pinFiles),
    ]) {
      assert.ok(path.startsWith(join(root, "binaries") + sep) && existsSync(path), path);
    }
  `;
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    binaries.href,
    process.cwd(),
  ], {
    cwd: await createDirectory(),
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(output).toBe("");
});
