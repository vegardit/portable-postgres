/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Checks what the linker copied into each native image of a Linux candidate. Clang links through the
 * build image's traced-ld, which stores the trace of every link under its output's build ID. The build ID
 * ties an image to the link that produced it, so an image without a full trace, such as one linked outside
 * the build or rebuilt by hand before a reassembly, is refused.
 */
import { readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { elfImages, readelf } from "./abi.ts";
import { dataOnlyElf } from "../artifact/data-library.ts";
import { isIcuDataLibrary } from "../artifact/runtime-layout.ts";

/** The directory in a build's work directory where build.sh has traced-ld store its traces. */
export const linkRecordsDirectory = "link-records";

/** Returns the GNU build ID of an ELF image as readelf prints it, which names its trace in traced-ld.sh. */
export function readBuildId(image: string): string | undefined {
  return /^\s*Build ID: ([0-9a-f]+)\s*$/m.exec(readelf(image, "--notes"))?.[1];
}

// GCC's runtime (GPL-3.0-or-later WITH GCC-exception-3.1) may not be linked, so no input may come from GCC's
// directories: not libgcc or crtbegin/crtend, which a compiler other than the configured Clang would link,
// and not crtfastmath.o, which Clang itself adds to a program built with -ffast-math when it finds the file.
const gccDirectory = "/gcc/";
const glibcCode =
  /^(?:\(\/(?:usr\/)?lib\/x86_64-linux-gnu\/[^)]+\.a\)[^ ]+|\/(?:usr\/)?lib\/x86_64-linux-gnu\/[^ ]+\.o)$/;
// glibc's startup files and libc_nonshared.a members are the only glibc code that may be copied into an
// image; the glibc-startup licence review covers exactly this set, for example not a static libc.a.
const reviewedGlibcCode =
  /^(?:\/(?:usr\/)?lib\/x86_64-linux-gnu\/(?:S?crt1|crti|crtn)\.o|\(\/(?:usr\/)?lib\/x86_64-linux-gnu\/libc_nonshared\.a\)(?:atexit|at_quick_exit|pthread_atfork|stack_chk_fail_local)\.oS)$/;

/**
 * Removes `.` and `..` segments from the path of a trace line, including the archive of an `(archive)member`
 * line. ld names an input by the search directory it found it in, and Clang searches GCC's directories as
 * `/usr/lib/gcc/x86_64-linux-gnu/11/../../..`, so the patterns above must see the file a line names, not its
 * spelling. POSIX rules, because the trace comes from Linux even when the tests run on Windows.
 */
function tracedFile(line: string): string {
  const member = /^\((\/[^)]*)\)(.*)$/.exec(line);
  if (member) return `(${posix.normalize(member[1]!)})${member[2]!}`;
  return line.startsWith("/") ? posix.normalize(line) : line;
}

/**
 * Requires a full link trace in `records` for every ELF image in the installation, wherever it lies, and
 * refuses any trace that shows GCC's runtime or glibc code that the glibc-startup review does not cover.
 * Tests pass their own `buildId`, because readelf from the build image's LLVM is missing on other hosts.
 */
export async function auditLinks(
  installation: string,
  records: string,
  buildId: (image: string) => string | undefined = readBuildId,
): Promise<void> {
  const unreviewed = new Set<string>();
  const images = await elfImages(installation);
  for (const path of images) {
    const name = relative(installation, path).split(sep).join("/");
    const id = buildId(path);
    const trace = id === undefined
      ? undefined
      : await readFile(join(records, id + ".trace"), "utf8").catch(() => undefined);
    // Code-bearing images need glibc's crti.o. ICU's raw data library deliberately links with -nostdlib.
    // Errors quote the raw line, so that it can be found in the stored trace.
    const lines = (trace?.split("\n") ?? []).map(line => ({ line, file: tracedFile(line) }));
    if (!lines.some(({ file }) => file.endsWith("/x86_64-linux-gnu/crti.o"))) {
      const dataOnly = isIcuDataLibrary(name, "linux-x64-glibc")
        && lines.some(({ file }) => file.endsWith(".o"))
        && dataOnlyElf(await readFile(path));
      if (!dataOnly) throw new Error("No linker record for " + name);
    }
    const gcc = lines.find(({ file }) => file.includes(gccDirectory));
    if (gcc !== undefined) {
      throw new Error(`The link of ${name} used a forbidden GCC runtime contribution: ${gcc.line}`);
    }
    for (const { line, file } of lines) {
      if (glibcCode.test(file) && !reviewedGlibcCode.test(file)) unreviewed.add(line);
    }
  }
  if (unreviewed.size > 0) {
    throw new Error(
      "A link copied glibc code that the glibc-startup review does not cover:\n"
        + [...unreviewed].sort().join("\n"),
    );
  }
  if (images.length === 0) throw new Error("No native image found in " + installation);
}
