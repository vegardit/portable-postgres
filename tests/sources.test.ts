/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Verifies source trust checks and the compiled build toolkit's import boundary. */
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

it("compiled build export imports without launching a build", () => {
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const { build } = await import('./dist/binaries/linux/build.js'); if (typeof build !== 'function') throw Error('Missing built export'); console.log('built-export-ok');",
  ], { encoding: "utf8", timeout: 10_000 });
  expect(output.trim()).toBe("built-export-ok");
});

it("compiled build drivers and the pin updater use the repository's recipes, notices and pins", async () => {
  // tsc emits only modules and the JSON they import, so a path next to the compiled module finds
  // neither the build scripts nor the notices, and would write updated pins into dist.
  // The parent owns the notice directory so a failing child cannot leave its files behind.
  const noticeDirectory = await createDirectory("notice");
  const script = `
    const { existsSync } = await import("node:fs");
    const { isAbsolute, join, relative, sep } = await import("node:path");
    const { linuxRecipe } = await import("./dist/binaries/linux/build.js");
    const { windowsRecipe } = await import("./dist/binaries/windows/build.js");
    const { msvcRuntimeNotice } = await import("./dist/binaries/windows/visual-studio.js");
    const { pinFiles } = await import("./dist/binaries/sources/update.js");
    // An admitted edition, so that line 18 gets the reviewed notice and writes no candidate text here.
    const line = version => [
      { component: "Visual Studio product line", version, evidence: "" },
      {
        component: "Visual Studio edition",
        version: "Microsoft.VisualStudio.Product.Community",
        evidence: "",
      },
    ];
    const paths = [
      ...linuxRecipe,
      ...windowsRecipe,
      await msvcRuntimeNotice(line("18"), "."),
      await msvcRuntimeNotice(line("2022"), process.argv[1]),
      pinFiles.sources,
      pinFiles.revision,
    ];
    // The compiled output directory itself, so that a checkout path that contains "dist" still passes.
    const inDist = path => {
      const rest = relative(join(process.cwd(), "dist"), path);
      return !isAbsolute(rest) && rest.split(sep)[0] !== "..";
    };
    console.log(JSON.stringify(paths.filter(path => !existsSync(path) || inDist(path))));
  `;
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    script,
    noticeDirectory,
  ], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(JSON.parse(output)).toEqual([]);
  await expect(readdir(noticeDirectory)).resolves.toEqual(["msvc-runtime.txt"]);
});

it("compiled tooling finds the repository root, not its own output directory", () => {
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const { root } = await import('./dist/binaries/paths.js'); console.log(root);",
  ], { encoding: "utf8", timeout: 10_000 });
  // The compiled modules live under dist, but the scripts and SQL fixtures they run stay in the repository.
  expect(output.trim()).toBe(process.cwd());
});
