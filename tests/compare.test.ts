/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Guards against targets that silently ship different extension versions or SQL scripts. */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { artifactManifestName } from "../binaries/artifact/artifact.ts";
import { root } from "../binaries/paths.ts";
import { createCandidate } from "./candidate.ts";
import { temporaryDirectories } from "./temporary-directories.ts";
import { compareTargets } from "../binaries/artifact/compare.ts";

type Payload = Parameters<typeof compareTargets>[0];
const { directory, cleanup } = temporaryDirectories("manifest-comparison");
afterEach(cleanup);

it("requires a matching downloaded manifest for every hosted target", async () => {
  const downloads = await directory();
  const manifest = await createCandidate(await directory(), "windows-x64");
  const compare = () =>
    spawnSync(process.execPath, [
      join(root, "binaries/validate.ts"),
      "compare",
      "--require-all-targets",
      downloads,
    ], { encoding: "utf8" });
  for (const target of ["linux-x64-glibc", "windows-x64"]) {
    const location = join(downloads, "manifest-" + target);
    await mkdir(location);
    await writeFile(join(location, artifactManifestName), JSON.stringify({ ...manifest, target }));
  }
  const missing = compare();
  expect(missing.status).not.toBe(0);
  expect(missing.stderr).toContain("manifest-macos-arm64");
  const location = join(downloads, "manifest-macos-arm64");
  await mkdir(location);
  await writeFile(join(location, artifactManifestName), JSON.stringify(manifest));
  expect(compare().stderr).toContain("expected macos-arm64");
  await writeFile(join(location, artifactManifestName),
    JSON.stringify({ ...manifest, target: "macos-arm64" }));
  expect(compare().status).toBe(0);
});

function payload(
  target: Payload["target"],
  suffix: string,
  sql: string[],
  otherFiles: string[] = [],
): Payload {
  const extensionFiles = ["pg_textsearch.control", ...sql, ...otherFiles];
  return {
    target,
    files: extensionFiles.map(file => ({
      path: "share/extension/" + file,
      kind: "file",
      sha256: "0".repeat(64),
      executable: false,
    })),
    postgresqlVersion: "18.7",
    sources: [],
    extensions: [{
      sourceId: "pg_textsearch",
      name: "pg_textsearch",
      version: "1.5.1",
      control: "share/extension/pg_textsearch.control",
      sql: sql.map(file => "share/extension/" + file),
      libraries: ["lib/pg_textsearch" + suffix],
    }],
  };
}

it("treats platform library suffixes as equal and reports extra SQL scripts by target", () => {
  const scripts = ["pg_textsearch--1.5.1.sql", "pg_textsearch--1.5.0--1.5.1.sql"];
  const linux = payload("linux-x64-glibc", ".so", scripts);
  expect(compareTargets(linux, payload("windows-x64", ".dll", scripts))).toEqual([]);
  expect(
    compareTargets(linux, payload("windows-x64", ".dll", [...scripts, "pg_textsearch--0.5.0.sql"])),
  ).toEqual(["pg_textsearch: sql only in windows-x64: pg_textsearch--0.5.0.sql"]);
  const windows = payload("windows-x64", ".dll", scripts.slice(0, 1));
  const macos = payload("macos-arm64", ".dylib", scripts);
  expect(compareTargets(linux, windows, macos)).toEqual([
    "linux-x64-glibc vs windows-x64: pg_textsearch: sql only in linux-x64-glibc: pg_textsearch--1.5.0--1.5.1.sql",
  ]);
});

it("reports version and PostgreSQL differences", () => {
  const linux = payload("linux-x64-glibc", ".so", []);
  const windows = payload("windows-x64", ".dll", []);
  windows.postgresqlVersion = "18.6";
  windows.extensions[0]!.version = "1.5.0";
  expect(compareTargets(linux, windows)).toEqual([
    "PostgreSQL version: 18.7 (linux-x64-glibc) vs 18.6 (windows-x64)",
    "pg_textsearch: version 1.5.1 (linux-x64-glibc) vs 1.5.0 (windows-x64)",
  ]);
});

it("reports unlisted extension files sorted within each target, left target first", () => {
  const scripts = ["pg_textsearch--1.5.1.sql"];
  // A plain install script, such as pgTAP's pgtap.sql, is not an extension version script.
  const linux = payload("linux-x64-glibc", ".so", scripts, ["z.sql", "common.sql", "pgtap.sql"]);
  const windows = payload("windows-x64", ".dll", scripts, ["y.sql", "common.sql", "a.sql"]);
  expect(compareTargets(linux, windows)).toEqual([
    "share/extension files only in linux-x64-glibc: pgtap.sql, z.sql",
    "share/extension files only in windows-x64: a.sql, y.sql",
  ]);
});
