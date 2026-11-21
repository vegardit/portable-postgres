/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Reduces the copyright and licence text of a source tree to a set of signatures, so that a source update that
 * brings new licence text reopens the source's licence review: the set changes. It scans every file of the
 * pinned source, not only the compiled ones. Tracing what each image compiles needs heuristics that an upstream
 * build change can break silently, and the release's source bundle redistributes the whole tree anyway.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import * as z from "zod";

const attribution =
  /copyright|©|\(c\)\s*(?:19|20)\d\d|\blicen[cs](?:e|ed|es|ing)\b|public domain|all rights reserved/i;
const grant = /redistribution and use|permission (?:is hereby granted|to use)/i;
const hashGrant = /\b(?:you (?:can|may) redistribute|gives unlimited permission)\b/i;
// Not "derived": design notes say "derived state", and licence text that uses it also says "software".
const condition = /warrant|liab|distribut|permission|\bnotice\b|\bsold\b/i;
const attributionProse = /\b(?:software|authors?)\b/i;

function mentionsNotice(text: string): boolean {
  return attribution.test(text) || grant.test(text);
}

const copyrightLine = /copyright|\(c\)|©/i;
const years = /\b(?:19|20)\d\d(?:\s*[-,]\s*(?:19|20)?\d\d)*\b/g;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The text of a file, or `undefined` for a binary one. UTF-16 needs its byte order mark, because its text
 * contains NUL bytes. Otherwise UTF-8 first: decoding UTF-8 as latin1 would turn "é" (C3 A9) into "Ã©" and
 * report every French translation as a copyright notice. A file that is not valid UTF-8, such as an old
 * latin1 source whose "©" is the single byte A9, is read as latin1.
 */
export function decodeText(data: Uint8Array): string | undefined {
  if (data[0] === 0xFF && data[1] === 0xFE) return new TextDecoder("utf-16le").decode(data);
  if (data[0] === 0xFE && data[1] === 0xFF) return new TextDecoder("utf-16be").decode(data);
  // A NUL byte near the start marks object code, images and compressed data; no source text contains one.
  if (data.subarray(0, 8192).includes(0)) return undefined;
  try {
    return utf8.decode(data);
  } catch {
    return Buffer.from(data).toString("latin1");
  }
}

/**
 * Reduces a notice line to what a licence review cares about: comment markers and spacing are dropped, and so
 * are the years of a copyright line, so its yearly bump changes nothing. Holders, grants and exceptions count.
 */
export function normalizeNoticeLine(line: string): string {
  const text = line.replaceAll(/^[\s/*#;%-]+|\s*\*?\/?\s*$/g, "");
  return (copyrightLine.test(text) ? text.replaceAll(years, "YYYY") : text).replaceAll(/\s+/g, " ")
    .trim();
}

/** Keeps notice paragraphs in a comment block that can also contain a file description or implementation notes. */
function addBlockNotices(body: string[], found: Set<string>, hashGrantBlock = false): void {
  if (!hashGrantBlock && !body.some(mentionsNotice)) return;
  const paragraphs = body.map(normalizeNoticeLine).join("\n").trim().split(/\n{2,}/);
  const grantIndex = paragraphs.findIndex(paragraph => grant.test(paragraph));
  let inGrant = false;
  for (const [index, paragraph] of paragraphs.entries()) {
    const lines = paragraph.split("\n");
    // Autoconf grants can start a line before the permission phrase or licence name.
    const opensHashGrant = hashGrantBlock && hashGrant.test(paragraph);
    // Shell and M4 maintenance notes often mention the software after its grant has ended.
    const aboutTerms = condition.test(paragraph)
      || (!hashGrantBlock && attributionProse.test(paragraph));
    const start: number = opensHashGrant || (inGrant && aboutTerms)
      ? 0
      : lines.findIndex(mentionsNotice);
    if (start >= 0) {
      for (const line of lines.slice(start)) found.add(line);
    }
    // In regcomp.c the notice starts at the copyright: it disclaims the funders' responsibility
    // before the grant and explains attribution after it. A file description can precede both.
    const startsNotice = start === 0
      && (index === 0 || (index < grantIndex && copyrightLine.test(lines[0]!)));
    inGrant ||= startsNotice || index === grantIndex || opensHashGrant;
  }
}

const proseFile = /(?:^|\/)readme(?:$|\.)|\.(?:md|mmd|markdown|txt)$/i;
const licenceHeading = /^(?:licen[cs]es?|licensing|copyright(?:\s+(?:and|&)\s+licen[cs]es?)?)$/i;

/** A subsection belongs to the enclosing licence until a peer or higher-level heading ends it. */
function licenceLevel(current: number, depth: number, title: string): number {
  if (current > 0 && depth > current) return current;
  return licenceHeading.test(title) ? depth : 0;
}

function addNoticeLine(line: string, found: Set<string>): void {
  const normalized = normalizeNoticeLine(line);
  if (normalized !== "") found.add(normalized);
}

/** ppport.h embeds POD followed by a Perl program inside one C comment. Only POD headings delimit its grant. */
function addCBlockNotices(body: string[], found: Set<string>): void {
  const pod = body.findIndex(line => /^=(?:pod(?:\s|$)|head[1-6]\s)/.test(line));
  if (pod === -1) {
    addBlockNotices(body, found);
    return;
  }
  addBlockNotices(body.slice(0, pod), found);
  let level = 0;
  for (const line of body.slice(pod)) {
    const heading = /^=head([1-6])\s+(.+?)\s*$/.exec(line);
    if (heading) {
      level = licenceLevel(level, Number(heading[1]), heading[2]!);
    } else if (/^=cut(?:\s|$)/.test(line)) {
      level = 0;
    }
    if (level > 0) addNoticeLine(line, found);
  }
}

/** Marks complete licence sections in prose so a wrapped condition can change on a line without a keyword. */
function licenceSectionLines(lines: string[]): Set<number> {
  const included = new Set<number>();
  let level = 0;
  let fence = "";
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const delimiter = /^(`{3,}|~{3,})/.exec(line)?.[0];
    if (fence !== "") {
      if (delimiter === line && delimiter.startsWith(fence)) fence = "";
    } else if (delimiter !== undefined) {
      fence = delimiter;
    } else if (line !== "") {
      const atx = /^(#{1,6})\s+(.*?)(?:\s+#+)?$/.exec(line);
      const underline = lines[index + 1]?.trim() ?? "";
      let depth = atx?.[1]?.length ?? 0;
      if (depth === 0 && /^(?:=+|-+)$/.test(underline)) depth = underline.startsWith("=") ? 1 : 2;
      if (depth > 0) level = licenceLevel(level, depth, atx?.[2] ?? line);
    }
    if (level > 0 && !/^(?:=+|-+)$/.test(line)) included.add(index);
  }
  return included;
}

/** Adds notices from ordinary source text or marked Markdown sections, in source order. */
function addSourceNotices(text: string, path: string, found: Set<string>): void {
  if (!mentionsNotice(text) && !hashGrant.test(text)) return;
  const lines = text.split(/\r?\n/);
  const section = proseFile.test(path) ? licenceSectionLines(lines) : undefined;
  // Both config.guess and install-sh are shell scripts without a .sh suffix.
  const shell = /\.(?:ba|da|k|z)?sh$/i.test(path)
    || /^#!\s*(?:\S*\/)?(?:env\s+(?:-S\s+)?)?(?:ba|da|k|z)?sh(?:\s|$)/.test(lines[0]!);
  const m4 = /\.m4$/i.test(path);
  const hashMarker = shell || m4 ? /^\s*#(?!!|\s*SPDX-)/ : undefined;
  const dnlMarker = m4 ? /^\s*dnl\b/ : undefined;
  let block: string[] | undefined;
  let previousMarker: string | undefined;
  let endedSentence = false;

  const addLine = (line: string, marker?: string): void => {
    const explicit = mentionsNotice(line);
    const continuation = marker !== undefined && marker === previousMarker;
    previousMarker = undefined;
    if (!explicit && !continuation) return;
    const normalized = normalizeNoticeLine(line);
    // In .po and SQL files a complete licence sentence often precedes unrelated comments.
    const numberedClause = /^(?:\d+[.)]|\([a-z\d]+\))\s/i.test(normalized);
    if (normalized === "" || (!explicit && endedSentence && !numberedClause)) return;
    found.add(normalized);
    // An SPDX tag is a complete statement on one line, so the next line is never its continuation.
    previousMarker = /^SPDX-[A-Za-z][A-Za-z0-9-]*:/.test(normalized) ? undefined : marker;
    endedSentence = normalized.endsWith(".");
  };
  for (let index = 0; index < lines.length; index++) {
    const line = block === undefined ? lines[index]!.trimStart() : lines[index]!;
    if (section?.has(index)) {
      addNoticeLine(line, found);
      previousMarker = undefined;
      continue;
    }

    const blockMarker = line.startsWith("#") ? hashMarker : dnlMarker;
    if (block === undefined && blockMarker?.test(line)) {
      // Bare markers separate paragraphs inside the notice. A physical blank ends the comment block.
      const body = [line.replace(blockMarker, "")];
      while (index + 1 < lines.length && blockMarker.test(lines[index + 1]!)) {
        body.push(lines[++index]!.replace(blockMarker, ""));
      }
      // Only hash blocks with grants need paragraph handling. Other hash comments use sentence boundaries.
      const hash = blockMarker === hashMarker;
      if (hash && !body.some(part => grant.test(part) || hashGrant.test(part))) {
        for (const part of body) addLine(part, "#");
      } else {
        addBlockNotices(body, found, hash);
      }
      previousMarker = undefined;
    } else if (block !== undefined || line.startsWith("/*")) {
      const start = block === undefined ? 2 : 0;
      const end = line.indexOf("*/", start);
      const body = line.slice(start, end === -1 ? undefined : end);
      if (block !== undefined || end === -1) {
        block ??= [];
        block.push(body);
        previousMarker = undefined;
        if (end === -1) continue;
        addCBlockNotices(block, found);
        block = undefined;
      } else {
        // GEQO writes each line of a single grant as a separate C comment.
        addLine(body, "/*");
      }
      const tail = line.slice(end + 2).trim();
      if (tail !== "") addLine(tail);
    } else {
      addLine(line, /^(?:\/\/|--|[#;%](?=\s|$))/.exec(line)?.[0]);
    }
  }
  if (block !== undefined) addCBlockNotices(block, found);
}

/** The file's distinct normalized notice lines and their continuations, in source order. */
export function noticeSignature(text: string, path = ""): string | undefined {
  const found = new Set<string>();
  let offset = 0;
  if (/\.sgml?$/i.test(path)) {
    // DocBook identifies the holder and grant explicitly. Treat entities as source text.
    const elements = /<!--[\s\S]*?-->|<(copyright|legalnotice)(?=[\s>])[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    for (const match of text.matchAll(elements)) {
      if (match[1] === undefined) continue;
      addSourceNotices(text.slice(offset, match.index), path, found);
      const body = match[1].toLowerCase() === "copyright"
        ? match[2]!.replaceAll(/<year\b[^>]*>[\s\S]*?<\/year\s*>/gi, "")
        : match[2]!;
      for (const line of body.replaceAll(/<!--[\s\S]*?-->|<[^>]+>/g, " ").split(/\r?\n/)) {
        addNoticeLine(line, found);
      }
      offset = match.index + match[0].length;
    }
  }
  addSourceNotices(text.slice(offset), path, found);
  return found.size === 0 ? undefined : [...found].join(" | ");
}

/** Source code whose name happens to start like a licence file, such as `notice.c`. */
const codeFile =
  /\.(?:c|h|cc|cpp|hpp|y|l|sql|pl|pm|py|rb|js|ts|sh|cmake|in|am|ac|m4|sgml|xml|html?|out|source|spec|po)$/i;

/**
 * Whether a file is a licence text of its own, such as `LICENSE`, `COPYING.LIB`, `NOTICE` or
 * `SectionMemoryManager.LICENSE`. Its conditions often sit in lines without any keyword, so such a file is
 * fingerprinted whole instead of by its notice lines.
 */
export function isLicenceFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/\.licen[cs]e$/i.test(name)) return true;
  return /^(?:licen[cs]e|copying|copyright|notice)s?(?:[._-]|$)/i.test(name)
    && !codeFile.test(name);
}

/**
 * The signature of a licence file: its path, so that a moved licence is noticed, and the SHA-256 of its text
 * with spacing, blank lines and copyright years normalized.
 */
export function licenceFileSignature(path: string, text: string): string {
  const normalized = text.split(/\r?\n/).map(line =>
    (copyrightLine.test(line) ? line.replaceAll(years, "YYYY") : line).replaceAll(/\s+/g, " ")
      .trim()
  ).filter(Boolean).join("\n");
  return `licence file ${path} sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

/**
 * Scans every regular file below `directory` and returns each signature with the files that have it, by path
 * relative to `directory` with forward slashes, both sorted. Symbolic links are skipped: the file they point to is
 * scanned where it lies, and a link out of the tree must not add a file from elsewhere.
 */
export async function scanNoticeSignatures(directory: string): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const text = decodeText(await readFile(path));
    if (text === undefined) continue;
    const name = relative(directory, path).split(sep).join("/");
    const signature = isLicenceFile(name)
      ? licenceFileSignature(name, text)
      : noticeSignature(text, name);
    if (signature === undefined) continue;
    const files = found.get(signature) ?? [];
    files.push(name);
    found.set(signature, files);
  }
  return new Map(
    [...found].sort(([left], [right]) => compareOrdinal(left, right))
      .map(([signature, files]) => [signature, files.sort(compareOrdinal)]),
  );
}

/** Ordinal order, so that the result does not depend on the host's locale. */
export function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Where a fresh build stores the scan of its sources in its work directory, for reassembly to reuse. */
export const sourceNoticesFile = "source-notices.json";

/** Each source's signatures, each with every file that has it. */
export type SourceNoticeScan = Record<string, Record<string, string[]>>;
/** Preserve the exact signature or path while rejecting blank text at either storage boundary. */
export const nonblankText = z.string().refine(value => value.trim().length > 0,
  "expected a nonempty string");
export const maxNoticeExamples = 3;
const scanSchema = z.record(nonblankText, z.record(nonblankText, z.array(nonblankText)));

/**
 * Scans each source below `sourcesRoot`, one directory per source ID, and stores the result in `file`. A build
 * runs it right after extracting the archives: the Linux build compiles inside the source trees, and its
 * generated files must not count as upstream text. The scanner is part of both build recipes, so reassembly
 * never reuses a scan that another version of it made.
 */
export async function writeSourceNoticeScan(
  sourcesRoot: string,
  sourceIds: readonly string[],
  file: string,
): Promise<SourceNoticeScan> {
  const scan: SourceNoticeScan = {};
  for (const id of sourceIds) {
    scan[id] = Object.fromEntries(await scanNoticeSignatures(join(sourcesRoot, id)));
  }
  await writeFile(file, JSON.stringify(scan, null, 2) + "\n");
  return scan;
}

/** Reads the scan that a fresh build stored; a build without one predates the scanner and must be redone. */
export async function readSourceNoticeScan(file: string): Promise<SourceNoticeScan> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error("A fresh build is required: the build stored no source notice scan in " + file);
  });
  const result = scanSchema.safeParse(JSON.parse(text));
  if (!result.success) throw new Error("Malformed source notice scan: " + file);
  return result.data;
}

/** The public manifest stores notice text as a value so case-insensitive JSON readers can read it. */
export type NoticeSignatureExample = { signature: string; files: string[] };

/**
 * What a manifest records of a scan: each signature with up to three of its files, which tell a reviewer where
 * to look when a signature is new. Only the signatures are reviewed, so a file that comes or goes changes nothing.
 */
export function noticeSignatureExamples(
  scan: SourceNoticeScan,
): Record<string, NoticeSignatureExample[]> {
  return Object.fromEntries(Object.entries(scan).map(([id, signatures]) => [
    id,
    Object.entries(signatures).map(([signature, files]) => ({
      signature,
      files: files.slice(0, maxNoticeExamples),
    })),
  ]));
}
