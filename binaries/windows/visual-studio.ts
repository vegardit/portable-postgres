/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Selects the Visual Studio that compiles the Windows build and describes it for the toolchain licence review. */
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type HostEvidence,
  msvcRuntimeNoticePath,
  releaseVisualStudioEditions,
  reviewedMsvcNoticeFile,
  toolchainEvidence,
  visualStudioEditionEvidence,
  visualStudioReleaseGap,
} from "../artifact/artifact.ts";
import { root } from "../paths.ts";
import { capture } from "../process.ts";

const vcTools = "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";

/**
 * The vswhere queries that select the build's installation, tried in order. The first prefers the
 * editions whose terms a release review covers, because `-latest` would otherwise pick a newer Build Tools
 * installed beside them. The second lets any other product, such as Build Tools alone, build candidates.
 * Neither passes `-prerelease`, so vswhere never selects a preview or Insiders installation: the licence
 * terms forbid distributing software developed with Insiders channel software.
 */
export const vswhereSelections: ReadonlyArray<readonly string[]> = [
  ["-latest", "-products", ...releaseVisualStudioEditions, "-requires", vcTools],
  ["-latest", "-products", "*", "-requires", vcTools],
];

function vswhere(args: readonly string[]): string {
  const path = join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  return capture(path, args).trim();
}

/**
 * Returns the installation path of the Visual Studio that the Windows build would compile with, or
 * `undefined` when vswhere lists no installation with the C++ build tools. A failed query throws.
 */
export function findVisualStudio(): string | undefined {
  for (const selection of vswhereSelections) {
    const installation = vswhere([...selection, "-property", "installationPath"]);
    if (installation !== "") return installation;
  }
  return undefined;
}

/** Returns the installation path of the Visual Studio that the Windows build compiles with. */
export function selectVisualStudio(): string {
  const installation = findVisualStudio();
  if (installation === undefined) {
    throw new Error("No Visual Studio installation with the C++ build tools was found.");
  }
  return installation;
}

/**
 * Returns the notice for the Microsoft code that the build linked into every image. The reviewed notice
 * says which Visual Studio built the binaries and passes on the conditions of its licence terms, so it is
 * true only for a build that release validation accepts: a reviewed product line and an admitted edition.
 * Any other build, such as Visual Studio 2022 or Build Tools alone, makes candidates only and gets the
 * candidate text with its line and product filled in, written into `directory` under the name that the
 * archive ships it as.
 */
export async function msvcRuntimeNotice(
  toolchain: readonly HostEvidence[],
  directory: string,
): Promise<string> {
  // From the repository, because tsc does not copy the notices next to the compiled module.
  const recipeRoot = join(root, "binaries/windows");
  if (visualStudioReleaseGap(toolchain) === undefined) return reviewedMsvcNoticeFile;
  // A build recorded before its edition was part of the evidence lacks that value.
  const recorded = (component: string): string =>
    toolchain.find(entry => entry.component === component)?.version ?? "not recorded";
  const template = await readFile(join(recipeRoot, "notices/msvc-runtime-candidate.txt"), "utf8");
  const candidate = join(directory, basename(msvcRuntimeNoticePath));
  await writeFile(
    candidate,
    template
      .replace("{productLine}", recorded(toolchainEvidence("msvc-runtime")))
      .replace("{product}", recorded(visualStudioEditionEvidence)),
  );
  return candidate;
}

/**
 * Describes the installation that build.cmd compiled with, and the MSVC toolset and Windows SDK that its
 * environment selected. Querying by path keeps the evidence on that installation even when several are installed.
 */
export function visualStudioEvidence(
  installation: string,
  toolset: string,
  sdk: string,
): HostEvidence[] {
  const property = (name: string): string => {
    const value = vswhere(["-path", installation, "-property", name]);
    if (value === "" || /\s/.test(value)) {
      throw new Error("vswhere reported no single " + name + " for " + installation);
    }
    return value;
  };
  const query = "vswhere -path <the build's installation> -property ";
  return [
    {
      component: toolchainEvidence("msvc-runtime"),
      version: property("catalog_productLineVersion"),
      evidence: query + "catalog_productLineVersion",
    },
    // The edition decides which Visual Studio licence terms cover the startup code in every image.
    {
      component: visualStudioEditionEvidence,
      version: property("productId"),
      evidence: query + "productId",
    },
    {
      component: "Visual Studio channel",
      version: property("channelId"),
      evidence: query + "channelId",
    },
    // Evidence only: binding the review to it would reopen the review with every runner image update.
    {
      component: "MSVC toolset",
      version: toolset,
      evidence: "VCToolsVersion after vcvars64.bat in build.cmd",
    },
    // Evidence only, like the toolset: the link check keeps static Windows SDK code out of every image.
    {
      component: "Windows SDK",
      version: sdk,
      evidence: "WindowsSDKVersion after vcvars64.bat in build.cmd",
    },
  ];
}
