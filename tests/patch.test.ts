/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Guards that source patches apply exactly once, or stop the build, and that every patch is part of the recipe. */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyHunks, applyPatchFile, parsePatch } from "../binaries/patch.ts";
import { root } from "../binaries/paths.ts";
import { sources } from "../binaries/sources/sources.ts";
import { windowsPatches, windowsRecipe } from "../binaries/windows/build.ts";

const patchRoot = join(root, "binaries/windows/patches");
/** A patch of `src/file.c` from its lines: the hunk header counts them. */
function patchOf(...hunks: string[][]): string {
  const body = hunks.flatMap(lines => {
    const old = lines.filter(line => !line.startsWith("+")).length;
    const added = lines.filter(line => !line.startsWith("-")).length;
    return [`@@ -1,${old} +1,${added} @@`, ...lines];
  });
  return ["Description.", "", "--- a/src/file.c", "+++ b/src/file.c", ...body, ""].join("\n");
}
const simplePatch = patchOf([" one", "-two", "+TWO", " three"]);

it("the UCRT patch switches only the MinGW setjmp implementation", async () => {
  const patch = parsePatch(await readFile(join(patchRoot, "postgresql/ucrt-setjmp.patch"), "utf8"));
  expect(patch.path).toBe("src/include/c.h");
  const original = ["/* a different line number */", ...patch.hunks[0]!.oldLines, ""].join("\n");
  expect(applyHunks(original, patch)).toBe(
    original.replace("#ifdef __MINGW64__", "#if defined(__MINGW64__) && !defined(_UCRT)"),
  );
});

it("a patch that is already applied, or no longer fits, stops the build", () => {
  const patch = parsePatch(simplePatch);
  expect(applyHunks("zero\none\ntwo\nthree\n", patch)).toBe("zero\none\nTWO\nthree\n");
  expect(() => applyHunks("zero\none\nTWO\nthree\n", patch)).toThrow(/already present/);
  // An upstream change touched the patched lines.
  expect(() => applyHunks("zero\none\nchanged\nthree\n", patch)).toThrow(/does not apply/);
});

it("an insertion whose line the source already has is not inserted twice", () => {
  const patch = parsePatch(patchOf([" one", "+added", " three"]));
  expect(applyHunks("one\nthree\n", patch)).toBe("one\nadded\nthree\n");
  expect(() => applyHunks("one\nadded\nthree\none\nthree\n", patch)).toThrow(/already present/);
});

it("a hunk whose old lines occur twice is refused rather than applied at a guess", () => {
  expect(() => applyHunks("one\ntwo\nthree\none\ntwo\nthree\n", parsePatch(simplePatch))).toThrow(
    /matches 2 places/,
  );
});

it("every hunk is placed in the original text, in order, never in what an earlier hunk wrote", () => {
  // The second hunk's old lines exist only in the first hunk's result.
  const chained = parsePatch(patchOf([" a", "-b", "+c", " d"], [" c", "-d", "+e"]));
  expect(() => applyHunks("a\nb\nd\n", chained)).toThrow(/does not apply/);
  const reversed = parsePatch(patchOf([" x", "-y", "+Y"], [" a", "-b", "+B"]));
  expect(() => applyHunks("a\nb\nx\ny\n", reversed)).toThrow(/precedes the hunk before it/);
  const ordered = parsePatch(patchOf([" a", "-b", "+B"], [" x", "-y", "+Y"]));
  expect(applyHunks("a\nb\nx\ny\n", ordered)).toBe("a\nB\nx\nY\n");
});

it("the final line feed is no empty line that a hunk could match or remove", () => {
  const trailing = parsePatch(patchOf([" x", "-", "+y"]));
  expect(() => applyHunks("x\n", trailing)).toThrow(/does not apply/);
  expect(applyHunks("x\n\n", trailing)).toBe("x\ny\n");
  expect(applyHunks("x\n", parsePatch(patchOf(["-x", "+y"])))).toBe("y\n");
  expect(applyHunks("x", parsePatch(patchOf(["-x", "+y"])))).toBe("y");
});

it("a CRLF checkout of the patch applies to LF sources, and CRLF sources are named as such", () => {
  const patch = parsePatch(simplePatch.replaceAll("\n", "\r\n"));
  expect(applyHunks("zero\none\ntwo\nthree\n", patch)).toBe("zero\none\nTWO\nthree\n");
  expect(() => applyHunks("zero\r\none\r\ntwo\r\nthree\r\n", patch)).toThrow(/CR line endings/);
});

it("an editor that strips the space of an empty context line keeps the patch valid", () => {
  const patch = parsePatch(simplePatch.replace("\n one\n", "\n\n"));
  expect(applyHunks("zero\n\ntwo\nthree\n", patch)).toBe("zero\n\nTWO\nthree\n");
});

it("paths outside the source tree, including Windows forms, are refused", () => {
  for (const path of [
    "../file.c",
    "src/../../file.c",
    "src\\..\\..\\file.c",
    "C:/file.c",
    "/file.c",
    "src/./file.c",
    "src//file.c",
  ]) {
    expect(() => parsePatch(simplePatch.replaceAll("src/file.c", path)), path).toThrow(
      /unsafe path|Expected/,
    );
  }
});

it("malformed patches are refused before anything is applied", () => {
  expect(() => parsePatch("no diff here\n")).toThrow(/no file header/);
  expect(() => parsePatch(simplePatch.replace("@@ -1,3 +1,3 @@", "@@ -1,4 +1,3 @@"))).toThrow(
    /ends early|line counts/,
  );
  expect(() => parsePatch(simplePatch.replace("@@ -1,3 +1,3 @@", "@@ -1,2 +1,3 @@"))).toThrow(
    /line counts/,
  );
  expect(() => parsePatch(simplePatch.replace("+++ b/src/file.c", "+++ b/src/other.c"))).toThrow(
    /changes the name/,
  );
  expect(() => parsePatch(simplePatch + "\\ No newline at end of file\n")).toThrow(
    /Unexpected text/,
  );
  expect(() => parsePatch(patchOf([" one", " two"]))).toThrow(/changes nothing/);
});

it("a patch changes one file, and a damaged header cannot hide a file's hunks as description", () => {
  const second = simplePatch.split("\n").slice(2).join("\n").replaceAll("file.c", "other.c");
  expect(() => parsePatch(simplePatch + second)).toThrow(/one file/);
  // The first file's "---" line is lost; its "+++" line and hunk must not count as description.
  const damaged = simplePatch.replace("--- a/src/file.c\n", "") + second;
  expect(() => parsePatch(damaged)).toThrow(/diff lines before its file header/);
});

it("applying a patch keeps every other byte of the file, also in files that are not UTF-8", async () => {
  const directory = await mkdtemp(join(tmpdir(), "portable-postgres-patch-"));
  try {
    await mkdir(join(directory, "src"));
    const target = join(directory, "src/file.c");
    // Latin-1 é and an invalid UTF-8 byte around the patched lines.
    const before = Buffer.from([0xE9, 0x0A, ...Buffer.from("one\ntwo\nthree\n"), 0xFF, 0x0A]);
    await writeFile(target, before);
    const patch = join(directory, "file.patch");
    await writeFile(patch, patchOf([" one", "-two", " three"]));
    await expect(applyPatchFile(directory, patch)).resolves.toBe("src/file.c");
    await expect(readFile(target)).resolves.toEqual(
      Buffer.from([0xE9, 0x0A, ...Buffer.from("one\nthree\n"), 0xFF, 0x0A]),
    );
    // Applying it again fails and leaves the file as it was.
    await expect(applyPatchFile(directory, patch)).rejects.toThrow(/already present/);
    await expect(readFile(target)).resolves.toEqual(
      Buffer.from([0xE9, 0x0A, ...Buffer.from("one\nthree\n"), 0xFF, 0x0A]),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("every Windows source patch is in the recipe identity, with the code that applies it", async () => {
  const files = (await readdir(patchRoot, { recursive: true }))
    .map(file => file.replaceAll("\\", "/"))
    .filter(file => file.endsWith(".patch"));
  expect(windowsPatches.map(patch => patch.file)).toEqual(
    files.map(file => join(patchRoot, file)).sort(),
  );
  expect(windowsRecipe).toContain(join(root, "binaries/patch.ts"));
  for (const patch of windowsPatches) {
    expect(windowsRecipe).toContain(patch.file);
    // The directory names the source, so the hashed path records which source a patch changes.
    expect(sources.map(source => source.id)).toContain(patch.source);
    expect(patch.file).toBe(
      join(patchRoot, patch.source, patch.file.slice(join(patchRoot, patch.source).length + 1)),
    );
  }
});
