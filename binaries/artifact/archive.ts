/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Packs candidates with stable entry order and timestamps in their target's archive format. */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { create } from "tar";
import { root } from "../paths.ts";
import { run } from "../process.ts";

const archiveTime = new Date("2000-01-01T00:00:00Z");

/** Packs an owned candidate without owner identity, with one fixed timestamp and a sorted entry order. */
export async function writeNativeArchive(installation: string, archive: string): Promise<void> {
  if (archive.endsWith(".zip")) {
    await run(process.platform === "win32" ? "python" : "python3", [
      join(root, "binaries/windows/pack-zip.py"),
      installation,
      archive,
    ]);
    return;
  }
  const paths = ["."];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(join(installation, directory), { withFileTypes: true })) {
      const path = directory + "/" + entry.name;
      paths.push(path);
      if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(".");
  await create({
    file: archive,
    cwd: installation,
    gzip: { level: 9 },
    // Portable headers omit the builder's user, group, device, and access times.
    portable: true,
    mtime: archiveTime,
    noDirRecurse: true,
    // Portable mode also drops directory times; keep the fixed time so extraction never dates directories 1970.
    onWriteEntry: entry => {
      entry.noMtime = false;
    },
  }, paths.sort());
  // node-tar writes PAX or GNU metadata for a name that a plain header cannot hold, such as a non-ASCII or
  // very long one, and tar readers apply such metadata differently, so the archive must not contain any.
  const problem = await plainUstarProblem(archive);
  if (problem !== undefined) throw new Error(`${archive} is not a plain USTAR archive: ${problem}`);
}

/** The header types that the packer writes: regular files, directories and symbolic links. */
const plainTypes: ReadonlySet<string> = new Set(["0", "5", "2"]);

/**
 * Returns why the packer's own output is not plain POSIX USTAR, or `undefined` when it is: every header must
 * be a file, directory or symbolic link with the USTAR signature, an octal size and printable ASCII names.
 * It only checks what node-tar can write for an unusual payload, not archives from elsewhere: the release job
 * trusts the archives of its own workflow run. It reads the archive as a stream and skips each member's data.
 */
async function plainUstarProblem(archive: string): Promise<string | undefined> {
  let pending = Buffer.alloc(0);
  let skip = 0;
  for await (const chunk of createReadStream(archive).pipe(createGunzip())) {
    const data = chunk as Buffer;
    const skipped = Math.min(skip, data.length);
    skip -= skipped;
    pending = Buffer.concat([pending, data.subarray(skipped)]);
    while (skip === 0 && pending.length >= 512) {
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);
      if (header.every(byte => byte === 0)) return undefined;
      const text = (offset: number, length: number): string =>
        header.toString("latin1", offset, offset + length).replace(/\0.*$/s, "");
      const name = (text(345, 155) === "" ? "" : text(345, 155) + "/") + text(0, 100);
      const type = header.toString("latin1", 156, 157);
      if (!plainTypes.has(type)) return `unsupported header type ${JSON.stringify(type)}: ${name}`;
      if (header.toString("latin1", 257, 265) !== "ustar\u000000") {
        return "not a USTAR header: " + name;
      }
      if (![text(0, 100), text(157, 100), text(345, 155)].every(field =>
        /^[\u0020-\u007E]*$/.test(field)
      )) {
        return "name outside printable ASCII: " + name;
      }
      const size = /^([0-7]{1,11})[ \0]+$/.exec(header.toString("latin1", 124, 136))?.[1];
      if (size === undefined) return "invalid size field: " + name;
      const member = 512 * Math.ceil(Number.parseInt(size, 8) / 512);
      const available = Math.min(member, pending.length);
      pending = pending.subarray(available);
      skip = member - available;
    }
  }
  return "the archive has no end marker";
}
