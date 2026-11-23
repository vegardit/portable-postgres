/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks that each build ships exactly the notices of the current source pins. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { toolchainNotices } from "../binaries/artifact/artifact.ts";
import {
  anchoredLines,
  copySourceNotices,
  projectNoticeRoot,
  readProjectNotice,
  verifyNoticeAnchors,
} from "../binaries/artifact/notices.ts";
import { root } from "../binaries/paths.ts";
import { sources } from "../binaries/sources/sources.ts";
import { sourceTree } from "./candidate.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

const { directory, cleanup } = temporaryDirectories("notices");
afterEach(cleanup);

it("ships both Regents notices from PostgreSQL under runtime-safe names", async () => {
  const tree = await sourceTree(await directory());
  const candidate = await directory();
  const notices = [
    ["src/port/pgmkdirp.c", "postgresql-src-port-pgmkdirp.c"],
    ["src/include/lib/sort_template.h", "postgresql-src-include-lib-sort_template.h.txt"],
  ] as const;
  for (const [source] of notices) {
    await writeFile(join(tree, "postgresql", source), source + "\r\n");
  }
  await copySourceNotices(tree, candidate);
  for (const [source, name] of notices) {
    await expect(readFile(join(candidate, "notices", name))).resolves.toEqual(
      await readFile(join(tree, "postgresql", source)),
    );
  }
});

it("each toolchain notice has its text next to the target's recipe and ships under its archive path", async () => {
  // The Windows build passes the recipe file with the same relative path as the archive path.
  for (const notice of toolchainNotices("windows-x64")) {
    const text = join(root, "binaries/windows", notice);
    const installation = await directory();
    await copySourceNotices(await sourceTree(await directory()), installation, [text]);
    await expect(readFile(join(installation, notice), "utf8")).resolves.toBe(
      await readFile(text, "utf8"),
    );
  }
  // The Linux build passes no toolchain notices; a Linux notice would need it to.
  expect(toolchainNotices("linux-x64-glibc")).toEqual([]);
});

it("ships every project notice with its pinned bytes, and refuses a text edited after pinning", async () => {
  const pinned = sources.flatMap(source =>
    ("projectNotices" in source ? source.projectNotices : []).map(notice => ({
      source: source.id,
      notice,
    }))
  );
  expect(pinned.length).toBeGreaterThan(0);
  const installation = await directory();
  await copySourceNotices(await sourceTree(await directory()), installation);
  for (const { source, notice } of pinned) {
    const text = await readFile(join(projectNoticeRoot, source, notice.file));
    // The repository copy is the one that sources.json pins.
    expect(createHash("sha256").update(text).digest("hex"), notice.file).toBe(notice.sha256);
    await expect(readFile(join(installation, "notices", source + "-" + notice.file))).resolves
      .toEqual(text);
  }
  const { source, notice } = pinned[0]!;
  await expect(readProjectNotice(source, { ...notice, sha256: "0".repeat(64) })).rejects.toThrow(
    `The project notice ${source}/${notice.file} no longer matches its SHA-256 in sources.json.`,
  );
});

it("an anchor selects matching lines, or one block from its start through the next end line", () => {
  const text = "a\n#define V 1\nb\n/* begin */\nx\n#endif\ny\n#endif\n";
  expect(anchoredLines(text, { match: "^#define" })).toEqual(["#define V 1"]);
  expect(anchoredLines(text, { from: "begin", to: "^#endif" })).toEqual([
    "/* begin */",
    "x",
    "#endif",
  ]);
  expect(anchoredLines("a\r\nb", {})).toEqual(["a", "b"]);
  expect(anchoredLines(text, { match: "^missing" })).toEqual({
    problem: "no line matches /^missing/",
  });
  expect(anchoredLines(text + "/* begin */\n", { from: "begin", to: "^#endif" })).toEqual({
    problem: "2 lines match /begin/, expected one",
  });
  expect(anchoredLines(text, { from: "begin" })).toEqual({
    problem: "an anchor needs both from and to",
  });
});

it("a changed fact behind a project notice fails the build with its observed value", async () => {
  const tree = await directory();
  await mkdir(join(tree, "fixture", "stop"), { recursive: true });
  await writeFile(join(tree, "fixture", "README"), "synced with commit\nabc\n");
  await writeFile(join(tree, "fixture", "stop", "a.stop"), "and\n");
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const set = sha("a.stop\t" + sha("and\n"));
  const pins = (readme: string, stopwords: string) => [{
    id: "fixture",
    projectNotices: [{
      file: "notice.txt",
      anchors: [
        { file: "README", match: "^abc$|^def$", text: readme },
        { files: "stop/*.stop", sha256: stopwords },
      ],
    }],
  }];
  await expect(verifyNoticeAnchors(tree, pins("abc", set))).resolves.toBeUndefined();
  await writeFile(join(tree, "fixture", "README"), "synced with commit\ndef\n");
  await writeFile(join(tree, "fixture", "stop", "b.stop"), "or\n");
  const failure = verifyNoticeAnchors(tree, pins("abc", set));
  await expect(failure).rejects.toThrow('fixture/notice.txt: README now has "def", pinned "abc"');
  const listing = "a.stop\t" + sha("and\n") + "\nb.stop\t" + sha("or\n");
  await expect(failure).rejects.toThrow(
    `stop/*.stop (2 files) has SHA-256 ${sha(listing)}, pinned ${set}`,
  );
  await rm(join(tree, "fixture", "README"));
  await expect(verifyNoticeAnchors(tree, pins("def", set))).rejects.toThrow("README is missing");
});

it("the Snowball COPYING notice comes from the commit that its anchor pins", () => {
  const postgresql = sources.find(source => source.id === "postgresql")!;
  const notices = "projectNotices" in postgresql ? postgresql.projectNotices : [];
  const copying = notices.find(notice => notice.file === "snowball-copying.txt")!;
  const commit = copying.anchors.find(anchor => "text" in anchor);
  expect(commit && "text" in commit && copying.origin.includes(commit.text)).toBe(true);
  // Every project notice names at least one fact that the build checks.
  for (const notice of notices) expect(notice.anchors.length, notice.file).toBeGreaterThan(0);
});

it("the Unicode anchor detects an input moved to a different download rule", () => {
  const pg = sources.find(source => source.id === "postgresql")!;
  const notice = pg.projectNotices!.find(pin => pin.file === "unicode-license-v3.txt")!;
  const anchor = notice.anchors.find(pin => "file" in pin && pin.file.endsWith("/Makefile"))!;
  const rules = (first: string, second: string) =>
    first + ":\n\t$(DOWNLOAD) https://example.org/icu/$(@F)\n"
    + second + ":\n\t$(DOWNLOAD) https://example.org/other/$(@F)\n";
  expect(anchoredLines(rules("a.xml b.xml", "c.xml"), anchor))
    .not.toEqual(anchoredLines(rules("a.xml", "b.xml c.xml"), anchor));
});

it.each(["file", "files"] as const)("preserves a filesystem error reading a %s anchor",
  async key => {
    const tree = await directory();
    await mkdir(join(tree, "fixture"));
    await writeFile(join(tree, "fixture", "parent"), "a regular file");
    // Reading a directory as text or listing a regular file must report the original I/O error.
    const anchor = key === "files"
      ? { files: "parent/*.stop", sha256: "0".repeat(64) }
      : { file: ".", text: "" };
    await expect(verifyNoticeAnchors(tree, [{
      id: "fixture",
      projectNotices: [{ file: "notice.txt", anchors: [anchor] }],
    }])).rejects.toMatchObject({ code: key === "files" ? "ENOTDIR" : "EISDIR" });
  });
