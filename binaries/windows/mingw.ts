/** Provisions a private, hash-pinned CLANG64 SDK and verifies linked inputs on every Windows assembly. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { root } from "../paths.ts";
import { buildJobs, capture, run } from "../process.ts";
import { requireApacheOnlyTimescaleDB } from "../timescaledb.ts";
import type { HostEvidence } from "../artifact/artifact.ts";
import { dataOnlyPe } from "../artifact/data-library.ts";
import {
  extensionLibraries,
  extensionNames,
  isIcuDataLibrary,
  librarySource,
  mingwEvidence,
  mingwNotice,
  mingwSourcePrefix,
} from "../artifact/runtime-layout.ts";
import { sources } from "../sources/sources.ts";
import pins from "./clang64.json" with { type: "json" };
import { readPeImports } from "./imports.ts";

const runtimeDlls: Readonly<Record<string, string>> = {
  "libc++.dll": "c356e40f2f685b001b2108d5f57f4a19de24d5ecae4a714b1960696864f09f86",
  "libwinpthread-1.dll": "be8345e0b2515333b37d4c571dcb8c4a901f80b0f1c99afa40747a1c3d7343b1",
};
const recipe = join(root, "binaries/windows");

export async function compileMingw(
  work: string,
  archives: Map<string, string>,
  python: string,
): Promise<void> {
  const tar = join(work, "msys2-base.tar");
  const fd = openSync(tar, "wx");
  try {
    await run("7z", ["x", "-so", archives.get("msys2-base")!], { stdout: fd });
  } finally {
    closeSync(fd);
  }
  const system = join(process.env["SystemRoot"]!, "System32");
  await run(join(system, "tar.exe"), ["-xf", tar, "-C", work]);
  await rm(tar);
  const msys = join(work, "msys64");
  // Bash reads the script incrementally. Keep an in-flight build independent of checkout edits.
  for (const file of ["build.sh", "trace-link.py"])
    await copyFile(join(recipe, file), join(work, file));
  for (const pin of pins.slice(1)) {
    await run(join(msys, "usr/bin/bsdtar.exe"), [
      "-xf",
      archives.get(pin.id)!,
      "-C",
      msys,
      "--exclude",
      ".PKGINFO",
      "--exclude",
      ".BUILDINFO",
      "--exclude",
      ".MTREE",
      "--exclude",
      ".INSTALL",
    ]);
  }
  // PGXS invokes make on unquoted SDK paths. A private drive alias also handles checkout paths with spaces.
  let drive: string | undefined;
  if (/[^a-z\d:/\\._-]/i.test(work)) {
    for (const letter of "ZYXWVUTSRQPONMLKJIHGFED") {
      if (existsSync(letter + ":\\")) continue;
      try {
        capture(join(system, "subst.exe"), [letter + ":", work]);
        drive = letter + ":";
        break;
      } catch {
        if (!existsSync(letter + ":\\")) throw new Error("Could not map " + work + " to " + letter);
      }
    }
    if (!drive) throw new Error("No drive letter available for the PGXS build");
  }
  try {
    const path = drive ? drive + "\\" : work;
    const which = (name: string): string =>
      capture(join(system, "where.exe"), [name]).trim().split(/\r?\n/)[0]!;
    await run(join(path, "msys64/usr/bin/bash.exe"), [
      join(path, "build.sh").replaceAll("\\", "/"),
    ], {
      env: {
        ...process.env,
        MSYSTEM: "CLANG64",
        PORTABLE_PG_WORK: path,
        PORTABLE_PG_ROOT: root,
        PORTABLE_PG_CMAKE: which("cmake.exe"),
        PORTABLE_PG_PERL: (process.env["PG_BUILD_PERL"] ?? which("perl.exe")).replaceAll("\\", "/"),
        PORTABLE_PG_PYTHON: python,
        PORTABLE_PG_TRACE: join(path, "trace-link.py"),
        BUILD_JOBS: buildJobs(),
      },
    });
    // CMake records the drive alias in its source paths. Audit them while this build owns it.
    await requireApacheOnlyTimescaleDB(
      join(path, "windows-timescaledb"),
      join(path, "windows-sources", "timescaledb"),
    );
  } finally {
    if (drive) capture(join(system, "subst.exe"), [drive, "/D"]);
  }
  const directory = join(work, "toolchain-notices");
  await mkdir(directory);
  const notices = [];
  for (const file of [
    "crt/COPYING.MinGW-w64-runtime.txt",
    "crt/COPYING",
    "compiler-rt/LICENSE",
    "libc++/LICENSE",
    "libwinpthread/COPYING",
  ]) {
    notices.push(
      file + "\n\n" + await readFile(join(msys, "clang64/share/licenses", file), "utf8"),
    );
  }
  notices.push(await readFile(join(recipe, "notices/mingw-supplement.txt"), "utf8"));
  await writeFile(join(directory, mingwNotice), notices.join("\n\n"));
}

/** Recompute the linked-member inventory against the actual PE bytes, including when reassembling an SDK. */
export async function mingwLinkEvidence(
  installation: string,
  work: string,
  fresh: boolean,
): Promise<HostEvidence[]> {
  const inventory = new Map<string, string>();
  const fingerprints: string[] = [];
  for (const file of await readdir(installation, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const full = join(file.parentPath, file.name);
    const bytes = await readFile(full);
    if (!readPeImports(bytes)) continue;
    const path = relative(installation, full).split(sep).join("/");
    const hash = createHash("sha256").update(bytes).digest("hex");
    fingerprints.push(path + " " + hash);
    if (isIcuDataLibrary(path, "windows-x64")) {
      if (!dataOnlyPe(bytes)) throw new Error("ICU data contains executable code: " + path);
      continue;
    }
    const vendor = dirname(path) === "bin" && runtimeDlls[basename(path)];
    if (vendor) {
      if (hash !== vendor) throw new Error("Unpinned CLANG64 runtime DLL: " + path);
      inventory.set(path, path + " " + hash);
      continue;
    }
    const record = JSON.parse(
      await readFile(join(work, "link-records", hash + ".json"), "utf8"),
    ) as {
      image: string;
      external: string[];
      selected: string[];
    };
    if (record.image !== basename(path).toLowerCase() || record.external.length > 0
      || record.selected.length === 0
      || record.selected.some(name => /libgcc|libstdc\+\+|gmon|gprof|\.lib(?:\(|$)/i.test(name)))
    {
      throw new Error("Unapproved linker inputs for " + path + ": " + JSON.stringify(record));
    }
    inventory.set(path, path + " " + record.selected.join(" "));
  }
  if (inventory.size === 0) throw new Error("Missing Windows image link evidence");
  const classified = [...inventory.values()].sort().join("\n");
  const snapshot = fingerprints.sort().join("\n") + "\n\n" + classified + "\n";
  const receipt = join(work, "windows-linked-inputs.txt");
  if (fresh) {
    // Reassembly can read this SDK before its first packaging finishes.
    const staging = receipt + "." + randomUUID() + ".partial";
    try {
      await writeFile(staging, snapshot, { flag: "wx" });
      await rename(staging, receipt);
    } finally {
      await rm(staging, { force: true });
    }
  } else if (snapshot !== await readFile(receipt, "utf8")) {
    throw new Error("Windows linked inputs changed since the fresh build");
  }
  const pinHash = createHash("sha256").update(JSON.stringify(pins)).digest("hex");
  const evidence = (component: string, members: string): HostEvidence => ({
    component,
    version: "clang64 " + pinHash + " / " + createHash("sha256").update(members).digest("hex"),
    evidence:
      "SHA-256 of the pinned package list and the per-image linked toolchain member inventory",
  });
  const owners = new Map<string, string>();
  for (const [id, name] of Object.entries(extensionNames)) {
    const version = sources.find(source => source.id === id)!.version;
    for (const path of extensionLibraries(id, name, version, "windows-x64")) owners.set(path, id);
  }
  const grouped = Map.groupBy(inventory,
    ([path]) => owners.get(path) ?? librarySource(path, "windows-x64") ?? "postgresql");
  const result = [evidence(mingwEvidence, classified)];
  for (const id of [...grouped.keys()].sort()) {
    // The vendor DLLs already belong to the build-wide runtime review.
    if (id === "mingw-runtime") continue;
    const members = grouped.get(id)!.map(([, line]) => line).sort().join("\n");
    result.push(evidence(mingwSourcePrefix + id, members));
  }
  return result;
}
