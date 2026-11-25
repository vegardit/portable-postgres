/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Derives release names from the pinned PostgreSQL version and the tracked packaging revision. */
import type { ArtifactTarget } from "../artifact/runtime-layout.ts";
import revision from "./revision.json" with { type: "json" };
import { sources } from "./sources.ts";

/**
 * Counts the released packagings of one PostgreSQL release. Changes to the archives join the current
 * revision until it has been released; only then does the next change take a new value.
 */
export const packagingRevision: number = revision.packagingRevision;

/**
 * Returns a name such as `18.7-r1`. A three-part form would read like a PostgreSQL version,
 * and PostgreSQL itself has used two-part versions since release 10.
 */
export function nativeVersion(): string {
  const postgresql = sources.find(source => source.id === "postgresql");
  if (!postgresql || !/^\d+\.\d+$/.test(postgresql.version)) {
    throw new Error("The PostgreSQL pin must name a major.minor release");
  }
  if (!Number.isSafeInteger(packagingRevision) || packagingRevision < 1) {
    throw new Error("The packaging revision must be a positive integer");
  }
  return `${postgresql.version}-r${packagingRevision}`;
}

/** Compares dotted numeric versions such as `2.35` or `1.10.0`; `1.10` is newer than `1.9`. */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The Git tag of a native release; the prefix keeps it apart from future wrapper tags. */
export function nativeReleaseTag(): string {
  return "native-v" + nativeVersion();
}

export function nativeArchiveName(target: ArtifactTarget): string {
  const extension = target === "windows-x64" ? "zip" : "tar.gz";
  return `portable-postgres-${nativeVersion()}-${target}.${extension}`;
}
