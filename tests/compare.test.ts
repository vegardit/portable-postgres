/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Guards against targets that silently ship different extension versions or SQL scripts. */
import { expect, it } from "vitest";
import { compareTargets } from "../binaries/artifact/compare.ts";

type Payload = Parameters<typeof compareTargets>[0];

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

it("reports a shipped extension file that no extension entry lists", () => {
  const scripts = ["pg_textsearch--1.5.1.sql"];
  // A plain install script, such as pgTAP's pgtap.sql, is not an extension version script.
  const linux = payload("linux-x64-glibc", ".so", scripts, ["pgtap.sql"]);
  expect(compareTargets(linux, payload("windows-x64", ".dll", scripts))).toEqual([
    "share/extension files only in linux-x64-glibc: pgtap.sql",
  ]);
});
