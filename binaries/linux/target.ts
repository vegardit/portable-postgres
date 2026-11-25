/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Architecture identities used by native Linux builds, ELF validation and clean Docker consumers. */
export const linuxTargets = {
  "linux-x64-glibc": {
    output: "linux-x64",
    platform: "linux/amd64",
    gnuArch: "x86_64",
    loader: "ld-linux-x86-64.so.2",
    machine: 62,
  },
  "linux-arm64-glibc": {
    output: "linux-arm64",
    platform: "linux/arm64",
    gnuArch: "aarch64",
    loader: "ld-linux-aarch64.so.1",
    machine: 183,
  },
} as const;

export type LinuxTarget = keyof typeof linuxTargets;

export function isLinuxTarget(value: string | undefined): value is LinuxTarget {
  return value !== undefined && Object.hasOwn(linuxTargets, value);
}

export function nativeLinuxTarget(): LinuxTarget {
  const target = `linux-${process.arch}-glibc`;
  if (process.platform !== "linux" || !isLinuxTarget(target)) {
    throw new Error(
      "This recipe requires Linux x64 or arm64. See CONTRIBUTING.md for the build container.",
    );
  }
  return target;
}
