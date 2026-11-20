/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks archive header normalization independently of the native binaries in the payload. */
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { writeNativeArchive } from "../binaries/artifact/archive.ts";

it("refuses to pack a name that would need a PAX header", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "portable-postgres-archive-"));
  try {
    const installation = join(temporary, "candidate installation");
    await mkdir(join(installation, "share"), { recursive: true });
    await writeFile(join(installation, "share/café.txt"), "a non-ASCII name");
    await expect(writeNativeArchive(installation, join(temporary, "archive.tar.gz"))).rejects
      .toThrow('unsupported header type "x"');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it("packs anonymous ownership, fixed timestamps, and sorted entries despite input mtime changes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "portable-postgres-archive-"));
  try {
    const installation = join(temporary, "candidate installation");
    await mkdir(join(installation, "sub"), { recursive: true });
    const file = join(installation, "z-last");
    await writeFile(file, "file");
    await writeFile(join(installation, "sub/a file"), "nested file");
    const windows = process.platform === "win32";
    if (!windows) await symlink("z-last", join(installation, "link"));

    const first = join(temporary, "first.tar.gz");
    const second = join(temporary, "second.tar.gz");
    await writeNativeArchive(installation, first);
    const later = new Date("2020-01-01T00:00:00Z");
    await utimes(file, later, later);
    await writeNativeArchive(installation, second);
    const compressed = await readFile(first);
    expect(compressed.equals(await readFile(second))).toBe(true);
    expect(compressed.readUInt32LE(4)).toBe(0);

    const archive = gunzipSync(compressed);
    const paths: string[] = [];
    for (let offset = 0; archive[offset];) {
      const field = (start: number, length: number) =>
        archive.toString("ascii", offset + start, offset + start + length).split("\0")[0]!;
      const size = Number.parseInt(field(124, 12), 8);
      paths.push(field(0, 100));
      // Empty owner fields carry no builder identity; tar readers treat them as user and group 0.
      for (const [start, length] of [[108, 8], [116, 8], [265, 32], [297, 32]] as const) {
        expect(field(start, length).trim()).toBe("");
      }
      expect(Number.parseInt(field(100, 8), 8) & 0o022).toBe(0);
      expect(Number.parseInt(field(136, 12), 8)).toBe(946_684_800);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(paths).toEqual([
      "./",
      ...(windows ? [] : ["./link"]),
      "./sub/",
      "./sub/a file",
      "./z-last",
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
