/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Finds newer upstream releases for the pinned sources and records their URLs, digests, and packaging revision. */
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod";
import { writeJson } from "../files.ts";
import { root, workRoot } from "../paths.ts";
import { capture } from "../process.ts";
import { compareVersions } from "./compare-versions.ts";

/** Where a source's releases come from; the archive URL is derived from it and the chosen version. */
export type Upstream =
  | { type: "postgresql"; major: number }
  | {
    type: "github";
    repository: string;
    tagPrefix: string;
    releaseAsset?: string;
    series?: string;
  };

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
export function newestTagVersion(
  tags: string[],
  prefix: string,
  series?: string,
): string | undefined {
  const versions = tags.filter(tag => tag.startsWith(prefix)).map(tag => tag.slice(prefix.length))
    .filter(version =>
      /^\d+(?:\.\d+)+$/.test(version)
      && (series === undefined || version.slice(0, version.lastIndexOf(".")) === series)
    );
  return versions.sort(compareVersions).at(-1);
}

/** Returns the newest minor release of one PostgreSQL major from the source directory listing. */
export function newestPostgresqlVersion(listing: string, major: number): string | undefined {
  const versions = [...listing.matchAll(/href="v(\d+\.\d+)\/"/g)].map(match => match[1]!)
    .filter(version => version.startsWith(major + "."));
  return versions.sort(compareVersions).at(-1);
}

export function archiveUrl(upstream: Upstream, version: string): string {
  if (upstream.type === "postgresql") {
    return `https://ftp.postgresql.org/pub/source/v${version}/postgresql-${version}.tar.bz2`;
  }
  // ICU's release archive includes generated locale data that the repository tag archive omits.
  if (upstream.releaseAsset) {
    return `https://github.com/${upstream.repository}/releases/download/${upstream.tagPrefix}${version}/`
      + upstream.releaseAsset.replaceAll("{version}", version);
  }
  return `https://codeload.github.com/${upstream.repository}/tar.gz/refs/tags/${upstream.tagPrefix}${version}`;
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
      upstream.series,
    );
  if (!version) throw new Error("No release found for " + JSON.stringify(upstream));
  return version;
}

const githubRelease = z.object({
  assets: z.array(z.object({ browser_download_url: z.string(), digest: z.string().nullish() })),
});

/** Downloads a release into the source cache and checks the published digest for release assets. */
export async function downloadReleaseDigest(
  downloads: string,
  source: PinnedSource,
  url: string,
  version: string,
): Promise<string> {
  const { upstream } = source;
  let expectedSha256: string | undefined;
  if (upstream.type === "postgresql" || source.id === "openssl" || source.id === "lz4") {
    // These publishers provide the checksum alongside the release tarball.
    const published = (await fetchText(url + ".sha256")).trim().split(/\s+/)[0];
    if (!published || !/^[a-f0-9]{64}$/.test(published)) {
      throw new Error("Unreadable published checksum for " + url);
    }
    expectedSha256 = published;
  } else if (upstream.releaseAsset) {
    const tag = upstream.tagPrefix + version;
    const release = githubRelease.parse(JSON.parse(
      await fetchText(`https://api.github.com/repos/${upstream.repository}/releases/tags/${tag}`),
    ));
    // One release can contain several archives and their signatures, each with a different digest.
    const asset = release.assets.find(entry => entry.browser_download_url === url);
    expectedSha256 = /^sha256:([a-f0-9]{64})$/.exec(asset?.digest ?? "")?.[1];
    if (!expectedSha256) throw new Error("Missing or invalid release asset SHA-256 for " + url);
  }
  // Only GitHub's generated tag archives have no published digest to check.
  // The downloader also imports the checkout's pins. Load it only after the CLI holds the update lock.
  const { downloadArchive } = await import("./sources.ts");
  return (await downloadArchive(downloads, source.id, url, expectedSha256)).sha256;
}

/** Whether the release for the current version already exists, which needs the tags in the checkout. */
function released(tag: string): boolean {
  return capture("git", ["tag", "--list", tag]).trim() === tag;
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

async function updateCheckout(summaryPath: string | undefined): Promise<void> {
  const sourcesPath = pinFiles.sources;
  const revisionPath = pinFiles.revision;
  const inputs = JSON.parse(await readFile(sourcesPath, "utf8")) as PinnedSource[];
  const revision = JSON.parse(await readFile(revisionPath, "utf8")) as {
    packagingRevision: number;
  };
  const { sources, changes } = await updatePins(inputs, {
    newestVersion,
    digest: (source, url, version) =>
      downloadReleaseDigest(join(workRoot, "downloads"), source, url, version),
  });
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
      "Its job summary lists reopened license reviews and up to 20 notice signature changes per component.",
      "Compare each uploaded review draft with the target's tracked review to see every change.",
      "Check each updated source's release notes for bundled code that brings no new detected notice.",
      "Update the target review files on this pull request and check the new evidence before merging.",
      "See the license review instructions in CONTRIBUTING.md.",
    ].join("\n") + "\n";
    console.log(summary);
    if (summaryPath) await writeFile(summaryPath, summary);
  }
}

if (import.meta.main) {
  // Strict parsing: a misspelled flag must fail the scheduled update, not silently drop its summary.
  const summaryPath = parseArgs({ options: { summary: { type: "string" } } }).values.summary;
  const lock = join(workRoot, "update-pins.lock");
  await mkdir(workRoot, { recursive: true });
  // The revision depends on both original files. Reserve the checkout before reading either one.
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `Another source update holds ${lock}. If the updater was interrupted, confirm it has stopped before removing the lock and retrying.`,
      { cause: error },
    );
  }
  try {
    await updateCheckout(summaryPath);
  } finally {
    await rmdir(lock);
  }
}
