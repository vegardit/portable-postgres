/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks that each build ships exactly the notices of the current source pins. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { toolchainNotices } from "../binaries/artifact/artifact.ts";
import { copySourceNotices } from "../binaries/artifact/notices.ts";
import { root } from "../binaries/paths.ts";
import { sourceTree } from "./candidate.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const created of temporary.splice(0)) {
    await rm(created, { recursive: true, force: true });
  }
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "portable-postgres-notices-"));
  temporary.push(path);
  return path;
}

it("ships both Regents notices from PostgreSQL under runtime-safe names", async () => {
  const tree = await sourceTree(await directory());
  const candidate = await directory();
  const notices = [
    ["src/port/pgmkdirp.c", "postgresql-src-port-pgmkdirp.c"],
    ["src/include/lib/sort_template.h", "postgresql-src-include-lib-sort_template.h.txt"],
  ] as const;
  for (const [source] of notices) {
    await writeFile(join(tree, "postgresql", source), source + "\r\n");
  }
  await copySourceNotices(tree, candidate);
  for (const [source, name] of notices) {
    await expect(readFile(join(candidate, "notices", name))).resolves.toEqual(
      await readFile(join(tree, "postgresql", source)),
    );
  }
});

it("each toolchain notice has its text next to the target's recipe and ships under its archive path", async () => {
  // The Windows build passes the recipe file with the same relative path as the archive path.
  for (const notice of toolchainNotices("windows-x64")) {
    const text = join(root, "binaries/windows", notice);
    const installation = await directory();
    await copySourceNotices(await sourceTree(await directory()), installation, [text]);
    await expect(readFile(join(installation, notice), "utf8")).resolves.toBe(
      await readFile(text, "utf8"),
    );
  }
  // The Linux build passes no toolchain notices; a Linux notice would need it to.
  expect(toolchainNotices("linux-x64-glibc")).toEqual([]);
});
