/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Checks macOS tool selection and SDK reassembly. Mach-O fixtures exercise the load-command reader,
 * linker maps, relocation checks and host measurements without an Apple toolchain.
 */
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { build as buildMacOS } from "../binaries/macos/build.ts";
import * as packaging from "../binaries/package.ts";
import * as notices from "../binaries/artifact/notices.ts";
import * as processTools from "../binaries/process.ts";
import * as links from "../binaries/macos/links.ts";
import * as runtime from "../binaries/macos/runtime.ts";
import { isNativeImage } from "../binaries/artifact/artifact.ts";
import { machOVersion, readMachO } from "../binaries/artifact/macho.ts";
import { auditLinks, mapInputs } from "../binaries/macos/links.ts";
import { inspectMacOSRuntime, machOImages } from "../binaries/macos/runtime.ts";
import { machOFixture, machOSignatureCommand } from "./candidate.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

const { directory, cleanup } = temporaryDirectories("macos");
afterEach(cleanup);

vi.mock(import("node:fs/promises"), async importOriginal => {
  const actual = await importOriginal();
  // The spy forwards every overload, although Vitest's mock type retains only the last one.
  return {
    ...actual,
    readdir: vi.fn<typeof actual.readdir>(actual.readdir) as unknown as typeof actual.readdir,
  };
});

const uuid = "8a8854bc9c253fe69e5f6c187259ae39";

/** One load command with a string argument, padded to 8 bytes as the linker writes it. */
function stringCommand(command: number, value: string, offset = 24): Buffer {
  const size = Math.ceil((offset + value.length + 1) / 8) * 8;
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32LE(command, 0);
  bytes.writeUInt32LE(size, 4);
  bytes.writeUInt32LE(offset, 8);
  bytes.write(value, offset, "utf8");
  return bytes;
}

/** A signed arm64 macOS image with these libraries, install name, search paths and minimum macOS. */
function image(
  options: {
    dylibs?: string[];
    id?: string;
    rpaths?: string[];
    minimumOS?: number;
    uuid?: string;
  } = {},
): Buffer {
  const commands: Buffer[] = [];
  const build = Buffer.alloc(24);
  build.writeUInt32LE(0x32, 0);
  build.writeUInt32LE(24, 4);
  build.writeUInt32LE(1, 8);
  build.writeUInt32LE(options.minimumOS ?? 0x00_0F_00_00, 12);
  commands.push(build);
  if (options.uuid !== undefined) {
    const command = Buffer.alloc(24);
    command.writeUInt32LE(0x1B, 0);
    command.writeUInt32LE(24, 4);
    Buffer.from(options.uuid, "hex").copy(command, 8);
    commands.push(command);
  }
  if (options.id !== undefined) commands.push(stringCommand(0xD, options.id));
  for (const dylib of options.dylibs ?? ["/usr/lib/libSystem.B.dylib"]) {
    commands.push(stringCommand(0xC, dylib));
  }
  for (const rpath of options.rpaths ?? []) commands.push(stringCommand(0x80_00_00_1C, rpath, 12));
  const header = Buffer.alloc(32);
  const signatureData = Buffer.alloc(16);
  const signatureStart = header.length
    + commands.reduce((size, command) => size + command.length, 0) + 16;
  commands.push(machOSignatureCommand(signatureStart, signatureData.length));
  const body = Buffer.concat(commands);
  header.writeUInt32LE(0xFE_ED_FA_CF, 0);
  header.writeUInt32LE(0x01_00_00_0C, 4);
  header.writeUInt32LE(options.id === undefined ? 2 : 6, 12);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body, signatureData]);
}

/** An installation with one program that loads the bundled libpq, as relocation leaves it. */
async function installation(program: Buffer = image({
  dylibs: ["@rpath/libpq.5.dylib", "/usr/lib/libSystem.B.dylib"],
  rpaths: ["@loader_path/../lib"],
  uuid,
})): Promise<string> {
  const root = await directory();
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "lib"));
  await mkdir(join(root, "share"));
  await writeFile(join(root, "bin/psql"), program);
  await writeFile(
    join(root, "lib/libpq.5.dylib"),
    image({ id: "@rpath/libpq.5.dylib", uuid: "00".repeat(16) }),
  );
  return root;
}

/** Exercises the macOS driver on every test host, restoring the host even after a failed assertion. */
async function onMacOS(check: () => Promise<void>): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process, "arch", { value: "arm64" });
    await check();
  } finally {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
  }
}

it("reassembles on a newer host with the macOS version recorded during compilation", async () => {
  const root = await installation();
  const buildOS = { component: "macOS", version: "15.0", evidence: "original build" };
  const buildWork = await directory();
  const records = join(buildWork, links.linkRecordsDirectory);
  await mkdir(records);
  await writeFile(join(records, "build-root"), "/work\n");
  for (const id of [uuid, "00".repeat(16)]) {
    await writeFile(join(records, id + ".map"), linkMap(["command.o"]));
  }
  await onMacOS(async () => {
    vi.spyOn(packaging, "readBuild").mockResolvedValue({
      buildWork,
      developmentInstallation: root,
      inputs: [],
      recipe: "fixture",
      toolchainEvidence: [buildOS],
    });
    vi.spyOn(notices, "verifyNoticeAnchors").mockResolvedValue(undefined);
    const audit = vi.spyOn(links, "auditLinks");
    const inspect = vi.spyOn(runtime, "inspectMacOSRuntime");
    const capture = vi.spyOn(processTools, "capture").mockImplementation(command =>
      command === "sw_vers" ? "26.0" : ""
    );
    vi.spyOn(packaging, "packageCandidate").mockImplementation(async options => {
      const evidence = await options.hostEvidence(root);
      expect(evidence.filter(entry => entry.component === "macOS")).toEqual([buildOS]);
      return root;
    });
    await buildMacOS("assemble");
    const images = [join(root, "bin/psql"), join(root, "lib/libpq.5.dylib")];
    expect(vi.mocked(readdir).mock.calls.filter(([path]) => path === root)).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(root, records, images);
    expect(inspect).toHaveBeenCalledWith(root, expect.any(String), images);
    expect(capture.mock.calls.filter(([tool]) => tool === "codesign").map(([, args]) => args))
      .toEqual(images.map(path => ["--verify", "--strict", path]));
  });
});

it("uses the checkout's macOS pins and rejects a saved SDK after a parser change", async () => {
  const checkout = await directory();
  const pins = {
    xcode: "/fixture/Selected.app",
    xcodeVersion: "16.4",
    deploymentTarget: "14.0",
    bison: "/fixture/bin/bison",
    flex: "/fixture/bin/flex",
  };
  const measured: string[] = [];
  const capture: typeof processTools.capture = (command, args) => {
    if (args[0] === "--version") measured.push(command);
    return command === "xcodebuild" ? "Xcode 16.4\nBuild version fixture" : "fixture";
  };
  let compilerEnv: NodeJS.ProcessEnv | undefined;
  const run: typeof processTools.run = (command, args, options) => {
    expect([command, ...args]).toEqual(["bash", join(checkout, "binaries/macos/build.sh")]);
    compilerEnv = options?.env;
    return Promise.reject(new Error("fixture reached the compile script"));
  };
  // Recipe paths are set at import time. Load the driver against this fixture's checkout.
  vi.resetModules();
  vi.doMock(import("../binaries/paths.ts"),
    () => ({ root: checkout, workRoot: checkout, outputRoot: checkout }));
  vi.doMock(import("../binaries/process.ts"), () => ({ capture, run, buildJobs: () => "1" }));
  vi.doMock(import("../binaries/sources/sources.ts"),
    () => ({ sources: [], fetchSources: () => Promise.resolve(new Map<string, string>()) }));
  try {
    const { build, macOSRecipe } = await import("../binaries/macos/build.ts");
    const { recipeIdentity, recordBuild } = await import("../binaries/package.ts");
    for (const path of macOSRecipe) {
      expect(path.startsWith(checkout + sep)).toBe(true);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "fixture");
    }
    const baseline = join(checkout, "binaries/macos/base.json");
    await writeFile(baseline, JSON.stringify(pins));
    await onMacOS(async () => {
      await expect(build("build")).rejects.toThrow("fixture reached the compile script");
      expect.soft(compilerEnv?.["DEVELOPER_DIR"]).toBe(join(pins.xcode, "Contents/Developer"));
      expect.soft(compilerEnv?.["MACOSX_DEPLOYMENT_TARGET"]).toBe(pins.deploymentTarget);
      expect.soft([compilerEnv?.["BISON"], compilerEnv?.["FLEX"]]).toEqual([pins.bison, pins.flex]);
      expect.soft(measured).toEqual([pins.bison, pins.flex]);
      await recordBuild(join(checkout, "macos-arm64"), {
        buildWork: checkout,
        developmentInstallation: join(checkout, "sdk"),
        recipe: await recipeIdentity(macOSRecipe),
      });
      await writeFile(baseline, JSON.stringify({ ...pins, bison: "/fixture/new/bison" }));
      await expect(build("assemble")).rejects.toThrow(
        "A fresh build with the current source inputs and build recipe",
      );
    });
  } finally {
    vi.doUnmock(import("../binaries/paths.ts"));
    vi.doUnmock(import("../binaries/process.ts"));
    vi.doUnmock(import("../binaries/sources/sources.ts"));
    vi.resetModules();
  }
});

it("reads the load commands that validation and packaging check", () => {
  expect(readMachO(image({
    dylibs: ["@rpath/libpq.5.dylib", "/usr/lib/libSystem.B.dylib"],
    id: "@rpath/libecpg.6.dylib",
    rpaths: ["@loader_path/../lib"],
    minimumOS: 0x00_0F_02_01,
    uuid,
  }))).toEqual({
    cpuType: 0x01_00_00_0C,
    cpuSubtype: 0,
    fileType: 6,
    platform: 1,
    minimumOS: "15.2.1",
    dylibs: ["@rpath/libpq.5.dylib", "/usr/lib/libSystem.B.dylib"],
    id: "@rpath/libecpg.6.dylib",
    rpaths: ["@loader_path/../lib"],
    uuid,
    signed: true,
  });
  expect(readMachO(machOFixture({ signed: false })).signed).toBe(false);
  expect(machOVersion(0x00_0F_00_00)).toBe("15.0");
  // A header that claims more load commands than the file holds must not read past its end.
  const truncated = image();
  truncated.writeUInt32LE(truncated.length, 20);
  expect(() => readMachO(truncated)).toThrow("truncated Mach-O load commands");
  // The next command contains zeros, but only a NUL inside this command terminates its name.
  const unterminated = image({ dylibs: ["fixture"] });
  unterminated[unterminated.indexOf("fixture") + "fixture".length] = 0x78;
  expect(() => readMachO(unterminated)).toThrow("invalid Mach-O load command string");
  expect(() => readMachO(Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]))).toThrow(
    "not a 64-bit Mach-O image",
  );
});

it.each([
  ["empty", { signatureSize: 0 }],
  ["beyond the end of the file", { signatureOffset: 120 }],
  ["overlapping the load commands", { signatureOffset: 56 }],
])("rejects a Mach-O signature region that is %s", (_name, options) => {
  expect(() => readMachO(machOFixture(options))).toThrow("invalid Mach-O code signature range");
});

it.each([0xCA_FE_BA_BF, 0xBF_BA_FE_CA, 0xCE_FA_ED_FE, 0xCF_FA_ED_FE])(
  "recognizes an unsupported Mach-O magic %i under a data filename",
  async magic => {
    const root = await directory();
    const file = join(root, "data");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(magic);
    await writeFile(file, header);
    await expect(isNativeImage(file)).resolves.toBe(true);
    await expect(machOImages(root)).resolves.toEqual([file]);
    expect(() => readMachO(header)).toThrow();
  },
);

it("resolves a linker map's inputs against the directory the link ran in", () => {
  const map = [
    "# link directory: /work/sources/postgresql/src/bin/psql",
    "# Path: psql",
    "# Arch: arm64",
    "# Object files:",
    "[  0] linker synthesized",
    "[  1] command.o",
    "[  2] ../../../src/common/libpgcommon.a(string.o)",
    "[  3] /SDK/usr/lib/libSystem.tbd",
    "# Sections:",
    "[  4] not an input",
  ].join("\n");
  expect(mapInputs(map)).toEqual([
    "linker synthesized",
    "/work/sources/postgresql/src/bin/psql/command.o",
    "/work/sources/postgresql/src/common/libpgcommon.a(string.o)",
    "/SDK/usr/lib/libSystem.tbd",
  ]);
  // Without the link directory, relative inputs cannot be judged.
  expect(mapInputs(map.split("\n").slice(1).join("\n"))).toBeUndefined();
  expect(mapInputs(map.split("# Sections:")[0]!)).toBeUndefined();
  expect(mapInputs(map.replace("[  1] command.o", "unrecognized object row"))).toBeUndefined();
});

function linkMap(inputs: string[]): string {
  return [
    "# link directory: /work/sources/postgresql/src/bin/psql",
    "# Object files:",
    ...inputs.map((input, index) => `[${index}] ${input}`),
    "# Sections:",
  ].join("\n");
}

it("requires a linker map for every image and refuses static code from outside the build", async () => {
  const root = await installation();
  const workspace = await directory();
  const records = join(workspace, "link-records");
  await mkdir(records);
  await writeFile(join(records, "build-root"), "/work\n");
  const own = linkMap(["linker synthesized", "command.o", "/SDK/usr/lib/libSystem.tbd"]);
  await writeFile(join(records, "0".repeat(32) + ".map"), own);
  // psql's map is missing: an image linked outside the build has none.
  await expect(auditLinks(root, records)).rejects.toThrow("No linker record for bin/psql");
  await writeFile(join(records, uuid + ".map"), own);
  await expect(auditLinks(root, records)).resolves.toBeUndefined();
  // compiler-rt's static builtins would be toolchain code that no review covers.
  await writeFile(
    join(records, uuid + ".map"),
    linkMap(["command.o", "/Xcode/usr/lib/clang/17/lib/darwin/libclang_rt.osx.a(divdc3.o)"]),
  );
  await expect(auditLinks(root, records)).rejects.toThrow(
    "bin/psql: /Xcode/usr/lib/clang/17/lib/darwin/libclang_rt.osx.a(divdc3.o)",
  );
  // A relative input that climbs out of the build tree is judged by where it resolves.
  await writeFile(join(records, uuid + ".map"),
    linkMap(["../../../../../../opt/homebrew/lib/libz.a(inflate.o)"]));
  await expect(auditLinks(root, records)).rejects.toThrow(
    "bin/psql: /opt/homebrew/lib/libz.a(inflate.o)",
  );
  await writeFile(join(records, uuid + ".map"), own);
  const moved = join(workspace, "relocated-records");
  await rename(records, moved);
  await expect(auditLinks(root, moved)).resolves.toBeUndefined();
});

it("measures the system libraries and minimum macOS of a relocated installation", async () => {
  await expect(inspectMacOSRuntime(await installation(), "15.0")).resolves.toEqual({
    imports: ["/usr/lib/libSystem.B.dylib"],
    minimumOS: "15.0",
  });
});

it("rejects a system zlib import when the archive supplies its own zlib", async () => {
  const root = await installation(image({ dylibs: ["/usr/lib/libz.1.dylib"] }));
  await writeFile(join(root, "lib/libz.1.dylib"), image({ id: "@rpath/libz.1.dylib" }));
  await expect(inspectMacOSRuntime(root, "15.0")).rejects.toThrow(
    "bin/psql uses the system copy of a bundled library: /usr/lib/libz.1.dylib",
  );
});

it("uses the first existing bundled library in loader search order", async () => {
  const root = await installation(image({
    dylibs: ["@rpath/libpq.5.dylib"],
    rpaths: ["@loader_path/../optional", "@loader_path/../share", "@loader_path/../lib"],
  }));
  // A missing search directory is harmless while the packaged client library is reachable.
  await expect(inspectMacOSRuntime(root, "15.0")).resolves.toBeDefined();
  await writeFile(join(root, "share/libpq.5.dylib"), image());
  await expect(inspectMacOSRuntime(root, "15.0")).rejects.toThrow(
    "bin/psql cannot reach the bundled library",
  );
});

it.each([
  [
    "an absolute library outside the system",
    { dylibs: ["/opt/homebrew/lib/libzstd.1.dylib"] },
    "bin/psql needs an unreviewed runtime library: /opt/homebrew/lib/libzstd.1.dylib",
  ],
  [
    "a system library path that climbs into a third-party directory",
    { dylibs: ["/usr/lib/../local/lib/libexample.dylib"] },
    "bin/psql needs an unreviewed runtime library: /usr/lib/../local/lib/libexample.dylib",
  ],
  [
    "a bundled library that the archive lacks",
    { dylibs: ["@rpath/libssl.3.dylib"] },
    "bin/psql needs an unreviewed runtime library: @rpath/libssl.3.dylib",
  ],
  [
    "an absolute build path",
    { dylibs: ["/work/postgresql-sdk/lib/libpq.5.dylib"] },
    "bin/psql needs an unreviewed runtime library: /work/postgresql-sdk/lib/libpq.5.dylib",
  ],
  [
    "an absolute search path",
    { rpaths: ["/work/postgresql-sdk/lib"] },
    "bin/psql searches libraries outside the installation: /work/postgresql-sdk/lib",
  ],
  [
    "a relative search path outside the installation",
    { rpaths: ["@loader_path/../../lib"] },
    "bin/psql searches libraries outside the installation",
  ],
  [
    "no search path to a bundled library",
    { dylibs: ["@rpath/libpq.5.dylib"], rpaths: ["@loader_path/../share"] },
    "bin/psql cannot reach the bundled library",
  ],
  [
    "a newer minimum macOS than the floor",
    { minimumOS: 0x00_1A_00_00 },
    "bin/psql needs macOS 26.0, newer than the 15.0 floor",
  ],
])("refuses an image with %s", async (_name, options, message) => {
  await expect(inspectMacOSRuntime(await installation(image(options)), "15.0")).rejects.toThrow(
    message,
  );
});

it("refuses a bundled library whose install name is not relocatable", async () => {
  const root = await installation();
  await writeFile(join(root, "lib/libpq.5.dylib"),
    image({ id: "/work/postgresql-sdk/lib/libpq.5.dylib" }));
  await expect(inspectMacOSRuntime(root, "15.0")).rejects.toThrow(
    "lib/libpq.5.dylib has a non-relocatable install name: /work/postgresql-sdk/lib/libpq.5.dylib",
  );
});
