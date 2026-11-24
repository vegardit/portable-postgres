/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Exercises Windows build retention and explicit pruning with isolated work and output directories. */
import { mkdir, readdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type NativeBuild, readRecord, recordBuild } from "../binaries/package.ts";
import { pruneWindowsWork, withWindowsBuild } from "../binaries/windows/work.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

vi.mock(import("node:fs/promises"), async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    // Vitest's mock type exposes only the last readdir overload.
    readdir: vi.fn<typeof actual.readdir>(actual.readdir) as unknown as typeof actual.readdir,
    rename: vi.fn<typeof actual.rename>(actual.rename),
    rm: vi.fn<typeof actual.rm>(actual.rm),
  };
});

const { directory, cleanup } = temporaryDirectories("windows-work");
afterEach(async () => {
  vi.mocked(readdir).mockReset();
  await cleanup();
});

function denyDirectoryReads(...paths: string[]) {
  const read = vi.mocked(readdir).getMockImplementation()!;
  const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
  vi.mocked(readdir).mockImplementation((path, options) =>
    typeof path === "string" && paths.includes(path) ? Promise.reject(denied) : read(path, options)
  );
  return denied;
}

async function previewWork(work: string, output: string): Promise<string> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await pruneWindowsWork(work, output, "preview");
    return log.mock.calls.flat().join("\n");
  } finally {
    log.mockRestore();
  }
}

async function expectRecordedInUse(work: string, output: string, current: string): Promise<string> {
  vi.mocked(readdir).mockClear();
  const preview = await previewWork(work, output);
  expect(preview).toContain(basename(current) + "  in use  recorded");
  expect(vi.mocked(readdir).mock.calls.map(([path]) => path))
    .not.toContain(join(current, "postgresql-sdk"));
  return preview;
}

async function recordSdk(output: string, build: NativeBuild): Promise<void> {
  // The real driver records a compiled SDK before its first packaging attempt.
  await mkdir(build.developmentInstallation, { recursive: true });
  await recordBuild(output, build);
}

async function fixture() {
  const root = await directory();
  const work = join(root, "work");
  const output = join(root, "output");
  // Stand in for packaging's final record write without compiling or assembling PostgreSQL.
  async function packageBuild(build: NativeBuild) {
    await recordSdk(output, build);
    await writeFile(join(output, "last-build.json"), JSON.stringify({
      ...await readRecord(output),
      installation: "candidate",
      archive: "archive.tar.gz",
    }));
    return build.buildWork;
  }
  async function fresh() {
    let path = "";
    await withWindowsBuild(work, output, "build", "recipe", async build => {
      path = await packageBuild(build);
    });
    return path;
  }
  return { work, output, fresh, packageBuild };
}

it("retires a superseded packaged tree after its last concurrent reassembly finishes", async () => {
  const { work, output, fresh } = await fixture();
  const older = await fresh();
  let current = "";
  await withWindowsBuild(work, output, "assemble", "recipe", async reader => {
    expect(reader.buildWork).toBe(older);
    await expectRecordedInUse(work, output, older);
    current = await fresh();
    await expect(pruneWindowsWork(work, output, [basename(older)])).rejects.toThrow("active");
    await expect(readdir(work)).resolves.toContain(basename(older));
  });
  await expect(readdir(work)).resolves.toEqual([basename(current)]);
  await expect(pruneWindowsWork(work, output, [basename(current)])).rejects.toThrow("recorded");
});

it("keeps the physical SDK readable during reassembly from another checkout", async () => {
  const { work, output, fresh } = await fixture();
  const older = await fresh();
  await writeFile(join(older, "postgresql-sdk", "probe"), "original SDK");
  const reader = await fixture();
  await symlink(work, reader.work, "junction");
  await mkdir(reader.output);
  await writeFile(join(reader.output, "last-build.json"),
    await readFile(join(output, "last-build.json")));

  await withWindowsBuild(reader.work, reader.output, "assemble", "recipe", async build => {
    await fresh();
    await expect(readFile(join(build.developmentInstallation, "probe"), "utf8")).resolves.toBe(
      "original SDK",
    );
    await expect(pruneWindowsWork(work, output, [basename(older)])).rejects.toThrow("active");
  });
  await pruneWindowsWork(work, output, "automatic");
  await expect(readdir(work)).resolves.not.toContain(basename(older));
});

it("keeps the last successful tree and failed diagnostics when the replacement fails packaging", async () => {
  const { work, output, fresh } = await fixture();
  const previous = await fresh();
  let failed = "";
  await expect(withWindowsBuild(work, output, "build", "recipe", async build => {
    failed = build.buildWork;
    await recordSdk(output, build);
    throw new Error("packaging failed");
  })).rejects.toThrow("packaging failed");
  await pruneWindowsWork(work, output, "automatic");
  await expect(readdir(work)).resolves.toContain(basename(previous));
  const current = await fresh();
  expect((await readdir(work)).sort()).toEqual([basename(current), basename(failed)].sort());
});

it("keeps a relocated build read-only and protects its SDK while a new build replaces it", async () => {
  const { work, output, fresh } = await fixture();
  const older = await fresh();
  const external = await directory("relocated");
  await recordBuild(output, {
    buildWork: external,
    developmentInstallation: join(older, "postgresql-sdk"),
    recipe: "recipe",
  });
  await withWindowsBuild(work, output, "assemble", "recipe", async build => {
    expect(build.buildWork).toBe(external);
    await fresh();
    await expect(pruneWindowsWork(work, output, [basename(older)])).rejects.toThrow("active");
    await expect(readdir(external)).resolves.toEqual([]);
  });
  await expect(readdir(work)).resolves.not.toContain(basename(older));
  await expect(readdir(external)).resolves.toEqual([]);
});

it("previews legacy runs and removes only explicitly selected real work directories", async () => {
  const { work, output, fresh } = await fixture();
  const current = await fresh();
  const legacy = "windows-build-Aa1234";
  const incomplete = "windows-build-Bb1234";
  const unknown = "windows-build-Cc1234";
  for (const name of [legacy, incomplete]) {
    await mkdir(join(work, name, "windows-sources"), { recursive: true });
    await writeFile(join(work, name, "windows-postgresql.tar"), "temporary tar");
  }
  await writeFile(join(work, legacy, "windows-link-evidence.json"), "{}");
  await mkdir(join(work, unknown));
  const outside = await directory();
  await writeFile(join(outside, "keep"), "caller data");
  await symlink(outside, join(work, legacy, "linked"), "junction");
  await symlink(outside, join(work, "windows-build-Dd1234"), "junction");
  const preview = await previewWork(work, output);
  expect(preview).toContain(legacy + "  0.00 GiB  legacy (audited)");
  expect(preview).toContain(incomplete + "  0.00 GiB  incomplete");
  await pruneWindowsWork(work, output, "automatic");
  await expect(pruneWindowsWork(work, output, [legacy, basename(current)])).rejects.toThrow(
    "recorded",
  );
  await expect(pruneWindowsWork(work, output, [unknown])).rejects.toThrow("unrecognized");
  await expect(pruneWindowsWork(work, output, ["../" + legacy])).rejects.toThrow("exact");
  await expect(pruneWindowsWork(work, output, ["windows-build-Dd1234"])).rejects.toThrow();
  await pruneWindowsWork(work, output, [legacy]);
  await expect(readdir(work)).resolves.not.toContain(legacy);
  await expect(readdir(work)).resolves.toContain(incomplete);
  await expect(readFile(join(outside, "keep"), "utf8")).resolves.toBe("caller data");
});

it("requires a cleanup receipt before retrying a partially removed tree", async () => {
  const { work, output, fresh } = await fixture();
  await fresh();
  const original = "windows-build-Aa1234";
  const name = original + ".retired-4ccafffd-e97d-4a89-b1b6-13c7c0b9df43";
  await mkdir(join(work, name));
  await expect(pruneWindowsWork(work, output, [name])).rejects.toThrow("unrecognized");
  await writeFile(join(output, name), original);
  await pruneWindowsWork(work, output, [name]);
  await expect(readdir(work)).resolves.not.toContain(name);
  await expect(readdir(output)).resolves.not.toContain(name);
});

it("retires a build recovered by reassembly once a newer build succeeds", async () => {
  const { work, output, fresh, packageBuild } = await fixture();
  await expect(withWindowsBuild(work, output, "build", "recipe", async build => {
    await recordSdk(output, build);
    throw new Error("initial packaging failed");
  })).rejects.toThrow("initial packaging failed");
  await withWindowsBuild(work, output, "assemble", "recipe", async build => {
    await packageBuild(build);
  });
  const current = await fresh();
  await expect(readdir(work)).resolves.toEqual([basename(current)]);
});

it("reports the packaging failure and the marker that could not be released", async () => {
  const { work, output } = await fixture();
  const failure = new Error("packaging failed");
  let marker = "";
  const outcome = await withWindowsBuild(work, output, "build", "recipe", async build => {
    await recordSdk(output, build);
    marker = join(output,
      (await readdir(output)).find(name => name.startsWith(".portable-postgres-in-use-"))!);
    await writeFile(join(marker, "keep"), "prevents marker removal");
    throw failure;
  }).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(AggregateError);
  expect(outcome).toMatchObject({ errors: [failure, expect.objectContaining({ path: marker })] });
});

it("can remove a failed first build but refuses to prune with a malformed record", async () => {
  const { work, output } = await fixture();
  let name = "";
  await expect(withWindowsBuild(work, output, "build", "recipe", build => {
    name = basename(build.buildWork);
    return Promise.reject(new Error("compilation failed"));
  })).rejects.toThrow("compilation failed");
  const record = join(output, "last-build.json");
  await writeFile(record, "{}");
  await expect(pruneWindowsWork(work, output, [name])).rejects.toThrow("Cannot identify");
  await expect(readdir(work)).resolves.toContain(name);
  await unlink(record);
  await pruneWindowsWork(work, output, [name]);
  await expect(readdir(work)).resolves.toEqual([]);
});

it.each(["recorded", "active"])(
  "protects the physical SDK when the build is %s and uses a junction",
  async state => {
    const { work, output, fresh, packageBuild } = await fixture();
    const physical = await fresh();
    const recorded = join(work, "windows-build-Aa1234");
    await mkdir(recorded);
    const sdk = join(recorded, "postgresql-sdk");
    await symlink(join(physical, "postgresql-sdk"), sdk, "junction");
    await packageBuild({
      buildWork: recorded,
      developmentInstallation: sdk,
      recipe: "recipe",
    });
    if (state === "recorded") {
      await expect(previewWork(work, output)).resolves.toMatch(
        /recorded Windows build.*retaining all build directories/i,
      );
      await pruneWindowsWork(work, output, "automatic");
      await expect(readdir(sdk)).resolves.toEqual([]);
      await expect(pruneWindowsWork(work, output, [basename(physical)])).rejects.toThrow();
    } else {
      await withWindowsBuild(work, output, "assemble", "recipe", async () => {
        await fresh();
        await expect(readdir(sdk)).resolves.toEqual([]);
      });
      await expect(readdir(work)).resolves.not.toContain(basename(physical));
    }
  },
);

it("builds under a redirected work root and skips automatic cleanup there", async () => {
  const { work, output, fresh, packageBuild } = await fixture();
  const volume = await directory("redirected");
  const otherOutput = await directory("other-checkout");
  await symlink(volume, work, "junction");
  const first = await fresh();
  let second = "";
  await withWindowsBuild(work, output, "build", "recipe", async build => {
    second = build.buildWork;
    await expect(pruneWindowsWork(volume, otherOutput, [basename(second)])).rejects.toThrow(
      "redirected",
    );
    await packageBuild(build);
  });
  await expect(pruneWindowsWork(volume, otherOutput, [basename(second)])).rejects.toThrow(
    "redirected",
  );
  await expect(readdir(join(second, "postgresql-sdk"))).resolves.toEqual([]);
  expect((await readdir(volume)).sort()).toEqual([basename(first), basename(second)].sort());
  await expect(pruneWindowsWork(work, output, [basename(first)])).rejects.toThrow();
});

it("identifies the blocking marker and explains safe recovery in the preview", async () => {
  const { work, output, fresh } = await fixture();
  const current = await fresh();
  const marker = join(output, ".portable-postgres-in-use-external-123-fixture");
  await mkdir(marker);
  const preview = await expectRecordedInUse(work, output, current);
  expect(preview).toContain(marker);
  expect(preview).toMatch(/child processes.*exited/);
  await expect(readdir(marker)).resolves.toEqual([]);
});

it("retains an unreadable tree and prunes its independently verified neighbor", async () => {
  const { work, output, fresh } = await fixture();
  await fresh();
  const blocked = "windows-build-Aa1234";
  const eligible = "windows-build-Bb1234";
  for (const name of [blocked, eligible]) {
    await mkdir(join(work, name));
    await writeFile(join(work, name, ".portable-postgres-build"), "packaged\n");
  }
  const record = join(output, "last-build.json");
  const saved = await readFile(record);
  await writeFile(record, "{");
  await expect(pruneWindowsWork(work, output, "automatic")).rejects.toThrow(SyntaxError);
  await expect(readdir(work)).resolves.toContain(eligible);
  await writeFile(record, saved);
  const markersDenied = denyDirectoryReads(output);
  await expect(pruneWindowsWork(work, output, "automatic")).rejects.toBe(markersDenied);
  await expect(readdir(work)).resolves.toContain(eligible);
  vi.mocked(readdir).mockReset();
  const inspectionDenied = denyDirectoryReads(join(work, blocked));
  await expect(pruneWindowsWork(work, output, [eligible, blocked])).rejects.toBe(inspectionDenied);
  await expect(readdir(work)).resolves.toContain(eligible);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await pruneWindowsWork(work, output, "automatic");
    expect(warn.mock.calls.flat().join(" ")).toContain(join(work, blocked));
  } finally {
    warn.mockRestore();
  }
  const remaining = await readdir(work);
  expect(remaining).toContain(blocked);
  expect(remaining).not.toContain(eligible);
});

it("shows later preview rows after directory inspection and sizing errors", async () => {
  const { work, output } = await fixture();
  const names = ["windows-build-Aa1234", "windows-build-Bb1234", "windows-build-Cc1234"] as const;
  for (const name of names) await mkdir(join(work, name, "objects"), { recursive: true });
  denyDirectoryReads(join(work, names[0]), join(work, names[1], "objects"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const preview = await previewWork(work, output);
    expect(warn.mock.calls.flat().join(" ")).toContain(join(work, names[0]));
    expect(preview).toContain(names[1] + "  size unavailable  unrecognized");
    expect(preview).toContain(names[2] + "  0.00 GiB  unrecognized");
  } finally {
    warn.mockRestore();
  }
});

it.each(["rename", "tree", "receipt"])("finishes independent work after a %s failure",
  async failure => {
    const { work, output, fresh } = await fixture();
    await fresh();
    const names = ["windows-build-Aa1234", "windows-build-Bb1234", "windows-build-Cc1234"];
    for (const name of names) {
      await mkdir(join(work, name));
      await writeFile(join(work, name, ".portable-postgres-build"), "building\n");
    }
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const blocked = names[1]!;
    vi.mocked(rename).mockImplementation((from, to) =>
      failure === "rename" && from === join(work, blocked)
        ? Promise.reject(new Error("locked"))
        : actual.rename(from, to)
    );
    vi.mocked(rm).mockImplementation((path, options) => {
      if (typeof path === "string" && basename(path).startsWith(blocked + ".retired-")
        && ((failure === "tree" && dirname(path) === work)
          || (failure === "receipt" && dirname(path) === output)))
      {
        return Promise.reject(new Error("locked"));
      }
      return actual.rm(path, options);
    });
    try {
      const operation = pruneWindowsWork(work, output, names);
      await expect(operation).rejects.toThrow(blocked);
      const remaining = await readdir(work);
      expect(
        remaining.filter(name =>
          names.some(original => name.startsWith(original) && original !== blocked)
        ),
      ).toEqual([]);
      const receipt = (await readdir(output)).find(name => name.startsWith(blocked + ".retired-"));
      if (failure === "receipt") {
        expect(remaining.some(name => name.startsWith(blocked))).toBe(false);
        await expect(operation).rejects.toThrow("Removed tree " + join(work, receipt!));
        await expect(operation).rejects.toThrow(join(output, receipt!));
        await expect(operation).rejects.not.toThrow("--remove");
      } else if (failure === "tree") {
        expect(remaining).toContain(receipt);
        await expect(operation).rejects.toThrow(join(work, receipt!));
      } else {
        expect(remaining).toContain(blocked);
        expect(receipt).toBeUndefined();
      }
    } finally {
      vi.mocked(rename).mockReset();
      vi.mocked(rm).mockReset();
    }
  });
