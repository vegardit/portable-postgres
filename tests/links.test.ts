/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks that Linux packaging requires a full, reviewed link trace for every image a candidate ships. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { auditLinks } from "../binaries/linux/links.ts";
import { elfFixture } from "./candidate.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

const { directory, cleanup } = temporaryDirectories("links");
afterEach(cleanup);

const id = "0123456789abcdef0123456789abcdef01234567";

/** Stands in for readelf, which only the build image has: every image reads as linked under `id`. */
const buildId = (): string => id;

/** What GNU ld's --trace --trace lists for a link that Clang runs with compiler-rt. */
const trace = [
  "/usr/bin/ld.bfd: mode elf_x86_64",
  "/lib/x86_64-linux-gnu/Scrt1.o",
  "/lib/x86_64-linux-gnu/crti.o",
  "/usr/lib/llvm/lib/clang/lib/linux/clang_rt.crtbegin-x86_64.o",
  "main.o",
  "(/usr/lib/x86_64-linux-gnu/libc_nonshared.a)atexit.oS",
  "/lib/x86_64-linux-gnu/crtn.o",
];

/** A candidate with one image at `path` and link records that hold `lines` for its build ID. */
async function candidate(path: string, lines: string[] | undefined) {
  const installation = await directory();
  const records = await directory();
  await mkdir(dirname(join(installation, path)), { recursive: true });
  await writeFile(join(installation, path), elfFixture());
  await mkdir(join(installation, "share"), { recursive: true });
  await writeFile(join(installation, "share/postgres.bki"), "not an image");
  if (lines !== undefined) await writeFile(join(records, id + ".trace"), lines.join("\n") + "\n");
  return { installation, records };
}

it("accepts an image whose link copied only reviewed toolchain code", async () => {
  const { installation, records } = await candidate("bin/postgres", trace);
  await expect(auditLinks(installation, records, buildId)).resolves.toBeUndefined();
});

it.each([
  ["bin/postgres", undefined],
  // Assembly ships images outside bin and lib as well, and validation finds them by their bytes.
  ["share/timezone/helper", undefined],
  ["lib/vector.so", trace.filter(line => !line.endsWith("/crti.o"))],
])("refuses %s without a full link record", async (path, lines) => {
  const { installation, records } = await candidate(path, lines);
  await expect(auditLinks(installation, records, buildId)).rejects.toThrow(
    "No linker record for " + path,
  );
});

it("refuses an image without a build ID", async () => {
  const installation = await directory();
  await mkdir(join(installation, "bin"));
  await writeFile(join(installation, "bin/postgres"), elfFixture());
  await expect(auditLinks(installation, await directory(), () => undefined)).rejects.toThrow(
    "No linker record for bin/postgres",
  );
});

it("refuses a link that used GCC's runtime", async () => {
  const libgcc = "/usr/lib/gcc/x86_64-linux-gnu/11/libgcc.a";
  const { installation, records } = await candidate("bin/postgres", [...trace, libgcc]);
  await expect(auditLinks(installation, records, buildId)).rejects.toThrow(
    "The link of bin/postgres used a forbidden GCC runtime contribution: " + libgcc,
  );
});

it("refuses a link that used any file from GCC's directories", async () => {
  // Clang adds GCC's crtfastmath.o to a program linked with -ffast-math when it finds the file.
  const crtfastmath = "/usr/lib/gcc/x86_64-linux-gnu/11/crtfastmath.o";
  const { installation, records } = await candidate("bin/postgres", [...trace, crtfastmath]);
  await expect(auditLinks(installation, records, buildId)).rejects.toThrow(
    "The link of bin/postgres used a forbidden GCC runtime contribution: " + crtfastmath,
  );
});

it("refuses glibc code that the glibc-startup review does not cover", async () => {
  const member = "(/usr/lib/x86_64-linux-gnu/libc.a)printf.o";
  const { installation, records } = await candidate("bin/postgres", [...trace, member]);
  await expect(auditLinks(installation, records, buildId)).rejects.toThrow(
    "A link copied glibc code that the glibc-startup review does not cover:\n" + member,
  );
});

// ld names each input by the search directory it was found in, and Clang searches GCC's directories as
// /usr/lib/gcc/x86_64-linux-gnu/11/../../.., so one file can appear under a spelling that passes through them.
it("judges a trace path by the file it names, not by its spelling", async () => {
  const startup = "/usr/lib/gcc/x86_64-linux-gnu/11/../../../x86_64-linux-gnu/crti.o";
  const accepted = await candidate("bin/postgres", [...trace, startup]);
  await expect(auditLinks(accepted.installation, accepted.records, buildId)).resolves
    .toBeUndefined();

  const member = "(/usr/lib/gcc/x86_64-linux-gnu/11/../../../x86_64-linux-gnu/libc.a)printf.o";
  const refused = await candidate("bin/postgres", [...trace, member]);
  await expect(auditLinks(refused.installation, refused.records, buildId)).rejects.toThrow(
    "A link copied glibc code that the glibc-startup review does not cover:\n" + member,
  );
});
