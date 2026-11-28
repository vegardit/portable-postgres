/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Architecture and libc identities used by Linux builds, ELF validation and clean Docker consumers. */
import glibc from "./base.json" with { type: "json" };
import musl from "./musl.json" with { type: "json" };

export const linuxBases = { glibc, musl } as const;

export const linuxTargets = {
  "linux-x64-glibc": {
    libc: "glibc",
    output: "linux-x64",
    platform: "linux/amd64",
    gnuArch: "x86_64",
    loader: "ld-linux-x86-64.so.2",
    machine: 62,
  },
  "linux-arm64-glibc": {
    libc: "glibc",
    output: "linux-arm64",
    platform: "linux/arm64",
    gnuArch: "aarch64",
    loader: "ld-linux-aarch64.so.1",
    machine: 183,
  },
  "linux-x64-musl": {
    libc: "musl",
    output: "linux-x64-musl",
    platform: "linux/amd64",
    gnuArch: "x86_64",
    loader: "ld-musl-x86_64.so.1",
    machine: 62,
  },
  "linux-arm64-musl": {
    libc: "musl",
    output: "linux-arm64-musl",
    platform: "linux/arm64",
    gnuArch: "aarch64",
    loader: "ld-musl-aarch64.so.1",
    machine: 183,
  },
} as const;

export type LinuxTarget = keyof typeof linuxTargets;

/** Both Linux recipes hash this module so a compiler selection change requires a fresh SDK. */
export function compilerFor(target: LinuxTarget): string {
  const { libc } = linuxTargets[target];
  const { llvm } = linuxBases[libc];
  return libc === "musl" ? `/usr/lib/llvm${llvm}/bin/clang` : `clang-${llvm}`;
}

export function isLinuxTarget(value: string | undefined): value is LinuxTarget {
  return value !== undefined && Object.hasOwn(linuxTargets, value);
}

export function nativeLinuxTarget(): LinuxTarget {
  const report = process.platform === "linux" ? process.report.getReport() : undefined;
  const libc = (report as { header: { glibcVersionRuntime?: string } } | undefined)
      ?.header.glibcVersionRuntime
    ? "glibc"
    : "musl";
  const target = `linux-${process.arch}-${libc}`;
  if (process.platform !== "linux" || !isLinuxTarget(target)) {
    throw new Error(
      "This recipe requires Linux x64 or arm64. See CONTRIBUTING.md for the build container.",
    );
  }
  return target;
}
