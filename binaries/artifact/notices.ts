/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Names and copies the upstream licence notices that belong to the runtime payload. */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readOptionalText } from "../files.ts";
import { root } from "../paths.ts";
import { sources } from "../sources/sources.ts";

/**
 * Where the repository keeps the licence texts that a source needs but does not contain, such as Unicode's licence
 * for the tables PostgreSQL generates from Unicode data. `sources.json` pins each one (`projectNotices`) by SHA-256.
 */
export const projectNoticeRoot = join(root, "binaries/sources/notices");

/**
 * Reads the repository's copy of a project notice and refuses it unless it still has its pinned SHA-256: a review
 * binds the shipped bytes, so a text edited after pinning must not reach a candidate.
 */
export async function readProjectNotice(
  sourceId: string,
  notice: { file: string; sha256: string },
): Promise<Buffer> {
  const text = await readFile(join(projectNoticeRoot, sourceId, notice.file));
  if (createHash("sha256").update(text).digest("hex") !== notice.sha256) {
    throw new Error(
      `The project notice ${sourceId}/${notice.file} no longer matches its SHA-256 in sources.json.`,
    );
  }
  return text;
}

/**
 * A fact in the pinned source that a project notice depends on, such as the Snowball commit that PostgreSQL's
 * stemmers come from. `file` selects lines (all of them, those matching `match`, or the block from the one line
 * matching `from` through the next line matching `to`) and pins them as `text` or by SHA-256. `files` pins a set of
 * files, `dir/*.ext`, by the SHA-256 of their sorted names and contents.
 */
export type NoticeAnchor = {
  file?: string;
  files?: string;
  match?: string;
  from?: string;
  to?: string;
  text?: string;
  sha256?: string;
};

const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** Returns the lines that an anchor selects from `text`, or why it selects none. */
export function anchoredLines(text: string, anchor: NoticeAnchor): string[] | { problem: string } {
  const lines = text.split(/\r?\n/);
  if (anchor.match !== undefined) {
    const pattern = new RegExp(anchor.match);
    const selected = lines.filter(line => pattern.test(line));
    return selected.length > 0 ? selected : { problem: `no line matches /${anchor.match}/` };
  }
  if (anchor.from !== undefined || anchor.to !== undefined) {
    if (anchor.from === undefined || anchor.to === undefined) {
      return { problem: "an anchor needs both from and to" };
    }
    const from = new RegExp(anchor.from);
    const to = new RegExp(anchor.to);
    const starts = lines.flatMap((line, index) => from.test(line) ? [index] : []);
    if (starts.length !== 1) {
      return { problem: `${starts.length} lines match /${anchor.from}/, expected one` };
    }
    const end = lines.findIndex((line, index) => index > starts[0]! && to.test(line));
    if (end === -1) return { problem: `no line after /${anchor.from}/ matches /${anchor.to}/` };
    return lines.slice(starts[0], end + 1);
  }
  return lines;
}

/** Returns why an anchor no longer holds in a source tree, or undefined while it does. */
async function anchorProblem(
  sourceRoot: string,
  anchor: NoticeAnchor,
): Promise<string | undefined> {
  if (anchor.files !== undefined) {
    const separator = anchor.files.lastIndexOf("/");
    const [prefix, suffix] = anchor.files.slice(separator + 1).split("*");
    if (suffix === undefined || anchor.sha256 === undefined) {
      return `the file set ${anchor.files} needs one * and a sha256`;
    }
    const directory = join(sourceRoot, anchor.files.slice(0, separator));
    const names = (await readdir(directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }))
      .filter(name => name.startsWith(prefix!) && name.endsWith(suffix)).sort();
    if (names.length === 0) return `no file matches ${anchor.files}`;
    const listing = [];
    for (const name of names)
      listing.push(name + "\t" + sha256Hex(await readFile(join(directory, name))));
    const observed = sha256Hex(listing.join("\n"));
    return observed === anchor.sha256
      ? undefined
      : `${anchor.files} (${names.length} files) has SHA-256 ${observed}, pinned ${anchor.sha256}`;
  }
  if (anchor.file === undefined) return "an anchor needs file or files";
  const text = await readOptionalText(join(sourceRoot, anchor.file));
  if (text === undefined) return `${anchor.file} is missing`;
  const selected = anchoredLines(text, anchor);
  if ("problem" in selected) return `${anchor.file}: ${selected.problem}`;
  const joined = selected.join("\n");
  if (anchor.text !== undefined) {
    return joined === anchor.text
      ? undefined
      : `${anchor.file} now has ${JSON.stringify(joined)}, pinned ${JSON.stringify(anchor.text)}`;
  }
  if (anchor.sha256 === undefined) return `the anchor on ${anchor.file} needs text or sha256`;
  const observed = sha256Hex(joined);
  return observed === anchor.sha256
    ? undefined
    : `${anchor.file} (${selected.length} selected lines) has SHA-256 ${observed}, pinned ${anchor.sha256}`;
}

/**
 * Checks the source facts behind project notices before compilation or when reusing a saved build.
 * Reports each changed fact with its observed value so a reviewer can check the notice and update its anchor.
 */
export async function verifyNoticeAnchors(
  sourceRoot: string,
  pins: ReadonlyArray<
    {
      id: string;
      projectNotices?: ReadonlyArray<{ file: string; anchors?: readonly NoticeAnchor[] }>;
    }
  > = sources,
): Promise<void> {
  const problems: string[] = [];
  for (const source of pins) {
    for (const notice of source.projectNotices ?? []) {
      for (const anchor of notice.anchors ?? []) {
        const problem = await anchorProblem(join(sourceRoot, source.id), anchor);
        if (problem !== undefined) problems.push(`${source.id}/${notice.file}: ${problem}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      "The source facts behind these project notices changed. Re-check each notice, then update its anchor in"
        + " binaries/sources/sources.json:\n" + problems.join("\n"),
    );
  }
}

/** Header files retained for their licence text use a text suffix because the runtime excludes SDK headers. */
export function additionalNoticeName(sourceId: string, file: string): string {
  return sourceId + "-" + file.replaceAll("/", "-") + (/\.h$/i.test(file) ? ".txt" : "");
}

/**
 * Preserves exact upstream license and attribution texts alongside the source-input manifest.
 * `toolchainNotices` are the project's own texts for linked toolchain code that has no upstream notice.
 * `prefix` is a fresh candidate, so only the current pins' notices are there.
 */
export async function copySourceNotices(
  sourceRoot: string,
  prefix: string,
  toolchainNotices: readonly string[] = [],
): Promise<void> {
  const notices = join(prefix, "notices");
  await mkdir(notices, { recursive: true });
  for (const source of sources) {
    await cp(join(sourceRoot, source.id, source.licenseFile), join(notices, source.id + ".txt"));
    if ("noticeFiles" in source) {
      for (const file of source.noticeFiles ?? []) {
        await cp(
          join(sourceRoot, source.id, file),
          join(notices, additionalNoticeName(source.id, file)),
        );
      }
    }
    if ("projectNotices" in source) {
      for (const notice of source.projectNotices) {
        await writeFile(
          join(notices, additionalNoticeName(source.id, notice.file)),
          await readProjectNotice(source.id, notice),
        );
      }
    }
  }
  for (const notice of toolchainNotices) await cp(notice, join(notices, basename(notice)));
  // Record the inputs loaded for this build, even if the repository manifest changes concurrently.
  await writeFile(join(notices, "source-inputs.json"), JSON.stringify(sources, null, 2) + "\n");
}
