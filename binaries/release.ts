/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Checks built archives against the release version and writes the checksums, descriptor, notes, and source
 * bundle to publish.
 *
 * It does not extract or validate the archives again. Each build job validates its archive after packing:
 * it unpacks the finished archive with GNU tar, runs the native tests on that tree, and in release mode runs
 * release validation on it before uploading. The release job trusts the archives of its own workflow run,
 * because whoever could change one there could also change the manifest and review that it would be checked
 * against. It checks what the build jobs cannot: that every archive belongs to this version and checkout,
 * passed its review, exists for every target, and ships the same contents as the others.
 */
import { appendFile, copyFile, mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { list } from "tar";
import {
  type ArtifactManifest,
  artifactManifestName,
  type ArtifactTarget,
  matchesReleaseSource,
  parseArtifactManifest,
  toolchainNotices,
} from "./artifact/artifact.ts";
import { compareTargets } from "./artifact/compare.ts";
import { fileSha256 } from "./hash.ts";
import { artifactTargets } from "./artifact/runtime-layout.ts";
import { root, workRoot } from "./paths.ts";
import { sourceBundleName, writeSourceBundle } from "./source-bundle.ts";
import { fetchSources, sources } from "./sources/sources.ts";
import {
  nativeArchiveName,
  nativeReleaseTag,
  nativeVersion,
  packagingRevision,
} from "./sources/version.ts";

/** Reads the manifest from inside the archive, so the published metadata is the one the archive carries. */
async function archivedManifest(archive: string): Promise<ArtifactManifest> {
  let text: string | undefined;
  await list({
    file: archive,
    filter: path => path === "./" + artifactManifestName || path === artifactManifestName,
    onReadEntry: entry => {
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => chunks.push(chunk));
      entry.on("end", () => {
        text = Buffer.concat(chunks).toString("utf8");
      });
    },
  });
  if (text === undefined) {
    throw new Error("Archive has no " + artifactManifestName + ": " + archive);
  }
  return parseArtifactManifest(text);
}

export type PreparedRelease = { tag: string; assets: string[] };

/**
 * The targets that a real release must contain. macOS arm64 has no recipe yet, so no release can be
 * published without it; dry runs check the targets that can be built today.
 */
const releaseTargets: readonly string[] = [...artifactTargets, "macos-arm64"];

/**
 * Prepares the release assets in `output`, a new directory, from the archives that the build jobs uploaded
 * to `downloads`. The downloads stay as they are, and publication reads only the output, so a download that
 * changes later cannot change what was checked.
 * A real release needs every target; a dry run accepts the targets that a local runner could build.
 * `writeSourceBundle` writes the release's source bundle to the file it is given; the command below always
 * passes one, and tests that cover only the archive checks leave it out.
 */
export async function prepareRelease(
  downloads: string,
  output: string,
  repository: string,
  options: { requireAllTargets: boolean; writeSourceBundle?: (file: string) => Promise<void> },
): Promise<PreparedRelease> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Expected owner/repository");
  const version = nativeVersion();
  const tag = nativeReleaseTag();
  const present = new Set(await readdir(downloads));
  const archives = artifactTargets.filter(target => present.has(nativeArchiveName(target)));
  // A dry run may omit a target, but a stale or misnamed project archive is a failed handoff.
  const expected = new Set(artifactTargets.map(nativeArchiveName));
  for (const name of present) {
    if (name.startsWith("portable-postgres-") && name.endsWith(".tar.gz") && !expected.has(name)) {
      throw new Error("Unexpected native archive: " + name);
    }
  }
  if (archives.length === 0) throw new Error("No release archives in " + downloads);
  // A new directory, so that no earlier preparation's assets mix with these.
  await mkdir(output, { mode: 0o700 });
  try {
    return await assemble();
  } catch (error) {
    // A retry with the same output must not find a half-prepared release.
    await rm(output, { recursive: true, force: true });
    throw error;
  }

  async function assemble(): Promise<PreparedRelease> {
    const manifests = new Map<ArtifactTarget, ArtifactManifest>();
    const descriptor: Record<string, { url: string; sha256: string; size: number }> = {};
    const checksums: string[] = [];
    const assets: string[] = [];
    for (const target of archives) {
      const name = nativeArchiveName(target);
      const archive = join(output, name);
      // Publication, metadata inspection and hashing all use this one copy of the download.
      await copyFile(join(downloads, name), archive);
      const file = await open(archive, "r");
      const signature = Buffer.alloc(2);
      try {
        await file.read(signature);
      } finally {
        await file.close();
      }
      // The format and every consumer expect gzip, although the parser would also read a plain tar.
      if (signature[0] !== 0x1F || signature[1] !== 0x8B) {
        throw new Error(name + " is not a gzip archive");
      }
      const manifest = await archivedManifest(archive);
      // A stale or misnamed archive must never be published under this version.
      if (
        manifest.target !== target
        || manifest.postgresqlVersion + "-r" + manifest.packagingRevision !== version
        || manifest.packagingRevision !== packagingRevision
      ) {
        throw new Error(
          `${name} describes ${manifest.target} ${manifest.postgresqlVersion}-r${manifest.packagingRevision}`,
        );
      }
      // Source updates and notice corrections can share an unreleased revision with an earlier archive.
      const stale = [
        ...sources.filter(source => {
          const built = manifest.sources.find(entry => entry.id === source.id);
          return built === undefined || !matchesReleaseSource(built, source);
        }),
        ...manifest.sources.filter(entry => !sources.some(source => source.id === entry.id)),
      ].map(source => source.id);
      if (stale.length > 0) {
        throw new Error(
          `${name} was built from other source pins than this checkout: ${stale.join(", ")}`,
        );
      }
      // The build job ran release validation in release mode; a candidate archive must not be published.
      if (
        options.requireAllTargets
        && (manifest.licenseInventory.status !== "verified" || manifest.hostRequirements === null)
      ) {
        throw new Error(`${name} has not passed the licence and host review`);
      }
      manifests.set(target, manifest);
      const digest = await fileSha256(archive);
      checksums.push(`${digest}  ${name}`);
      descriptor[target] = {
        url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
        sha256: digest,
        size: (await stat(archive)).size,
      };
      const manifestAsset = `portable-postgres-${version}-${target}.native-artifact.json`;
      await writeFile(join(output, manifestAsset), JSON.stringify(manifest, null, 2) + "\n");
      assets.push(name, manifestAsset);
    }
    // Checked after the archives themselves, so that an unreviewed archive is reported even while a target
    // is still missing, which it is for every release until the macOS target exists.
    const prepared: ReadonlySet<string> = new Set(manifests.keys());
    const missing = releaseTargets.filter(target => !prepared.has(target));
    if (options.requireAllTargets && missing.length > 0) {
      throw new Error(`Missing release archives for ${missing.join(", ")} in ${downloads}`);
    }
    const [first, ...others] = [...manifests.values()];
    for (const other of others) {
      const differences = compareTargets(first!, other);
      if (differences.length > 0) {
        throw new Error("Targets ship different contents:\n" + differences.join("\n"));
      }
    }
    // After the archive checks, so that a bundle is only packed for archives that may be published.
    const bundle = sourceBundleName(version);
    if (options.writeSourceBundle !== undefined) {
      await options.writeSourceBundle(join(output, bundle));
      checksums.push(`${await fileSha256(join(output, bundle))}  ${bundle}`);
      assets.push(bundle);
    }
    await writeFile(join(output, "SHA256SUMS"), checksums.sort().join("\n") + "\n");
    const descriptorName = `portable-postgres-${version}.json`;
    await writeFile(
      join(output, descriptorName),
      JSON.stringify({ version, tag, archives: descriptor }, null, 2) + "\n",
    );
    assets.push("SHA256SUMS", descriptorName);
    const lines = [
      `PostgreSQL ${first!.postgresqlVersion}, packaging revision ${packagingRevision}.`,
      "",
      "| Extension | Version |",
      "| --------- | ------- |",
      ...first!.extensions.map(extension => `| ${extension.name} | ${extension.version} |`),
      "",
      "Verify an archive against `SHA256SUMS`, or with `gh attestation verify <archive> --repo "
      + repository + "`.",
      // People download from the release page, so it points to the conditions that the archive carries.
      ...archives.includes("windows-x64")
        ? toolchainNotices("windows-x64").flatMap(notice => [
          "",
          "The Windows archive contains Microsoft runtime code that the linker copies into every program. "
          + `Read \`${notice}\` in the archive before you redistribute it.`,
        ])
        : [],
      ...options.writeSourceBundle === undefined ? [] : [
        "",
        `\`${bundle}\` contains what these archives were built from: this repository at the release commit, `
        + "with the pinned PostgreSQL and extension source archives in the download cache that the build reads. "
        + "It contains no build tools and none of the toolchain code that linking adds.",
      ],
    ];
    await writeFile(join(output, "release-notes.md"), lines.join("\n") + "\n");
    return { tag, assets: assets.sort() };
  }
}

if (import.meta.main) {
  const [downloads, output, repository, flag] = process.argv.slice(2);
  if (
    !downloads || !output || !repository
    || (flag !== undefined && flag !== "--require-all-targets")
  ) {
    throw new Error(
      "Usage: pnpm binaries:release <downloads> <output> <owner/repository> [--require-all-targets]",
    );
  }
  const prepared = await prepareRelease(resolve(downloads), resolve(output), repository, {
    requireAllTargets: flag === "--require-all-targets",
    // Fetching verifies each archive against the pins that the release checked the archives against.
    writeSourceBundle: async file =>
      writeSourceBundle({
        repository: root,
        directory: `portable-postgres-${nativeVersion()}-sources`,
        archives: (await fetchSources(join(workRoot, "downloads"))).values(),
        file,
      }),
  });
  console.log(`Prepared ${prepared.tag}: ${prepared.assets.join(", ")}`);
  if (process.env["GITHUB_OUTPUT"]) {
    await appendFile(
      process.env["GITHUB_OUTPUT"],
      `tag=${prepared.tag}\nassets=${prepared.assets.join(" ")}\n`,
    );
  }
}
