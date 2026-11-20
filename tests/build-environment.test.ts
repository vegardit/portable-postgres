/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Checks that a fresh build stops when its tools differ from the recipe that its record will name, because
 * the recipe identity covers the tool pins, not the tools that are installed.
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { imageRecipeDirectory, requireCurrentImage } from "../binaries/linux/build.ts";
import { root } from "../binaries/paths.ts";
import { requirePinnedMeson } from "../binaries/windows/build.ts";
import baseline from "../binaries/linux/base.json" with { type: "json" };

const temporary: string[] = [];
afterEach(async () => {
  for (const created of temporary.splice(0)) {
    await rm(created, { recursive: true, force: true });
  }
});

const requirements = "meson==1.12.1 --hash=sha256:" + "0".repeat(64) + "\n";

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
async function imageRecipe(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "portable-postgres-image-"));
  temporary.push(directory);
  for (const file of ["Dockerfile", "traced-ld.sh"]) {
    await copyFile(join(root, "binaries/linux/image", file), join(directory, file));
  }
  await writeFile(join(directory, "ubuntu-image"), baseline.image + "\n");
  await writeFile(join(directory, "llvm-major"), baseline.llvm + "\n");
  return directory;
}

it("a fresh Linux build runs only in an image built from the current recipe", async () => {
  const image = await imageRecipe();
  await expect(requireCurrentImage(image)).resolves.toBeUndefined();

  await writeFile(join(image, "traced-ld.sh"), '#!/bin/sh\nexec ld "$@"\n');
  await writeFile(join(image, "llvm-major"), "20\n");
  await expect(requireCurrentImage(image)).rejects.toThrow(
    "The build image was built from another recipe (traced-ld.sh, LLVM major).",
  );

  // An image from before the image kept its recipe, or a host outside the image, has none.
  await expect(requireCurrentImage(join(image, "missing"))).rejects.toThrow(
    "another recipe (Dockerfile, traced-ld.sh, Ubuntu image, LLVM major)",
  );
});

it("the Linux image keeps the recipe files and arguments where the build compares them", async () => {
  const dockerfile = await readFile(join(root, "binaries/linux/image/Dockerfile"), "utf8");
  expect(dockerfile).toMatch(
    new RegExp("^COPY Dockerfile traced-ld\\.sh " + imageRecipeDirectory + "/$", "m"),
  );
  for (const [file, argument] of [["ubuntu-image", "UBUNTU_IMAGE"], ["llvm-major", "LLVM_MAJOR"]]) {
    expect(dockerfile).toContain(`"$${argument}" > ${imageRecipeDirectory}/${file}`);
  }
});
