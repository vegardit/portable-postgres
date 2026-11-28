/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Fetches the pinned sources on any host and builds the Linux candidate from verified inputs only. */
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { release } from "node:os";
import {
  type HostEvidence,
  hostMeasurementEvidence,
  toolchainEvidence,
  toolchainNotices,
} from "../artifact/artifact.ts";
import { sourceNoticesFile, writeSourceNoticeScan } from "../artifact/notice-scan.ts";
import { verifyNoticeAnchors } from "../artifact/notices.ts";
import { reviewFiles } from "../artifact/review.ts";
import { readOptionalText } from "../files.ts";
import { requireApacheOnlyTimescaleDB } from "../timescaledb.ts";
import { fetchSources, sources } from "../sources/sources.ts";
import { inspectLinuxRuntime } from "./abi.ts";
import { auditLinks, linkRecordsDirectory } from "./links.ts";
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
import {
  compilerFor,
  type LinuxTarget,
  linuxBases,
  linuxTargets,
  nativeLinuxTarget,
} from "./target.ts";

const recipeRoot = join(root, "binaries/linux");

const commonRecipe = [
  ...[
    "build.sh",
    "image/traced-ld.sh",
    "image/clang-cxx.sh",
    "target.ts",
  ].map(
    file => join(recipeRoot, file),
  ),
  join(root, "binaries/artifact/notice-scan.ts"),
  join(root, "binaries/build-openssl.sh"),
  join(root, "binaries/compression/CMakeLists.txt"),
  join(root, "binaries/timescaledb.ts"),
];

/**
 * Each SDK depends on the shared compile scripts and the image used for its libc.
 * Reassembly also relies on the fresh build's notice scan and TimescaleDB check.
 */
export const linuxRecipes = {
  glibc: [...commonRecipe, join(recipeRoot, "base.json"), join(recipeRoot, "image/Dockerfile")],
  musl: [...commonRecipe, join(recipeRoot, "musl.json"), join(recipeRoot, "image/musl.Dockerfile")],
} as const;

/** Where the build image keeps the recipe files and the build arguments that it was built from. */
export const imageRecipeDirectory = "/usr/local/share/portable-postgres/recipe";

/**
 * Stops a fresh build in an image that another recipe built. The recipe identity covers the image's files
 * and the pinned base and compiler, not the image that the build runs in, so the build would otherwise be
 * recorded as made by a recipe that it did not follow. An image without the copies predates them.
 */
export async function requireCurrentImage(
  image: string = imageRecipeDirectory,
  libc: "glibc" | "musl" = "glibc",
): Promise<void> {
  const baseline = linuxBases[libc];
  const dockerfile = libc === "musl" ? "musl.Dockerfile" : "Dockerfile";
  const differences: string[] = [];
  for (const file of [dockerfile, "traced-ld.sh", "clang-cxx.sh"]) {
    const current = await readFile(join(recipeRoot, "image", file), "utf8");
    if (await readOptionalText(join(image, file)) !== current) differences.push(file);
  }
  const argument = async (file: string): Promise<string | undefined> =>
    (await readOptionalText(join(image, file)))?.trim();
  const distribution = libc === "musl" ? "Alpine" : "Ubuntu";
  if (await argument(distribution.toLowerCase() + "-image") !== baseline.image) {
    differences.push(distribution + " image");
  }
  if (await argument("llvm-major") !== baseline.llvm) differences.push("LLVM major");
  if (differences.length > 0) {
    throw new Error(
      `The build image was built from another recipe (${differences.join(", ")}).`
        + " Build it again from this checkout as CONTRIBUTING.md shows, and run the build in it.",
    );
  }
}

export async function build(command: string | undefined): Promise<void> {
  if (command !== "fetch" && command !== "build" && command !== "assemble") {
    throw new Error(
      "Usage: pnpm binaries:fetch | pnpm binaries:build:linux | pnpm binaries:assemble:linux",
    );
  }
  const target = command === "fetch" ? undefined : nativeLinuxTarget();
  if (target !== undefined && command === "build") {
    // Before fetching, so that a stale image stops the build at once.
    await requireCurrentImage(imageRecipeDirectory, linuxTargets[target].libc);
  }
  const downloads = join(workRoot, "downloads");
  // Extraction must read the exact files that fetching verified.
  const archives = command === "assemble"
    ? new Map<string, string>()
    : await fetchSources(downloads);
  if (target === undefined) return;
  const profile = linuxTargets[target];
  const baseline = linuxBases[profile.libc];
  const output = join(outputRoot, profile.output);
  const recipe = await recipeIdentity(linuxRecipes[profile.libc]);
  let current: NativeBuild;
  if (command === "build") {
    // Each build starts with empty sources, objects, and SDK files, even when release pins change.
    const buildWork = await mkdtemp(
      join(workRoot, profile.libc === "musl" ? "linux-musl-build-" : "linux-build-"),
    );
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
        ...process.env,
        PORTABLE_PG_WORK: buildWork,
        PORTABLE_PG_PREFIX: current.developmentInstallation,
        BUILD_JOBS: buildJobs(),
        PORTABLE_PG_GNU_ARCH: profile.gnuArch,
        PORTABLE_PG_LIBC: profile.libc,
        PORTABLE_PG_CC: compilerFor(target),
        LLVM_MAJOR: baseline.llvm,
      },
    });
    await requireApacheOnlyTimescaleDB(
      join(buildWork, "timescaledb-build"),
      join(buildWork, "sources", "timescaledb"),
    );
    current.toolchainEvidence = await measureToolchain(target);
    await recordBuild(output, current);
  } else {
    current = await readBuild(output, recipe);
    // Notice pins can change while the source archives and compiled SDK stay the same.
    await verifyNoticeAnchors(join(current.buildWork, "sources"));
  }
  const toolchain = recordedToolchain(current);
  const records = join(current.buildWork, linkRecordsDirectory);
  const candidate = await packageCandidate({
    target,
    output,
    reviewFile: reviewFiles[target],
    toolchainNotices: toolchainNotices(target).map(notice => join(recipeRoot, notice)),
    sourceRoot: join(current.buildWork, "sources"),
    build: current,
    hostEvidence: async installation => {
      // The candidate's images, on every assembly: a reassembly reuses a development installation
      // that may have changed since its build.
      await auditLinks(installation, records, target);
      const glibcVersion = await inspectLinuxRuntime(installation, target);
      return [
        ...toolchain,
        { component: "Linux kernel", version: release(), evidence: "os.release on the build host" },
        {
          component: hostMeasurementEvidence[target],
          version: glibcVersion === undefined ? linuxBases.musl.musl : `GLIBC_${glibcVersion}`,
          evidence: glibcVersion === undefined
            ? `Musl baseline from ${linuxBases.musl.image}; ELF interpreter and dependencies verified with llvm-readelf`
            : "Highest glibc symbol version required by any packaged ELF file, measured with llvm-readelf",
        },
      ];
    },
  });
  console.log(`Assembled relocated runtime candidate: ${candidate}`);
}

/**
 * Describes the compiler and libc that the build linked into every image. It runs right after compiling,
 * in the build container, because the license reviews of their linked code are bound to these lines.
 */
async function measureToolchain(target: LinuxTarget): Promise<HostEvidence[]> {
  const musl = linuxTargets[target].libc === "musl";
  const muslPackage = ["info", "--installed", "--verbose", "musl-dev"];
  const libc = musl
    ? capture("apk", muslPackage).trim()
    : capture("getconf", ["GNU_LIBC_VERSION"]).trim();
  if (musl && !libc.startsWith(`musl-dev-${linuxBases.musl.musl}-r`)) {
    throw new Error(`Expected musl-dev ${linuxBases.musl.musl}, found ${libc}`);
  }
  const compiler = compilerFor(target);
  const clangVersion = capture(compiler, ["-dumpversion"]).trim();
  const llvmVersionFile = "/opt/portable-llvm/version";
  return [
    {
      // compiler-rt comes with the compiler, so its review is bound to the compiler's major version.
      component: toolchainEvidence("compiler-rt"),
      version: clangVersion.split(".")[0]!,
      evidence: `${compiler} -dumpversion on the build host: ${clangVersion}`,
    },
    {
      // glibc's startup code is copied from this glibc into every image; its review is bound to it.
      component: toolchainEvidence(musl ? "musl-startup" : "glibc-startup"),
      version: libc,
      evidence: musl
        ? `apk ${muslPackage.join(" ")} on the build host`
        : "getconf GNU_LIBC_VERSION on the build host; minimum support is not inferred",
    },
    ...musl
      ? [{
        component: toolchainEvidence("llvm-cxx-runtime", target),
        version: (await readFile(llvmVersionFile, "utf8")).trim(),
        evidence: "Pinned LLVM release built as PIC static libraries in the Alpine build image",
      }]
      : [],
  ];
}

if (import.meta.main) await build(process.argv[2]);
