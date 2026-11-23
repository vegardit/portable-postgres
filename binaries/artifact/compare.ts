/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Compares what two targets ship, because each target installs its extensions with a different recipe. */
import { posix } from "node:path";
import type { ArtifactManifest } from "./artifact.ts";

type Payload = Pick<
  ArtifactManifest,
  "target" | "postgresqlVersion" | "sources" | "extensions" | "files"
>;

/** Lists shipped extension files that no extension entry accounts for, such as plain install scripts. */
function otherExtensionFiles(payload: Payload): Set<string> {
  const listed = new Set(
    payload.extensions.flatMap(extension => [extension.control, ...extension.sql]),
  );
  return new Set(
    payload.files.map(file => file.path).filter(path =>
      path.startsWith("share/extension/") && !listed.has(path)
    ).map(path => posix.basename(path)),
  );
}

/** Compares each target with the first. A release rehearsal may have only one archive. */
export function compareTargets(first: Payload, ...others: Payload[]): string[] {
  return others.flatMap(other => {
    const differences = comparePair(first, other);
    // "Only in" describes one pair, even when a third target also ships the file.
    return others.length > 1
      ? differences.map(difference => `${first.target} vs ${other.target}: ${difference}`)
      : differences;
  });
}

function comparePair(left: Payload, right: Payload): string[] {
  const differences: string[] = [];
  function reportFileDifferences(
    label: string,
    leftFiles: ReadonlySet<string>,
    rightFiles: ReadonlySet<string>,
  ): void {
    for (const [target, here, there] of [
      [left.target, leftFiles, rightFiles],
      [right.target, rightFiles, leftFiles],
    ] as const) {
      const extra = [...here].filter(file => !there.has(file)).sort();
      if (extra.length > 0) differences.push(`${label} only in ${target}: ${extra.join(", ")}`);
    }
  }

  if (left.postgresqlVersion !== right.postgresqlVersion) {
    differences.push(
      `PostgreSQL version: ${left.postgresqlVersion} (${left.target}) vs ${right.postgresqlVersion} (${right.target})`,
    );
  }
  const pins = (payload: Payload): string =>
    payload.sources.map(source => `${source.id}@${source.version}#${source.sha256}`).sort().join(
      " ",
    );
  if (pins(left) !== pins(right)) {
    differences.push(`source pins differ between ${left.target} and ${right.target}`);
  }
  const describe = (
    payload: Payload,
  ): Map<string, { version: string; sql: Set<string>; libraries: Set<string> }> =>
    new Map(payload.extensions.map(extension => [extension.name, {
      version: extension.version,
      // Names only: SQL bytes differ legitimately, as TimescaleDB writes CRLF on Windows and pgTAP
      // embeds the operating system name; the source pins already prove the same upstream SQL.
      sql: new Set(extension.sql.map(path => posix.basename(path))),
      // Library names differ only in the platform suffix.
      libraries: new Set(
        extension.libraries.map(path => posix.basename(path).replace(/\.(dll|so|dylib)$/, "")),
      ),
    }]));
  const leftExtensions = describe(left);
  const rightExtensions = describe(right);
  for (const name of new Set([...leftExtensions.keys(), ...rightExtensions.keys()])) {
    const one = leftExtensions.get(name);
    const other = rightExtensions.get(name);
    if (!one || !other) {
      differences.push(`${name}: only in ${one ? left.target : right.target}`);
      continue;
    }
    if (one.version !== other.version) {
      differences.push(
        `${name}: version ${one.version} (${left.target}) vs ${other.version} (${right.target})`,
      );
    }
    for (const kind of ["sql", "libraries"] as const) {
      reportFileDifferences(`${name}: ${kind}`, one[kind], other[kind]);
    }
  }
  // Extension entries list only version scripts, so compare every other shipped extension file directly.
  reportFileDifferences("share/extension files", otherExtensionFiles(left),
    otherExtensionFiles(right));
  return differences;
}
