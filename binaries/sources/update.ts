/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Finds newer upstream releases for the pinned sources and records their URLs, digests, and packaging revision. */
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod";
import { root, workRoot } from "../paths.ts";
import { capture } from "../process.ts";
import { downloadArchive } from "./sources.ts";
import { compareVersions } from "./version.ts";

/** Where a source's releases come from; the archive URL is derived from it and the chosen version. */
export type Upstream =
  | { type: "postgresql"; major: number }
  | { type: "github"; repository: string; tagPrefix: string };

export type PinnedSource = {
  id: string;
  version: string;
  url: string;
  sha256: string;
  upstream: Upstream;
  [key: string]: unknown;
};

export type PinChange = { id: string; from: string; to: string };

/** Returns the newest stable release among tag names; pre-releases and differently named tags are ignored. */
export function newestTagVersion(tags: string[], prefix: string): string | undefined {
  const versions = tags.filter(tag => tag.startsWith(prefix)).map(tag => tag.slice(prefix.length))
    .filter(version => /^\d+(?:\.\d+)+$/.test(version));
  return versions.sort(compareVersions).at(-1);
}

/** Returns the newest minor release of one PostgreSQL major from the source directory listing. */
export function newestPostgresqlVersion(listing: string, major: number): string | undefined {
  const versions = [...listing.matchAll(/href="v(\d+\.\d+)\/"/g)].map(match => match[1]!)
    .filter(version => version.startsWith(major + "."));
  return versions.sort(compareVersions).at(-1);
}

export function archiveUrl(upstream: Upstream, version: string): string {
  return upstream.type === "postgresql"
    ? `https://ftp.postgresql.org/pub/source/v${version}/postgresql-${version}.tar.bz2`
    : `https://codeload.github.com/${upstream.repository}/tar.gz/refs/tags/${upstream.tagPrefix}${version}`;
}

/**
 * A new PostgreSQL release restarts the revision at 1. Any other change starts the next revision only when
 * the current one has been released; changes before that release join the revision that is still open.
 */
export function nextRevision(options: {
  revision: number;
  postgresqlChanged: boolean;
  otherChanged: boolean;
  currentReleased: boolean;
}): number {
  if (options.postgresqlChanged) return 1;
  if (options.otherChanged && options.currentReleased) return options.revision + 1;
  return options.revision;
}

/** Looks up each source's newest release and pins it with the digest of its downloaded archive. */
export async function updatePins(
  inputs: PinnedSource[],
  lookup: {
    newestVersion: (upstream: Upstream) => Promise<string>;
    digest: (source: PinnedSource, url: string, version: string) => Promise<string>;
  },
): Promise<{ sources: PinnedSource[]; changes: PinChange[] }> {
  const changes: PinChange[] = [];
  const updated: PinnedSource[] = [];
  for (const source of inputs) {
    const version = await lookup.newestVersion(source.upstream);
    if (compareVersions(version, source.version) <= 0) {
      updated.push(source);
      continue;
    }
    const url = archiveUrl(source.upstream, version);
    const sha256 = await lookup.digest(source, url, version);
    updated.push({ ...source, version, url, sha256 });
    changes.push({ id: source.id, from: source.version, to: version });
  }
  return { sources: updated, changes };
}

async function fetchText(url: string): Promise<string> {
  const headers: Record<string, string> = { "user-agent": "portable-postgres-source-updater" };
  // A token only raises GitHub's rate limit; public release data needs no permissions.
  if (process.env["GITHUB_TOKEN"] && url.startsWith("https://api.github.com/")) {
    headers["authorization"] = "Bearer " + process.env["GITHUB_TOKEN"];
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Lookup failed: ${url} (HTTP ${response.status})`);
  return response.text();
}

/** GitHub answers a tag lookup with one object per matching ref. */
const matchingRefs = z.array(z.object({ ref: z.string() }));

/** Returns the tag names in GitHub's answer to a tag lookup. */
export function tagNames(answer: unknown): string[] {
  // An answer of another shape must not look like a repository without releases.
  const refs = matchingRefs.safeParse(answer);
  if (!refs.success) {
    throw new Error("Unexpected answer to a GitHub tag lookup:\n" + z.prettifyError(refs.error));
  }
  return refs.data.map(ref => ref.ref.replace(/^refs\/tags\//, ""));
}

async function newestVersion(upstream: Upstream): Promise<string> {
  const version = upstream.type === "postgresql"
    ? newestPostgresqlVersion(
      await fetchText("https://ftp.postgresql.org/pub/source/"),
      upstream.major,
    )
    : newestTagVersion(
      tagNames(JSON.parse(
        await fetchText(
          `https://api.github.com/repos/${upstream.repository}/git/matching-refs/tags/${upstream.tagPrefix}`,
        ),
      )),
      upstream.tagPrefix,
    );
  if (!version) throw new Error("No release found for " + JSON.stringify(upstream));
  return version;
}

async function digest(source: PinnedSource, url: string): Promise<string> {
  const downloads = join(workRoot, "downloads");
  if (source.upstream.type === "postgresql") {
    // PostgreSQL publishes a checksum next to each tarball, an independent check of the downloaded bytes.
    const published = (await fetchText(url + ".sha256")).trim().split(/\s+/)[0];
    if (!published || !/^[a-f0-9]{64}$/.test(published)) {
      throw new Error("Unreadable published checksum for " + url);
    }
    return (await downloadArchive(downloads, source.id, url, published)).sha256;
  }
  // GitHub publishes no digest for tag archives, so the first verified download defines the pin.
  return (await downloadArchive(downloads, source.id, url)).sha256;
}

/** Whether the release for the current version already exists, which needs the tags in the checkout. */
function released(tag: string): boolean {
  return capture("git", ["tag", "--list", tag]).trim() === tag;
}

/** Replaces a JSON file atomically and keeps its line endings, so a checkout shows only the changed values. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const eol = (await readFile(path, "utf8")).includes("\r\n") ? "\r\n" : "\n";
  const staging = path + ".partial";
  await writeFile(staging, JSON.stringify(value, null, 2).replaceAll("\n", eol) + eol);
  await rename(staging, path);
}

/**
 * The tracked files that an update rewrites. tsc copies sources.json next to the compiled modules, so a
 * path next to this module would let a compiled updater rewrite that copy instead of the repository's.
 */
export const pinFiles = {
  sources: join(root, "binaries/sources/sources.json"),
  revision: join(root, "binaries/sources/revision.json"),
};

/**
 * Writes the new packaging revision before the new pins. If the pins are not written, a retry finds the
 * same changes and keeps the unreleased revision. New pins without their revision would look current to
 * a retry, which would then never raise the revision.
 */
export async function writeUpdate(
  paths: { sources: string; revision: string },
  update: { sources: PinnedSource[]; revision: { packagingRevision: number } },
): Promise<void> {
  await writeJson(paths.revision, update.revision);
  await writeJson(paths.sources, update.sources);
}

if (import.meta.main) {
  // Strict parsing: a misspelled flag must fail the scheduled update, not silently drop its summary.
  const summaryPath = parseArgs({ options: { summary: { type: "string" } } }).values.summary;
  const sourcesPath = pinFiles.sources;
  const revisionPath = pinFiles.revision;
  const inputs = JSON.parse(await readFile(sourcesPath, "utf8")) as PinnedSource[];
  const revision = JSON.parse(await readFile(revisionPath, "utf8")) as {
    packagingRevision: number;
  };
  const { sources, changes } = await updatePins(inputs, { newestVersion, digest });
  if (changes.length === 0) {
    console.log("All pinned sources are current.");
  } else {
    const postgresql = inputs.find(source => source.id === "postgresql")!;
    const postgresqlChanged = changes.some(change => change.id === "postgresql");
    const packagingRevision = nextRevision({
      revision: revision.packagingRevision,
      postgresqlChanged,
      otherChanged: changes.some(change => change.id !== "postgresql"),
      currentReleased: !postgresqlChanged
        && released(`native-v${postgresql.version}-r${revision.packagingRevision}`),
    });
    await writeUpdate(
      { sources: sourcesPath, revision: revisionPath },
      { sources, revision: { ...revision, packagingRevision } },
    );
    const version = sources.find(source => source.id === "postgresql")!.version;
    const summary = [
      `Updates the pinned sources for native release \`${version}-r${packagingRevision}\`.`,
      "",
      "| Source | From | To |",
      "| ------ | ---- | -- |",
      ...changes.map(change => `| ${change.id} | ${change.from} | ${change.to} |`),
      "",
      "The build checks that every target still compiles and passes the native tests.",
      "Its job summary lists the licence review parts that this update reopens, such as a changed",
      "licence text or new files; if it lists none, the shipped files and licence texts still match",
      "the tracked reviews. That comparison cannot see newly bundled third-party code while the",
      "licence files stay the same, so skim the release notes of each updated source for it.",
      "Review reopened parts before the next release, as described in CONTRIBUTING.md.",
    ].join("\n") + "\n";
    console.log(summary);
    if (summaryPath) await writeFile(summaryPath, summary);
  }
}
