/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Checks that reassembly only reuses a development installation built by the current recipe, describes
 * the build's own toolchain, and leaves the installation unchanged, and that a candidate claims only the
 * parts of the tracked review that still match it.
 */
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  type ArtifactTarget,
  type HostEvidence,
  toolchainNotices,
} from "../binaries/artifact/artifact.ts";
import { draftReview } from "../binaries/artifact/review.ts";
import { archivedManifest } from "../binaries/release.ts";
import { sourceNoticesFile } from "../binaries/artifact/notice-scan.ts";
import {
  lastCandidate,
  packageCandidate,
  readBuild,
  recipeIdentity,
  recordBuild,
  recordedToolchain,
} from "../binaries/package.ts";
import {
  complete,
  createCandidate,
  fixtureEvidence,
  fixtureNoticeScan,
  remeasured,
  sourceTree,
  writeFixtureNoticeScan,
} from "./candidate.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

// A test can hold back a replacement of the build record to let another writer run in between, or make
// reading the record fail.
vi.mock(import("node:fs/promises"), async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    // A mock's type keeps only the last of readFile's overloads, which the module's type does not accept.
    readFile: vi.fn<typeof actual.readFile>(actual.readFile) as unknown as typeof actual.readFile,
    rename: vi.fn<typeof actual.rename>(actual.rename),
  };
});

const { directory, cleanup } = temporaryDirectories("package");
afterEach(cleanup);

it("reassembly refuses a development installation from a different build recipe", async () => {
  const recipes = await directory();
  const script = join(recipes, "build.sh");
  await writeFile(script, "make install");
  const output = await directory();
  const build = {
    developmentInstallation: join(output, "sdk"),
    buildWork: output,
    recipe: await recipeIdentity([script]),
    // Reassembly describes the compiler as the build used it, not as it is installed now.
    toolchainEvidence: [{
      component: "CLANG64 packages and linked objects",
      version: "fixture-1",
      evidence: "fixture",
    }],
  };
  await recordBuild(output, build);
  await expect(readBuild(output, build.recipe)).resolves.toMatchObject(build);

  // A recipe change, such as a different list of installed SQL files, makes the recorded SDK unusable.
  await writeFile(script, "make install DATA=fewer-files");
  await expect(readBuild(output, await recipeIdentity([script]))).rejects.toThrow(
    "A fresh build with the current source inputs and build recipe is required",
  );
});

it("resolves the build and candidate from the record's current checkout", async () => {
  const workspace = await directory();
  const buildRoot = join(workspace, "container");
  const hostRoot = join(workspace, "checkout with spaces");
  const output = join(buildRoot, "output");
  const hostOutput = join(hostRoot, "output");
  const work = join(buildRoot, "work");
  const sdk = join(work, "postgresql-sdk");
  const target: ArtifactTarget = process.platform === "win32" ? "windows-x64" : "linux-x64-glibc";
  await mkdir(work, { recursive: true });
  await mkdir(sdk, { mode: 0o700 });
  await createCandidate(sdk, target);
  await writeFixtureNoticeScan(work);
  await packageCandidate({
    target,
    output,
    sourceRoot: await sourceTree(join(work, "sources")),
    reviewFile: join(work, "missing-review.json"),
    build: { buildWork: work, developmentInstallation: sdk, recipe: "recipe" },
    toolchainNotices: toolchainNotices(target).map(notice => join(sdk, notice)),
    hostEvidence: () => Promise.resolve(fixtureEvidence(target)),
  });
  // A bind mount exposes the same files under a different root on the host.
  await rename(buildRoot, hostRoot);
  const record = await readBuild(hostOutput, "recipe");
  expect(record.buildWork).toBe(join(hostRoot, "work"));
  expect(record.developmentInstallation).toBe(join(hostRoot, "work/postgresql-sdk"));
  await expect(lastCandidate(hostOutput)).resolves.toBe(record.installation);
  expect((await stat(record.installation!)).isDirectory()).toBe(true);
  expect((await stat(record.archive!)).isFile()).toBe(true);
});

it("continues to read absolute paths from an earlier build record", async () => {
  const output = await directory();
  const build = {
    developmentInstallation: join(output, "sdk"),
    buildWork: join(output, "work"),
    recipe: "recipe",
  };
  const installation = join(output, "candidate installation");
  await recordBuild(output, build);
  const path = join(output, "last-build.json");
  const record = JSON.parse(await readFile(path, "utf8")) as object;
  await writeFile(path, JSON.stringify({ ...record, ...build, installation }));
  await expect(readBuild(output, "recipe")).resolves.toMatchObject({ ...build, installation });
  await expect(lastCandidate(output)).resolves.toBe(installation);
});

it.each([
  ["missing", "no source notice scan"],
  ["malformed", "Malformed source notice scan"],
  ["incomplete", "missing notice scan for source: pgvector"],
  ["blank signature", "Malformed source notice scan"],
  ["blank path", "Malformed source notice scan"],
])("a source scan that is %s stops packaging before assembly", async (state, message) => {
  const work = await directory();
  const output = await directory();
  const target = process.platform === "win32" ? "windows-x64" : "linux-x64-glibc";
  if (state === "malformed") await writeFile(join(work, sourceNoticesFile), "[]");
  if (state === "incomplete" || state.startsWith("blank")) {
    const scan = fixtureNoticeScan();
    if (state === "incomplete") delete scan["pgvector"];
    else if (state === "blank signature") scan["pgvector"] = { " \t": ["README"] };
    else scan["pgvector"] = { "Copyright Acme": [" \t"] };
    await writeFile(join(work, sourceNoticesFile), JSON.stringify(scan));
  }
  const sdk = await directory();
  await createCandidate(sdk, target);
  const hostEvidence = vi.fn<() => Promise<HostEvidence[]>>().mockResolvedValue(
    fixtureEvidence(target),
  );
  await expect(packageCandidate({
    target,
    output,
    sourceRoot: await sourceTree(await directory()),
    reviewFile: join(work, "missing-review.json"),
    build: { developmentInstallation: sdk, buildWork: work, recipe: "recipe" },
    hostEvidence,
  })).rejects.toThrow(message);
  expect(hostEvidence).not.toHaveBeenCalled();
  await expect(readdir(output)).resolves.toEqual([]);
});

it("reassembly uses the toolchain evidence of the build and refuses a build that recorded none", () => {
  const build = { developmentInstallation: "sdk", buildWork: "work", recipe: "recipe" };
  // Measuring on the reassembling host could describe another compiler or glibc than the images contain.
  expect(() => recordedToolchain(build)).toThrow(
    "A fresh build is required: the recorded build lacks its toolchain evidence.",
  );
  const toolchainEvidence = [{ component: "glibc", version: "2.35", evidence: "fixture" }];
  expect(recordedToolchain({ ...build, toolchainEvidence })).toBe(toolchainEvidence);
});

/** Every file below a directory with its content, to show that a step left the directory as it was. */
async function snapshot(tree: string): Promise<Array<[string, string]>> {
  const entries = await readdir(tree, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries.filter(entry => entry.isFile()).map(async entry => {
      const path = join(entry.parentPath, entry.name);
      return [relative(tree, path), await readFile(path, "latin1")] satisfies [string, string];
    }),
  ).then(files => files.sort(([left], [right]) => left.localeCompare(right)));
}

it("packaging writes the notices into the candidate and leaves the development installation as it is", async () => {
  // Assembly runs for the host's own target, so the fixture installation is built for it as well.
  const target: ArtifactTarget = process.platform === "win32" ? "windows-x64" : "linux-x64-glibc";
  const work = await directory();
  // A directory from mkdtemp, because the fixture must pass candidate validation even under a permissive umask.
  const developmentInstallation = await directory();
  await createCandidate(developmentInstallation, target);
  // A reassembled build reuses its development installation, which may still hold an earlier pin's notice.
  await writeFile(join(developmentInstallation, "notices/pgvector-REMOVED"), "stale notice");
  const sourceRoot = await sourceTree(await directory());
  if (target === "linux-x64-glibc") {
    // A permissive umask in the build container leaves extracted sources group-writable.
    await chmod(join(sourceRoot, "pgvector/LICENSE"), 0o664);
  }
  const before = await snapshot(developmentInstallation);

  const output = await directory();
  await writeFixtureNoticeScan(work);
  const candidate = await packageCandidate({
    target,
    output,
    sourceRoot,
    reviewFile: join(work, "missing-review.json"),
    build: { developmentInstallation, buildWork: work, recipe: "recipe" },
    toolchainNotices: toolchainNotices(target).map(notice => join(developmentInstallation, notice)),
    hostEvidence: () => Promise.resolve(fixtureEvidence(target)),
  });

  // Concurrent assemblies of one build read the same installation, so packaging must never change it.
  await expect(snapshot(developmentInstallation)).resolves.toEqual(before);
  const notices = await readdir(join(candidate, "notices"));
  expect(notices).not.toContain("pgvector-REMOVED");
  expect(notices).toEqual(expect.arrayContaining(["pgvector.txt", "source-inputs.json"]));
  for (const notice of toolchainNotices(target)) expect(notices).toContain(basename(notice));
  // The notice comes from the extracted sources, not from the installation's earlier copy.
  await expect(readFile(join(candidate, "notices/pgvector.txt"), "utf8")).resolves.toBe("fixture");
  if (target === "linux-x64-glibc") {
    expect((await stat(join(candidate, "notices/pgvector.txt"))).mode & 0o777).toBe(0o644);
  }
});

it(
  "packaging reopens the parts of the tracked review that no longer match the candidate",
  async () => {
    const target: ArtifactTarget = process.platform === "win32" ? "windows-x64" : "linux-x64-glibc";
    const work = await directory();
    const developmentInstallation = await directory();
    await createCandidate(developmentInstallation, target);
    const sourceRoot = await sourceTree(await directory());
    const output = await directory();
    const reviewFile = join(work, "review.json");
    const packaged = async (hostEvidence = fixtureEvidence(target)) => {
      await writeFixtureNoticeScan(work);
      const candidate = await packageCandidate({
        target,
        output,
        sourceRoot,
        reviewFile,
        build: { developmentInstallation, buildWork: work, recipe: "recipe" },
        toolchainNotices: toolchainNotices(target).map(notice =>
          join(developmentInstallation, notice)
        ),
        hostEvidence: () => Promise.resolve(hostEvidence),
      });
      const { archive } = await readBuild(output, "recipe");
      return { candidate, manifest: await archivedManifest(archive!) };
    };

    // Without a tracked review, the candidate is pending.
    const first = await packaged();
    expect(first.manifest).toMatchObject({
      licenseInventory: { status: "pending", components: [] },
      hostRequirements: null,
    });

    // A review of that candidate stays verified while the next candidate matches it.
    const tracked = complete((await draftReview(first.candidate, target)).review);
    await writeFile(reviewFile, JSON.stringify(tracked));
    const same = await packaged();
    expect(same.manifest.licenseInventory).toEqual(tracked.licenseInventory);
    expect(same.manifest.hostRequirements).toEqual(tracked.hostRequirements);

    // Another host measurement leaves the host requirements unresolved and the licences verified.
    const measurement = target === "windows-x64"
      ? "ucrtbase.dll, advapi32.dll"
      : "GLIBC_2.34";
    const remeasuredHost = await packaged(remeasured(fixtureEvidence(target), target, measurement));
    expect(remeasuredHost.manifest.hostRequirements).toBeNull();
    expect(remeasuredHost.manifest.licenseInventory).toEqual(tracked.licenseInventory);

    // A changed licence text reopens its component and the inventory, not the other components.
    await writeFile(join(sourceRoot, "pgvector/LICENSE"), "a changed licence text");
    const changed = await packaged();
    expect(changed.manifest.licenseInventory.status).toBe("pending");
    expect(
      changed.manifest.licenseInventory.components.filter(component =>
        component.status === "pending"
      ).map(component => component.id),
    ).toEqual(["pgvector"]);
    expect(changed.manifest.hostRequirements).toEqual(tracked.hostRequirements);
  },
  60_000,
);

/** The tests choose when the newer build is recorded relative to packaging the older one. */
async function reassemblyFixture(output: string, installation?: string) {
  const target: ArtifactTarget = process.platform === "win32" ? "windows-x64" : "linux-x64-glibc";
  const older = await directory();
  const developmentInstallation = await directory();
  await createCandidate(developmentInstallation, target);
  await recordBuild(output, {
    developmentInstallation,
    buildWork: older,
    recipe: "recipe",
    ...installation === undefined ? {} : { installation },
  });
  const build = await readBuild(output, "recipe");
  const newer = {
    developmentInstallation: join(output, "newer/postgresql-sdk"),
    buildWork: join(output, "newer"),
    recipe: "recipe",
  };
  async function reassemble() {
    await writeFixtureNoticeScan(build.buildWork);
    return packageCandidate({
      target,
      output,
      sourceRoot: await sourceTree(await directory()),
      reviewFile: join(older, "missing-review.json"),
      build,
      toolchainNotices: toolchainNotices(target).map(notice =>
        join(developmentInstallation, notice)
      ),
      hostEvidence: () => Promise.resolve(fixtureEvidence(target)),
    });
  }
  return { newer, reassemble };
}

it("a reassembly of an older build leaves a newer build's record in place", async () => {
  const output = await directory();
  const previous = join(output, "previous candidate");
  const { newer, reassemble } = await reassemblyFixture(output, previous);
  await expect(lastCandidate(output)).resolves.toBe(previous);
  // A fresh build finishes compiling and records itself while the reassembly of the older one runs.
  await recordBuild(output, newer);
  await expect(lastCandidate(output)).rejects.toThrow("No packaged candidate is recorded");

  const warnings: unknown[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation(message => {
    warnings.push(message);
  });
  try {
    await reassemble();
  } finally {
    warn.mockRestore();
  }
  // Tests and a later reassembly must use the newer build, not the candidate of the older one.
  await expect(readBuild(output, "recipe")).resolves.toMatchObject(newer);
  await expect(lastCandidate(output)).rejects.toThrow("No packaged candidate is recorded");
  expect(warnings).toEqual([expect.stringContaining("newer build")]);
});

it("a fresh build that records itself while a reassembly replaces the record stays recorded", async () => {
  const output = await directory();
  const { newer, reassemble } = await reassemblyFixture(output);

  // The fresh build writes its record after the reassembly found its own build in the record, and
  // before the reassembly replaces it.
  const record = join(output, "last-build.json");
  const replace = vi.mocked(rename).getMockImplementation()!;
  let competing: Promise<void> | undefined;
  vi.mocked(rename).mockImplementation(async (from, to) => {
    if (competing === undefined && to === record) {
      competing = recordBuild(output, newer);
      await delay(200);
    }
    return replace(from, to);
  });
  try {
    await reassemble();
    await competing;
  } finally {
    vi.mocked(rename).mockImplementation(replace);
  }
  await expect(readBuild(output, "recipe")).resolves.toMatchObject(newer);
});

it("packaging stops instead of replacing a build record that it cannot read", async () => {
  const output = await directory();
  const { newer, reassemble } = await reassemblyFixture(output);
  await recordBuild(output, newer);

  // Only a missing record means that there is no build to keep; an unreadable one may name a newer build.
  const record = join(output, "last-build.json");
  const read = vi.mocked(readFile).getMockImplementation()!;
  const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  vi.mocked(readFile).mockImplementation((path, options) =>
    path === record ? Promise.reject(denied) : read(path, options)
  );
  let outcome: unknown;
  try {
    outcome = await reassemble().catch((error: unknown) => error);
  } finally {
    vi.mocked(readFile).mockImplementation(read);
  }
  await expect(readBuild(output, "recipe")).resolves.toMatchObject(newer);
  expect(outcome).toBe(denied);
});

it("the build record is replaced without leaving temporary files", async () => {
  const output = await directory();
  const build = {
    developmentInstallation: join(output, "sdk"),
    buildWork: join(output, "work"),
    recipe: "recipe",
  };
  await recordBuild(output, build);
  const newer = join(output, "newer");
  await recordBuild(output, { ...build, buildWork: newer });
  await expect(readdir(output)).resolves.toEqual(["last-build.json"]);
  await expect(readBuild(output, "recipe")).resolves.toMatchObject({ buildWork: newer });
});
