/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Acquires reviewed build archives; only digest-verified inputs reach extraction or execution. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileSha256 } from "../hash.ts";
import sourceInputs from "./sources.json" with { type: "json" };

export const sources = sourceInputs;
export type Source = (typeof sources)[number];

export async function verifyArchive(path: string, expectedSha256: string): Promise<void> {
  if (await fileSha256(path) !== expectedSha256) {
    throw new Error(`Source integrity check failed: ${path}`);
  }
}

/** Cache file name of one pinned archive; the digest keeps different pins of a source apart. */
export function cachedArchivePath(directory: string, id: string, sha256: string): string {
  return join(directory, `${id}-${sha256}.archive`);
}

/**
 * Downloads one archive into the cache with a size limit and returns its path and SHA-256. With an expected
 * digest, a mismatching download is discarded; without one, the caller records the digest as a new pin.
 */
export async function downloadArchive(
  directory: string,
  id: string,
  url: string,
  expectedSha256?: string,
): Promise<{ path: string; sha256: string }> {
  await mkdir(directory, { recursive: true });
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Source download failed: ${id} (HTTP ${response.status})`);
  }
  // Unique staging files prevent interrupted or competing downloads from becoming trusted inputs.
  const staging = join(directory, `${id}.${randomUUID()}.partial`);
  const digest = createHash("sha256");
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      digest.update(chunk);
      callback(
        bytes > 128 * 1024 * 1024 ? new Error("Source archive exceeds 128 MiB") : null,
        chunk,
      );
    },
  });
  const file = await open(staging, "wx");
  try {
    await pipeline(Readable.fromWeb(response.body), limit, file.createWriteStream());
    const sha256 = digest.digest("hex");
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw new Error(`Source integrity check failed: ${id} from ${url}`);
    }
    const path = cachedArchivePath(directory, id, sha256);
    await rename(staging, path);
    return { path, sha256 };
  } catch (error) {
    try {
      await file.close();
      await rm(staging, { force: true });
    } catch (cleanupError) {
      console.warn(`Could not remove incomplete source download ${staging}`, cleanupError);
    }
    throw error;
  }
}

/**
 * Downloads or reuses each pinned archive and returns the verified path per source ID. Cache files are
 * named by digest, so builds with different pins can share the cache without replacing each other's inputs.
 */
export async function fetchSources(
  directory: string,
  inputs: ReadonlyArray<Pick<Source, "id" | "version" | "url" | "sha256">> = sources,
): Promise<Map<string, string>> {
  await mkdir(directory, { recursive: true });
  const paths = new Map<string, string>();
  for (const source of inputs) {
    const archive = cachedArchivePath(directory, source.id, source.sha256);
    paths.set(source.id, archive);
    const existing = await stat(archive).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing) {
      await verifyArchive(archive, source.sha256);
      console.log(`Verified cached source: ${source.id} ${source.version}`);
      continue;
    }
    await downloadArchive(directory, source.id, source.url, source.sha256);
    console.log(`Verified downloaded source: ${source.id} ${source.version}`);
  }
  return paths;
}
