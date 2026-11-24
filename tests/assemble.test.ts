/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Prevents development-only files and helper executables from entering the native runtime payload. */
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { assembleRuntime } from "../binaries/artifact/assemble.ts";
import {
  contribExtensions,
  includesRuntimePath,
  moduleSuffix,
  requiredModules,
} from "../binaries/artifact/runtime-layout.ts";

it("assembles the same programs and extension payload from either platform's SDK", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "portable-postgres-assembly-"));
  try {
    const windows = process.platform === "win32";
    const prefix = join(temporary, "build");
    const candidate = await mkdtemp(join(temporary, "relocated runtime-"));
    for (const directory of [
      "bin",
      "share/doc/extension",
      "share/extension",
      "share/tsearch_data",
      "notices",
      "lib/pgxs",
      "include",
    ]) {
      await mkdir(join(prefix, directory), { recursive: true });
    }
    const executableSuffix = windows ? ".exe" : "";
    const librarySuffix = windows ? ".dll" : ".so";
    const pgClient = windows ? "bin/libpq.dll" : "lib/libpq.so.5";
    for (const file of [
      "bin/postgres" + executableSuffix,
      "bin/ecpg" + executableSuffix,
      "bin/test_cloexec" + executableSuffix,
      "bin/vacuumlo" + executableSuffix,
      "bin/oid2name" + executableSuffix,
      pgClient,
      "lib/vector" + librarySuffix,
      "lib/tablefunc" + librarySuffix,
      "lib/test_decoding" + librarySuffix,
      "lib/libpq.a",
      "lib/pgxs/missing",
      "include/postgres.h",
      "notices/upstream-license.txt",
      "share/extension/plpgsql.control",
      "share/extension/vector--1.0.sql",
      "share/extension/vector.control",
      "share/extension/tablefunc.control",
      "share/extension/pageinspect--1.0.sql",
      "share/tsearch_data/english.stop",
      "share/tsearch_data/xsyn_sample.rules",
      "share/doc/extension/refint.example",
    ]) {
      await writeFile(join(prefix, file), "fixture");
    }
    if (!windows) {
      await mkdir(join(candidate, "lib"));
      await chmod(join(candidate, "lib"), 0o777);
    }
    // The Linux layout on every POSIX host, macOS included; the macOS names are checked below.
    await assembleRuntime(prefix, candidate, windows ? "windows-x64" : "linux-x64-glibc");
    // Packaging writes the current notices into the candidate; an installation's copy is never shipped.
    expect((await readdir(candidate)).sort()).toEqual(["bin", "lib", "share"]);
    expect((await readdir(join(candidate, "bin"))).sort()).toEqual(
      windows ? ["ecpg.exe", "libpq.dll", "postgres.exe"] : ["ecpg", "postgres"],
    );
    expect((await readdir(join(candidate, "lib"))).sort()).toEqual(
      windows ? ["vector.dll"] : ["libpq.so.5", "vector.so"],
    );
    expect((await readdir(join(candidate, "share"))).sort()).toEqual(["extension", "tsearch_data"]);
    expect((await readdir(join(candidate, "share/extension"))).sort()).toEqual([
      "plpgsql.control",
      "vector--1.0.sql",
      "vector.control",
    ]);
    await expect(readdir(join(candidate, "share/tsearch_data"))).resolves.toEqual(["english.stop"]);
    if (!windows) {
      for (const directory of ["", "lib"]) {
        expect((await stat(join(candidate, directory))).mode & 0o777).toBe(0o755);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it.each(["linux-x64-glibc", "windows-x64", "macos-arm64"] as const)(
  "%s keeps versioned extension scripts and controls but not an unversioned install script",
  target => {
    // pgTAP's make install also copies pgtap.sql, which CREATE EXTENSION never reads; the Windows
    // recipe installs only what the server loads, and both archives must ship the same files.
    expect(includesRuntimePath("share/extension/pgtap.sql", target)).toBe(false);
    for (
      const path of [
        "share/extension/pgtap.control",
        "share/extension/pgtap--1.3.4.sql",
        "share/extension/pg_cron--1.0--1.6.sql",
        "share/extension/plpgsql--1.0.control",
      ]
    ) {
      expect(includesRuntimePath(path, target), path).toBe(true);
    }
  },
);

it.each(["linux-x64-glibc", "windows-x64", "macos-arm64"] as const)(
  "%s keeps the selected contrib modules with their scripts and data, and no other contrib module",
  target => {
    const suffix = moduleSuffix(target);
    for (const name of contribExtensions) {
      for (const path of [
        "lib/" + name + suffix,
        "share/extension/" + name + ".control",
        "share/extension/" + name + "--1.0--1.1.sql",
      ]) {
        expect(includesRuntimePath(path, target), path).toBe(true);
      }
    }
    expect(includesRuntimePath("share/tsearch_data/unaccent.rules", target)).toBe(true);
    for (const path of [
      "lib/tablefunc" + suffix,
      "lib/hstore_plperl" + suffix,
      "share/extension/tablefunc.control",
      "share/extension/pg_trgm.sql",
      "share/tsearch_data/xsyn_sample.rules",
    ]) {
      expect(includesRuntimePath(path, target), path).toBe(false);
    }
  },
);

it("keeps every module that validation requires, and a conversion module that a later release adds", () => {
  // A later PostgreSQL release may add a conversion; the runtime ships it although nothing requires it.
  for (const module of [...requiredModules, "utf8_and_future"]) {
    expect(includesRuntimePath("lib/" + module + ".so", "linux-x64-glibc"), module).toBe(true);
    expect(includesRuntimePath("lib/" + module + ".dll", "windows-x64"), module).toBe(true);
    expect(includesRuntimePath("lib/" + module + ".dylib", "macos-arm64"), module).toBe(true);
  }
});

it.each([
  ["linux-x64-glibc", ["lib/libicuuc.so.79", "lib/libicui18n.so.79.1", "lib/libicudata.so.79"]],
  ["windows-x64", ["bin/icuuc79.dll", "bin/icuin79.dll", "bin/icudt79.dll"]],
  ["macos-arm64", [
    "lib/libicuuc.79.dylib",
    "lib/libicui18n.79.1.dylib",
    "lib/libicudata.79.dylib",
  ]],
] as const)("%s retains ICU code and its locale data", (target, paths) => {
  for (const path of paths) expect(includesRuntimePath(path, target), path).toBe(true);
  for (const path of [
    "bin/icuinfo",
    "bin/icuinfo.exe",
    "lib/libicuuc.a",
    "lib/icuuc.lib",
    "share/man/man1/icuinfo.1",
    "share/icu/79.1/config/mh-linux",
  ]) {
    expect(includesRuntimePath(path, target), path).toBe(false);
  }
});

it("selects macOS libraries by their Darwin names, where only client libraries carry versions", () => {
  for (
    const path of [
      "lib/libpq.5.dylib",
      "lib/libpq.dylib",
      "lib/libecpg_compat.3.dylib",
      "lib/libpqwalreceiver.dylib",
      "lib/vector.dylib",
      "lib/pg_trgm.dylib",
      "lib/timescaledb-2.32.0.dylib",
      "bin/postgres",
    ]
  ) {
    expect(includesRuntimePath(path, "macos-arm64"), path).toBe(true);
  }
  for (
    const path of [
      "lib/libpq.a",
      "lib/libpq.so.5",
      "lib/tablefunc.dylib",
      "lib/vector.1.dylib",
      "lib/libfoo.1.dylib",
      "bin/postgres.exe",
    ]
  ) {
    expect(includesRuntimePath(path, "macos-arm64"), path).toBe(false);
  }
});
