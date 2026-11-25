/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Builds isolated Windows candidates; reassembly never reuses a mismatched source identity. */
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { release } from "node:os";
import { applyPatchFile } from "../patch.ts";
import { fetchSources, sources } from "../sources/sources.ts";
import windowsTools from "./tools.json" with { type: "json" };
import clang64 from "./clang64.json" with { type: "json" };
import { compileMingw, mingwLinkEvidence } from "./mingw.ts";
import { mingwNotice } from "../artifact/runtime-layout.ts";
import { hostMeasurementEvidence } from "../artifact/artifact.ts";
import { sourceNoticesFile, writeSourceNoticeScan } from "../artifact/notice-scan.ts";
import { verifyNoticeAnchors } from "../artifact/notices.ts";
import { reviewFiles } from "../artifact/review.ts";
import { inspectWindowsRuntime } from "./imports.ts";
import { installWindowsSql } from "./sql.ts";
import { withWindowsBuild } from "./work.ts";
import {
  type NativeBuild,
  packageCandidate,
  recipeIdentity,
  recordBuild,
} from "../package.ts";
import { outputRoot, root, workRoot } from "../paths.ts";
import { capture, run } from "../process.ts";

// From the repository, because the compiled copy of this module in dist has none of these files.
const recipeRoot = join(root, "binaries/windows");

/**
 * Patches applied to the extracted sources before compiling, sorted by path, which is the order they apply in.
 * A patch in `patches/<source ID>/` changes that source, so the recipe identity, which hashes each file with its
 * path, also covers what each patch changes and in which order.
 * docs/native-artifact.md ("Source patches") explains why each one exists and when it goes.
 */
export const windowsPatches: ReadonlyArray<{ source: string; file: string }> = [
  "postgresql/ucrt-setjmp.patch",
  "plpgsql_check/mingw-memmem.patch",
  "timescaledb/mingw-link.patch",
  "timescaledb/windows-version-value.patch",
].sort().map(path => ({ source: path.split("/")[0]!, file: join(recipeRoot, "patches", path) }));

/**
 * These scripts, the source patches and the code that applies them, the SQL installer, and the tool pins
 * determine the development installation. Reassembly also relies on the fresh build's notice scan and
 * TimescaleDB check.
 */
export const windowsRecipe: readonly string[] = [
  ...[
    "build.ts",
    "build.sh",
    "mingw.ts",
    "notices/mingw-supplement.txt",
    "clang64.json",
    "trace-ld.c",
    "trace-link.py",
    "sql.ts",
    "requirements.txt",
    "tools.json",
  ].map(file => join(recipeRoot, file)),
  join(root, "binaries/compression/CMakeLists.txt"),
  join(root, "binaries/patch.ts"),
  join(root, "binaries/artifact/data-library.ts"),
  join(root, "binaries/artifact/notice-scan.ts"),
  join(root, "binaries/timescaledb.ts"),
  ...windowsPatches.map(patch => patch.file),
];

/** The isolated environment whose Meson build.sh runs, as CONTRIBUTING.md creates it. */
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
  const recipe = await recipeIdentity(windowsRecipe);
  let inputs: WindowsInputs | undefined;
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
    const tools = await fetchSources(downloads, [...windowsTools, ...clang64]);
    inputs = { archives, tools };
  }
  await withWindowsBuild(workRoot, output, command, recipe,
    current => compileAndPackage(output, current, inputs));
}

type WindowsInputs = { archives: Map<string, string>; tools: Map<string, string> };

async function compileAndPackage(
  output: string,
  current: NativeBuild,
  inputs?: WindowsInputs,
): Promise<void> {
  if (inputs) {
    const { archives, tools } = inputs;
    const { buildWork } = current;
    const systemTar = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32/tar.exe");
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
      if (source.id === "postgresql") await rm(expandedArchive);
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
    await compileMingw(buildWork, tools, toolchainPython);
    await installWindowsSql(join(buildWork, "windows-sources"), current.developmentInstallation);
    await recordBuild(output, current);
  } else {
    // Notice pins can change while the source archives and compiled SDK stay the same.
    await verifyNoticeAnchors(join(current.buildWork, "windows-sources"));
  }
  const candidate = await packageCandidate({
    target: "windows-x64",
    output,
    reviewFile: reviewFiles["windows-x64"],
    sourceRoot: join(current.buildWork, "windows-sources"),
    build: current,
    toolchainNotices: [join(current.buildWork, "toolchain-notices", mingwNotice)],
    // Reassembly checks the actual candidate in case its saved SDK was modified.
    hostEvidence: async installation => [
      ...await mingwLinkEvidence(installation, current.buildWork, inputs !== undefined),
      {
        component: "Windows kernel",
        version: release(),
        evidence: "os.release on the build host; supported minima require clean-consumer evidence",
      },
      {
        component: hostMeasurementEvidence["windows-x64"],
        version: (await inspectWindowsRuntime(installation)).join(", "),
        evidence:
          "DLL names in the import and delay-import tables of every packaged PE file that the bundle does not supply",
      },
    ],
  });
  console.log("Assembled Windows runtime candidate: " + candidate);
}

if (import.meta.main) await build(process.argv[2]);
