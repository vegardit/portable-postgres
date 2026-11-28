/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Checks the tools of a fresh build and the source facts a saved build must still satisfy on reassembly.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  build as buildLinux,
  imageRecipeDirectory,
  linuxRecipes,
  requireCurrentImage,
} from "../binaries/linux/build.ts";
import { recipeIdentity, recordBuild } from "../binaries/package.ts";
import { root } from "../binaries/paths.ts";
import {
  build as buildWindows,
  requirePinnedMeson,
  windowsRecipe,
} from "../binaries/windows/build.ts";
import { linuxBases, linuxTargets, nativeLinuxTarget } from "../binaries/linux/target.ts";
import { fixtureEvidence } from "./candidate.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

const { directory: createDirectory, cleanup } = temporaryDirectories("reassemble");
afterEach(cleanup);

const requirements = "meson==1.12.1 --hash=sha256:" + "0".repeat(64) + "\n";

it.each([
  ["Linux glibc", linuxRecipes.glibc],
  ["Linux musl", linuxRecipes.musl],
  ["Windows", windowsRecipe],
] as const)(
  "the %s recipe binds reassembly to its TimescaleDB license check",
  (_, recipe) => {
    expect(recipe).toContain(join(root, "binaries/timescaledb.ts"));
  },
);

it.each(Object.entries(linuxRecipes))("the %s recipe hashes the C compiler selector",
  async (_, recipe) => {
    const modules = await Promise.all(
      recipe.filter(path => path.endsWith(".ts")).map(path => readFile(path, "utf8")),
    );
    expect(modules.some(source => source.includes("function compilerFor("))).toBe(true);
  });

it.skipIf(
  !(process.platform === "win32" && process.arch === "x64"
    || process.platform === "linux" && ["x64", "arm64"].includes(process.arch)),
)(
  "reassembly checks the notice anchors of a matching saved build before packaging",
  async () => {
    const output = await createDirectory();
    const windows = process.platform === "win32";
    const target = windows ? "windows-x64" : nativeLinuxTarget();
    const targetOutput = join(output,
      target === "windows-x64" ? target : linuxTargets[target].output);
    const pg = join(output, windows ? "windows-sources" : "sources", "postgresql");
    await mkdir(join(pg, "src/backend/snowball"), { recursive: true });
    await writeFile(join(pg, "src/backend/snowball/README"), "0".repeat(40));
    await recordBuild(targetOutput, {
      recipe: await recipeIdentity(
        target === "windows-x64" ? windowsRecipe : linuxRecipes[linuxTargets[target].libc],
      ),
      buildWork: output,
      developmentInstallation: join(output, "sdk"),
      toolchainEvidence: fixtureEvidence(target),
    });
    const paths = await import("../binaries/paths.ts");
    const outputRoot = vi.spyOn(paths, "outputRoot", "get").mockReturnValue(output);
    try {
      await expect((windows ? buildWindows : buildLinux)("assemble")).rejects.toThrow(
        "snowball-copying.txt: src/backend/snowball/README now has",
      );
    } finally {
      outputRoot.mockRestore();
    }
  },
);

it("a fresh Windows build stops when the installed Meson differs from the pin", () => {
  expect(() => requirePinnedMeson("1.12.1", requirements)).not.toThrow();
  const older = () => requirePinnedMeson("1.11.0", requirements);
  expect(older).toThrow("Meson 1.11.0");
  expect(older).toThrow("pins 1.12.1");
  // The message gives the install command, which upgrades an existing environment to the pin as well.
  expect(older).toThrow(
    "-m pip install --require-hashes --only-binary=:all: -r binaries/windows/requirements.txt",
  );
  expect(() => requirePinnedMeson("1.12.1", "")).toThrow("must pin meson");
});

it("the Meson install command in the message is the one that CONTRIBUTING.md documents", async () => {
  const guide = await readFile(join(root, "CONTRIBUTING.md"), "utf8");
  const message = (() => {
    try {
      requirePinnedMeson("0", requirements);
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  })();
  const command = message.split("\n").at(-1)!;
  expect(guide).toContain(command);
});

/** An image recipe directory as the Dockerfile writes it, from this checkout's recipe. */
async function imageRecipe(libc: keyof typeof linuxBases): Promise<string> {
  const directory = await createDirectory("image");
  const dockerfile = libc === "musl" ? "musl.Dockerfile" : "Dockerfile";
  for (const file of [dockerfile, "traced-ld.sh", "clang-cxx.sh"]) {
    await copyFile(join(root, "binaries/linux/image", file), join(directory, file));
  }
  const marker = libc === "musl" ? "alpine-image" : "ubuntu-image";
  await writeFile(join(directory, marker), linuxBases[libc].image + "\n");
  await writeFile(join(directory, "llvm-major"), linuxBases[libc].llvm + "\n");
  return directory;
}

it("a fresh Linux build runs only in an image built from the current recipe", async () => {
  const image = await imageRecipe("glibc");
  await expect(requireCurrentImage(image)).resolves.toBeUndefined();

  await writeFile(join(image, "traced-ld.sh"), '#!/bin/sh\nexec ld "$@"\n');
  await writeFile(join(image, "llvm-major"), "20\n");
  await expect(requireCurrentImage(image)).rejects.toThrow(
    "The build image was built from another recipe (traced-ld.sh, LLVM major).",
  );

  // An image from before the image kept its recipe, or a host outside the image, has none.
  await expect(requireCurrentImage(join(image, "missing"))).rejects.toThrow(
    "another recipe (Dockerfile, traced-ld.sh, clang-cxx.sh, Ubuntu image, LLVM major)",
  );
});

it.each([
  ["musl.Dockerfile", "musl.Dockerfile"],
  ["alpine-image", "Alpine image"],
] as const)("a fresh musl build rejects a stale %s", async (file, difference) => {
  const image = await imageRecipe("musl");
  await expect(requireCurrentImage(image, "musl")).resolves.toBeUndefined();
  await writeFile(join(image, file), "stale\n");
  await expect(requireCurrentImage(image, "musl")).rejects.toThrow(
    `The build image was built from another recipe (${difference}).`,
  );
});

it("the Linux image keeps the recipe files and arguments where the build compares them", async () => {
  const dockerfile = await readFile(join(root, "binaries/linux/image/Dockerfile"), "utf8");
  expect(dockerfile).toMatch(
    new RegExp("^COPY Dockerfile traced-ld\\.sh clang-cxx\\.sh " + imageRecipeDirectory + "/$",
      "m"),
  );
  for (const [file, argument] of [["ubuntu-image", "UBUNTU_IMAGE"], ["llvm-major", "LLVM_MAJOR"]]) {
    expect(dockerfile).toContain(`"$${argument}" > ${imageRecipeDirectory}/${file}`);
  }
});
