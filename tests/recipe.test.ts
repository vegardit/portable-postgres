/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Guards values that shell, batch, CMake, Docker, and SQL files restate because they cannot import TypeScript. */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extensionNames, sqlOnlyExtensions } from "../binaries/artifact/runtime-layout.ts";
import { linkRecordsDirectory } from "../binaries/linux/links.ts";
import { linkEnvironmentFile, parseLinkEnvironment } from "../binaries/windows/links.ts";
import { root } from "../binaries/paths.ts";

const read = (path: string) => readFile(join(root, path), "utf8");
const captures = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map(match => match[1]!);
const sourceIds = Object.keys(extensionNames).sort();
const names = Object.values(extensionNames).sort();

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

it("the Windows recipe builds every extension source", async () => {
  const script = await read("binaries/windows/build-extensions.cmd");
  const cmake = await read("binaries/windows/extensions/CMakeLists.txt");
  const built = new Set([
    ...captures(script, /call :nmake_extension (\w+)/g),
    ...captures(script, /windows-sources\\(\w+)/g),
    ...captures(cmake, /^add_library\((\w+) MODULE/gm),
    // binaries/windows/sql.ts installs these from the same set, so no script restates them; the layout
    // check and smoke.sql prove that they install.
    ...sqlOnlyExtensions,
  ]);
  expect([...built].sort()).toEqual(sourceIds);
});

it("the toolchain evidence names the Visual Studio installation that the Windows recipe compiles with", async () => {
  const script = await read("binaries/windows/build.cmd");
  // A selection of its own could compile with another installation than the one the evidence describes.
  expect(script).not.toMatch(/vswhere/i);
  expect(script).toContain('set "VS_ROOT=%PORTABLE_PG_VISUAL_STUDIO%"');
  expect(script).toContain('call "%VS_ROOT%\\VC\\Auxiliary\\Build\\vcvars64.bat"');
  expect(script).toContain('> "%WORK_ROOT%\\windows-msvc-toolset.txt" echo %VCToolsVersion%');
});

it("every Windows link writes the map and environment that the Windows link check reads", async () => {
  const script = await read("binaries/windows/build.cmd");
  const vcvars = script.indexOf("vcvars64.bat");
  // After vcvars64.bat, which sets these variables, and before the first link.
  const lines = [
    'set "_LINK_=/MAP /VERBOSE:LIB"',
    'node "%PROJECT_ROOT%\\binaries\\windows\\link-recipe.ts" environment',
  ];
  for (const line of lines) {
    expect(script).toContain(line);
    expect(script.indexOf(line)).toBeGreaterThan(vcvars);
    expect(script.indexOf(line)).toBeLessThan(script.indexOf("mesonbuild.mesonmain setup"));
  }
});

it("captures the inherited library paths as data", async () => {
  const work = await mkdtemp(join(tmpdir(), "postgres link & environment-"));
  try {
    execFileSync(process.execPath, [join(root, "binaries/windows/link-recipe.ts"), "environment"], {
      env: {
        ...process.env,
        PORTABLE_PG_WORK: work,
        LIB: work,
        VCToolsInstallDir: work,
        WindowsSDKVersion: "10",
      },
    });
    expect(
      parseLinkEnvironment(await readFile(join(work, linkEnvironmentFile), "utf8")).libraryPath,
    )
      .toEqual([work]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
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

it("Windows scripts never put a variable directly before a redirection", async () => {
  // cmd.exe takes a single digit before ">" as the handle to redirect, so "--parallel %BUILD_JOBS%>"
  // with BUILD_JOBS=4 passes "--parallel" without a value and leaves the log empty.
  for (const file of ["binaries/windows/build.cmd", "binaries/windows/build-extensions.cmd"]) {
    const lines = (await read(file)).split(/\r?\n/);
    expect(lines.filter(line => /%[\w~]+%[0-9]?>/.test(line)), file).toEqual([]);
  }
});

it("the README's pg_cron settings are the ones the native proofs run with", async () => {
  const readme = (await read("README.md")).replaceAll("\r\n", "\n");
  const settings = (/```ini\n(cron\.database_name[^`]*)```/.exec(readme))?.[1]?.trim().split("\n");
  expect(settings, "README.md shows the pg_cron settings").toBeDefined();
  const server = (await read("tests/native/server.conf")).split(/\r?\n/);
  for (const setting of settings!) expect(server, setting).toContain(setting);
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

it("build scripts take the LLVM major and the job count from the TypeScript drivers", async () => {
  for (
    const file of [
      "binaries/linux/build.sh",
      "binaries/linux/image/Dockerfile",
      "binaries/linux/image/traced-ld.sh",
      "binaries/linux/abi.ts",
      "binaries/windows/build.cmd",
      "binaries/windows/build-extensions.cmd",
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
