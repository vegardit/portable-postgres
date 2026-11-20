/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Hashes files the one way that pins, manifests and checksum files record them: SHA-256 as lowercase hex. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Streams the file, so that a source or release archive never has to fit into memory. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
