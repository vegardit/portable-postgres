/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Reads the load commands of a 64-bit Mach-O image. Validation and packaging read the bytes themselves, so
 * that a macOS archive can be checked on any host and the checks do not depend on how otool formats them.
 * Layouts from <mach-o/loader.h>.
 */

/** The magic of a 64-bit Mach-O image in the byte order of its arm64 and x86-64 hosts. */
export const machO64Magic = 0xFE_ED_FA_CF;
/** Other thin and universal image magics, including the byte-swapped forms. */
export const otherMachOMagics: readonly number[] = [
  0xCF_FA_ED_FE,
  0xFE_ED_FA_CE,
  0xCE_FA_ED_FE,
  0xCA_FE_BA_BE,
  0xBE_BA_FE_CA,
  0xCA_FE_BA_BF,
  0xBF_BA_FE_CA,
];
export const cpuTypeArm64 = 0x01_00_00_0C;
/** dyld recognizes ARM64_ALL and ARM64_V8 as plain arm64. arm64e requires a different ABI. */
export const plainArm64Subtypes: ReadonlySet<number> = new Set([0, 1]);
/** The `LC_BUILD_VERSION` platform of macOS; simulators and other Apple systems have their own. */
export const platformMacOS = 1;

export const fileTypes = { execute: 2, dylib: 6, bundle: 8 } as const;

const loadCommands = {
  loadDylib: 0xC,
  idDylib: 0xD,
  uuid: 0x1B,
  codeSignature: 0x1D,
  lazyLoadDylib: 0x20,
  buildVersion: 0x32,
  loadWeakDylib: 0x80_00_00_18,
  rpath: 0x80_00_00_1C,
  reexportDylib: 0x80_00_00_1F,
  loadUpwardDylib: 0x80_00_00_23,
} as const;
const dylibImports: ReadonlySet<number> = new Set([
  loadCommands.loadDylib,
  loadCommands.lazyLoadDylib,
  loadCommands.loadWeakDylib,
  loadCommands.reexportDylib,
  loadCommands.loadUpwardDylib,
]);

export type MachOImage = {
  cpuType: number;
  cpuSubtype: number;
  fileType: number;
  /** `LC_BUILD_VERSION` platform and minimum OS, as `major.minor` or `major.minor.patch`. */
  platform?: number;
  minimumOS?: string;
  /** Install names of the libraries the image loads, in load-command order. */
  dylibs: string[];
  /** The image's own install name, for a shared library. */
  id?: string;
  rpaths: string[];
  /** `LC_UUID` in lowercase hexadecimal; the linker writes it, and later rewrites keep it. */
  uuid?: string;
  /** The code signature command points to a nonempty region inside the file. */
  signed: boolean;
};

/** Formats a packed `xxxx.yy.zz` version as `LC_BUILD_VERSION` stores it. */
export function machOVersion(packed: number): string {
  const major = packed >>> 16;
  const minor = (packed >>> 8) & 0xFF;
  const patch = packed & 0xFF;
  return `${major}.${minor}` + (patch === 0 ? "" : `.${patch}`);
}

/** Returns the first four bytes in the native image's little-endian byte order. */
export function machOMagic(bytes: Buffer): number | undefined {
  return bytes.length >= 4 ? bytes.readUInt32LE(0) : undefined;
}

/** Recognizes every Mach-O form so an unsupported machine is checked even under a data filename. */
export function hasMachOMagic(bytes: Buffer): boolean {
  const magic = machOMagic(bytes);
  return magic !== undefined && (magic === machO64Magic || otherMachOMagics.includes(magic));
}

/** Parses a 64-bit little-endian Mach-O image and rejects malformed load commands. */
export function readMachO(binary: Buffer): MachOImage {
  if (binary.length < 32 || binary.readUInt32LE(0) !== machO64Magic) {
    throw new Error("not a 64-bit Mach-O image");
  }
  const cpuType = binary.readUInt32LE(4);
  const cpuSubtype = binary.readUInt32LE(8);
  const fileType = binary.readUInt32LE(12);
  const count = binary.readUInt32LE(16);
  const size = binary.readUInt32LE(20);
  const end = 32 + size;
  if (end > binary.length) throw new Error("truncated Mach-O load commands");
  const image: MachOImage = {
    cpuType,
    cpuSubtype,
    fileType,
    dylibs: [],
    rpaths: [],
    signed: false,
  };
  // The string offset and its terminating NUL both belong to this load command.
  const string = (command: number, commandSize: number, offsetField: number): string => {
    const bytes = binary.subarray(command, command + commandSize);
    const start = bytes.readUInt32LE(offsetField);
    const terminator = bytes.indexOf(0, start);
    if (terminator === -1) throw new Error("invalid Mach-O load command string");
    return bytes.toString("utf8", start, terminator);
  };
  let offset = 32;
  for (let index = 0; index < count; index++) {
    if (offset + 8 > end) throw new Error("truncated Mach-O load commands");
    const command = binary.readUInt32LE(offset);
    const commandSize = binary.readUInt32LE(offset + 4);
    if (commandSize < 8 || offset + commandSize > end) {
      throw new Error("invalid Mach-O load command size");
    }
    if (dylibImports.has(command)) image.dylibs.push(string(offset, commandSize, 8));
    else if (command === loadCommands.idDylib) image.id = string(offset, commandSize, 8);
    else if (command === loadCommands.rpath) image.rpaths.push(string(offset, commandSize, 8));
    else if (command === loadCommands.codeSignature) {
      if (commandSize !== 16) throw new Error("invalid Mach-O code signature command size");
      // Unlike the offsets in string commands, dataoff is relative to the start of the file.
      const dataOffset = binary.readUInt32LE(offset + 8);
      const dataSize = binary.readUInt32LE(offset + 12);
      if (dataSize === 0 || dataOffset < end || dataOffset + dataSize > binary.length) {
        throw new Error("invalid Mach-O code signature range");
      }
      image.signed = true;
    } else if (command === loadCommands.uuid && commandSize >= 24) {
      image.uuid = binary.toString("hex", offset + 8, offset + 24);
    } else if (command === loadCommands.buildVersion && commandSize >= 24) {
      image.platform = binary.readUInt32LE(offset + 8);
      image.minimumOS = machOVersion(binary.readUInt32LE(offset + 12));
    }
    offset += commandSize;
  }
  return image;
}
