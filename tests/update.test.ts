/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks release discovery, pin rewriting, and packaging revision rules without network access. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sources } from "../binaries/sources/sources.ts";
import {
  archiveUrl,
  newestPostgresqlVersion,
  newestTagVersion,
  nextRevision,
  type PinnedSource,
  tagNames,
  updatePins,
  writeUpdate,
} from "../binaries/sources/update.ts";

it("picks the newest stable tag with the expected prefix", () => {
  const tags = ["v1.9.0", "v1.10.0", "v1.10.0-rc1", "v2.0.0beta", "debian/1.11.0-1", "1.12.0"];
  expect(newestTagVersion(tags, "v")).toBe("1.10.0");
  // TimescaleDB mixes plain release tags with loader tags.
  expect(newestTagVersion(["2.31.2", "loader-2.11.0p1", "2.32.0"], "")).toBe("2.32.0");
  expect(newestTagVersion(["release-1"], "v")).toBeUndefined();
});

it("reads tag names from a tag lookup and refuses any other answer", () => {
  expect(tagNames([{ ref: "refs/tags/v1.2.0", node_id: "x" }, { ref: "refs/tags/v1.3.0" }]))
    .toEqual(["v1.2.0", "v1.3.0"]);
  // GitHub reports a failure as an object; read as a list, it would look like a repository without tags.
  expect(() => tagNames({ message: "Not Found" })).toThrow(
    "Unexpected answer to a GitHub tag lookup",
  );
  expect(() => tagNames([{ name: "v1.2.0" }])).toThrow("Unexpected answer to a GitHub tag lookup");
});

it("stays within the pinned PostgreSQL major", () => {
  const listing = `<a href="v17.9/">v17.9/</a> <a href="v18.6/">v18.6/</a>
    <a href="v18.10/">v18.10/</a> <a href="v19beta1/">v19beta1/</a> <a href="v19.0/">v19.0/</a>`;
  expect(newestPostgresqlVersion(listing, 18)).toBe("18.10");
});

it("derives the same archive URLs that the current pins use", () => {
  for (const source of sources) {
    expect(archiveUrl(source.upstream as PinnedSource["upstream"], source.version), source.id)
      .toBe(source.url);
  }
});

it("a PostgreSQL release restarts the revision, and other changes open the next one once released", () => {
  const base = { revision: 3, postgresqlChanged: false, otherChanged: true };
  expect(nextRevision({ ...base, postgresqlChanged: true, currentReleased: true })).toBe(1);
  expect(nextRevision({ ...base, currentReleased: true })).toBe(4);
  // An unreleased revision collects further updates instead of skipping numbers.
  expect(nextRevision({ ...base, currentReleased: false })).toBe(3);
  expect(nextRevision({ ...base, otherChanged: false, currentReleased: true })).toBe(3);
});

it("an interrupted update never leaves new pins with the old packaging revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "portable-postgres-update-"));
  try {
    const paths = {
      sources: join(directory, "sources.json"),
      revision: join(directory, "revision.json"),
    };
    const before: { sources: PinnedSource[]; revision: { packagingRevision: number } } = {
      sources: [],
      revision: { packagingRevision: 3 },
    };
    await writeFile(paths.sources, JSON.stringify(before.sources) + "\n");
    await writeFile(paths.revision, JSON.stringify(before.revision) + "\n");
    const update = {
      // Only the ID matters to the writer, so the fixture leaves out the other pin fields.
      sources: [{ id: "changed" }] as unknown as PinnedSource[],
      revision: { packagingRevision: 4 },
    };
    const read = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

    // A retry finds current pins and stops, so pins without their revision would never be repaired.
    await mkdir(paths.revision + ".partial");
    await expect(writeUpdate(paths, update)).rejects.toThrow();
    await expect(read(paths.sources)).resolves.toEqual(before.sources);
    await rm(paths.revision + ".partial", { recursive: true });

    // The other way round is safe: the retry finds the same changes and keeps the unreleased revision.
    await mkdir(paths.sources + ".partial");
    await expect(writeUpdate(paths, update)).rejects.toThrow();
    await expect(read(paths.revision)).resolves.toEqual(update.revision);
    expect(
      nextRevision({
        revision: 4,
        postgresqlChanged: false,
        otherChanged: true,
        currentReleased: false,
      }),
    ).toBe(4);
    await rm(paths.sources + ".partial", { recursive: true });
    await writeUpdate(paths, update);
    await expect(read(paths.sources)).resolves.toEqual(update.sources);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rewrites only the version, URL, and digest of sources with a newer release", async () => {
  const inputs: PinnedSource[] = [
    {
      id: "pgvector",
      version: "0.8.7",
      url: "old",
      sha256: "0".repeat(64),
      upstream: { type: "github", repository: "pgvector/pgvector", tagPrefix: "v" },
      license: "PostgreSQL",
      licenseFile: "LICENSE",
    },
    {
      id: "pgtap",
      version: "1.3.4",
      url: "unchanged",
      sha256: "1".repeat(64),
      upstream: { type: "github", repository: "theory/pgtap", tagPrefix: "v" },
    },
  ];
  const downloaded: string[] = [];
  const result = await updatePins(inputs, {
    newestVersion: upstream =>
      Promise.resolve(
        upstream.type === "github" && upstream.repository === "pgvector/pgvector"
          ? "0.9.0"
          : "1.3.4",
      ),
    digest: (_source, url) => {
      downloaded.push(url);
      return Promise.resolve("2".repeat(64));
    },
  });
  expect(result.changes).toEqual([{ id: "pgvector", from: "0.8.7", to: "0.9.0" }]);
  expect(downloaded).toEqual([
    "https://codeload.github.com/pgvector/pgvector/tar.gz/refs/tags/v0.9.0",
  ]);
  expect(result.sources[0]).toEqual({
    ...inputs[0],
    version: "0.9.0",
    url: "https://codeload.github.com/pgvector/pgvector/tar.gz/refs/tags/v0.9.0",
    sha256: "2".repeat(64),
  });
  expect(result.sources[1]).toBe(inputs[1]);
});
