/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks native build recipes, documented settings, and the CI rules that gate a merge. */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  contribExtensions,
  extensionNames,
  sqlOnlyExtensions,
} from "../binaries/artifact/runtime-layout.ts";
import { linkRecordsDirectory } from "../binaries/linux/links.ts";
import { root } from "../binaries/paths.ts";
import { sources } from "../binaries/sources/sources.ts";

const read = (path: string) => readFile(join(root, path), "utf8");
const captures = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map(match => match[1]!);
const sourceIds = Object.keys(extensionNames).sort();
const names = [...Object.values(extensionNames), ...contribExtensions].sort();

it("the Linux recipe builds every extension source", async () => {
  const script = await read("binaries/linux/build.sh");
  const built = new Set(captures(script, /\$source_root\/(\w+)/g));
  for (const loop of captures(script, /^for extension in ([\w ]+); do$/gm)) {
    for (const id of loop.split(" ")) built.add(id);
  }
  built.delete("postgresql");
  expect(built.delete("openssl"), "OpenSSL is built before PostgreSQL").toBe(true);
  expect(built.delete("icu"), "ICU is built before PostgreSQL").toBe(true);
  expect([...built].sort()).toEqual(sourceIds);
});

it("the make recipes build every selected contrib module", async () => {
  // Meson builds all of contrib on Windows, where the runtime layout alone selects what ships.
  for (const file of ["binaries/linux/build.sh", "binaries/macos/build.sh"]) {
    const loops = captures(await read(file), /^for module in ([\w ]+); do$/gm);
    expect(loops.map(loop => loop.split(" ")), file).toEqual([[...contribExtensions]]);
  }
});

it("the Windows recipe builds every extension source", async () => {
  const script = await read("binaries/windows/build.sh");
  const loop = captures(script, /^for extension in ([\w ]+); do$/gm);
  expect(loop).toHaveLength(1);
  expect(script).toContain('-S "$src/timescaledb"');
  expect(script).toContain("-DAPACHE_ONLY=ON");
  expect([...loop[0]!.split(" "), "timescaledb", ...sqlOnlyExtensions].sort()).toEqual(sourceIds);
});

it("the Linux image links through the tracing linker whose records Linux packaging checks", async () => {
  const dockerfile = await read("binaries/linux/image/Dockerfile");
  const copied = (/^COPY --chmod=0755 traced-ld\.sh (\S+)$/m.exec(dockerfile))?.[1];
  expect(copied, "the image installs traced-ld.sh").toBeDefined();
  expect(dockerfile).toContain("--ld-path=" + copied);
  const linker = await read("binaries/linux/image/traced-ld.sh");
  const variable = (/^records=\$\{(\w+):-\}$/m.exec(linker))?.[1];
  expect(variable, "traced-ld.sh reads its records directory").toBeDefined();
  const script = await read("binaries/linux/build.sh");
  expect(script).toMatch(new RegExp("^export " + variable + "=\\$link_records$", "m"));
  // Packaging reads the records from the build's work directory under this name.
  expect(script).toMatch(
    new RegExp('^link_records="\\$work_root/' + linkRecordsDirectory + '"$', "m"),
  );
});

it("the Windows compiler traces links and strips debug sections for both driver languages", async () => {
  const script = await read("binaries/windows/build.sh");
  expect(script).toContain("for driver in clang clang++; do");
  expect(script).toContain("--ld-path=");
  expect(script).toContain("--strip-debug");
});

it("the README's pg_cron settings are the ones the native proofs run with", async () => {
  const readme = (await read("README.md")).replaceAll("\r\n", "\n");
  const settings = (/```ini\n(cron\.database_name[^`]*)```/.exec(readme))?.[1]?.trim().split("\n");
  expect(settings, "README.md shows the pg_cron settings").toBeDefined();
  const server = (await read("tests/native/server.conf")).split(/\r?\n/);
  for (const setting of settings!) expect(server, setting).toContain(setting);
});

it("the README lists every pinned extension with the license of its source pin", async () => {
  const rows = (await read("README.md")).split(/\r?\n/).filter(line => line.startsWith("| ["));
  for (const id of sourceIds) {
    const source = sources.find(candidate => candidate.id === id)!;
    const repository = "upstream" in source && "repository" in source.upstream
      ? source.upstream.repository
      : undefined;
    const row = rows.find(line => line.includes(`](https://github.com/${repository})`));
    expect(row, id + " has a row in the README's extension table").toBeDefined();
    expect(row!.split("|").at(-2)!.trim(), id).toBe(source.license);
  }
});

it("the native SQL proofs create and count every extension", async () => {
  const smoke = await read("tests/native/smoke.sql");
  expect(captures(smoke, /^CREATE EXTENSION (\w+)/gm).sort()).toEqual(names);
  const tap = await read("tests/native/tap.sql");
  const coexistence = /extname IN\s*\(([^)]*)\)\),\s*(\d+),/.exec(tap);
  expect(coexistence, "tap.sql must count the selected extensions").not.toBeNull();
  expect(captures(coexistence![1]!, /'(\w+)'/g).sort()).toEqual(names);
  expect(Number(coexistence![2])).toBe(names.length);
});

it("the native scope of a pull request compares the tested merge with its first parent", async () => {
  const workflow = await read(".github/workflows/build.yml");
  const scope = (/^ {6}- id: scope\r?\n[\s\S]*?(?=^ {2}#{5,})/m.exec(workflow))?.[0];
  expect(scope, "build.yml has the native scope step").toBeDefined();
  // The event's base SHA can predate the merge's base and is absent from the depth-2 checkout.
  expect(scope).not.toContain("pull_request.base.sha");
  expect(scope).toContain("HEAD^2");
  expect(scope).toMatch(/git diff [^\n]*"?HEAD\^1"? HEAD /);
});

it("merge queue branches build through merge_group only", async () => {
  const workflow = await read(".github/workflows/build.yml");
  const events = /^on:[^\n]*\n((?:[ \t][^\n]*\n|\r?\n)*)/m.exec(workflow)?.[1];
  expect(events).toMatch(/^ {2}merge_group:/m);
  const ignored = (/^ {2}push:\r?\n {4}branches-ignore:\r?\n((?: {6}.*\r?\n)+)/m.exec(events!))
    ?.[1];
  expect(ignored, "build.yml ignores branches for push").toBeDefined();
  // GitHub also sends a push for each queue branch, which would build the same merge twice.
  expect(ignored).toMatch(/^ {6}- "gh-readonly-queue\/\*\*"/m);
});

it("readiness requires the repository checks and the comparison of every selected run", async () => {
  const workflow = (await read(".github/workflows/build.yml")).replaceAll("\r\n", "\n");
  const readiness = /^ {2}readiness:\n((?: {4}[^\n]*\n|\n)+)/m.exec(workflow)?.[1];
  expect(readiness, "build.yml has the readiness job").toBeDefined();
  expect(readiness).toContain("needs: [scope, docs, build, compare]");
  // GitHub can skip a dependent job after a failure unless its job-level condition still selects it.
  expect(readiness).toMatch(/^ {4}if: always\(\)$/m);
  const script = /^ {8}run: \|\n((?: {10}[^\n]*\n|\n)+)/m.exec(readiness!)?.[1];
  expect(script, "readiness has a shell step").toBeDefined();
  // A skipped job reports no failure, so the checks selected for each path must actually succeed.
  for (const [scope, native, docs, build, compareResult, expectedStatus] of [
    ["success", "true", "skipped", "success", "success", 0],
    ["success", "true", "skipped", "success", "failure", 1],
    ["success", "true", "skipped", "failure", "success", 1],
    ["success", "true", "skipped", "success", "skipped", 1],
    ["success", "true", "skipped", "skipped", "skipped", 1],
    ["success", "false", "success", "skipped", "skipped", 0],
    ["success", "false", "failure", "skipped", "skipped", 1],
    ["success", "false", "skipped", "skipped", "skipped", 1],
    ["failure", "", "skipped", "skipped", "skipped", 1],
  ] as const) {
    // Git can launch Bash on Windows even when its bundled bash.exe is outside PATH.
    const result = spawnSync("git", ["-c", "alias.check-readiness=!bash -e -s", "check-readiness"],
      {
        input: script!,
        env: {
          ...process.env,
          SCOPE: scope,
          NATIVE: native,
          DOCS: docs,
          BUILD: build,
          COMPARE: compareResult,
        },
        encoding: "utf8",
        windowsHide: true,
      });
    if (result.error) throw result.error;
    expect(result.status,
      `scope=${scope} native=${native} docs=${docs} build=${build} compare=${compareResult}\n${result.stdout}${result.stderr}`)
      .toBe(expectedStatus);
  }
  const compare = (/^ {2}compare:\n[\s\S]*?(?=^ {2}\w+:$)/m.exec(workflow))?.[0];
  expect(compare, "build.yml has the compare job").toBeDefined();
  // A pending review fails the build job after its manifest upload; the comparison must still run then.
  expect(compare).toContain("if: ${{ !cancelled() && needs.build.result != 'skipped' }}");
});

it("build scripts take the LLVM major and the job count from the TypeScript drivers", async () => {
  for (
    const file of [
      "binaries/linux/build.sh",
      "binaries/linux/image/Dockerfile",
      "binaries/linux/image/traced-ld.sh",
      "binaries/linux/abi.ts",
      "binaries/windows/build.sh",
    ]
  ) {
    const text = await read(file);
    expect(text, `${file} names an LLVM major`).not.toMatch(
      /(?:clang|llvm|readelf|rt|jammy)-\d+\b/,
    );
    expect(text, `${file} fixes a job count`).not.toMatch(/ -j ?\d|--parallel \d/);
  }
  // The image build receives the LLVM major from base.json like the Ubuntu image.
  for (const file of [".github/workflows/build.yml", "CONTRIBUTING.md"]) {
    const text = await read(file);
    const imageBuilds = text.match(/--build-arg "UBUNTU_IMAGE=/g)?.length ?? 0;
    expect(imageBuilds, `${file} builds the Linux image`).toBeGreaterThan(0);
    expect(text.match(/--build-arg "LLVM_MAJOR=\$llvm"/g)?.length ?? 0).toBe(imageBuilds);
  }
});
