/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Exercises the artifact trust boundary with altered, incomplete, unsafe, and unreviewed payloads. */
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  type ArtifactManifest,
  artifactManifestName,
  type ArtifactTarget,
  parseArtifactManifest,
  sourceComponentLicenses,
  validateArtifact,
  verifyArtifactArchive,
  writeArtifactManifest,
} from "../binaries/artifact/artifact.ts";
import {
  moduleSuffix,
  opensslLibraries,
  requiredIcuLibraries,
} from "../binaries/artifact/runtime-layout.ts";
import { sources } from "../binaries/sources/sources.ts";
import {
  createCandidate,
  hostMeasurements,
  hostRequirementsFixture,
  machOFixture,
  macOSMinimum,
  peFixture,
  remeasured,
  reviewedFixture,
  toolchainLicenses,
  toolchainParts,
} from "./candidate.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

const timescaleVersion = sources.find(source => source.id === "timescaledb")!.version;
/** Linux and macOS fixtures need executable permissions, which only a POSIX host can validate. */
const releaseTargets: ArtifactTarget[] = process.platform === "win32"
  ? ["windows-x64"]
  : ["windows-x64", "linux-x64-glibc", "macos-arm64"];
/** Every toolchain component of every target that this host can validate. */
const toolchainCases = releaseTargets.flatMap(target =>
  toolchainParts[target].map(part => ({ target, ...part }))
);
const msvcLicense = toolchainLicenses["msvc-runtime"]!;
const msvcNotice = "notices/msvc-runtime.txt";
const { directory, cleanup } = temporaryDirectories("artifact");
afterEach(cleanup);

async function fixture(
  target: ArtifactTarget = "windows-x64",
): Promise<{ root: string; manifest: ArtifactManifest }> {
  const root = await directory();
  return { root, manifest: await createCandidate(root, target) };
}

async function rewrite(root: string, manifest: ArtifactManifest): Promise<void> {
  await writeFile(join(root, artifactManifestName), JSON.stringify(manifest));
}

it("release validation rejects an obsolete measured library and retains manual prerequisites", async () => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  manifest.licenseInventory = reviewedFixture(manifest);
  const library = { ...manifest.hostRequirements.libraries[0]!, name: "obsolete.dll" };
  manifest.hostRequirements.libraries.push(library);
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).resolves.toBeDefined();
  library.measured = true;
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow("obsolete.dll");
});

it.skipIf(process.platform === "win32")("requires compiler-rt's licence on Linux", async () => {
  const { root, manifest } = await fixture("linux-x64-glibc");
  manifest.hostRequirements = hostRequirementsFixture("linux-x64-glibc");
  manifest.licenseInventory = reviewedFixture(manifest);
  manifest.licenseInventory.components.find(component => component.id === "compiler-rt")!.licenses =
    ["MIT"];
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "linux-x64-glibc")).rejects.toThrow(
    "must carry Apache-2.0 WITH LLVM-exception",
  );
});

it.skipIf(process.platform === "win32")("requires owner execute access to core programs",
  async () => {
    const { root } = await fixture("linux-x64-glibc");
    await chmod(join(root, "bin/postgres"), 0o645);
    await expect(validateArtifact(root, "linux-x64-glibc", { mode: "candidate" })).rejects.toThrow(
      /executable|permission/,
    );
  });

it("candidate metadata records portable executables and real control/SQL version paths", async () => {
  const { root, manifest } = await fixture();
  const result = await validateArtifact(root, "windows-x64", { mode: "candidate" });
  expect(result.executables.postgres).toBe("bin/postgres.exe");
  expect(result.extensions.find(extension => extension.name === "pg_cron")?.version).toBe("1.6");
  expect(result.extensions.find(extension => extension.name === "pg_cron")?.sql).toHaveLength(2);
  expect(result.licenseInventory.status).toBe("pending");
  expect(manifest.formatVersion).toBe(1);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "license inventory is unresolved",
  );
  await expect(validateArtifact(root, "linux-x64-glibc", { mode: "candidate" })).rejects.toThrow(
    "wrong target",
  );
});

it.each(releaseTargets)("%s checks TLS libraries and their coverage when OpenSSL is pinned",
  async target => {
    const { root, manifest } = await fixture(target);
    const withoutOpenSsl = manifest.sources.filter(source => source.id !== "openssl");
    await rewrite(root, { ...manifest, sources: withoutOpenSsl });
    await expect(validateArtifact(root, target, { mode: "candidate" })).rejects.toThrow(
      "missing OpenSSL source",
    );
    manifest.hostRequirements = hostRequirementsFixture(target);
    manifest.licenseInventory = reviewedFixture(manifest);
    const component = manifest.licenseInventory.components.find(part => part.id === "openssl")!;
    const [ssl, crypto] = opensslLibraries(target);
    component.files = component.files.filter(path => path !== ssl);
    manifest.licenseInventory.components.find(part => part.id === "postgresql")!.files.push(ssl!);
    await rewrite(root, manifest);
    await expect(validateArtifact(root, target)).rejects.toThrow(
      "missing license coverage for openssl: " + ssl,
    );

    // Keep the inventory in sync so the layout check sees the missing library.
    await rm(join(root, crypto!));
    manifest.files = manifest.files.filter(file => file.path !== crypto);
    await rewrite(root, manifest);
    await expect(validateArtifact(root, target, { mode: "candidate" })).rejects.toThrow(
      "missing OpenSSL runtime library: " + crypto,
    );

    // Format-1 archives built before TLS have neither the source nor any of its payload.
    const remaining = new Set([ssl!, ...component.notices]);
    for (const path of remaining) await rm(join(root, path));
    manifest.files = manifest.files.filter(file => !remaining.has(file.path));
    manifest.sources = withoutOpenSsl;
    manifest.licenseInventory = reviewedFixture(manifest);
    await rewrite(root, manifest);
    await expect(validateArtifact(root, target)).resolves.toBeDefined();
  });

it.each(releaseTargets)("%s requires the complete ICU runtime and its source ownership",
  async target => {
    const { root, manifest } = await fixture(target);
    const withoutIcu = manifest.sources.filter(source => source.id !== "icu");
    // ICU is mandatory; an unrelated source cannot satisfy the requirement by restoring the count.
    for (const inputs of [withoutIcu, [...withoutIcu, { ...withoutIcu[0]!, id: "unrelated" }]]) {
      expect.soft(() => parseArtifactManifest(JSON.stringify({ ...manifest, sources: inputs })))
        .toThrow(/missing source: icu|expected all ten source inputs/);
    }
    manifest.hostRequirements = hostRequirementsFixture(target);
    manifest.licenseInventory = reviewedFixture(manifest);
    const icu = manifest.licenseInventory.components.find(component => component.id === "icu")!;
    const path = requiredIcuLibraries(target,
      sources.find(source => source.id === "icu")!.version)[0]!;
    icu.files = icu.files.filter(file => file !== path);
    // Another source's coverage must never substitute for the component that built ICU.
    manifest.licenseInventory.components.find(component => component.id === "postgresql")!.files
      .push(path);
    await rewrite(root, manifest);
    await expect(validateArtifact(root, target)).rejects.toThrow(
      "missing license coverage for icu: " + path,
    );
    await rm(join(root, path));
    await rm(join(root, artifactManifestName));
    await expect(writeArtifactManifest(root, {
      target,
      packagingRevision: 2,
      hostEvidence: manifest.hostEvidence,
    })).rejects.toThrow(
      "missing ICU runtime library: " + path,
    );
  });

it.each([
  "lib/vector.dll",
  "bin/libpq.dll",
  "share/extension/pgtap.control",
  "share/extension/pg_cron--1.0--1.6.sql",
  "notices/timescaledb-NOTICE",
])(
  "rejects a missing runtime dependency or required payload: %s",
  async path => {
    const { root } = await fixture();
    await rm(join(root, path));
    await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).rejects.toThrow();
  },
);

it.each(releaseTargets.filter(target => target !== "macos-arm64"))(
  "%s refuses executable code disguised as ICU locale data",
  async target => {
    const { root, manifest } = await fixture(target);
    const path = requiredIcuLibraries(target,
      sources.find(source => source.id === "icu")!.version)[2]!;
    const image = await readFile(join(root, path));
    image.writeUInt32LE(target === "windows-x64" ? 0x60_00_00_20 : 5,
      target === "windows-x64" ? 364 : 68);
    await writeFile(join(root, path), image);
    await rm(join(root, artifactManifestName));
    await expect(
      writeArtifactManifest(root, {
        target,
        packagingRevision: 2,
        hostEvidence: manifest.hostEvidence,
      }),
    )
      .rejects.toThrow("ICU data library contains executable code: " + path);
  },
);

it("detects modified bytes and foreign architecture even when metadata is rewritten", async () => {
  const { root, manifest } = await fixture();
  await writeFile(join(root, "lib/vector.dll"), "altered");
  await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).rejects.toThrow(
    "inventory/hash",
  );
  const foreign = peFixture();
  foreign.writeUInt16LE(0xAA_64, 68);
  // Restore the library so architecture rejection is independent of the earlier integrity failure.
  await writeFile(join(root, "lib/vector.dll"), peFixture());
  await writeFile(join(root, "bin/postgres.exe"), foreign);
  manifest.files = manifest.files.map(file =>
    file.kind === "file" && file.path === "bin/postgres.exe"
      ? { ...file, sha256: createHash("sha256").update(foreign).digest("hex") }
      : file
  );
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).rejects.toThrow(
    "Windows x64",
  );
});

it.each([
  "lib/timescaledb-tsl-" + timescaleVersion + ".dll",
  "lib/pg_partman_bgw.dll",
  "bin/pg_prove",
  "lib/pgxs/Makefile",
  "bin/helper.py",
  "bin/test_cloexec.exe",
  "bin/vacuumlo.exe",
  "lib/pg_trgm.dll",
  "share/extension/pg_trgm.control",
  "share/extension/pg_stat_statements--1.0.sql",
  "share/tsearch_data/unaccent.rules",
])(
  "rejects excluded components even when the manifest could be regenerated: %s",
  async path => {
    const { root } = await fixture();
    await rm(join(root, artifactManifestName));
    const parts = path.split("/");
    await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(root, path), "excluded");
    await expect(
      writeArtifactManifest(root, {
        target: "windows-x64",
        packagingRevision: 1,
        hostEvidence: [],
      }),
    )
      .rejects.toThrow(/excluded/);
  },
);

it.each(["lib/vector.dll", "lib/timescaledb-" + timescaleVersion + ".dll", "bin/libpq.dll"])(
  "rejects a wrong-architecture shared library despite a matching inventory hash: %s",
  async path => {
    const { root, manifest } = await fixture();
    const foreign = peFixture();
    foreign.writeUInt16LE(0x1_4C, 68);
    await writeFile(join(root, path), foreign);
    manifest.files = manifest.files.map(file =>
      file.kind === "file" && file.path === path
        ? { ...file, sha256: createHash("sha256").update(foreign).digest("hex") }
        : file
    );
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).rejects.toThrow(
      "Windows x64 PE image",
    );
  },
);

it("JSON object field ordering does not affect portable validation and an unknown mode cannot bypass release checks", async () => {
  const { root, manifest } = await fixture();
  manifest.files = manifest.files.map(file =>
    Object.fromEntries(Object.entries(file).toReversed()) as typeof file
  );
  manifest.extensions = manifest.extensions.map(extension =>
    Object.fromEntries(Object.entries(extension).toReversed()) as typeof extension
  );
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).resolves.toMatchObject(
    { formatVersion: 1 },
  );
  await expect(validateArtifact(root, "windows-x64", { mode: "relase" as "release" })).rejects
    .toThrow("invalid validation mode");
});

it("rejects traversal, drive paths, and case collisions in artifact paths", async () => {
  const { root, manifest } = await fixture();
  for (const path of [
    "../escape",
    "C:/outside",
    "bin/CON.txt",
    "bin/alternate:stream",
    "bin/trailing.",
  ]) {
    const changed = structuredClone(manifest);
    changed.files[0]!.path = path;
    await rewrite(root, changed);
    await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).rejects.toThrow(
      /unsafe|reserved|relative/,
    );
  }
  await rewrite(root, manifest);
  // Notice names allow both spellings individually, so this exercises the collision check itself.
  await writeFile(join(root, "notices/Timescaledb.txt"), "collision");
  // A case-insensitive volume overwrites the existing file instead, which must fail integrity validation.
  // The volume decides, not the OS: macOS volumes are case-insensitive by default, and a Windows directory
  // can be case-sensitive. So the directory entries choose the expected error.
  const names = await readdir(join(root, "notices"));
  await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).rejects.toThrow(
    names.includes("Timescaledb.txt") && names.includes("timescaledb.txt")
      ? "case-colliding path: notices/"
      : "payload inventory/hash/permission mismatch",
  );
});

it(
  "release validation rejects unreviewed coverage, missing host prerequisites, GPL, and unknown licenses",
  async () => {
    const { root, manifest } = await fixture();
    manifest.licenseInventory = reviewedFixture(manifest);
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
      "host requirements are unresolved",
    );
    manifest.hostRequirements = hostRequirementsFixture();
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "windows-x64")).resolves.toMatchObject({
      formatVersion: 1,
    });
    // A reviewed binary can contain contributions from both its source and its compiler runtime.
    manifest.licenseInventory.components.push({
      id: "compiler-rt",
      licenses: ["Apache-2.0 WITH LLVM-exception"],
      status: "verified",
      evidence: ["Owned contract-test fixture"],
      files: ["lib/vector.dll"],
      notices: [],
      noticeSha256: {},
    });
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "windows-x64")).resolves.toMatchObject({
      formatVersion: 1,
    });
    for (
      const license of ["GPL-3.0-or-later WITH GCC-exception-3.1", "AGPL-3.0-only", "Unresolved"]
    ) {
      manifest.licenseInventory.components[0]!.licenses = [license];
      await rewrite(root, manifest);
      await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
        /forbidden|unresolved|unapproved/,
      );
    }
    manifest.licenseInventory = reviewedFixture(manifest);
    manifest.hostRequirements.libraries[0]!.license = "Unresolved";
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
      "unresolved host library license",
    );
    manifest.hostRequirements.libraries[0]!.license = "LicenseRef-Microsoft-Windows";
    manifest.licenseInventory.components[0]!.files.pop();
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "windows-x64")).rejects.toThrow("unreviewed payload file");
  },
);

it.each(toolchainCases)(
  "release validation requires the $target toolchain component $id on every native image",
  async ({ target, id }) => {
    const { root, manifest } = await fixture(target);
    manifest.hostRequirements = hostRequirementsFixture(target);
    manifest.licenseInventory = reviewedFixture(manifest);
    await rewrite(root, manifest);
    await expect(validateArtifact(root, target)).resolves.toMatchObject({ target });

    // Another component still covers the image, so only the toolchain rule can notice the gap.
    const toolchain = manifest.licenseInventory.components.find(component => component.id === id)!;
    const omitted = toolchain.files.pop()!;
    await rewrite(root, manifest);
    await expect(validateArtifact(root, target)).rejects.toThrow(
      "missing toolchain coverage for " + id + ": " + omitted,
    );

    manifest.licenseInventory.components = manifest.licenseInventory.components.filter(
      component => component.id !== id,
    );
    await rewrite(root, manifest);
    await expect(validateArtifact(root, target)).rejects.toThrow(
      "unreviewed toolchain component: " + id,
    );
  },
);

it("release validation rejects a licence notice that changed since its review", async () => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  manifest.licenseInventory = reviewedFixture(manifest);
  const pgvector = manifest.licenseInventory.components.find(component =>
    component.id === "pgvector"
  )!;
  // The review read an older licence text than the one this build ships, as after a source update.
  pgvector.noticeSha256["notices/pgvector.txt"] = "0".repeat(64);
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "license notice changed since review: pgvector: notices/pgvector.txt",
  );
  delete pgvector.noticeSha256["notices/pgvector.txt"];
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "license notice changed since review: pgvector: notices/pgvector.txt",
  );
});

it.each(toolchainCases)(
  "release validation binds the $target toolchain review of $id to the line it was built with",
  async ({ target, id, evidence }) => {
    const { root, manifest } = await fixture(target);
    manifest.hostRequirements = hostRequirementsFixture(target);
    manifest.licenseInventory = reviewedFixture(manifest);
    const toolchain = manifest.licenseInventory.components.find(component => component.id === id)!;
    const built = toolchain.toolchain!;
    toolchain.toolchain = "fixture-0";
    await rewrite(root, manifest);
    await expect(validateArtifact(root, target)).rejects.toThrow(
      "toolchain changed since review: " + id + " was reviewed for fixture-0, built with " + built,
    );

    toolchain.toolchain = built;
    manifest.hostEvidence = manifest.hostEvidence.filter(entry => entry.component !== evidence);
    await rewrite(root, manifest);
    await expect(validateArtifact(root, target)).rejects.toThrow(
      "missing toolchain evidence: " + evidence,
    );
  },
);

it("the glibc startup licence is admitted only for its Linux toolchain component", async () => {
  const startupLicense = toolchainLicenses["glibc-startup"]!;
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  manifest.licenseInventory = reviewedFixture(manifest);
  manifest.licenseInventory.components.find(component => component.id === "postgresql")!
    .licenses = [startupLicense];
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "unresolved or unapproved license: " + startupLicense,
  );
  // The component name alone does not admit it where glibc's startup code is not a toolchain part.
  manifest.licenseInventory = reviewedFixture(manifest);
  manifest.licenseInventory.components.push({
    id: "glibc-startup",
    licenses: [startupLicense],
    status: "verified",
    evidence: ["Owned contract-test fixture"],
    files: ["lib/vector.dll"],
    notices: [],
    noticeSha256: {},
  });
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "unresolved or unapproved license: " + startupLicense,
  );
});

it.skipIf(process.platform === "win32")(
  "the glibc startup licence is rejected on the other Linux toolchain component",
  async () => {
    const { root, manifest } = await fixture("linux-x64-glibc");
    manifest.hostRequirements = hostRequirementsFixture("linux-x64-glibc");
    manifest.licenseInventory = reviewedFixture(manifest);
    manifest.licenseInventory.components.find(component => component.id === "compiler-rt")!
      .licenses = [toolchainLicenses["glibc-startup"]!];
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "linux-x64-glibc")).rejects.toThrow(
      "unresolved or unapproved license",
    );
  },
);

it.skipIf(process.platform === "win32")(
  "the glibc startup review must carry the glibc linking exception",
  async () => {
    const { root, manifest } = await fixture("linux-x64-glibc");
    manifest.hostRequirements = hostRequirementsFixture("linux-x64-glibc");
    manifest.licenseInventory = reviewedFixture(manifest);
    // A permitted licence alone would describe glibc's startup code wrongly.
    manifest.licenseInventory.components.find(component => component.id === "glibc-startup")!
      .licenses = ["MIT"];
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "linux-x64-glibc")).rejects.toThrow(
      "toolchain component glibc-startup must carry " + toolchainLicenses["glibc-startup"],
    );
    // The Visual Studio identifier describes no Linux code.
    manifest.licenseInventory = reviewedFixture(manifest);
    manifest.licenseInventory.components.find(component => component.id === "postgresql")!
      .licenses = [msvcLicense];
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "linux-x64-glibc")).rejects.toThrow(
      "unresolved or unapproved license: " + msvcLicense,
    );
  },
);

it("the Visual Studio identifier is required on the Windows runtime component and admitted nowhere else", async () => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  manifest.licenseInventory = reviewedFixture(manifest);
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).resolves.toMatchObject({ formatVersion: 1 });

  // A permitted licence on the runtime component passes every other rule, so only this one notices it.
  const runtime = manifest.licenseInventory.components.find(component =>
    component.id === "msvc-runtime"
  )!;
  runtime.licenses = ["MIT"];
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "toolchain component msvc-runtime must carry " + msvcLicense,
  );

  manifest.licenseInventory = reviewedFixture(manifest);
  manifest.licenseInventory.components.find(component => component.id === "postgresql")!
    .licenses = [msvcLicense];
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "unresolved or unapproved license: " + msvcLicense,
  );
});

it.each([
  [
    "an unreviewed product line",
    "Visual Studio product line",
    "19",
    "Visual Studio product line 19 has no reviewed licence terms",
  ],
  [
    "Build Tools alone",
    "Visual Studio edition",
    "Microsoft.VisualStudio.Product.BuildTools",
    "Visual Studio edition Microsoft.VisualStudio.Product.BuildTools is not admitted for releases",
  ],
  [
    "an unknown product",
    "Visual Studio edition",
    "Microsoft.VisualStudio.Product.Unknown",
    "Visual Studio edition Microsoft.VisualStudio.Product.Unknown is not admitted for releases",
  ],
  [
    "no edition evidence",
    "Visual Studio edition",
    undefined,
    "missing toolchain evidence: Visual Studio edition",
  ],
])(
  "release validation refuses a Windows build with %s",
  async (_name, component, version, message) => {
    const { root, manifest } = await fixture();
    manifest.hostRequirements = hostRequirementsFixture();
    manifest.licenseInventory = reviewedFixture(manifest);
    manifest.hostEvidence = manifest.hostEvidence.flatMap(entry =>
      entry.component === component ? version === undefined ? [] : [{ ...entry, version }] : [entry]
    );
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(message);
  },
);

it("release validation binds the Windows runtime review to the project's notice for that code", async () => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  const runtime = () =>
    manifest.licenseInventory.components.find(component => component.id === "msvc-runtime")!;

  manifest.licenseInventory = reviewedFixture(manifest);
  runtime().noticeSha256[msvcNotice] = "0".repeat(64);
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "license notice changed since review: msvc-runtime: " + msvcNotice,
  );

  manifest.licenseInventory = reviewedFixture(manifest);
  runtime().files = runtime().files.filter(file => file !== msvcNotice);
  runtime().notices = [];
  runtime().noticeSha256 = {};
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "missing toolchain notice for msvc-runtime: " + msvcNotice,
  );

  // The runtime licence describes only the linked code and its notice, not another source's files.
  manifest.licenseInventory = reviewedFixture(manifest);
  runtime().files.push("notices/pgvector.txt");
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "toolchain component msvc-runtime covers a file that is not a native image: notices/pgvector.txt",
  );
});

it("candidate validation requires the toolchain notice that a Windows archive ships", async () => {
  const { root, manifest } = await fixture();
  await rm(join(root, msvcNotice));
  manifest.files = manifest.files.filter(file => file.path !== msvcNotice);
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).rejects.toThrow(
    "missing toolchain notice: " + msvcNotice,
  );
});

it.each(releaseTargets.map(target => ({
  target,
  measurement: hostMeasurements[target].component,
})))(
  "release validation refuses a $target build without the $measurement measurement",
  async ({ target, measurement }) => {
    const { root, manifest } = await fixture(target);
    manifest.hostRequirements = hostRequirementsFixture(target);
    manifest.licenseInventory = reviewedFixture(manifest);
    // Without the measurement the reviewed prerequisites could not be compared with what the build needs.
    manifest.hostEvidence = manifest.hostEvidence.filter(entry => entry.component !== measurement);
    await rewrite(root, manifest);
    await expect(validateArtifact(root, target)).rejects.toThrow(
      "missing host measurement: " + measurement,
    );
  },
);

it("release validation requires a reviewed entry for every host library the build imports", async () => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  manifest.licenseInventory = reviewedFixture(manifest);
  // A source update starts to import a new system DLL that the tracked review does not list.
  manifest.hostEvidence = remeasured(
    manifest.hostEvidence,
    "windows-x64",
    "secur32.dll, vcruntime140.dll",
  );
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "unresolved host library prerequisite: secur32.dll",
  );
  manifest.hostRequirements.libraries.push({
    name: "secur32.dll",
    requirement: "fixture",
    license: "LicenseRef-Microsoft-Windows",
    evidence: "fixture",
  });
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).resolves.toMatchObject({ formatVersion: 1 });
});

it("release validation refuses a second entry for a host library under another casing", async () => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  manifest.licenseInventory = reviewedFixture(manifest);
  // The gate matches names case-insensitively, so it would check only the first and publish both.
  manifest.hostRequirements.libraries.push({
    name: "VCRUNTIME140.DLL",
    requirement: "a contradicting requirement",
    license: "LicenseRef-Microsoft-Windows",
    evidence: "fixture",
  });
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "duplicate host library: VCRUNTIME140.DLL",
  );
});

it("release validation refuses a second component under one ID", async () => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  manifest.licenseInventory = reviewedFixture(manifest);
  const pgvector = manifest.licenseInventory.components.find(component =>
    component.id === "pgvector"
  )!;
  manifest.licenseInventory.components.push({ ...pgvector, evidence: ["another review"] });
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "duplicate license component: pgvector",
  );
});

it.skipIf(process.platform === "win32")(
  "release validation requires the reviewed glibc requirement to match the measured one",
  async () => {
    const { root, manifest } = await fixture("linux-x64-glibc");
    manifest.hostRequirements = hostRequirementsFixture("linux-x64-glibc");
    manifest.licenseInventory = reviewedFixture(manifest);
    // A source update starts to use a newer glibc symbol than the tracked review states.
    manifest.hostEvidence = remeasured(manifest.hostEvidence, "linux-x64-glibc", "GLIBC_2.38");
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "linux-x64-glibc")).rejects.toThrow(
      "host requirement changed since review: glibc requires GLIBC_2.38 or newer",
    );
    manifest.hostRequirements.libraries[0]!.requirement = "GLIBC_2.38 or newer";
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "linux-x64-glibc")).resolves.toMatchObject({
      formatVersion: 1,
    });
  },
);

it.skipIf(process.platform === "win32")(
  "a relative link to a payload file is recorded as a link, not as a second image",
  async () => {
    const root = await directory();
    const manifest = await createCandidate(root, "linux-x64-glibc", {
      links: { "lib/libpq.so": "libpq.so.5" },
    });
    expect(manifest.files).toContainEqual({
      path: "lib/libpq.so",
      kind: "symlink",
      target: "libpq.so.5",
    });
    manifest.hostRequirements = hostRequirementsFixture("linux-x64-glibc");
    manifest.licenseInventory = reviewedFixture(manifest);
    await rewrite(root, manifest);
    // The toolchain components cover the link target; the link itself is not an image.
    await expect(validateArtifact(root, "linux-x64-glibc")).resolves.toMatchObject({
      formatVersion: 1,
    });
    manifest.licenseInventory.components[0]!.notices.push("lib/libpq.so");
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "linux-x64-glibc")).rejects.toThrow("lib/libpq.so");
  },
);

it.skipIf(process.platform === "win32").each([
  ["an absolute link", "/etc/passwd", "unsafe link"],
  ["a chained link", "libpq.so.5.18", "links must resolve directly to files"],
  ["a link to a directory", "../share", "links must resolve directly to files"],
  ["a dangling link", "missing.so", "ENOENT"],
])("candidate validation rejects %s", async (_name, target, message) => {
  const { root } = await fixture("linux-x64-glibc");
  // A valid intermediate link, so that the chained case points at a link rather than a file.
  await symlink("libpq.so.5", join(root, "lib/libpq.so.5.18"));
  await symlink(target, join(root, "lib/libpq.so"));
  await expect(validateArtifact(root, "linux-x64-glibc", { mode: "candidate" })).rejects.toThrow(
    message,
  );
});

it.each([
  "lib/vector.dll",
  "share/extension/vector.control",
  "share/extension/pg_cron--1.0--1.6.sql",
])("release validation rejects an extension file credited only to PostgreSQL: %s", async path => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  manifest.licenseInventory = reviewedFixture(manifest);
  const sourceId = path.includes("pg_cron") ? "pg_cron" : "pgvector";
  const extension = manifest.licenseInventory.components.find(component =>
    component.id === sourceId
  )!;
  const postgres = manifest.licenseInventory.components.find(component =>
    component.id === "postgresql"
  )!;
  extension.files = extension.files.filter(file => file !== path);
  // The inventory still covers every payload path, but this source component omits its own file.
  postgres.files.push(path);
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "missing license coverage for " + sourceId + ": " + path,
  );
});

it.each(["bundled-code", "pgvector"])(
  "release validation requires each native image on the component of the source that built it, not %s",
  async credited => {
    const { root, manifest } = await fixture();
    manifest.hostRequirements = hostRequirementsFixture();
    manifest.licenseInventory = reviewedFixture(manifest);
    const components = manifest.licenseInventory.components;
    const postgres = components.find(component => component.id === "postgresql")!;
    postgres.files = postgres.files.filter(file => file !== "bin/postgres.exe");
    // The runtime component and the credited component still cover the image, but neither built it.
    const source = components.find(component => component.id === credited);
    if (source) source.files.push("bin/postgres.exe");
    else {
      components.push({
        id: credited,
        licenses: ["MIT"],
        status: "verified",
        evidence: ["Owned contract-test fixture"],
        files: ["bin/postgres.exe"],
        notices: [],
        noticeSha256: {},
      });
    }
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
      "missing license coverage for postgresql: bin/postgres.exe",
    );
  },
);

it.each([
  ["DEL", "\u007F"],
  ["a C1 control character", "\u0085"],
])("candidate validation refuses a path with %s, as release validation does",
  async (_, character) => {
    const root = await directory();
    await expect(
      createCandidate(root, "windows-x64", {
        files: { [`share/odd${character}name.txt`]: "fixture" },
      }),
    ).rejects.toThrow("unsafe path: share/odd");
  });

it("candidate validation requires a boolean measured flag on a host library", async () => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  // A string would pass for a library that a reviewer added, which the review merge keeps.
  Object.assign(manifest.hostRequirements.libraries[0]!, { measured: "true" });
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).rejects.toThrow(
    "invalid measured flag: vcruntime140.dll",
  );
});

it("release validation requires notices on their source component", async () => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  manifest.licenseInventory = reviewedFixture(manifest);
  const source = manifest.licenseInventory.components.find(component =>
    component.id === "timescaledb"
  )!;
  source.notices = source.notices.filter(path => path !== "notices/timescaledb-NOTICE");
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "missing license notice for timescaledb: notices/timescaledb-NOTICE",
  );
});

it("rejects an archive digest mismatch before metadata is trusted", async () => {
  const { root } = await fixture();
  const archive = join(root, "test.archive");
  await writeFile(archive, "trusted archive fixture");
  const expected = createHash("sha256").update(await readFile(archive)).digest("hex");
  await verifyArtifactArchive(archive, expected);
  await writeFile(archive, "changed");
  await expect(verifyArtifactArchive(archive, expected)).rejects.toThrow("archive integrity");
});

it.each([
  [artifactManifestName, "hard-linked file: " + artifactManifestName],
  ["bin/postgres.exe", "special or hard-linked file: bin/postgres.exe"],
])("candidate validation rejects a hard link to %s", async (path, message) => {
  const { root } = await fixture();
  // A second name outside the installation could change the file after validation.
  const outside = await directory("outside");
  await link(join(root, path), join(outside, "copy"));
  await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).rejects.toThrow(
    message,
  );
});

it("requires core programs in a regenerated Windows artifact", async () => {
  const { root } = await fixture();
  await rm(join(root, artifactManifestName));
  await rm(join(root, "bin/ecpg.exe"));
  await expect(writeArtifactManifest(root, {
    target: "windows-x64",
    packagingRevision: 1,
    hostEvidence: [],
  })).rejects.toThrow("nonexecutable program: bin/ecpg.exe");
});

it.each(releaseTargets)(
  "a %s candidate requires the encoding conversion modules that PostgreSQL always builds",
  async target => {
    const { root } = await fixture(target);
    await rm(join(root, artifactManifestName));
    // Without it, a UTF-8 server cannot convert for a client that uses a Windows code page.
    const module = "lib/utf8_and_win" + moduleSuffix(target);
    await rm(join(root, module));
    await expect(writeArtifactManifest(root, {
      target,
      packagingRevision: 1,
      hostEvidence: [],
    })).rejects.toThrow("missing library: " + module);
  },
);

it("does not accept a directory as an extension SQL file", async () => {
  const { root } = await fixture();
  await rm(join(root, artifactManifestName));
  const sql = "share/extension/pg_cron--1.0.sql";
  await rm(join(root, sql));
  await mkdir(join(root, sql));
  await expect(writeArtifactManifest(root, {
    target: "windows-x64",
    packagingRevision: 1,
    hostEvidence: [],
  })).rejects.toThrow("unexpected runtime directory: " + sql);
});

it.skipIf(process.platform !== "win32")(
  "rejects Linux validation on Windows before attempting to read file modes",
  async () => {
    const { root, manifest } = await fixture();
    manifest.target = "linux-x64-glibc";
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "linux-x64-glibc", { mode: "candidate" }))
      .rejects.toThrow("requires a POSIX host");
    await expect(writeArtifactManifest(root, {
      target: "linux-x64-glibc",
      packagingRevision: 1,
      hostEvidence: [],
    })).rejects.toThrow("requires a POSIX host");
  },
);

it.skipIf(process.platform === "win32")(
  "rejects escaping links and writable POSIX metadata or payload directories",
  async () => {
    const { root } = await fixture("linux-x64-glibc");
    await chmod(join(root, artifactManifestName), 0o666);
    await expect(validateArtifact(root, "linux-x64-glibc", { mode: "candidate" })).rejects.toThrow(
      "writable metadata",
    );
    await rm(join(root, artifactManifestName));
    await symlink("../../outside", join(root, "lib/libpq.so"));
    await expect(
      writeArtifactManifest(root, {
        target: "linux-x64-glibc",
        packagingRevision: 1,
        hostEvidence: [],
      }),
    )
      .rejects.toThrow("unsafe path");
    await rm(join(root, "lib/libpq.so"));
    await chmod(join(root, "lib"), 0o777);
    await expect(
      writeArtifactManifest(root, {
        target: "linux-x64-glibc",
        packagingRevision: 1,
        hostEvidence: [],
      }),
    )
      .rejects.toThrow("writable directory");
  },
);

it.skipIf(process.platform === "win32").each([
  ["bin/postgres", 0o4755],
  ["bin/postgres", 0o2755],
  ["lib", 0o2755],
  [artifactManifestName, 0o4644],
])("rejects setuid or setgid permissions on Linux %s (mode %i)", async (path, mode) => {
  const { root } = await fixture("linux-x64-glibc");
  await chmod(join(root, path), mode);
  await expect(validateArtifact(root, "linux-x64-glibc", { mode: "candidate" })).rejects.toThrow(
    "setuid or setgid",
  );
});

it.skipIf(process.platform === "win32")(
  "writes a readable manifest under a restrictive umask and rejects an unreadable one",
  async () => {
    // A builder with umask 077 must not ship a manifest that other users cannot read.
    const previous = process.umask(0o077);
    let root: string;
    try {
      ({ root } = await fixture("linux-x64-glibc"));
    } finally {
      process.umask(previous);
    }
    expect((await stat(join(root, artifactManifestName))).mode & 0o777).toBe(0o644);
    await chmod(join(root, artifactManifestName), 0o600);
    await expect(validateArtifact(root, "linux-x64-glibc", { mode: "candidate" })).rejects.toThrow(
      "unreadable metadata",
    );
  },
);

it.each([
  ["a 32-bit PE image", () => {
    const image = peFixture();
    image.writeUInt16LE(0x1_4C, 68);
    return image;
  }],
  ["an ELF image", () => {
    const image = Buffer.alloc(64);
    image.set([127, 69, 76, 70, 2, 1]);
    image.writeUInt16LE(62, 18);
    return image;
  }],
])("rejects %s hidden under a name that does not look native", async (_name, image) => {
  const { root } = await fixture();
  await rm(join(root, artifactManifestName));
  // Discovery by file name alone would let this payload file escape the architecture check.
  // Time zone data is accepted by directory, so any file name there passes the payload layout check.
  await mkdir(join(root, "share/timezone"), { recursive: true });
  await writeFile(join(root, "share/timezone/Helper"), image());
  await expect(
    writeArtifactManifest(root, { target: "windows-x64", packagingRevision: 1, hostEvidence: [] }),
  ).rejects.toThrow("expected a Windows x64 PE image: share/timezone/Helper");
});

it("a source component's scoped licences are required on it and admitted nowhere else", async () => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  manifest.licenseInventory = reviewedFixture(manifest);
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).resolves.toMatchObject({ formatVersion: 1 });
  const component = (id: string) =>
    manifest.licenseInventory.components.find(candidate => candidate.id === id)!;

  // Omitted: the reviewed code ships in every build, so its licence must be named.
  component("pg_cron").licenses = component("pg_cron").licenses.filter(license =>
    license !== "Vixie-Cron"
  );
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "source component pg_cron must carry Vixie-Cron",
  );
  // Substituted by a permitted licence, which every other rule would accept.
  manifest.licenseInventory = reviewedFixture(manifest);
  component("postgresql").licenses = ["MIT"];
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "source component postgresql must carry " + sourceComponentLicenses.get("postgresql")![0],
  );
  // On another component.
  manifest.licenseInventory = reviewedFixture(manifest);
  component("pgvector").licenses.push("Spencer-99");
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "unresolved or unapproved license: Spencer-99",
  );
  // As a host licence.
  manifest.licenseInventory = reviewedFixture(manifest);
  manifest.hostRequirements.libraries[0]!.license = "BSL-1.0";
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "unresolved host library license: BSL-1.0",
  );
});

it("a release needs each source tree's notice scan and a review that covers all of it", async () => {
  const { root, manifest } = await fixture();
  manifest.hostRequirements = hostRequirementsFixture();
  manifest.licenseInventory = reviewedFixture(manifest);
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).resolves.toMatchObject({ formatVersion: 1 });
  const source = (id: string) => manifest.sources.find(candidate => candidate.id === id)!;
  const component = (id: string) =>
    manifest.licenseInventory.components.find(candidate => candidate.id === id)!;

  // HypoPG's SQL and C notices differ only in the capitalization of "license".
  const cNotice = "This program is open source, licensed under the PostgreSQL license."
    + " | For license terms, see the LICENSE file. | Copyright (C) YYYY: Julien Rouhaud";
  const sqlNotice = cNotice.replace("PostgreSQL license", "PostgreSQL License");
  const examples = [
    { signature: sqlNotice, files: ["a.sql", "b.sql", "hypopg--1.3.1.sql"] },
    { signature: cNotice, files: ["hypopg.c"] },
  ];
  source("hypopg").noticeSignatures = examples;
  component("hypopg").noticeSignatures = [cNotice, sqlNotice];
  await rewrite(root, manifest);
  const parsed = await validateArtifact(root, "windows-x64");
  expect(parsed.sources.find(entry => entry.id === "hypopg")?.noticeSignatures).toEqual(examples);
  examples[0]!.files.push("fourth.sql");
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).rejects.toThrow(
    "at most three example paths",
  );
  examples[0]!.files.pop();
  examples.push({ signature: cNotice, files: ["include/hypopg.h"] });
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow("duplicate notice signature");
  examples.pop();

  // Text that the review has not seen, such as one that a source update brought.
  source("postgresql").noticeSignatures!.push({
    signature: "Copyright (c) YYYY Newcomer",
    files: ["src/new.c"],
  });
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "reviewed notice signatures differ from the source tree: postgresql",
  );
  // Covered once the review lists it, in any order.
  component("postgresql").noticeSignatures!.unshift("Copyright (c) YYYY Newcomer");
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).resolves.toMatchObject({ formatVersion: 1 });

  // Without a scan, nothing shows that no new licence text arrived, even when the review lists none either.
  delete source("pgvector").noticeSignatures;
  component("pgvector").noticeSignatures = [];
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "missing notice scan for source: pgvector",
  );

  source("pgvector").noticeSignatures = [];
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).resolves.toBeDefined();
  delete component("pgvector").noticeSignatures;
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64")).rejects.toThrow(
    "reviewed notice signatures differ from the source tree: pgvector",
  );
});

it("a candidate ships every project notice with the bytes that its pin names", async () => {
  const postgresql = sources.find(source => source.id === "postgresql")!;
  const [notice] = "projectNotices" in postgresql ? postgresql.projectNotices : [];
  expect(notice, "PostgreSQL pins project notices").toBeDefined();
  const path = "notices/postgresql-" + notice!.file;
  const changed = await directory();
  await expect(createCandidate(changed, "windows-x64", { files: { [path]: "edited text" } }))
    .rejects.toThrow("project notice differs from its pin: " + path);
  const missing = await directory();
  await expect(createCandidate(missing, "windows-x64", { remove: [path] }))
    .rejects.toThrow("missing source notice: " + path);

  const { root, manifest } = await fixture();
  const pg = manifest.sources.find(source => source.id === "postgresql")!;
  // Another packaging of the same upstream release can carry a different reviewed notice.
  const earlier = "Earlier pinned text";
  const digest = createHash("sha256").update(earlier).digest("hex");
  await writeFile(join(root, path), earlier);
  pg.projectNotices = pg.projectNotices!.map(pin =>
    pin.file === notice!.file ? { ...pin, sha256: digest } : pin
  );
  const entry = manifest.files.find(file => file.path === path)!;
  if (entry.kind !== "file") throw new Error("Expected a regular notice");
  entry.sha256 = digest;
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).resolves.toBeDefined();
  delete pg.projectNotices;
  await rewrite(root, manifest);
  await expect(validateArtifact(root, "windows-x64", { mode: "candidate" })).rejects.toThrow(
    "missing project notice pin: " + path,
  );
});

// macOS candidates carry POSIX permissions, which only a POSIX host can validate.
it.skipIf(process.platform === "win32").each([
  [
    "an x86-64 image",
    machOFixture({ cpuType: 0x01_00_00_07 }),
    "expected a macOS arm64 Mach-O image",
  ],
  ["an arm64e image", machOFixture({ cpuSubtype: 2 }), "expected a macOS arm64 Mach-O image"],
  [
    "an ABI-versioned arm64e image",
    machOFixture({ cpuSubtype: 0x81_00_00_02 }),
    "expected a macOS arm64 Mach-O image",
  ],
  [
    "an arm64 iOS Simulator image",
    machOFixture({ platform: 7 }),
    "expected a macOS build platform",
  ],
  ["an unsigned image", machOFixture({ signed: false }), "unsigned Mach-O image"],
  [
    "a universal image",
    Buffer.from([0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 2]),
    "expected a macOS arm64 Mach-O image",
  ],
])("a macOS candidate refuses %s, even hidden under a name that does not look native", async (
  _name,
  image,
  message,
) => {
  for (const path of ["bin/postgres", "share/timezone/Helper"]) {
    const { root } = await fixture("macos-arm64");
    await rm(join(root, artifactManifestName));
    // Even a permissive builder umask must let this case reach the machine check.
    await mkdir(join(root, "share/timezone"), { recursive: true, mode: 0o755 });
    await writeFile(join(root, path), image);
    await chmod(join(root, path), 0o755);
    await expect(
      writeArtifactManifest(root, {
        target: "macos-arm64",
        packagingRevision: 1,
        hostEvidence: [],
      }),
    ).rejects.toThrow(message + ": " + path);
  }
});

it.skipIf(process.platform === "win32").each([
  ["bin/pg_test_fsync", 8, "expected a Mach-O executable"],
  ["lib/vector.dylib", 2, "expected a Mach-O loadable module"],
  ["lib/libpq.5.dylib", 8, "expected a Mach-O client dylib"],
  ["lib/libecpg.6.18.dylib", 8, "expected a Mach-O client dylib"],
])("a macOS candidate checks the Mach-O file type at %s", async (path, fileType, message) => {
  const root = await directory();
  await expect(createCandidate(root, "macos-arm64", {
    files: { [path]: machOFixture({ fileType }) },
  })).rejects.toThrow(message + ": " + path);
});

it.skipIf(process.platform === "win32")(
  "a macOS release states the measured minimum macOS as libSystem's requirement",
  async () => {
    const root = await directory();
    // A single installation may contain either plain arm64 subtype (ALL or V8).
    const manifest = await createCandidate(root, "macos-arm64", {
      files: { "bin/pg_test_fsync": machOFixture({ cpuSubtype: 1 }) },
    });
    manifest.hostRequirements = hostRequirementsFixture("macos-arm64");
    manifest.licenseInventory = reviewedFixture(manifest);
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "macos-arm64")).resolves.toMatchObject({
      formatVersion: 1,
    });
    // A build for a newer macOS reopens the host review.
    const measured = manifest.hostEvidence;
    manifest.hostEvidence = measured.map(entry =>
      entry.component === macOSMinimum.component ? { ...entry, version: "26.0" } : entry
    );
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "macos-arm64")).rejects.toThrow(
      "host requirement changed since review: /usr/lib/libSystem.B.dylib requires macOS 26.0 or newer",
    );
    // Without the measurement, the stated requirement would describe nothing.
    manifest.hostEvidence = measured.filter(entry => entry.component !== macOSMinimum.component);
    await rewrite(root, manifest);
    await expect(validateArtifact(root, "macos-arm64")).rejects.toThrow(
      "missing host measurement: " + macOSMinimum.component,
    );
  },
);
