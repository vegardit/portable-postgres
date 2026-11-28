/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks the musl dependency audit with one ELF module and controlled llvm-readelf output. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { inspectLinuxRuntime } from "../binaries/linux/abi.ts";
import { elfFixture } from "./candidate.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

vi.mock(import("node:child_process"));

const { directory, cleanup } = temporaryDirectories("linux-abi");
const modulePath = join("lib", "vector.so");
const muslDependency = "0x0000000000000001 (NEEDED) Shared library: [libc.musl-x86_64.so.1]";
let installation: string;

beforeAll(async () => {
  installation = await directory();
  await mkdir(join(installation, "lib"));
  await writeFile(join(installation, modulePath), elfFixture());
});

afterAll(cleanup);

it("accepts a module that needs only the target musl libc", async () => {
  vi.mocked(execFileSync).mockReturnValueOnce(muslDependency);
  await expect(inspectLinuxRuntime(installation, "linux-x64-musl")).resolves.toBeUndefined();
  expect(execFileSync).toHaveBeenCalledWith(
    expect.any(String),
    expect.arrayContaining(["--dynamic", "--version-info", join(installation, modulePath)]),
    expect.anything(),
  );
});

it.each([
  [
    "a glibc symbol requirement",
    muslDependency + "\nVersion needs section '.gnu.version_r' contains 1 entry:"
    + "\n  0x0010: Name: GLIBC_2.34  Flags: none  Version: 2",
    modulePath + " requires a glibc symbol: GLIBC_2.34",
  ],
  [
    "an installation with no musl libc dependency",
    "0x0000000000000000 (NULL) 0x0",
    "No dependency on libc.musl-x86_64.so.1 found",
  ],
  [
    "an unbundled glibc library alongside musl libc",
    muslDependency + "\n0x0000000000000001 (NEEDED) Shared library: [libm.so.6]",
    modulePath + " needs an unreviewed runtime library: libm.so.6",
  ],
] as const)("rejects %s", async (_, output, diagnostic) => {
  vi.mocked(execFileSync).mockReturnValueOnce(output);
  await expect(inspectLinuxRuntime(installation, "linux-x64-musl")).rejects.toThrow(diagnostic);
});
