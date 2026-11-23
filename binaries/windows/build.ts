/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Builds isolated Windows candidates; reassembly never reuses a mismatched source identity. */
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { release, tmpdir } from "node:os";
import { applyPatchFile } from "../patch.ts";
import { fetchSources, sources } from "../sources/sources.ts";
import windowsTools from "./tools.json" with { type: "json" };
import { hostMeasurementEvidence, visualStudioReleaseGap } from "../artifact/artifact.ts";
import { sourceNoticesFile, writeSourceNoticeScan } from "../artifact/notice-scan.ts";
import { verifyNoticeAnchors } from "../artifact/notices.ts";
import { reviewFiles } from "../artifact/review.ts";
import { inspectWindowsRuntime } from "./imports.ts";
import { auditWindowsLinks, linkEnvironmentFile, parseLinkEnvironment } from "./links.ts";
import { requireApacheOnlyTimescaleDB } from "../timescaledb.ts";
import { installWindowsSql } from "./sql.ts";
import { msvcRuntimeNotice, selectVisualStudio, visualStudioEvidence } from "./visual-studio.ts";
import {
  type NativeBuild,
  packageCandidate,
  readBuild,
  recipeIdentity,
  recordBuild,
  recordedToolchain,
} from "../package.ts";
import { outputRoot, root, workRoot } from "../paths.ts";
import { buildJobs, capture, run } from "../process.ts";

// From the repository, because the compiled copy of this module in dist has none of these files.
const recipeRoot = join(root, "binaries/windows");

/**
 * Patches applied to the extracted sources before compiling, sorted by path, which is the order they apply in.
 * A patch in `patches/<source ID>/` changes that source, so the recipe identity, which hashes each file with its
 * path, also covers what each patch changes and in which order.
 * docs/native-artifact.md ("Source patches") explains why each one exists and when it goes.
 */
export const windowsPatches: ReadonlyArray<{ source: string; file: string }> = [
  "postgresql/18-radius-in6addr-any.patch",
].sort().map(path => ({ source: path.split("/")[0]!, file: join(recipeRoot, "patches", path) }));

/**
 * These scripts, the source patches and the code that applies them, the SQL installer, and the tool pins
 * determine the development installation. Reassembly also relies on the fresh build's notice scan and
 * TimescaleDB check.
 */
export const windowsRecipe: readonly string[] = [
  ...[
    "build.cmd",
    "build-extensions.cmd",
    "link-recipe.ts",
    "links.ts",
    "extensions/CMakeLists.txt",
    "icu/CMakeLists.txt",
    "icu/meson.ini",
    "sql.ts",
    "requirements.txt",
    "tools.json",
  ].map(file => join(recipeRoot, file)),
  join(root, "binaries/patch.ts"),
  join(root, "binaries/artifact/data-library.ts"),
  join(root, "binaries/artifact/notice-scan.ts"),
  join(root, "binaries/timescaledb.ts"),
  ...windowsPatches.map(patch => patch.file),
];

/** The isolated environment whose Meson build.cmd runs, as CONTRIBUTING.md creates it. */
const toolchainPython = join(workRoot, "windows-toolchain/Scripts/python.exe");
const installRequirements = "& binaries/work/windows-toolchain/Scripts/python.exe -m pip install"
  + " --require-hashes --only-binary=:all: -r binaries/windows/requirements.txt";

/**
 * Stops a fresh build whose Meson is not the pinned one. The recipe identity covers the pin rather than the
 * installed tool, so the build would otherwise be recorded as made by a recipe that it did not follow.
 */
export function requirePinnedMeson(installed: string, requirements: string): void {
  const pinned = /^meson==(\S+)/m.exec(requirements)?.[1];
  if (pinned === undefined) throw new Error("binaries/windows/requirements.txt must pin meson.");
  if (installed !== pinned) {
    throw new Error(
      `The Windows build environment has Meson ${installed}, but binaries/windows/requirements.txt pins`
        + ` ${pinned}. Install the pinned requirements:\n${installRequirements}`,
    );
  }
}

export async function build(command: string = "build"): Promise<void> {
  if (command !== "build" && command !== "assemble") throw new Error("Expected build or assemble.");
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("Windows x64 is required.");
  }
  const downloads = join(workRoot, "downloads");
  const output = join(outputRoot, "windows-x64");
  const systemTar = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32/tar.exe");
  const recipe = await recipeIdentity(windowsRecipe);
  let current: NativeBuild;
  if (command === "build") {
    if (!existsSync(toolchainPython)) {
      throw new Error(
        "Create the isolated Meson environment first, as CONTRIBUTING.md shows: " + toolchainPython,
      );
    }
    requirePinnedMeson(
      capture(toolchainPython, ["-m", "mesonbuild.mesonmain", "--version"]).trim(),
      await readFile(join(recipeRoot, "requirements.txt"), "utf8"),
    );
    // Extraction must read the exact files that fetching verified.
    const archives = await fetchSources(downloads);
    const tools = await fetchSources(downloads, windowsTools);
    // Sources, objects, and the SDK must never carry material from a previous input identity.
    const buildWork = await mkdtemp(join(workRoot, "windows-build-"));
    // Meson uses the PostgreSQL name in the prefix to keep the SDK directories flat.
    current = { buildWork, developmentInstallation: join(buildWork, "postgresql-sdk"), recipe };
    // NOTE: Windows bsdtar's external bzip2 helper stalled locally. Reconsider 7-Zip when native decoding works.
    const expandedArchive = join(buildWork, "windows-postgresql.tar");
    const archiveOutput = openSync(expandedArchive, "w");
    try {
      await run("7z", ["x", "-so", archives.get("postgresql")!], { stdout: archiveOutput });
    } finally {
      closeSync(archiveOutput);
    }
    for (const source of sources) {
      const destination = join(buildWork, "windows-sources", source.id);
      await mkdir(destination, { recursive: true });
      await run(systemTar, [
        "-xf",
        source.id === "postgresql" ? expandedArchive : archives.get(source.id)!,
        "--strip-components=1",
        "-C",
        destination,
      ]);
    }
    // Before patching and compiling: a source update that changed a fact behind a project notice fails here.
    await verifyNoticeAnchors(join(buildWork, "windows-sources"));
    // The upstream text, before the project's patches change it.
    await writeSourceNoticeScan(
      join(buildWork, "windows-sources"),
      sources.map(source => source.id),
      join(buildWork, sourceNoticesFile),
    );
    for (const patch of windowsPatches) {
      await applyPatchFile(join(buildWork, "windows-sources", patch.source), patch.file);
      console.log(`Applied source patch: ${patch.source} ${basename(patch.file)}`);
    }
    await run("7z", [
      "x",
      tools.get("winflexbison")!,
      "-o" + join(buildWork, "windows-tools/winflexbison"),
      "-y",
    ]);
    const visualStudio = selectVisualStudio();
    // Relative to the repository root, where run() starts every tool: cmd.exe would split an absolute
    // path at a character such as "&", which a checkout directory may contain.
    await run("cmd.exe", ["/d", "/c", relative(root, join(recipeRoot, "build.cmd"))], {
      env: {
        ...process.env,
        PORTABLE_PG_WORK: buildWork,
        PORTABLE_PG_PREFIX: current.developmentInstallation,
        PORTABLE_PG_VISUAL_STUDIO: visualStudio,
        BUILD_JOBS: buildJobs(),
      },
    });
    await requireApacheOnlyTimescaleDB(
      join(buildWork, "windows-timescaledb"),
      join(buildWork, "windows-sources", "timescaledb"),
    );
    const toolset = (await readFile(join(buildWork, "windows-msvc-toolset.txt"), "utf8")).trim();
    const { sdkVersion } = parseLinkEnvironment(
      await readFile(join(buildWork, linkEnvironmentFile), "utf8"),
    );
    current.toolchainEvidence = visualStudioEvidence(visualStudio, toolset, sdkVersion);
    await installWindowsSql(join(buildWork, "windows-sources"), current.developmentInstallation);
    await recordBuild(output, current);
  } else {
    current = await readBuild(output, recipe);
    // Notice pins can change while the source archives and compiled SDK stay the same.
    await verifyNoticeAnchors(join(current.buildWork, "windows-sources"));
  }
  const toolchain = recordedToolchain(current);
  const gap = visualStudioReleaseGap(toolchain);
  if (gap !== undefined) {
    console.warn("This build can only produce a candidate, not a release: " + gap);
  }
  // A candidate notice is written per assembly, so that two assemblies of one build never share a file.
  const notices = await mkdtemp(join(tmpdir(), "portable-postgres-notices-"));
  try {
    const candidate = await packageCandidate({
      target: "windows-x64",
      output,
      reviewFile: reviewFiles["windows-x64"],
      sourceRoot: join(current.buildWork, "windows-sources"),
      build: current,
      toolchainNotices: [await msvcRuntimeNotice(toolchain, notices)],
      hostEvidence: async installation => {
        // The candidate's images, on every assembly: a reassembly reuses a development installation
        // that may have changed since its build.
        const links = await auditWindowsLinks(installation, current.buildWork, command);
        const linked = [...links.staticMicrosoftCode]
          .map(([library, { size }]) =>
            `${basename(library)} (${size} ${size === 1 ? "member" : "members"})`
          );
        console.log(
          `Static Microsoft code linked into ${links.images} PE images: ${linked.join(", ")}`,
        );
        return [
          ...toolchain,
          {
            component: "Windows kernel",
            version: release(),
            evidence:
              "os.release on the build host; supported minima require clean-consumer evidence",
          },
          {
            component: hostMeasurementEvidence["windows-x64"],
            version: (await inspectWindowsRuntime(installation)).join(", "),
            evidence:
              "DLL names in the import and delay-import tables of every packaged PE file that the bundle does not supply",
          },
        ];
      },
    });
    console.log("Assembled Windows runtime candidate: " + candidate);
  } finally {
    await rm(notices, { recursive: true, force: true });
  }
}

if (import.meta.main) await build(process.argv[2]);
