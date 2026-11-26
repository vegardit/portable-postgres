/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/* Checks ELF and PE locale-data layouts for packaging audits and linked-runtime license coverage. */
export function dataOnlyElf(data: Buffer): boolean {
  if (data.length < 64 || data.readBigUInt64LE(24) !== 0n) return false;
  const start = Number(data.readBigUInt64LE(32));
  const size = data.readUInt16LE(54);
  const count = data.readUInt16LE(56);
  if (start < 64 || size < 56 || !count || start + size * count > data.length) return false;
  let loads = 0;
  for (let index = 0; index < count; index++) {
    const header = start + size * index;
    if (data.readUInt32LE(header) !== 1) continue;
    if (data.readUInt32LE(header + 4) & 1) return false;
    loads++;
  }
  return loads > 0;
}

/** A data-only PE library has neither an entry point nor a section containing or executing code. */
export function dataOnlyPe(data: Buffer): boolean {
  if (data.length < 64) return false;
  const pe = data.readUInt32LE(60);
  if (pe + 24 > data.length) return false;
  const count = data.readUInt16LE(pe + 6);
  const optionalSize = data.readUInt16LE(pe + 20);
  const start = pe + 24 + optionalSize;
  if (!count || optionalSize < 20 || start + count * 40 > data.length
    || data.readUInt32LE(pe + 40) !== 0) return false;
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(start + index * 40 + 36) & 0x20_00_00_20) return false;
  }
  return true;
}
