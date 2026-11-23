/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks how source files are reduced to notice signatures. */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  decodeText,
  isLicenceFile,
  licenceFileSignature,
  normalizeNoticeLine,
  noticeSignature,
  noticeSignatureExamples,
  readSourceNoticeScan,
  scanNoticeSignatures,
  writeSourceNoticeScan,
} from "../binaries/artifact/notice-scan.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

const { directory, cleanup } = temporaryDirectories("scan");
afterEach(cleanup);

it("a UTF-8 accent is no copyright sign, while a latin1 one is", () => {
  // "Quiédeville" in UTF-8: read as latin1, its C3 A9 would become "Ã©".
  const french = decodeText(Buffer.from("# Merci à Rodolphe Quiédeville\n", "utf8"))!;
  expect(noticeSignature(french)).toBeUndefined();
  const latin1 = decodeText(
    Buffer.from([0x2F, 0x2A, 0x20, 0xA9, 0x20, 0x41, 0x63, 0x6D, 0x65, 0x20, 0x2A, 0x2F]),
  )!;
  expect(noticeSignature(latin1)).toBe("© Acme");
  expect(decodeText(Buffer.from([0x7F, 0x45, 0x4C, 0x46, 0x00, 0x01]))).toBeUndefined();
});

it("a signature ignores years, comment markers and spacing, but keeps holders and grants", () => {
  expect(
    normalizeNoticeLine(" * Portions Copyright (c) 1996-2025, PostgreSQL Global Development Group"),
  ).toBe(
    "Portions Copyright (c) YYYY, PostgreSQL Global Development Group",
  );
  expect(normalizeNoticeLine("-- Copyright 2019, 2021  Jane   Doe */")).toBe(
    "Copyright YYYY Jane Doe",
  );
  const text = [
    "/*",
    " * Copyright (c) 2010 Acme",
    " * Permission is hereby granted, free of charge, to any person",
    " * Copyright (c) 2024 Acme",
    " */",
    "int main(void) { return 0; }",
  ].join("\r\n");
  // The second copyright line differs only in its year, so it adds nothing.
  expect(noticeSignature(text)).toBe(
    "Copyright (c) YYYY Acme | Permission is hereby granted, free of charge, to any person",
  );
  expect(noticeSignature("int main(void) { return 0; }\n")).toBeUndefined();
});

it.each([
  ["Darrell L. Whitley", "Another holder"],
  ["for free distribution", "for noncommercial distribution"],
])("changing %s in a GEQO notice reopens its signature", (before, after) => {
  // PostgreSQL's GEQO notice puts each line in its own C comment.
  const notice = [
    "/* Copyright (c) 1990 */",
    "/* Darrell L. Whitley */",
    "/* */",
    "/* Permission is hereby granted to copy all or any part of */",
    "/* this program for free distribution. The author's name */",
    "/* and this copyright notice must be included in any copy. */",
  ].join("\n");
  const signature = noticeSignature(notice);
  expect(noticeSignature(notice.replace("1990", "2026"))).toBe(signature);
  expect(noticeSignature(notice.replace(before, after))).not.toBe(signature);
});

it("keeps licence continuations inside comments and stops at ordinary code", () => {
  const block = "/*\nCopyright (c) 2025 Acme\n\nOnly for free distribution.\n*/";
  expect(noticeSignature(block + "\nint unrelated;")).toBe(
    "Copyright (c) YYYY Acme | Only for free distribution.",
  );
  expect(noticeSignature("-- Permission is hereby granted\n-- for free distribution.\nSELECT 1;"))
    .toBe("Permission is hereby granted | for free distribution.");
  // A mixed-purpose file header can also have an unrelated paragraph after its attribution.
  const mixed =
    "/*\n * Some implementation\n *\n * Copyright (c) 2025 Acme\n *\n * IDENTIFICATION\n * src/a.c\n */";
  expect(noticeSignature(mixed)).toBe("Copyright (c) YYYY Acme");
});

it.each([
  ["none of whom are responsible", "all of whom are responsible"],
  ["not a requirement", "a requirement"],
])("keeps %s in the notice of a mixed C header", (before, after) => {
  const header = [
    "/* Compile regular expressions.",
    " *",
    " * Copyright (c) 1998 Henry Spencer. All rights reserved.",
    " *",
    " * Development of this software was funded by Cray Research Inc. and others,",
    " * none of whom are responsible for the results. The author thanks all of them.",
    " *",
    " * Redistribution and use in source and binary forms are permitted.",
    " *",
    " * I'd appreciate being given credit for this package in the documentation",
    " * of software which uses it, but that is not a requirement.",
    " *",
    " * src/backend/regex/regcomp.c",
    " */",
  ].join("\n");
  const signature = noticeSignature(header);
  expect(noticeSignature(header.replace(before, after))).not.toBe(signature);
  expect(noticeSignature(header.replace("regcomp.c", "renamed.c"))).toBe(signature);
});

it.each([
  ["redistribute it and/or modify", "redistribute it"],
  ["WITHOUT ANY WARRANTY", "WITH A LIMITED WARRANTY"],
  ["generated by Autoconf", "generated by another tool"],
])("keeps %s in an M4 licence notice", (before, after) => {
  const source = [
    "dnl Copyright © 2012-2015 Dan Nicholson",
    "dnl",
    "dnl This program is free software; you can redistribute it and/or modify",
    "dnl it under the terms of the GNU General Public License.",
    "dnl",
    "dnl This program is distributed WITHOUT ANY WARRANTY;",
    "dnl see the GNU General Public License for details.",
    "dnl",
    "dnl As a special exception to the GNU General Public License, if you",
    "dnl distribute this file with a configuration script generated by Autoconf,",
    "dnl you may include it under the same terms as the rest of that program.",
    "",
    "dnl Describe what the macro checks.",
    "AC_DEFUN([PKG_PREREQ], [])",
  ].join("\n");
  const path = "config/pkg.m4";
  const signature = noticeSignature(source, path);
  expect(noticeSignature(source.replace(before, after), path)).not.toBe(signature);
  expect(
    noticeSignature(source.replace("what the macro checks", "the software configuration"), path),
  )
    .toBe(signature);
});

it.each([
  [
    "file description",
    "/* Copyright Acme\n * Licensed under the PostgreSQL License.\n *\n * EXAMPLE describes the query optimizer.\n */",
  ],
  [
    "SQL test comment",
    "-- Licensed under the Apache License.\n-- EXAMPLE exercises a query.\nSELECT 1;",
  ],
  ["translator credit", "# Distributed under the PostgreSQL license.\n# EXAMPLE, 2012-2017, 2024."],
  // PostgreSQL's ru.po files list another translator right after an SPDX copyright tag.
  [
    "translator credit after an SPDX tag",
    "# SPDX-FileCopyrightText: 2024 Jane Doe\n# EXAMPLE <x@example.org>, 2021.",
  ],
  [
    "description after an SPDX licence identifier",
    "// SPDX-License-Identifier: MIT\n// EXAMPLE sorts the list.",
  ],
  [
    "description that mentions derived state",
    "/* Copyright Acme\n * Licensed under the PostgreSQL License.\n *\n * EXAMPLE is derived state of the index.\n */",
  ],
])("editing a %s leaves the reviewed signature unchanged", (_, source) => {
  const signature = noticeSignature(source);
  expect(signature).toBeDefined();
  expect(noticeSignature(source.replace("EXAMPLE", "UPDATED"))).toBe(signature);
});

it("keeps explicit translation copyright holders and numbered grant clauses after a full stop", () => {
  const notice =
    "# Distributed under the PostgreSQL license.\n# SPDX-FileCopyrightText: 2024 Jane Doe";
  expect(noticeSignature(notice.replace("Jane Doe", "Another holder"))).not.toBe(
    noticeSignature(notice),
  );
  expect(noticeSignature(notice.replace("2024", "2026"))).toBe(noticeSignature(notice));
  const clauses = "-- Permission is hereby granted.\n-- (a) Keep this statement.";
  expect(noticeSignature(clauses.replace("Keep", "Remove"))).not.toBe(noticeSignature(clauses));
});

it.each([
  ["Copyright and License\n---------------------", "Contributing\n------------"],
  ["## Copyright and License", "## Contributing"],
])("keeps the whole labelled grant in a README starting at %s", async (heading, nextHeading) => {
  const tree = await directory();
  const file = join(tree, "README.md");
  const readme = [
    heading,
    "",
    "Copyright (c) 2025 Acme.",
    "",
    "Permission to use, copy, modify, and distribute this software and its",
    "documentation for any purpose, without fee, and without a written agreement is",
    "hereby granted, provided that the above copyright notice is retained.",
    "",
    nextHeading,
    "",
    "Send patches here.",
  ].join("\n");
  const scan = async (contents: string) => {
    await writeFile(file, contents);
    return [...(await scanNoticeSignatures(tree)).keys()];
  };
  const original = await scan(readme);
  await expect(scan(readme.replace("without fee", "for a fee"))).resolves.not.toEqual(original);
  await expect(scan(readme.replace("Send patches here", "Open a pull request"))).resolves.toEqual(
    original,
  );
});

it.each([
  ["redistribute it and/or modify", "redistribute it"],
  ["WITHOUT ANY WARRANTY", "WITH A LIMITED WARRANTY"],
  ["without prior written authorization", "even with prior written authorization"],
])("keeps %s in a shell notice with wrapped paragraphs", (before, after) => {
  const script = [
    "#! /bin/sh",
    "timestamp='2024-07-27'",
    "",
    "# This file is free software; you can redistribute it and/or modify it",
    "# under the terms of the GNU General Public License.",
    "#",
    "# This program is distributed WITHOUT ANY WARRANTY;",
    "# see the General Public License for more details.",
    "#",
    "# Except as contained in this notice, the name of the X Consortium shall not",
    "# be used in advertising without prior written authorization.",
    "#",
    "# Calling this script install-sh avoids an implicit make rule.",
    "exit 0",
  ].join("\n");
  const signature = noticeSignature(script, "config/config.guess");
  expect(noticeSignature(script.replace(before, after), "config/config.guess")).not.toBe(signature);
  expect(
    noticeSignature(script.replace("implicit make rule", "unwanted software rebuild"),
      "config/config.guess"),
  )
    .toBe(signature);
});

it("keeps the Perl POD grant and ignores a later program reference to its heading", () => {
  const header = [
    "/*",
    "=pod",
    "",
    "=head1 NAME",
    "",
    "Portability header",
    "",
    "=head1 COPYRIGHT",
    "",
    "Copyright (c) 1999 Example",
    "",
    "This program is free software; you can redistribute it and/or",
    "modify it under the same terms as Perl itself.",
    "",
    "=head1 SEE ALSO",
    "",
    "See Devel::PPPort.",
    "",
    "=cut",
    "",
    "my ($copy) = $self =~ /^=head\\d\\s+COPYRIGHT/m;",
    "Devel::PPPort::WriteFile($0);",
    "*/",
    "/* SPDX-License-Identifier: MIT */",
  ].join("\n");
  const signature = noticeSignature(header, "ppport.h");
  expect(noticeSignature(header.replace("as Perl itself", "as the parent project"), "ppport.h")).not
    .toBe(signature);
  expect(noticeSignature(header.replace("WriteFile", "NewFunction"), "ppport.h")).toBe(signature);
  expect(signature).not.toContain("my ($copy)");
  expect(signature).toContain("SPDX-License-Identifier: MIT");
});

it("keeps the grant, warranty and exceptions in M4 hash comments without a shebang", () => {
  const macro = [
    "# This file is part of Autoconf. This program is free",
    "# software; you can redistribute it and/or modify it under the",
    "# terms of the GNU General Public License.",
    "#",
    "# This program is distributed WITHOUT ANY WARRANTY;",
    "#",
    "# Under Section 7 of GPL version 3, you are granted additional",
    "# permissions described in the Autoconf Configure Script Exception.",
    "#",
    "# This special exception applies to versions of the Autoconf Macro",
    "# released by the Autoconf Archive. When you distribute a modified",
    "# version, you may extend this exception to your version as well.",
    "",
    "#serial 24",
    "dnl Describe the macro.",
    "AC_DEFUN([AX_PTHREAD], [])",
  ].join("\n");
  const signature = noticeSignature(macro, "config/ax_pthread.m4");
  for (const clause of [
    "This file is part of Autoconf",
    "and/or modify",
    "WITHOUT ANY WARRANTY",
    "Under Section 7",
    "Configure Script Exception",
    "you may extend this exception",
  ]) {
    expect.soft(signature, clause).toContain(clause);
  }
  expect(noticeSignature(macro.replace("serial 24", "serial 25"), "config/ax_pthread.m4")).toBe(
    signature,
  );
  expect(signature).not.toContain("Describe the macro");
});

it("keeps configure's FSF permission notice and ignores the generated version", () => {
  const permission = [
    "This configure script is free software; the Free Software Foundation",
    "gives unlimited permission to copy, distribute and modify it.",
  ];
  const comments = permission.map(line => "# " + line).join("\n");
  const configure = [
    "#! /bin/sh",
    "# Generated by GNU Autoconf 2.69 for PostgreSQL 18.7.",
    "#",
    "# Copyright (C) 2012 Free Software Foundation, Inc.",
    "#",
    comments,
    "",
    "exit 0",
  ].join("\n");
  const signature = noticeSignature(configure, "configure");
  expect(signature).toBe(
    ["Copyright (C) YYYY Free Software Foundation, Inc.", ...permission].join(" | "),
  );
  expect(noticeSignature(configure.replace("2.69", "2.72"), "configure")).toBe(signature);
  expect(noticeSignature(comments, "example.sh")).toBe(permission.join(" | "));
  expect(noticeSignature(permission.join("\n"), "example.sh")).toBeUndefined();
});

it("an SPDX tag in a shell script ends the notice before the script description", () => {
  const script = "#!/bin/sh\n# SPDX-License-Identifier: MIT\n# Configure this build.\nexit 0";
  expect(noticeSignature(script, "setup.sh")).toBe("SPDX-License-Identifier: MIT");
});

it("keeps SGML legal terms and holders while ignoring document dates and copyright years", () => {
  const document = [
    "<date>2025</date>",
    "<copyright>",
    "<year>1996&ndash;2025</year>",
    "<holder>Example Group</holder>",
    "</copyright>",
    '<legalnotice id="legalnotice">',
    "<para>Permission to use this software",
    "for any purpose, without fee, is granted.</para>",
    "<para>THE AUTHORS DISCLAIM ALL WARRANTIES.</para>",
    "</legalnotice>",
    "<para>Install the software locally.</para>",
  ].join("\n");
  const signature = noticeSignature(document, "doc/legal.sgml");
  for (const phrase of ["without fee", "Example Group", "ALL WARRANTIES"]) {
    expect(noticeSignature(document.replace(phrase, "changed"), "doc/legal.sgml"), phrase).not.toBe(
      signature,
    );
  }
  for (const [before, after] of [
    ["<date>2025", "<date>2026"],
    ["&ndash;2025", "&ndash;2026"],
    ["locally", "elsewhere"],
  ] as const) {
    expect(noticeSignature(document.replace(before, after), "doc/legal.sgml"), before).toBe(
      signature,
    );
  }
});

it("a scan groups files by signature in ordinal order and skips binaries and links", async () => {
  const tree = await directory();
  await mkdir(join(tree, "src", "port"), { recursive: true });
  await writeFile(join(tree, "src", "b.c"), "/* Copyright (c) 2020 Acme */\n");
  await writeFile(join(tree, "src", "port", "a.c"), "/* Copyright (c) 1999 Acme */\n");
  await writeFile(join(tree, "README"), "Licensed under the MIT License.\n");
  await writeFile(join(tree, "logo.png"),
    Buffer.from([0x89, 0x50, 0x00, 0x43, 0x6F, 0x70, 0x79, 0x72, 0x69, 0x67, 0x68, 0x74]));
  await writeFile(join(tree, "plain.c"), "int x;\n");
  // Creating a symbolic link can need a privilege on Windows; the scan must skip one where it exists.
  await symlink(join(tree, "README"), join(tree, "LICENSE-link")).catch(() => undefined);

  expect([...await scanNoticeSignatures(tree)]).toEqual([
    ["Copyright (c) YYYY Acme", ["src/b.c", "src/port/a.c"]],
    ["Licensed under the MIT License.", ["README"]],
  ]);
});

it("a licence file counts whole, by its path, so a changed condition without any keyword is noticed", () => {
  for (const path of [
    "LICENSE",
    "COPYING.LIB",
    "NOTICE",
    "src/backend/regex/COPYRIGHT",
    "a/b.LICENSE",
    "LICENSE-APACHE",
  ]) {
    expect(isLicenceFile(path), path).toBe(true);
  }
  for (const path of [
    "src/notice.c",
    "license.c",
    "doc/copyright.sgml",
    "README",
    "licenses.sql",
  ]) {
    expect(isLicenceFile(path), path).toBe(false);
  }
  const text =
    "Copyright (c) 2020 Acme\n\nPermission to use this software is granted,\nprovided that this notice is kept.\n";
  const signature = licenceFileSignature("LICENSE", text);
  expect(signature).toMatch(/^licence file LICENSE sha256:[0-9a-f]{64}$/);
  // Another year, spacing or line ending changes nothing.
  expect(
    licenceFileSignature("LICENSE",
      text.replace("2020", "2020-2026").replaceAll("\n", "\r\n") + "\n\n"),
  )
    .toBe(signature);
  // A changed condition, on a line without any notice keyword, does.
  expect(licenceFileSignature("LICENSE", text.replace("is kept", "is kept and no fee is charged")))
    .not.toBe(signature);
  expect(licenceFileSignature("tsl/LICENSE", text)).not.toBe(signature);
});

it("UTF-16 with a byte order mark is text, and years stay in lines that are not copyright lines", () => {
  const utf16 = Buffer.concat([
    Buffer.from([0xFF, 0xFE]),
    Buffer.from("/* Copyright (c) 2020 Acme */\r\n", "utf16le"),
  ]);
  expect(noticeSignature(decodeText(utf16)!)).toBe("Copyright (c) YYYY Acme");
  expect(normalizeNoticeLine("# Licensed under the Apache License since 2019")).toBe(
    "Licensed under the Apache License since 2019",
  );
});

it("a build stores its scan per source, and a manifest keeps three files of each signature", async () => {
  const tree = await directory();
  for (const name of ["a.c", "b.c", "c.c", "d.c"]) {
    await mkdir(join(tree, "sources", "one"), { recursive: true });
    await writeFile(join(tree, "sources", "one", name), "/* Copyright (c) 2020 Acme */\n");
  }
  await writeFile(join(tree, "sources", "one", "e.sql"), "-- Copyright (c) 2020 acme\n");
  await mkdir(join(tree, "sources", "two"));
  const file = join(tree, "source-notices.json");
  const scan = await writeSourceNoticeScan(join(tree, "sources"), ["one", "two"], file);
  expect(scan).toEqual({
    one: {
      "Copyright (c) YYYY Acme": ["a.c", "b.c", "c.c", "d.c"],
      "Copyright (c) YYYY acme": ["e.sql"],
    },
    two: {},
  });
  await expect(readSourceNoticeScan(file)).resolves.toEqual(scan);
  expect(noticeSignatureExamples(scan)).toEqual({
    one: [
      { signature: "Copyright (c) YYYY Acme", files: ["a.c", "b.c", "c.c"] },
      { signature: "Copyright (c) YYYY acme", files: ["e.sql"] },
    ],
    two: [],
  });
  await expect(readSourceNoticeScan(join(tree, "missing.json"))).rejects.toThrow(
    "A fresh build is required: the build stored no source notice scan",
  );
});
