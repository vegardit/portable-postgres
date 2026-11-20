/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Names and copies the upstream licence notices that belong to the runtime payload. */
import { cp, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { sources } from "../sources/sources.ts";

/** Header files retained for their licence text use a text suffix because the runtime excludes SDK headers. */
export function additionalNoticeName(sourceId: string, file: string): string {
  return sourceId + "-" + file.replaceAll("/", "-") + (/\.h$/i.test(file) ? ".txt" : "");
}

/**
 * Preserves exact upstream license and attribution texts alongside the source-input manifest.
 * `toolchainNotices` are the project's own texts for linked toolchain code that has no upstream notice.
 * `prefix` is a fresh candidate, so only the current pins' notices are there.
 */
export async function copySourceNotices(
  sourceRoot: string,
  prefix: string,
  toolchainNotices: readonly string[] = [],
): Promise<void> {
  const notices = join(prefix, "notices");
  await mkdir(notices, { recursive: true });
  for (const source of sources) {
    await cp(join(sourceRoot, source.id, source.licenseFile), join(notices, source.id + ".txt"));
    if ("noticeFiles" in source) {
      for (const file of source.noticeFiles ?? []) {
        await cp(
          join(sourceRoot, source.id, file),
          join(notices, additionalNoticeName(source.id, file)),
        );
      }
    }
  }
  for (const notice of toolchainNotices) await cp(notice, join(notices, basename(notice)));
  // Record the inputs loaded for this build, even if the repository manifest changes concurrently.
  await writeFile(join(notices, "source-inputs.json"), JSON.stringify(sources, null, 2) + "\n");
}
