/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Applies the project's source patches strictly. A patch changes one file. Every hunk's old lines must occur exactly
 * once in the extracted file, and its new lines not at all, so a patch that no longer fits, or whose change the
 * source already has, stops the build instead of being skipped or applied twice.
 * Line numbers in hunk headers are not checked: a source update that only moves the code keeps the patch valid.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Hunk = { header: string; oldLines: string[]; newLines: string[] };
export type FilePatch = { path: string; hunks: Hunk[] };

/** Path segments of a file in a source tree; this also rules out backslashes and drive letters. */
const pathSegment = /^[\w+.-]+$/;

/** Parses a unified diff of one file with `a/` and `b/` paths. Text before the file header describes the patch. */
export function parsePatch(text: string): FilePatch {
  // A checkout may convert the patch to CRLF; the sources it applies to keep their own line endings.
  const lines = text.split("\n").map(line => line.replace(/\r$/, ""));
  if (lines.at(-1) === "") lines.pop();
  let index = lines.findIndex(line => line.startsWith("--- "));
  if (index < 0) throw new Error("The patch contains no file header.");
  // Otherwise a damaged header would turn its hunks into description, which is never applied.
  const stray = lines.slice(0, index).findIndex(line => /^(?:\+\+\+ |@@ )/.test(line));
  if (stray !== -1) {
    throw new Error(`The patch has diff lines before its file header, at line ${stray + 1}.`);
  }
  const oldHeader = lines[index]!;
  const newHeader = lines[index + 1] ?? "";
  if (!oldHeader.startsWith("--- a/") || !newHeader.startsWith("+++ b/")) {
    throw new Error(`Expected "--- a/<path>" and "+++ b/<path>" at patch line ${index + 1}.`);
  }
  const path = newHeader.slice("+++ b/".length);
  if (oldHeader.slice("--- a/".length) !== path) {
    throw new Error(`The patch changes the name of ${oldHeader.slice("--- a/".length)}.`);
  }
  if (!path.split("/").every(part => pathSegment.test(part) && part !== "." && part !== "..")) {
    throw new Error(`The patch names an unsafe path: ${path}`);
  }
  const hunks: Hunk[] = [];
  index += 2;
  while (lines[index]?.startsWith("@@ ")) {
    const header = lines[index]!;
    const counts = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(header);
    if (!counts) throw new Error(`Malformed hunk header at patch line ${index + 1}: ${header}`);
    let oldCount = Number(counts[1] ?? 1);
    let newCount = Number(counts[2] ?? 1);
    const hunk: Hunk = { header, oldLines: [], newLines: [] };
    index++;
    while (oldCount > 0 || newCount > 0) {
      const line = lines[index];
      if (line === undefined) throw new Error(`The hunk ${header} of ${path} ends early.`);
      // Editors may strip the single space of an empty context line.
      const kind = line === "" ? " " : line[0];
      const content = line.slice(1);
      if (kind === " ") {
        hunk.oldLines.push(content);
        hunk.newLines.push(content);
        oldCount--;
        newCount--;
      } else if (kind === "-") {
        hunk.oldLines.push(content);
        oldCount--;
      } else if (kind === "+") {
        hunk.newLines.push(content);
        newCount--;
      } else {
        // Also "\ No newline at end of file": no project patch needs it, so it is not supported.
        throw new Error(`Unexpected line in the hunk ${header} of ${path}: ${line}`);
      }
      if (oldCount < 0 || newCount < 0) {
        throw new Error(`The hunk ${header} of ${path} has other line counts than its header.`);
      }
      index++;
    }
    if (hunk.oldLines.length === 0) {
      throw new Error(`The hunk ${header} of ${path} has no old lines to match.`);
    }
    if (hunk.oldLines.join("\n") === hunk.newLines.join("\n")) {
      throw new Error(`The hunk ${header} of ${path} changes nothing.`);
    }
    hunks.push(hunk);
  }
  if (hunks.length === 0) throw new Error(`The patch has no hunk for ${path}.`);
  if (index < lines.length) {
    throw new Error(
      `Unexpected text after the hunks of ${path} at patch line ${
        index + 1
      }; a patch changes one file.`,
    );
  }
  return { path, hunks };
}

/** Returns where `needle` starts as whole lines of `haystack`. */
function occurrences(haystack: readonly string[], needle: readonly string[]): number[] {
  const starts: number[] = [];
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((line, offset) => haystack[start + offset] === line)) starts.push(start);
  }
  return starts;
}

/**
 * Returns `text` with the hunks applied. Every hunk is placed in the original text, in order and without overlap,
 * so a hunk can never match lines that an earlier hunk wrote.
 */
export function applyHunks(text: string, patch: FilePatch): string {
  // The patch lines carry no CR, so a CRLF source would match nothing; say so instead of "does not apply".
  if (text.includes("\r")) {
    throw new Error(`${patch.path} has CR line endings, which no project patch expects.`);
  }
  // A final LF ends the last line; it is not an empty line that a hunk could match or remove.
  const terminated = text.endsWith("\n");
  const original = (terminated ? text.slice(0, -1) : text).split("\n");
  const problem = (hunk: Hunk, what: string): Error =>
    new Error(
      `The hunk ${hunk.header} of the patch for ${patch.path} ${what}.`
        + " Check whether the patch is still needed for the pinned source.",
    );
  const placed: Array<{ start: number; hunk: Hunk }> = [];
  let end = 0;
  for (const hunk of patch.hunks) {
    // As GNU patch detects a reversed or previously applied patch: the source may already have the change.
    if (occurrences(original, hunk.newLines).length > 0) {
      throw problem(hunk, "finds its result already present");
    }
    const starts = occurrences(original, hunk.oldLines);
    if (starts.length === 0) throw problem(hunk, "does not apply");
    if (starts.length > 1) throw problem(hunk, `matches ${starts.length} places`);
    const start = starts[0]!;
    if (start < end) throw problem(hunk, "overlaps or precedes the hunk before it");
    placed.push({ start, hunk });
    end = start + hunk.oldLines.length;
  }
  const result: string[] = [];
  let next = 0;
  for (const { start, hunk } of placed) {
    result.push(...original.slice(next, start), ...hunk.newLines);
    next = start + hunk.oldLines.length;
  }
  result.push(...original.slice(next));
  return result.join("\n") + (terminated ? "\n" : "");
}

/**
 * Applies a patch file to an extracted source tree and returns the path it changed. Nothing is written unless
 * every hunk applies. Latin-1 maps every byte to one character, so a file that is not UTF-8 keeps its bytes.
 */
export async function applyPatchFile(sourceRoot: string, patchPath: string): Promise<string> {
  const patch = parsePatch(await readFile(patchPath, "latin1"));
  const target = join(sourceRoot, patch.path);
  await writeFile(target, applyHunks(await readFile(target, "latin1"), patch), "latin1");
  return patch.path;
}
