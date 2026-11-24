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
import baseline from "./base.json" with { type: "json" };

// From the repository, because the compiled copy of this module in dist has none of these files.
const recipeRoot = join(root, "binaries/linux");

/**
 * The build image, its pinned base, and the compile script determine the development installation.
 * Reassembly also relies on the fresh build's notice scan and TimescaleDB check.
 */
export const linuxRecipe: readonly string[] = [
  ...["build.sh", "image/Dockerfile", "image/traced-ld.sh", "image/clang-cxx.sh", "base.json"].map(
    file => join(recipeRoot, file),
  ),
  join(root, "binaries/artifact/notice-scan.ts"),
  join(root, "binaries/build-openssl.sh"),
  join(root, "binaries/compression/CMakeLists.txt"),
  join(root, "binaries/timescaledb.ts"),
];

/** Where the build image keeps the recipe files and the build arguments that it was built from. */
export const imageRecipeDirectory = "/usr/local/share/portable-postgres/recipe";

/**
 * Stops a fresh build in an image that another recipe built. The recipe identity covers the image's files
 * and the arguments from base.json, not the image that the build runs in, so the build would otherwise be
 * recorded as made by a recipe that it did not follow. An image without the copies predates them.
 */
export async function requireCurrentImage(image: string = imageRecipeDirectory): Promise<void> {
  const differences: string[] = [];
  for (const file of ["Dockerfile", "traced-ld.sh", "clang-cxx.sh"]) {
    const current = await readFile(join(recipeRoot, "image", file), "utf8");
    if (await readOptionalText(join(image, file)) !== current) differences.push(file);
  }
  const argument = async (file: string): Promise<string | undefined> =>
    (await readOptionalText(join(image, file)))?.trim();
  if (await argument("ubuntu-image") !== baseline.image) differences.push("Ubuntu image");
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
  if (command !== "fetch" && (process.platform !== "linux" || process.arch !== "x64")) {
    throw new Error(
      "This recipe requires Linux x64. See CONTRIBUTING.md for the Ubuntu build container.",
    );
  }
  // Before fetching, so that a stale image stops the build at once.
  if (command === "build") await requireCurrentImage();
  const downloads = join(workRoot, "downloads");
  // Extraction must read the exact files that fetching verified.
  const archives = command === "assemble"
    ? new Map<string, string>()
    : await fetchSources(downloads);
  if (command === "fetch") return;
  const output = join(outputRoot, "linux-x64");
  const recipe = await recipeIdentity(linuxRecipe);
  let current: NativeBuild;
  if (command === "build") {
    // Each build starts with empty sources, objects, and SDK files, even when release pins change.
    const buildWork = await mkdtemp(join(workRoot, "linux-build-"));
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
        LLVM_MAJOR: baseline.llvm,
      },
    });
    await requireApacheOnlyTimescaleDB(
      join(buildWork, "timescaledb-build"),
      join(buildWork, "sources", "timescaledb"),
    );
    current.toolchainEvidence = measureToolchain();
    await recordBuild(output, current);
  } else {
    current = await readBuild(output, recipe);
    // Notice pins can change while the source archives and compiled SDK stay the same.
    await verifyNoticeAnchors(join(current.buildWork, "sources"));
  }
  const toolchain = recordedToolchain(current);
  const records = join(current.buildWork, linkRecordsDirectory);
  const candidate = await packageCandidate({
    target: "linux-x64-glibc",
    output,
    reviewFile: reviewFiles["linux-x64-glibc"],
    toolchainNotices: [join(recipeRoot, "notices/llvm-cxx-runtime.txt")],
    sourceRoot: join(current.buildWork, "sources"),
    build: current,
    hostEvidence: async installation => {
      // The candidate's images, on every assembly: a reassembly reuses a development installation
      // that may have changed since its build.
      await auditLinks(installation, records);
      return [
        ...toolchain,
        { component: "Linux kernel", version: release(), evidence: "os.release on the build host" },
        {
          component: hostMeasurementEvidence["linux-x64-glibc"],
          version: `GLIBC_${await inspectLinuxRuntime(installation)}`,
          evidence:
            "Highest glibc symbol version required by any packaged ELF file, measured with llvm-readelf",
        },
      ];
    },
  });
  console.log(`Assembled relocated runtime candidate: ${candidate}`);
}

/**
 * Describes the compiler and glibc that the build linked into every image. It runs right after compiling,
 * in the build container, because the licence reviews of their linked code are bound to these lines.
 */
function measureToolchain(): HostEvidence[] {
  const libc = capture("getconf", ["GNU_LIBC_VERSION"]).trim();
  const compiler = "clang-" + baseline.llvm;
  const clangVersion = capture(compiler, ["-dumpversion"]).trim();
  return [
    {
      // compiler-rt comes with the compiler, so its review is bound to the compiler's major version.
      component: toolchainEvidence("compiler-rt"),
      version: clangVersion.split(".")[0]!,
      evidence: `${compiler} -dumpversion on the build host: ${clangVersion}`,
    },
    {
      // glibc's startup code is copied from this glibc into every image; its review is bound to it.
      component: toolchainEvidence("glibc-startup"),
      version: libc,
      evidence: "getconf GNU_LIBC_VERSION on the build host; minimum support is not inferred",
    },
  ];
}

if (import.meta.main) await build(process.argv[2]);
