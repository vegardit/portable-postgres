/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Protects Windows build trees during use and retires superseded trees after successful packaging. */
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readOptionalText } from "../files.ts";
import { type NativeBuild, readBuild, readRecord, withRecordLock } from "../package.ts";
import { outputRoot, workRoot } from "../paths.ts";

const buildName = /^windows-build-[A-Za-z0-9]{6}$/;
const usePrefix = ".portable-postgres-in-use-";
const stateFile = ".portable-postgres-build";
const retiredName = /^windows-build-[A-Za-z0-9]{6}\.retired-[0-9a-f-]{36}$/;
type WorkState =
  | "recorded"
  | "active"
  | "packaged"
  | "incomplete"
  | "redirected"
  | "unrecognized"
  | "retired";

function createUseMarker(directory: string, owner: string): Promise<string> {
  return mkdtemp(join(directory, usePrefix + owner.toLowerCase() + "-" + process.pid + "-"));
}

/** A relocated build and SDK can belong to different physical trees and different output records. */
async function protectAssemblyInputs(
  build: NativeBuild,
  uses: AsyncDisposableStack,
): Promise<void> {
  const trees = new Set<string>();
  for (const input of [build.buildWork, build.developmentInstallation]) {
    // Missing inputs have no tree to reserve. Let reassembly report its first failed validation.
    const physical = await realpath(input).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (physical === undefined) continue;
    for (let path = physical; dirname(path) !== path; path = dirname(path)) {
      if (buildName.test(basename(path))) trees.add(path);
    }
  }
  for (const tree of trees) {
    const work = dirname(tree);
    await withRecordLock(work, async () => {
      // Retirement may have won since realpath. Only register a reader for a tree still in place.
      if (!await isWorkDirectory(work, tree)) {
        throw new Error("Cannot reserve Windows build work: " + tree);
      }
      const marker = await createUseMarker(work, basename(tree));
      uses.defer(() => rmdir(marker));
    });
  }
}

/** Readers claim the recorded directory under the same lock that cleanup uses to detach it. */
export async function withWindowsBuild(
  work: string,
  output: string,
  command: "build" | "assemble",
  recipe: string,
  run: (build: NativeBuild) => Promise<void>,
): Promise<void> {
  const active = await withRecordLock(output, async () => {
    let build: NativeBuild;
    let managed: boolean;
    if (command === "build") {
      await mkdir(work, { recursive: true });
      const buildWork = await mkdtemp(join(work, "windows-build-"));
      // Meson uses the PostgreSQL name in the prefix to keep the SDK directories flat.
      build = { buildWork, developmentInstallation: join(buildWork, "postgresql-sdk"), recipe };
      managed = await isWorkDirectory(work, buildWork);
      // Another checkout can reach a redirected tree through its physical root and has different use markers.
      await writeFile(join(buildWork, stateFile), managed ? "building\n" : "redirected\n", {
        flag: "wx",
      });
    } else {
      build = await readBuild(output, recipe);
      // A relocated SDK may alias another build. Protect all work until that reader exits.
      managed = await hasPrivateSdk(work, build.buildWork, build.developmentInstallation);
    }
    const owner = managed ? basename(build.buildWork) : "external";
    return {
      build,
      managed,
      use: await createUseMarker(output, owner),
    };
  });
  let buildFailure: { error: unknown } | undefined;
  try {
    await using sharedUses = new AsyncDisposableStack();
    if (command === "assemble") await protectAssemblyInputs(active.build, sharedUses);
    await run(active.build);
    // Reassembly can finish a build whose first packaging attempt failed.
    if (active.managed) {
      const state = join(active.build.buildWork, stateFile);
      const entries = await readdir(active.build.buildWork, { withFileTypes: true });
      if (entries.some(entry => entry.name === stateFile && entry.isFile())
        && await readFile(state, "utf8") === "building\n")
      {
        await writeFile(state, "packaged\n");
      }
    }
  } catch (error) {
    buildFailure = { error };
  }
  try {
    await rmdir(active.use);
  } catch (error) {
    if (buildFailure) {
      throw new AggregateError([buildFailure.error, error],
        "Windows build or assembly failed and could not release " + active.use, { cause: error });
    }
    throw error;
  }
  // Even a failed reassembly may have been the last reader of a superseded successful build.
  try {
    await pruneWindowsWork(work, output, "automatic");
  } catch (error) {
    console.warn("Could not clean up superseded Windows build work:", error);
  }
  if (buildFailure) throw buildFailure.error;
}

async function isWorkDirectory(work: string, path: string): Promise<boolean> {
  const name = basename(path);
  return (buildName.test(name) || retiredName.test(name)) && relative(work, dirname(path)) === ""
    && (await lstat(path)).isDirectory() && (await lstat(work)).isDirectory()
    && relative(join(await realpath(work), name), await realpath(path)) === "";
}

/** Only a physically local SDK can be protected by reserving its build directory alone. */
async function hasPrivateSdk(work: string, buildWork: string, sdk: string): Promise<boolean> {
  if (!buildName.test(basename(buildWork))
    || relative(join(buildWork, "postgresql-sdk"), sdk) !== ""
    || !await isWorkDirectory(work, buildWork)) return false;
  try {
    return relative(join(await realpath(buildWork), "postgresql-sdk"), await realpath(sdk)) === "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function workState(
  path: string,
  current: string | undefined,
  output: string,
  inUse: boolean,
): Promise<WorkState> {
  if (current && relative(current, path) === "") return "recorded";
  if (inUse) return "active";
  const entries = await readdir(path, { withFileTypes: true });
  if (retiredName.test(basename(path))) {
    const name = basename(path);
    return await readOptionalText(join(output, name)) === name.split(".retired-")[0]
      ? "retired"
      : "unrecognized";
  }
  if (entries.some(entry => entry.name === stateFile && entry.isFile())) {
    const state = await readFile(join(path, stateFile), "utf8");
    if (state === "redirected\n") return "redirected";
    if (state === "packaged\n") return "packaged";
    return state === "building\n" ? "incomplete" : "unrecognized";
  }
  // Only a marker written by this builder establishes ownership for pruning.
  return "unrecognized";
}

/** Counts regular files for the preview without following links outside the tree. */
async function workBytes(path: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += await workBytes(child);
    else if (entry.isFile()) bytes += (await lstat(child)).size;
  }
  return bytes;
}

type PruneMode = "preview" | "automatic" | readonly string[];
type WorkDirectory = { name: string; state: WorkState; path: string; inUse: boolean };

/** Under the record lock, check the whole selection before detaching anything for removal. */
async function selectWork(work: string, output: string, mode: PruneMode): Promise<WorkDirectory[]> {
  const entries = await readdir(work, { withFileTypes: true });
  const directories = entries.filter(entry =>
    entry.isDirectory()
    && (buildName.test(entry.name) || (mode !== "automatic" && retiredName.test(entry.name)))
  )
    .map(entry => entry.name).sort();
  const names = typeof mode === "string" ? directories : [...new Set(mode)];
  const record = await readRecord(output);
  const current = typeof record?.buildWork === "string"
    ? resolve(output, record.buildWork)
    : undefined;
  if (mode === "automatic" && (!record?.archive || !record.installation)) return [];
  if (record !== undefined) {
    let privateSdk = false;
    try {
      privateSdk = current !== undefined && typeof record.developmentInstallation === "string"
        && await hasPrivateSdk(work, current, resolve(output, record.developmentInstallation));
    } catch (error) {
      if (mode !== "preview") throw error;
      console.warn("Could not inspect the recorded SDK:", error);
    }
    if (!privateSdk) {
      if (mode === "automatic") return [];
      const reason =
        "Cannot identify a private SDK for the recorded Windows build; retaining all build directories";
      if (mode !== "preview") throw new Error(reason);
      console.log(reason);
    }
  }
  const outputEntries = await readdir(output).catch((error: unknown) => {
    if (mode === "preview" && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const users = [
    ...outputEntries.filter(name => name.startsWith(usePrefix)).map(name => join(output, name)),
    ...entries.filter(entry => entry.name.startsWith(usePrefix)).map(entry =>
      join(work, entry.name)
    ),
  ];
  if (mode === "preview" && users.length > 0) {
    for (const user of users) console.log("In-use marker: " + user);
    console.log(
      "Only clear a marker after confirming its owner and all child processes have exited.",
    );
  }
  const selected: WorkDirectory[] = [];
  for (const name of names) {
    if (!directories.includes(name)) throw new Error("Unknown Windows build directory: " + name);
    const path = join(work, name);
    // A recorded SDK can also be active. Keep its retention status and skip its size scan.
    const inUse = users.some(user =>
      basename(user).startsWith(usePrefix + name.toLowerCase() + "-")
      || basename(user).startsWith(usePrefix + "external-")
    );
    let state: WorkState;
    try {
      if (!await isWorkDirectory(work, path)) {
        throw new Error("Expected a real Windows work directory: " + path);
      }
      state = await workState(path, current, output, inUse);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      // A failure reading the shared root or validating an explicit selection invalidates the batch.
      if (typeof mode !== "string" || failure.path === work || !failure.code) throw error;
      if (mode === "preview" && failure.code === "ENOENT") continue;
      console.warn("Could not inspect Windows build directory " + path, error);
      continue;
    }
    if (mode === "automatic" && state !== "packaged") continue;
    if (mode !== "preview"
      && !(state === "packaged" || state === "incomplete"
        || state === "retired"))
    {
      throw new Error("Refusing to remove " + state + " directory: " + path);
    }
    selected.push({ name, state, path, inUse });
  }
  return selected;
}

/** A preview only reads the trees. Explicit removal accepts exact names from that preview. */
export async function pruneWindowsWork(
  work: string,
  output: string,
  mode: PruneMode,
): Promise<void> {
  if (typeof mode !== "string"
    && (mode.length === 0 || mode.some(name => !buildName.test(name) && !retiredName.test(name))))
  {
    throw new Error("--remove requires exact Windows build directory names from the preview");
  }
  const rootInfo = await lstat(work).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || typeof mode !== "string") throw error;
    return undefined;
  });
  if (!rootInfo) return;
  if (!rootInfo.isDirectory()) {
    // The builder may create fresh trees through a junction, but cleanup does not own that volume.
    if (mode === "automatic") return;
    throw new Error("Expected a real Windows build work directory: " + work);
  }
  if (mode === "preview") {
    const directories = await selectWork(work, output, mode);
    for (const { name, path, state, inUse } of directories) {
      try {
        const size = inUse
          ? "in use"
          : ((await workBytes(path)) / 1024 ** 3).toFixed(2) + " GiB";
        console.log(`${name}  ${size}  ${state}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          console.log(name + "  changed during preview");
        } else {
          console.warn("Could not measure Windows build directory " + path, error);
          console.log(`${name}  size unavailable  ${state}`);
        }
      }
    }
    return;
  }
  const detached: WorkDirectory[] = [];
  const failures: Error[] = [];
  async function removeReceipt(receipt: string, outcome: string): Promise<void> {
    try {
      await rm(receipt, { force: true });
    } catch (error) {
      failures.push(
        new Error(outcome + ". Could not remove cleanup receipt " + receipt, { cause: error }),
      );
    }
  }
  try {
    // Separate checkouts can have independent output records while reading the same physical tree.
    await withRecordLock(output, () => withRecordLock(work, async () => {
      const selected = await selectWork(work, output, mode);
      for (const entry of selected) {
        if (entry.state === "retired") {
          detached.push(entry);
          continue;
        }
        const destination = join(work, entry.name + ".retired-" + randomUUID());
        // The receipt stays outside the tree so partial tree removal remains retryable.
        const receipt = join(output, basename(destination));
        try {
          await writeFile(receipt, entry.name, { flag: "wx" });
        } catch (error) {
          failures.push(
            new Error("Could not create cleanup receipt " + receipt + " for " + entry.path, {
              cause: error,
            }),
          );
          continue;
        }
        try {
          await rename(entry.path, destination);
          detached.push({ ...entry, path: destination });
        } catch (error) {
          failures.push(new Error("Could not retire " + entry.path, { cause: error }));
          await removeReceipt(receipt, "Tree still at " + entry.path);
        }
      }
    }));
  } catch (error) {
    if (detached.length === 0 && failures.length === 0) throw error;
    failures.push(
      new Error("Could not complete cleanup under the build record lock: " + String(error), {
        cause: error,
      }),
    );
  }
  // A failure in either phase must not strand trees we already detached.
  for (const { name, path } of detached) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      failures.push(
        new Error("Could not finish removing " + path + ". Retry with --remove and its exact name.",
          { cause: error }),
      );
      continue;
    }
    console.log("Removed Windows build work: " + name);
    await removeReceipt(join(output, basename(path)), "Removed tree " + path);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, failures.map(error => error.message).join("\n"));
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    options: { remove: { type: "boolean" } },
    allowPositionals: true,
  });
  if (!values.remove && positionals.length > 0) {
    throw new Error("Use --remove before the directory names");
  }
  await pruneWindowsWork(workRoot, join(outputRoot, "windows-x64"),
    values.remove ? positionals : "preview");
}
