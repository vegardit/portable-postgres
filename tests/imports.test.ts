/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks PE import reading and the Windows host-library gate with synthetic images. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectWindowsRuntime, readPeImports } from "../binaries/windows/imports.ts";

/** Builds a minimal PE32+ image with one section holding an import table and a delay-import table. */
function peImage(imports: string[], delayImports: string[] = []): Buffer {
  const image = Buffer.alloc(0x8_00);
  image.write("MZ");
  image.writeUInt32LE(64, 60);
  image.writeUInt32LE(0x45_50, 64);
  image.writeUInt16LE(0x86_64, 68);
  image.writeUInt16LE(1, 70);
  image.writeUInt16LE(240, 84);
  const optional = 88;
  image.writeUInt16LE(0x2_0B, optional);
  image.writeUInt32LE(16, optional + 108);
  // The section maps addresses 0x1000-0x15ff to file offsets 0x200-0x7ff.
  const section = optional + 240;
  image.writeUInt32LE(0x6_00, section + 8);
  image.writeUInt32LE(0x10_00, section + 12);
  image.writeUInt32LE(0x6_00, section + 16);
  image.writeUInt32LE(0x2_00, section + 20);
  const offsetOf = (address: number) => address - 0x10_00 + 0x2_00;
  let nameAddress = 0x14_00;
  function table(directory: number, address: number, size: number, field: number, names: string[]) {
    if (names.length === 0) return;
    image.writeUInt32LE(address, optional + 112 + directory * 8);
    for (const [index, name] of names.entries()) {
      image.writeUInt32LE(nameAddress, offsetOf(address) + index * size + field);
      image.write(name + "\0", offsetOf(nameAddress), "latin1");
      nameAddress += name.length + 1;
    }
  }
  table(1, 0x10_00, 20, 12, imports);
  table(13, 0x12_00, 32, 4, delayImports);
  return image;
}

it("reads import and delay-import names and ignores files that are not PE images", () => {
  expect(readPeImports(peImage(["KERNEL32.dll", "libpq.dll"], ["WS2_32.dll"]))).toEqual([
    "kernel32.dll",
    "libpq.dll",
    "ws2_32.dll",
  ]);
  expect(readPeImports(peImage([]))).toEqual([]);
  expect(readPeImports(Buffer.from("-- an SQL script"))).toBeNull();
});

it("accepts bundled and reviewed host libraries and rejects any other import", async () => {
  const installation = await mkdtemp(join(tmpdir(), "portable-postgres-imports-"));
  try {
    await mkdir(join(installation, "bin"));
    await mkdir(join(installation, "lib"));
    await writeFile(join(installation, "bin/libpq.dll"), peImage(["KERNEL32.dll"]));
    await writeFile(
      join(installation, "bin/psql.exe"),
      peImage(["LIBPQ.dll", "VCRUNTIME140.dll"], ["WS2_32.dll"]),
    );
    await writeFile(join(installation, "lib/notes.txt"), "not an image");
    await expect(inspectWindowsRuntime(installation)).resolves.toEqual([
      "kernel32.dll",
      "vcruntime140.dll",
      "ws2_32.dll",
    ]);
    await writeFile(join(installation, "lib/vector.dll"), peImage(["libssl-3-x64.dll"]));
    await expect(inspectWindowsRuntime(installation)).rejects.toThrow(
      "vector.dll needs an unreviewed runtime library: libssl-3-x64.dll",
    );
  } finally {
    await rm(installation, { recursive: true, force: true });
  }
});

it("only DLLs next to the programs count as bundled, because Windows looks for imports there", async () => {
  const installation = await mkdtemp(join(tmpdir(), "portable-postgres-imports-"));
  try {
    await mkdir(join(installation, "bin"));
    await mkdir(join(installation, "lib"));
    // A module that the server loads may import libpq.dll, which Windows finds next to postgres.exe.
    await writeFile(join(installation, "bin/libpq.dll"), peImage(["KERNEL32.dll"]));
    await writeFile(join(installation, "lib/libpqwalreceiver.dll"), peImage(["LIBPQ.dll"]));
    await expect(inspectWindowsRuntime(installation)).resolves.toEqual(["kernel32.dll"]);
    // PostgreSQL loads lib/ modules by full path with LoadLibrary, which does not search their directory.
    await writeFile(join(installation, "lib/extra.dll"), peImage(["KERNEL32.dll"]));
    await writeFile(join(installation, "bin/postgres.exe"), peImage(["EXTRA.dll"]));
    await expect(inspectWindowsRuntime(installation)).rejects.toThrow(
      "needs an unreviewed runtime library: extra.dll",
    );
  } finally {
    await rm(installation, { recursive: true, force: true });
  }
});
