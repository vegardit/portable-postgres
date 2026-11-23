/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Builds the macOS arm64 candidate from verified inputs only, with the Xcode that base.json pins. */
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import {
  type HostEvidence,
  hostMeasurementEvidence,
  macOSMinimumEvidence,
  macOSParserEvidence,
} from "../artifact/artifact.ts";
import { sourceNoticesFile, writeSourceNoticeScan } from "../artifact/notice-scan.ts";
import { verifyNoticeAnchors } from "../artifact/notices.ts";
import { reviewFiles } from "../artifact/review.ts";
import { requireApacheOnlyTimescaleDB } from "../timescaledb.ts";
import { fetchSources, sources } from "../sources/sources.ts";
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
import { auditLinks, linkRecordsDirectory } from "./links.ts";
import { inspectMacOSRuntime, machOImages } from "./runtime.ts";

// Both entry points must use the checkout's recipe, including the baseline whose bytes are hashed.
const recipeRoot = join(root, "binaries/macos");
const baselineFile = join(recipeRoot, "base.json");
const baselineSchema = z.object({
  xcode: z.string().min(1),
  xcodeVersion: z.string().min(1),
  deploymentTarget: z.string().min(1),
  bison: z.string().min(1),
  flex: z.string().min(1),
});

/**
 * The compile script and its pins determine the development installation. Reassembly also relies on the
 * fresh build's notice scan and TimescaleDB check.
 */
export const macOSRecipe: readonly string[] = [
  join(recipeRoot, "build.sh"),
  baselineFile,
  join(root, "binaries/artifact/notice-scan.ts"),
  join(root, "binaries/timescaledb.ts"),
];

export async function build(command: string | undefined): Promise<void> {
  if (command !== "build" && command !== "assemble") {
    throw new Error("Usage: pnpm binaries:build:macos | pnpm binaries:assemble:macos");
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("This recipe requires macOS on arm64. See CONTRIBUTING.md.");
  }
  const output = join(outputRoot, "macos-arm64");
  const baseline = baselineSchema.parse(JSON.parse(await readFile(baselineFile, "utf8")));
  const recipe = await recipeIdentity(macOSRecipe);
  let current: NativeBuild;
  if (command === "build") {
    // Before fetching, so that a missing or different Xcode stops the build at once.
    const env = {
      ...process.env,
      DEVELOPER_DIR: join(baseline.xcode, "Contents/Developer"),
      MACOSX_DEPLOYMENT_TARGET: baseline.deploymentTarget,
      BISON: baseline.bison,
      FLEX: baseline.flex,
    };
    const toolchainEvidence = measureToolchain(baseline, env);
    // Extraction must read the exact files that fetching verified.
    const archives = await fetchSources(join(workRoot, "downloads"));
    // Each build starts with empty sources, objects, and SDK files, even when release pins change.
    const buildWork = await mkdtemp(join(workRoot, "macos-build-"));
    // PostgreSQL keeps share and lib flat when the prefix contains "postgresql".
    current = { buildWork, developmentInstallation: join(buildWork, "postgresql-sdk"), recipe };
    for (const source of sources) {
      const destination = join(buildWork, "sources", source.id);
      await mkdir(destination, { recursive: true });
      await run("tar", [
        "-xf",
        archives.get(source.id)!,
        "--strip-components=1",
        "-C",
        destination,
      ]);
    }
    // Before compiling: a source update that changed a fact behind a project notice fails here, quickly.
    await verifyNoticeAnchors(join(buildWork, "sources"));
    // Also before compiling, which writes generated files into the source trees.
    await writeSourceNoticeScan(
      join(buildWork, "sources"),
      sources.map(source => source.id),
      join(buildWork, sourceNoticesFile),
    );
    await run("bash", [join(recipeRoot, "build.sh")], {
      env: {
        ...env,
        PORTABLE_PG_WORK: buildWork,
        PORTABLE_PG_PREFIX: current.developmentInstallation,
        BUILD_JOBS: buildJobs(),
      },
    });
    await requireApacheOnlyTimescaleDB(
      join(buildWork, "timescaledb-build"),
      join(buildWork, "sources", "timescaledb"),
    );
    current.toolchainEvidence = toolchainEvidence;
    await recordBuild(output, current);
  } else {
    current = await readBuild(output, recipe);
    // Notice pins can change while the source archives and compiled SDK stay the same.
    await verifyNoticeAnchors(join(current.buildWork, "sources"));
  }
  const toolchain = recordedToolchain(current);
  const records = join(current.buildWork, linkRecordsDirectory);
  const candidate = await packageCandidate({
    target: "macos-arm64",
    output,
    reviewFile: reviewFiles["macos-arm64"],
    sourceRoot: join(current.buildWork, "sources"),
    build: current,
    hostEvidence: async installation => {
      // The candidate's images, on every assembly: a reassembly reuses a development installation
      // that may have changed since its build.
      const images = await machOImages(installation);
      await auditLinks(installation, records, images);
      for (const image of images) {
        capture("codesign", ["--verify", "--strict", image]);
      }
      const { imports, minimumOS } = await inspectMacOSRuntime(installation,
        baseline.deploymentTarget, images);
      return [
        ...toolchain,
        {
          component: hostMeasurementEvidence["macos-arm64"],
          version: imports.join(", "),
          evidence:
            "System libraries that the packaged Mach-O images load, read from their load commands",
        },
        {
          component: macOSMinimumEvidence,
          version: minimumOS,
          evidence: "Highest LC_BUILD_VERSION minimum OS of any packaged Mach-O image",
        },
      ];
    },
  });
  console.log(`Assembled relocated runtime candidate: ${candidate}`);
}

/**
 * Records the build host and tools before compilation. PostgreSQL's review binds to the selected
 * Xcode and generators because their output is compiled after the source notice scan.
 */
function measureToolchain(
  baseline: z.infer<typeof baselineSchema>,
  env: NodeJS.ProcessEnv,
): HostEvidence[] {
  const xcode = capture("xcodebuild", ["-version"], { env }).trim().split("\n");
  const version = /^Xcode (\S+)$/.exec(xcode[0] ?? "")?.[1];
  if (version !== baseline.xcodeVersion) {
    throw new Error(
      `Expected Xcode ${baseline.xcodeVersion} at ${baseline.xcode}, found ${xcode[0] ?? "none"}`,
    );
  }
  const xcodeBuild = /^Build version (\S+)$/.exec(xcode[1] ?? "")?.[1];
  const sdk = capture("xcrun", ["--show-sdk-version"], { env }).trim();
  const clang = capture("xcrun", ["clang", "--version"], { env }).split("\n")[0]!.trim();
  const bison = capture(baseline.bison, ["--version"], { env }).split("\n")[0]!.trim();
  const flex = capture(baseline.flex, ["--version"], { env }).split("\n")[0]!.trim();
  if (!xcodeBuild || !bison || !flex) {
    throw new Error("Missing Xcode build or parser generator version for the PostgreSQL review");
  }
  const xcodeIdentity = `${version} (${xcodeBuild})`;
  return [
    {
      component: "macOS",
      version: capture("/usr/bin/sw_vers", ["-productVersion"]).trim(),
      evidence: "sw_vers -productVersion on the build host",
    },
    {
      component: macOSParserEvidence,
      version: `Xcode ${xcodeIdentity}, ${bison}, ${flex}`,
      evidence:
        "xcodebuild -version and the --version output of the BISON and FLEX passed to configure",
    },
    { component: "Xcode", version: xcodeIdentity, evidence: "xcodebuild -version" },
    { component: "macOS SDK", version: sdk, evidence: "xcrun --show-sdk-version" },
    { component: "Apple clang", version: clang, evidence: "xcrun clang --version" },
  ];
}

if (import.meta.main) await build(process.argv[2]);
