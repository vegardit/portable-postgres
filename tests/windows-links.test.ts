/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Guards the Windows link check: every image needs its map, and static Microsoft code only from the dynamic CRT. */
import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { recordLink } from "../binaries/windows/link-recipe.ts";
import {
  archiveMembers,
  auditWindowsLinks,
  linkEnvironmentFile,
  mapContributions,
  parseLinkEnvironment,
} from "../binaries/windows/links.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

/** A COFF archive member header, as lib.exe writes it. */
function memberHeader(name: string, size: number): Buffer {
  return Buffer.from(
    name.padEnd(16) + "0".padEnd(12) + "".padEnd(6) + "".padEnd(6) + "0".padEnd(8)
      + String(size).padEnd(10) + "`\n",
    "latin1",
  );
}

/** A COFF archive whose members all use long names, as lib.exe stores the full paths of objects. */
function archive(members: Array<[string, Buffer]>): Buffer {
  const names = Buffer.from(members.map(([name]) => name + "\0").join(""), "latin1");
  const pad = (data: Buffer) => data.length % 2 === 1 ? [Buffer.from("\n")] : [];
  const parts = [Buffer.from("!<arch>\n", "latin1"), memberHeader("/", 4), Buffer.alloc(4)];
  parts.push(memberHeader("//", names.length), names, ...pad(names));
  let offset = 0;
  for (const [name, body] of members) {
    parts.push(memberHeader("/" + offset, body.length), body, ...pad(body));
    offset += name.length + 1;
  }
  return Buffer.concat(parts);
}

/** A short import record: Sig1 0, Sig2 0xFFFF, version 0, x64. */
function shortImport(): Buffer {
  const record = Buffer.alloc(24);
  record.writeUInt16LE(0xFF_FF, 2);
  record.writeUInt16LE(0x86_64, 6);
  return record;
}

/** An x64 COFF object with these section names. */
function object(...sections: string[]): Buffer {
  const data = Buffer.alloc(20 + sections.length * 40);
  data.writeUInt16LE(0x86_64, 0);
  data.writeUInt16LE(sections.length, 2);
  for (const [index, name] of sections.entries()) data.write(name, 20 + index * 40, "latin1");
  return data;
}

/** A file with an MZ header and PE signature; `tag` makes images of different links differ. */
function peImage(tag: string): Buffer {
  const data = Buffer.alloc(128);
  data.write("MZ", 0, "latin1");
  data.writeUInt32LE(64, 60);
  data.write("PE\0\0", 64, "latin1");
  data.write(tag, 80, "latin1");
  return data;
}

/** A link map whose public symbols come from these `library:member` or object origins. */
function linkMap(...origins: string[]): string {
  return [
    " postgres",
    " Timestamp is 00000000 (fixture)",
    "",
    " Start         Length     Name                   Class",
    " 0001:00000000 00560a60H .text$mn                CODE",
    "",
    "  Address         Publics by Value              Rva+Base               Lib:Object",
    "",
    ...origins.map((origin, index) =>
      ` 0001:${
        index.toString(16).padStart(8, "0")
      }       symbol${index}                0000000140001000 f   ${origin}`
    ),
    "",
    " entry point at        0001:00000000",
    "",
  ].join("\r\n");
}

const { directory, cleanup } = temporaryDirectories("links");
afterEach(cleanup);

async function put(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/**
 * A build with a Visual Studio toolset, a Windows SDK, a project library, and postgres.exe linked with
 * `origins`; returns the paths to audit and to change.
 */
async function build(...origins: string[]) {
  const root = await directory();
  const vc = join(root, "vc");
  const toolset = join(vc, "lib", "x64");
  const sdk = join(root, "sdk", "um", "x64");
  await put(join(toolset, "msvcrt.lib"),
    archive([["D:\\crt\\md\\dll_dllmain.obj", object(".text$mn", ".pdata")]]));
  await put(
    join(toolset, "vcruntime.lib"),
    archive([
      ["D:\\crt\\softmemtag.obj", object(".00cfg", ".gfids$y")],
      ["VCRUNTIME140.dll", shortImport()],
      ["VCRUNTIME140.dll", object(".debug$S", ".idata$2", ".idata$6")],
    ]),
  );
  await put(join(toolset, "libcmt.lib"),
    archive([["D:\\crt\\mt\\exe_main.obj", object(".text$mn")]]));
  await put(join(toolset, "msvcrtd.lib"),
    archive([["D:\\crt\\mdd\\dll_dllmain.obj", object(".text$mn")]]));
  await put(join(toolset, "msvcprt.lib"), archive([
    ["vector_algorithms.obj", object(".text$mn")],
    ["xonce2.obj", object(".text$mn")],
    ["unreviewed.obj", object(".text$mn")],
  ]));
  await put(
    join(sdk, "kernel32.lib"),
    archive([
      ["KERNEL32.dll", shortImport()],
      ["KERNEL32.dll", object(".debug$S", ".idata$5", ".idata$4")],
    ]),
  );
  await put(
    join(sdk, "WS2_32.Lib"),
    archive([["WS2_32.dll", shortImport()], ["d:\\os\\obj\\indef.obj", object(".rdata", ".data")]]),
  );
  await put(join(sdk, "trick.lib"),
    archive([["TRICK.dll", shortImport()], ["TRICK.dll", object(".text$mn")]]));
  const work = join(root, "work");
  await put(
    join(work, linkEnvironmentFile),
    [
      `VCToolsInstallDir=${vc}`,
      "WindowsSDKVersion=10.0.26100.0\\",
      // A directory that does not exist, as vcvars64.bat lists ATLMFC without that component.
      `LIB=${join(vc, "atlmfc", "lib", "x64")};${toolset};${sdk};`,
      "",
    ].join("\r\n"),
  );
  await put(join(work, "windows-postgresql", "src", "port", "libpgport.a"), "!<arch>\n");
  const output = join(work, "windows-postgresql", "src", "backend", "postgres.exe");
  await put(output, peImage("postgres"));
  await put(output.replace(/\.exe$/, ".map"), linkMap(...origins));
  const inputs = [
    ...["msvcrt.lib", "vcruntime.lib", "libcmt.lib", "msvcrtd.lib", "msvcprt.lib"].map(name =>
      '"/defaultlib:' + join(toolset, name) + '"'
    ),
    ...["kernel32.lib", "WS2_32.Lib", "trick.lib"].map(name => '"' + join(sdk, name) + '"'),
    '"' + join(work, "windows-postgresql", "src", "port", "libpgport.a") + '"',
  ];
  await put(output + ".inputs", inputs.join("\r\n"));
  await recordLink(output, []);
  const installation = join(root, "installation");
  await put(join(installation, "bin", "postgres.exe"), peImage("postgres"));
  await put(join(installation, "share", "postgres.bki"), "not an image");
  return { installation, work, output, toolset, sdk };
}

const dynamicCrt = [
  "MSVCRT:dll_dllmain.obj",
  "vcruntime:softmemtag.obj",
  "vcruntime:VCRUNTIME140.dll",
  "kernel32:KERNEL32.dll",
  "libpgport:path.c.obj",
  "backend_main.c.obj",
  "<linker-defined>",
];

it("refuses a map changed after linking", async () => {
  const { installation, work, output } = await build(...dynamicCrt);
  const path = output.replace(/\.exe$/, ".map");
  const original = await readFile(path, "utf8");
  for (const invalid of [
    original.replace("softmemtag.obj", "VCRUNTIME140.dll"),
    "",
    original.replace("Timestamp is 00000000", "Timestamp is 12345678"),
  ]) {
    await writeFile(path, invalid);
    await expect(auditWindowsLinks(installation, work)).rejects.toThrow(
      "Link output or map changed since linking bin/postgres.exe",
    );
  }
});

it("refuses a recorded map without library symbols even when its hash matches", async () => {
  const { installation, work } = await build();
  await expect(auditWindowsLinks(installation, work)).rejects.toThrow(
    "Incomplete or mismatched link map for bin/postgres.exe",
  );
});

it("accepts ICU data without CRT members only when the PE image has no executable sections or entry point", async () => {
  const { installation, work } = await build(...dynamicCrt);
  const output = join(work, "icu", "icudt79.dll");
  const image = Buffer.alloc(512);
  peImage("icu").copy(image);
  image.writeUInt16LE(1, 70);
  image.writeUInt16LE(240, 84);
  image.writeUInt32LE(0, 104);
  image.writeUInt32LE(0x40_00_00_40, 364); // Readable initialized data.
  await put(output, image);
  await put(join(installation, "bin/icudt79.dll"), image);
  await put(output.replace(/\.dll$/, ".map"),
    linkMap("icudt79l_dat.obj").replace(" postgres", " icudt79"));
  await put(output + ".inputs", "");
  await recordLink(output, []);
  await expect(auditWindowsLinks(installation, work)).resolves.toBeDefined();
  image.writeUInt32LE(0x60_00_00_20, 364);
  await put(output, image);
  await put(join(installation, "bin/icudt79.dll"), image);
  await recordLink(output, []);
  await expect(auditWindowsLinks(installation, work)).rejects.toThrow(
    "Incomplete or mismatched link map for bin/icudt79.dll",
  );
});

it("reports every packaged image with missing link inputs", async () => {
  const { installation, work, output } = await build(...dynamicCrt);
  await rm(output + ".link.json");
  const second = join(dirname(output), "psql.exe");
  await put(second, peImage("psql"));
  await cp(second, join(installation, "bin", "psql.exe"));
  await put(second.replace(/\.exe$/, ".map"), linkMap(...dynamicCrt).replace(" postgres", " psql"));

  const audit = auditWindowsLinks(installation, work);
  await expect(audit).rejects.toThrow("No recorded link inputs for bin/postgres.exe");
  await expect(audit).rejects.toThrow("No recorded link inputs for bin/psql.exe");
});

it("reassembly uses saved classifications and rejects a replaced map with the same output", async () => {
  const { installation, work, output, sdk } = await build(...dynamicCrt);
  await expect(auditWindowsLinks(installation, work, "assemble")).rejects.toThrow(
    /no sealed link evidence.*retry when it finishes.*rebuild/i,
  );
  const expected = await auditWindowsLinks(installation, work);
  await rm(sdk, { recursive: true });
  await expect(auditWindowsLinks(installation, work, "assemble")).resolves.toEqual(expected);
  await writeFile(output.replace(/\.exe$/, ".map"), linkMap("kernel32:KERNEL32.dll"));
  await expect(auditWindowsLinks(installation, work, "assemble")).rejects.toThrow(/map/i);
});

it("audits the candidate inside directories that would be probes in the build tree", async () => {
  const { installation, work } = await build(...dynamicCrt);
  await put(join(installation, "share", "CMakeFiles", "helper"), peImage("unrecorded"));
  await expect(auditWindowsLinks(installation, work)).rejects.toThrow("share/CMakeFiles/helper");
});

it("checks the actual link input when a library name also exists in the toolset", async () => {
  const { installation, work, output, toolset } = await build(...dynamicCrt);
  const path = output + ".inputs";
  const external = join(dirname(work), "external", "msvcrt.lib");
  await put(external, await readFile(join(toolset, "msvcrt.lib")));
  await writeFile(path,
    (await readFile(path, "utf8")).replace(join(toolset, "msvcrt.lib"), external));
  await recordLink(output, []);
  await expect(auditWindowsLinks(installation, work)).rejects.toThrow(/msvcrt\.lib/i);
  // Libraries requested inside a COFF object appear only in the search log.
  await writeFile(path,
    (await readFile(path, "utf8")).split("\r\n").filter(line => !line.includes(external)).join(
      "\r\n",
    ));
  await recordLink(output, [join(toolset, "msvcrt.lib")]);
  await expect(auditWindowsLinks(installation, work)).resolves.toMatchObject({ images: 1 });
  await recordLink(output, [external]);
  await expect(auditWindowsLinks(installation, work)).rejects.toThrow(/msvcrt\.lib/i);
});

it("counts a repeated LIB directory once and propagates errors inspecting an existing path", async () => {
  const { installation, work, toolset, output } = await build(...dynamicCrt);
  const path = join(work, linkEnvironmentFile);
  const original = await readFile(path, "utf8");
  await appendFile(path, "LIB=" + original.split("LIB=")[1]!.trim() + toolset + "\r\n");
  await expect(auditWindowsLinks(installation, work)).resolves.toMatchObject({ images: 1 });
  await writeFile(path, original.replace("LIB=", "LIB=" + output + ";"));
  await expect(auditWindowsLinks(installation, work)).rejects.toMatchObject({
    code: "ENOTDIR",
    path: output,
  });
});

it("admits the dynamic CRT's static code and import stubs from any Microsoft library", async () => {
  const { installation, work, toolset } = await build(...dynamicCrt, "WS2_32:WS2_32.dll");
  const summary = await auditWindowsLinks(installation, work);
  expect(summary.images).toBe(1);
  expect(
    Object.fromEntries(
      [...summary.staticMicrosoftCode].map(([library, members]) => [library, [...members]]),
    ),
  )
    .toEqual({
      [join(toolset, "msvcrt.lib")]: ["dll_dllmain.obj"],
      [join(toolset, "vcruntime.lib")]: ["softmemtag.obj"],
    });
});

it("refuses static Windows SDK code, naming the image, the library and the member", async () => {
  const { installation, work, sdk } = await build(...dynamicCrt, "WS2_32:indef.obj");
  await expect(auditWindowsLinks(installation, work)).rejects.toThrow(
    `bin/postgres.exe links the static member indef.obj of ${
      join(sdk, "WS2_32.Lib")
    }, which the licence gate`,
  );
});

it("admits only the reviewed MSVC C++ support members from the selected toolset", async () => {
  const accepted = await build(...dynamicCrt, "msvcprt:vector_algorithms.obj",
    "msvcprt:xonce2.obj");
  const result = await auditWindowsLinks(accepted.installation, accepted.work);
  expect([...result.staticMicrosoftCode.get(join(accepted.toolset, "msvcprt.lib"))!].sort())
    .toEqual(["vector_algorithms.obj", "xonce2.obj"]);
  const rejected = await build(...dynamicCrt, "msvcprt:unreviewed.obj");
  await expect(auditWindowsLinks(rejected.installation, rejected.work)).rejects.toThrow(
    "msvcprt.lib, which the licence gate does not admit",
  );
});

it("a .dll name does not make a member an import stub", async () => {
  const { installation, work } = await build(...dynamicCrt, "trick:TRICK.dll");
  await expect(auditWindowsLinks(installation, work)).rejects.toThrow(
    /static member TRICK\.dll of .*trick\.lib/,
  );
});

it("refuses the static and the debug CRT, also beside the dynamic one", async () => {
  const mixed = await build(...dynamicCrt, "libcmt:exe_main.obj");
  const error = await auditWindowsLinks(mixed.installation, mixed.work).catch(String);
  expect(error).toMatch(/static member exe_main\.obj of .*libcmt\.lib/);
  expect(error).not.toMatch(/msvcrt\.lib|vcruntime\.lib/);
  const debug = await build("msvcrtd:dll_dllmain.obj");
  await expect(auditWindowsLinks(debug.installation, debug.work)).rejects.toThrow(/msvcrtd\.lib/);
});

it("an image needs exactly one map, beside a link output with the image's bytes", async () => {
  const missing = await build(...dynamicCrt);
  await rm(missing.output.replace(/\.exe$/, ".map"));
  await expect(auditWindowsLinks(missing.installation, missing.work)).rejects.toThrow(
    "No link record for bin/postgres.exe",
  );
  // Stale: the image was linked again after the build, or replaced by hand.
  const stale = await build(...dynamicCrt);
  await writeFile(join(stale.installation, "bin", "postgres.exe"), peImage("rebuilt"));
  await expect(auditWindowsLinks(stale.installation, stale.work)).rejects.toThrow("No link record");
  const twice = await build(...dynamicCrt);
  const copy = join(twice.work, "windows-extra-build", "postgres.exe");
  await cp(twice.output, copy);
  await cp(twice.output.replace(/\.exe$/, ".map"), copy.replace(/\.exe$/, ".map"));
  await expect(auditWindowsLinks(twice.installation, twice.work)).rejects.toThrow(
    "Ambiguous link records",
  );
  // A configure probe's map never counts, even beside an identical output.
  const probe = await build(...dynamicCrt);
  const probed = join(probe.work, "windows-postgresql", "meson-private", "tmp1", "postgres.exe");
  await cp(probe.output, probed);
  await cp(probe.output.replace(/\.exe$/, ".map"), probed.replace(/\.exe$/, ".map"));
  await expect(auditWindowsLinks(probe.installation, probe.work)).resolves.toMatchObject({
    images: 1,
  });
});

it("every library must have one known origin", async () => {
  const shadowed = await build(...dynamicCrt);
  await put(join(shadowed.work, "windows-postgresql", "kernel32.lib"), "!<arch>\n");
  await expect(auditWindowsLinks(shadowed.installation, shadowed.work)).rejects.toThrow(
    /from kernel32, which is ambiguous: .*kernel32\.lib, the build tree/,
  );
  const unknown = await build(...dynamicCrt, "mystery:helper.obj");
  await expect(auditWindowsLinks(unknown.installation, unknown.work)).rejects.toThrow(
    "links helper.obj from mystery, which found neither in LIB nor in the build",
  );
  const absent = await build(...dynamicCrt, "MSVCRT:absent.obj");
  await expect(auditWindowsLinks(absent.installation, absent.work)).rejects.toThrow(
    /absent\.obj from .*msvcrt\.lib, which has no member of that name/,
  );
});

it("a build without a recorded link environment must be rebuilt", async () => {
  const { installation, work } = await build(...dynamicCrt);
  await rm(join(work, linkEnvironmentFile));
  await expect(auditWindowsLinks(installation, work)).rejects.toThrow(
    /no link environment.*rebuild/,
  );
});

it("reads the library members of real map lines, and nothing from the section table or objects", () => {
  // From postgres.map of Build run 44832321470 (Visual Studio Enterprise 2026), before the RADIUS patch.
  const map = [
    " postgres",
    "",
    " Start         Length     Name                   Class",
    " 0001:00000000 00560a60H .text$mn                CODE",
    " 0002:00000000 00000af8H .idata$5                DATA",
    "",
    "  Address         Publics by Value              Rva+Base               Lib:Object",
    "",
    " 0000:00000000       __AbsoluteZero             0000000000000000     <absolute>",
    " 0000:00000000       __ImageBase                0000000140000000     <linker-defined>",
    " 0001:000199e0       pg_strong_random_init      000000014001a9e0 f   libpgport_srv:pg_strong_random.c.obj",
    " 0001:001e6f80       check_oauth_validator      00000001401e7f80 f   libpq_auth-oauth.c.obj",
    " 0001:0055fca0       __security_init_cookie     0000000140560ca0 f   MSVCRT:gs_support.obj",
    " 0002:000000b0       __imp_GetModuleHandleW     00000001405620b0     kernel32:KERNEL32.dll",
    " 0002:0022f208       in6addr_any                0000000140791208     ws2_32:indef.obj",
    " 0003:0005be78       __dyn_tls_init_callback    0000000140889e78     <common>",
    " 0003:0005be80       absolute_object            0000000140889e80     D:\\a\\build\\extra.obj",
    "",
    " entry point at        0001:0055fb20",
    "",
    " Static symbols",
    "",
    " 0001:00000000       _brin_begin_parallel       0000000140001000 f   access_brin_brin.c.obj",
    " 0001:00000010       _helper                    0000000140001010 f   vcruntime:d:\\crt objects\\softmemtag.obj",
    " 0005:000013e0       $R0011F0                   00000001408d03e0     win32ver.res",
  ].join("\r\n");
  expect(
    Object.fromEntries(
      [...mapContributions(map)].map(([library, members]) => [library, [...members]]),
    ),
  )
    .toEqual({
      libpgport_srv: ["pg_strong_random.c.obj"],
      MSVCRT: ["gs_support.obj"],
      kernel32: ["KERNEL32.dll"],
      ws2_32: ["indef.obj"],
      vcruntime: ["softmemtag.obj"],
    });
});

it("an archive name counts as import data only when every member of that name is", () => {
  const kinds = archiveMembers(archive([
    ["KERNEL32.dll", shortImport()],
    ["KERNEL32.dll", object(".debug$S", ".idata$2", ".idata$6")],
    ["MIXED.dll", shortImport()],
    ["MIXED.dll", object(".text$mn")],
    ["D:\\crt\\Gs_Support.obj", object(".text$mn")],
    // An anonymous object, such as one compiled for link-time code generation, is not an import record.
    ["ltcg.obj", Buffer.from([0, 0, 0xFF, 0xFF, 1, 0, 0x64, 0x86, ...Buffer.alloc(16)])],
  ]));
  expect(Object.fromEntries(kinds)).toEqual({
    "kernel32.dll": "import",
    "mixed.dll": "static",
    "gs_support.obj": "static",
    "ltcg.obj": "static",
  });
  expect(() => archiveMembers(Buffer.from("not an archive"))).toThrow(/Not a COFF archive/);
});

it("reads the link environment that build.cmd records", () => {
  const environment = parseLinkEnvironment(
    "VCToolsInstallDir=/vc/\r\nWindowsSDKVersion=10.0.26100.0\\\r\nLIB=/vc/lib/x64;/sdk/um/x64;\r\n",
  );
  expect(environment.sdkVersion).toBe("10.0.26100.0");
  expect(environment.libraryPath).toHaveLength(2);
  expect(environment.toolsetLibrary).toBe(join("/vc/", "lib", "x64"));
  expect(() => parseLinkEnvironment("LIB=/vc\r\n")).toThrow(/no VCToolsInstallDir/);
});
