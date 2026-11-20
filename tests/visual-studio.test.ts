/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks how the Windows build selects Visual Studio, and reads its evidence where an installation exists. */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { root } from "../binaries/paths.ts";
import { capture } from "../binaries/process.ts";
import {
  findVisualStudio,
  msvcRuntimeNotice,
  selectVisualStudio,
  visualStudioEvidence,
  vswhereSelections,
} from "../binaries/windows/visual-studio.ts";

// A test can answer the vswhere queries itself; every other call reaches the real tool.
vi.mock(import("../binaries/process.ts"), async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, capture: vi.fn<typeof actual.capture>(actual.capture) };
});

const vswhere = join(
  process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  "Microsoft Visual Studio/Installer/vswhere.exe",
);

it("the build finds no installation when vswhere lists none with the C++ tools, and reports a failed query", () => {
  // Visual Studio with only managed-language workloads installs vswhere, which then lists nothing.
  vi.mocked(capture).mockReturnValueOnce("").mockReturnValueOnce("");
  expect(findVisualStudio()).toBeUndefined();
  vi.mocked(capture).mockReturnValueOnce("").mockReturnValueOnce("");
  expect(() => selectVisualStudio()).toThrow(
    "No Visual Studio installation with the C++ build tools was found.",
  );
  // Build Tools alone match only the second query.
  vi.mocked(capture).mockReturnValueOnce("").mockReturnValueOnce("C:\\BuildTools\r\n");
  expect(findVisualStudio()).toBe("C:\\BuildTools");
  vi.mocked(capture).mockImplementationOnce(() => {
    throw new Error("vswhere.exe -latest failed (87)");
  });
  expect(() => findVisualStudio()).toThrow("vswhere.exe -latest failed (87)");
});

it("the selection prefers the editions a release admits and never selects a prerelease", () => {
  // Stated literally, so that a change to the admitted editions has to change this contract too.
  expect(vswhereSelections[0]).toEqual([
    "-latest",
    "-products",
    "Microsoft.VisualStudio.Product.Enterprise",
    "Microsoft.VisualStudio.Product.Professional",
    "Microsoft.VisualStudio.Product.Community",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
  ]);
  // Any other product, such as Build Tools alone, still builds candidates.
  expect(vswhereSelections.at(-1)).toEqual([
    "-latest",
    "-products",
    "*",
    "-requires",
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
  ]);
  expect(vswhereSelections.flat()).not.toContain("-prerelease");
});

it("a build that a release refuses ships the candidate notice that names its line and product", async () => {
  const directory = await mkdtemp(join(tmpdir(), "portable-postgres-notice-"));
  try {
    const evidence = (line: string, product?: string) => [
      { component: "Visual Studio product line", version: line, evidence: "fixture" },
      ...product === undefined
        ? []
        : [{ component: "Visual Studio edition", version: product, evidence: "fixture" }],
    ];
    // A reviewed line and an admitted edition ship the reviewed notice, which names the reviewed line.
    await expect(
      msvcRuntimeNotice(evidence("18", "Microsoft.VisualStudio.Product.Enterprise"), directory),
    ).resolves.toBe(join(root, "binaries/windows/notices/msvc-runtime.txt"));
    await expect(readdir(directory)).resolves.toEqual([]);
    // A reviewed line alone is not enough: the Build Tools terms have no Distributable Code section.
    // Each text is read before the next call, which writes the same file.
    const buildTools = await msvcRuntimeNotice(
      evidence("18", "Microsoft.VisualStudio.Product.BuildTools"),
      directory,
    );
    expect(buildTools).toBe(join(directory, "msvc-runtime.txt"));
    await expect(readFile(buildTools, "utf8")).resolves.toContain(
      "product line 18, product\nMicrosoft.VisualStudio.Product.BuildTools).",
    );
    // A build recorded before its edition was part of the evidence cannot show an admitted edition either.
    const unrecorded = await msvcRuntimeNotice(evidence("18"), directory);
    await expect(readFile(unrecorded, "utf8")).resolves.toContain(
      "product line 18, product\nnot recorded).",
    );
    // The approved text, stated literally; it ships under the archive path of the reviewed notice.
    const notice = await msvcRuntimeNotice(
      evidence("2022", "Microsoft.VisualStudio.Product.Community"),
      directory,
    );
    expect(notice).toBe(join(directory, "msvc-runtime.txt"));
    await expect(readFile(notice, "utf8")).resolves.toBe([
      "Microsoft code in these candidate binaries",
      "==========================================",
      "",
      "These Windows binaries were built with the Microsoft C/C++ compiler of a",
      "Visual Studio installation whose license terms this project does not accept",
      "for releases (Visual Studio reports product line 2022, product",
      "Microsoft.VisualStudio.Product.Community). The linker copies some Microsoft code into every .exe and .dll",
      "file: startup and support code from msvcrt.lib and vcruntime.lib, and",
      "possibly aliases from oldnames.lib. This code is copyrighted by Microsoft",
      "Corporation. The open-source licenses in this archive do not apply to it.",
      "",
      "These binaries are a build candidate for testing. Do not redistribute them.",
      "Releases are built with Visual Studio 2026 and carry their own notice.",
      "",
    ].join("\n"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A failed query fails the file here, rather than being taken for a machine without Visual Studio.
it.skipIf(
  process.platform !== "win32" || !existsSync(vswhere) || findVisualStudio() === undefined,
)(
  "Windows toolchain evidence describes the selected installation and the toolset it compiled with",
  () => {
    const [line, edition, channel, toolset] = visualStudioEvidence(
      selectVisualStudio(),
      "14.0.0",
    );
    expect(line).toMatchObject({ component: "Visual Studio product line" });
    // Visual Studio 2022 reports "2022", but Visual Studio 2026 reports "18". The review binds the raw value.
    expect(line!.version).toMatch(/^\d+$/);
    expect(edition).toMatchObject({ component: "Visual Studio edition" });
    expect(edition!.version).toMatch(/^Microsoft\.VisualStudio\.Product\.\w+$/);
    expect(channel!.version).toMatch(/^VisualStudio\.\d+\.\w+$/);
    expect(toolset).toMatchObject({ component: "MSVC toolset", version: "14.0.0" });
  },
);
