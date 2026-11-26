/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks that review drafts cover every shipped file and that tracked reviews reach the release gate. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type ArtifactTarget,
  type HostEvidence,
  validateArtifact,
} from "../binaries/artifact/artifact.ts";
import {
  type Draft,
  draftReview,
  mergeReview,
  parseReview,
  readTrackedReview,
  releaseReviewGap,
  type Review,
  reviewCandidate,
  reviewFileFor,
} from "../binaries/artifact/review.ts";
import { noticeSignatureExamples } from "../binaries/artifact/notice-scan.ts";
import { sources } from "../binaries/sources/sources.ts";
import {
  complete,
  createCandidate,
  fixtureEvidence,
  fixtureNoticeScan,
  noticeHashes,
  parserGenerators,
  remeasured,
  toolchainParts,
} from "./candidate.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

const { directory, cleanup } = temporaryDirectories("review");
afterEach(cleanup);

const hostEvidence: Record<ArtifactTarget, HostEvidence[]> = {
  "windows-x64": remeasured(
    fixtureEvidence("windows-x64"),
    "windows-x64",
    "kernel32.dll",
  ),
  "linux-arm64-glibc": fixtureEvidence("linux-arm64-glibc"),
  "linux-x64-glibc": fixtureEvidence("linux-x64-glibc"),
  "macos-arm64": fixtureEvidence("macos-arm64"),
};

/** Builds and validates two complete candidates, which takes longer than the default limit on a busy host. */
const twoCandidates = 30_000;

async function windowsDraft(
  installation: string,
  evidence = hostEvidence["windows-x64"],
): Promise<Draft> {
  await createCandidate(installation, "windows-x64", { hostEvidence: evidence });
  return draftReview(installation, "windows-x64");
}

it("requires the licenses of all bundled MinGW runtime contributions", async () => {
  const installation = await directory();
  const review = complete((await windowsDraft(installation)).review);
  const runtime = review.licenseInventory.components.find(part => part.id === "mingw-runtime")!;
  const fullLicences = runtime.licenses;
  runtime.licenses = ["Apache-2.0 WITH LLVM-exception"];
  await expect(releaseReviewGap(installation, "windows-x64", review)).resolves.toContain(
    "must carry MIT",
  );
  runtime.licenses = fullLicences;
  await expect(releaseReviewGap(installation, "windows-x64", review)).resolves.toBeUndefined();
  const postgres = review.licenseInventory.components.find(part => part.id === "postgresql")!;
  postgres.licenses.push("ZPL-2.1");
  await expect(reviewCandidate(installation, "windows-x64", review)).resolves.toMatchObject({
    changes: ["release gate: unresolved or unapproved license: ZPL-2.1"],
  });
  await expect(releaseReviewGap(installation, "windows-x64", review)).resolves.toContain(
    "unresolved or unapproved license: ZPL-2.1",
  );
});

it("reopens only the source whose Windows link inputs changed and the shared runtime review",
  async () => {
    const current = await directory();
    const previous = complete((await windowsDraft(await directory())).review);
    const updated = hostEvidence["windows-x64"].map(entry =>
      ["CLANG64 packages and linked objects", "CLANG64 packages and linked objects: pgvector"]
          .includes(entry.component)
        ? { ...entry, version: entry.version + "-changed" }
        : entry
    );
    const draft = await windowsDraft(current, updated);
    const { review } = mergeReview(draft, previous);
    expect(
      review.licenseInventory.components.filter(part => part.status === "pending").map(part =>
        part.id
      ).sort(),
    )
      .toEqual(["mingw-runtime", "pgvector"]);
    expect(review.licenseInventory.components.find(part => part.id === "pgvector")?.toolchain).toBe(
      "pgvector-1-changed",
    );
    const stale = complete(draft.review);
    stale.licenseInventory.components.find(part => part.id === "pgvector")!.toolchain =
      "pgvector-1";
    await expect(releaseReviewGap(current, "windows-x64", stale)).resolves.toContain(
      "toolchain changed since review: pgvector",
    );
  }, twoCandidates);

async function draftAndRelease(target: ArtifactTarget): Promise<Review> {
  const candidate = await directory();
  const manifest = await createCandidate(candidate, target, { hostEvidence: hostEvidence[target] });
  const { review: draft } = await draftReview(candidate, target);

  // Every payload path needs a component, and licenses stay empty until a person reviews them.
  const covered = new Set(draft.licenseInventory.components.flatMap(component => component.files));
  expect(manifest.files.filter(file => !covered.has(file.path))).toEqual([]);
  expect(draft.licenseInventory.status).toBe("pending");
  for (const component of draft.licenseInventory.components) {
    expect(component).toMatchObject({ licenses: [], evidence: [], status: "pending" });
  }

  // A review reads the shipped license texts and the toolchain line, so the draft records both.
  for (const component of draft.licenseInventory.components) {
    expect(Object.keys(component.noticeSha256)).toEqual(component.notices);
  }
  for (const part of toolchainParts[target]) {
    expect(
      draft.licenseInventory.components.find(component => component.id === part.id)?.toolchain,
    ).toBe(hostEvidence[target].find(entry => entry.component === part.evidence)!.version);
  }

  // A completed draft is enough for a new build of the same file list to pass the release gate.
  const release = await releaseCandidate(complete(draft), target, {
    hostEvidence: hostEvidence[target],
  });
  await expect(validateArtifact(release, target)).resolves.toMatchObject({ target });
  return draft;
}

/** Builds a candidate the way a build does, from a tracked review file. */
async function releaseCandidate(
  review: Review,
  target: ArtifactTarget,
  options: { hostEvidence: HostEvidence[]; files?: Record<string, string> },
): Promise<string> {
  const reviewFile = join(await directory(), "review.json");
  await writeFile(reviewFile, JSON.stringify({ target, ...review }));
  const release = await directory();
  await createCandidate(release, target, {
    ...options,
    trackedReview: (await readTrackedReview(reviewFile, target))!.review,
  });
  return release;
}

it(
  "Windows draft credits PE images to the MinGW runtime and lists required host libraries",
  async () => {
    const draft = await draftAndRelease("windows-x64");
    const toolchain = draft.licenseInventory.components.find(component =>
      component.id === "mingw-runtime"
    )!;
    expect(toolchain.files).toContain("bin/postgres.exe");
    expect(toolchain.files).toContain("lib/vector.dll");
    expect(toolchain.files).toEqual(
      expect.arrayContaining(["bin/libc++.dll", "bin/libwinpthread-1.dll"]),
    );
    // Besides the images, the runtime component holds only the project's notice for the linked code.
    expect(toolchain.files.filter(path => path.endsWith(".sql") || path.startsWith("notices/")))
      .toEqual(["notices/mingw-runtime.txt"]);
    expect(toolchain.notices).toEqual(["notices/mingw-runtime.txt"]);
    expect(
      draft.licenseInventory.components.find(component => component.id === "postgresql")!.files,
    ).not.toContain("notices/mingw-runtime.txt");
    expect(draft.hostRequirements.libraries.map(library => library.name)).toEqual([
      "ucrtbase.dll",
      "kernel32.dll",
    ]);
  },
  twoCandidates,
);

it.skipIf(process.platform === "win32")(
  "Linux draft credits ELF images to compiler-rt and glibc's startup code and carries the measured glibc requirement",
  async () => {
    const draft = await draftAndRelease("linux-x64-glibc");
    for (const id of ["compiler-rt", "glibc-startup"]) {
      const toolchain = draft.licenseInventory.components.find(component => component.id === id)!;
      expect(toolchain.files).toContain("bin/postgres");
      expect(toolchain.toolchain).toBe("fixture-1");
    }
    expect(draft.hostRequirements.libraries).toEqual([
      {
        name: "glibc",
        requirement: "GLIBC_2.35 or newer",
        license: "",
        evidence: "",
        measured: true,
      },
    ]);
  },
  twoCandidates,
);

it.skipIf(process.platform === "win32")(
  "a changed glibc requirement stays pending in a review file copied from the draft",
  async () => {
    const target = "linux-x64-glibc";
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const tracked = complete((await draftReview(first, target)).review);
    const changed = await directory();
    await createCandidate(changed, target, {
      hostEvidence: remeasured(hostEvidence[target], target, "GLIBC_2.38"),
    });
    const { review, changes } = mergeReview(await draftReview(changed, target), tracked);
    expect(changes).toEqual(["host requirements: glibc now requires GLIBC_2.38 or newer"]);
    expect(review.hostRequirements.libraries).toEqual([
      expect.objectContaining({ requirement: "GLIBC_2.38 or newer", license: "LGPL-2.1-or-later" }),
    ]);
    // The evidence described the earlier minimum, so the copied draft must not verify itself.
    const copied =
      parseReview(JSON.stringify(reviewFileFor(target, review)), "review.json", target).review;
    expect(copied.hostRequirements.status).toBe("pending");
  },
  twoCandidates,
);

it.skipIf(process.platform === "win32")(
  "macOS reopens only PostgreSQL when a parser generator changes on the same Xcode",
  async ({ onTestFinished }) => {
    const target = "macos-arm64";
    const first = await directory();
    await createCandidate(first, target);
    // Count the drafter's probes separately from the validator's required machine checks.
    const imageProbe = vi.spyOn(await import("../binaries/artifact/artifact.ts"), "isNativeImage");
    onTestFinished(() => imageProbe.mockRestore());
    const initial = await draftReview(first, target);
    expect(imageProbe).not.toHaveBeenCalled();
    const tracked = complete(initial.review);
    expect(mergeReview(initial, tracked).changes).toEqual([]);
    const changed = await directory();
    const newer = parserGenerators.version.replace("2.3,", "3.8,");
    await createCandidate(changed, target, {
      hostEvidence: hostEvidence[target].map(entry =>
        entry.component === parserGenerators.component
          ? { ...entry, version: newer }
          : entry
      ),
    });
    const { review, changes } = mergeReview(await draftReview(changed, target), tracked);
    expect(changes).toEqual([
      `postgresql: toolchain changed from ${parserGenerators.version} to ${newer}`,
    ]);
    expect(
      review.licenseInventory.components.filter(part => part.status === "pending").map(part =>
        part.id
      ),
    )
      .toEqual(["postgresql"]);
    await expect(releaseReviewGap(changed, target, tracked)).resolves.toContain(
      "toolchain changed since review: postgresql",
    );
    await expect(releaseReviewGap(first, target, tracked)).resolves.toBeUndefined();
    // An older approved review with no generator identity also needs this one component reviewed.
    delete tracked.licenseInventory.components.find(part => part.id === "postgresql")!.toolchain;
    expect(mergeReview(initial, tracked).review.licenseInventory.status).toBe("pending");
  },
  twoCandidates,
);

it(
  "a draft carries the tracked review forward and reopens only what changed",
  async () => {
    const target = "windows-x64";
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const tracked = complete((await draftReview(first, target)).review);

    // A rebuild with the same license texts, such as most source updates, keeps the whole review.
    const same = await directory();
    await createCandidate(same, target, { hostEvidence: hostEvidence[target] });
    expect(mergeReview(await draftReview(same, target), tracked)).toEqual({
      review: tracked,
      changes: [],
    });

    // A changed license text and host library each reopen exactly what they affect.
    const changedEvidence = remeasured(
      hostEvidence[target],
      target,
      "kernel32.dll, advapi32.dll",
    );
    const files = { "notices/pgvector.txt": "a changed license text" };
    const changed = await directory();
    await createCandidate(changed, target, { hostEvidence: changedEvidence, files });
    const { review, changes } = mergeReview(await draftReview(changed, target), tracked);
    expect(changes).toEqual([
      "pgvector: license notice changed: notices/pgvector.txt",
      "host requirements: libraries added: advapi32.dll",
    ]);
    const pending = review.licenseInventory.components.filter(component =>
      component.status === "pending"
    );
    expect(pending.map(component => component.id)).toEqual(["pgvector"]);
    for (const component of pending) {
      // The previous licenses are a starting point; the evidence must be written again.
      expect(component).toMatchObject({ licenses: ["MIT"], evidence: [] });
    }
    expect(review.licenseInventory.status).toBe("pending");
    expect(review.hostRequirements.status).toBe("pending");
    expect(review.hostRequirements.libraries.map(library => library.license)).toEqual([
      "LicenseRef-Microsoft-Windows",
      "LicenseRef-Microsoft-Windows",
      "",
    ]);

    // Reopened parts block a release until a person verifies them again.
    const blocked = await releaseCandidate(review, target, {
      hostEvidence: changedEvidence,
      files,
    });
    await expect(validateArtifact(blocked, target)).rejects.toThrow("unresolved");
    const release = await releaseCandidate(complete(review), target, {
      hostEvidence: changedEvidence,
      files,
    });
    await expect(validateArtifact(release, target)).resolves.toMatchObject({ target });
  },
  // Four complete candidates.
  2 * twoCandidates,
);

it(
  "a new CLANG64 link inventory and notice reopen the runtime review",
  async () => {
    const target = "windows-x64";
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const tracked = complete((await draftReview(first, target)).review);

    const lineEvidence = toolchainParts[target][0]!.evidence;
    const newLine = hostEvidence[target].map(entry =>
      entry.component === lineEvidence ? { ...entry, version: "fixture-2" } : entry
    );
    const files = { "notices/mingw-runtime.txt": "a reworded notice" };
    const changed = await directory();
    await createCandidate(changed, target, { hostEvidence: newLine, files });
    const { review, changes } = mergeReview(await draftReview(changed, target), tracked);
    expect(changes).toEqual([
      "mingw-runtime: license notice changed: notices/mingw-runtime.txt",
      "mingw-runtime: toolchain changed from fixture-1 to fixture-2",
    ]);

    // The reviewed inventory must match the new linked objects and the updated notice.
    const release = await releaseCandidate(complete(review), target, {
      hostEvidence: newLine,
      files,
    });
    await expect(validateArtifact(release, target)).resolves.toMatchObject({ target });
  },
  2 * twoCandidates,
);

it(
  "a draft keeps components added by hand while their files ship and reopens them when they change",
  async () => {
    const target = "windows-x64";
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const tracked = complete((await draftReview(first, target)).review);
    const pgvector = tracked.licenseInventory.components.find(component =>
      component.id === "pgvector"
    )!;
    // A reviewer credits code that pgvector bundles; no draft ever generates this component.
    const handAdded = (id: string, files: string[]) => ({
      id,
      licenses: ["MIT"],
      status: "verified" as const,
      evidence: ["Owned contract-test fixture"],
      files,
      notices: ["notices/pgvector.txt"],
      noticeSha256: { "notices/pgvector.txt": pgvector.noticeSha256["notices/pgvector.txt"]! },
    });
    tracked.licenseInventory.components.push(handAdded("bundled-code", ["lib/vector.dll"]));

    // The same payload keeps the whole review, which still passes the release gate.
    expect(mergeReview(await draftReview(first, target), tracked)).toEqual({
      review: tracked,
      changes: [],
    });
    const release = await releaseCandidate(tracked, target, { hostEvidence: hostEvidence[target] });
    await expect(validateArtifact(release, target)).resolves.toMatchObject({ target });

    // A changed license text reopens it with its licenses as a starting point and no evidence.
    const files = { "notices/pgvector.txt": "a changed license text" };
    const changed = await directory();
    await createCandidate(changed, target, { hostEvidence: hostEvidence[target], files });
    const reopened = mergeReview(await draftReview(changed, target), tracked);
    expect(reopened.changes).toEqual([
      "pgvector: license notice changed: notices/pgvector.txt",
      "bundled-code: license notice changed: notices/pgvector.txt",
    ]);
    expect(
      reopened.review.licenseInventory.components.find(component =>
        component.id === "bundled-code"
      ),
    ).toMatchObject({ status: "pending", licenses: ["MIT"], evidence: [] });

    // Files that no longer ship are removed from it; a component with none left is dropped.
    const current = await draftReview(first, target);
    tracked.licenseInventory.components.push(handAdded("retired", ["lib/retired.dll"]));
    expect(mergeReview(current, tracked).review.licenseInventory.status).toBe("pending");
    tracked.licenseInventory.components.splice(-1, 0,
      handAdded("partly-retired", ["lib/vector.dll", "lib/retired.dll"]));
    const { review, changes } = mergeReview(current, tracked);
    expect(changes).toEqual([
      "partly-retired: files removed: lib/retired.dll",
      "retired: no longer shipped",
    ]);
    const ids = review.licenseInventory.components.map(component => component.id);
    expect(ids).toContain("bundled-code");
    expect(ids).not.toContain("retired");
    expect(
      review.licenseInventory.components.find(component => component.id === "partly-retired"),
    ).toMatchObject({ status: "pending", files: ["lib/vector.dll"], evidence: [] });
  },
  2 * twoCandidates,
);

it.each([
  ["a component added by hand", "bundled-sql"],
  ["a drafted component", "hypopg"],
])(
  "%s keeps a shipped file that a reviewer cites as its notice",
  async (_, id) => {
    const target = "windows-x64";
    const hypopg = sources.find(source => source.id === "hypopg")!;
    const script = "share/extension/hypopg--" + hypopg.version + ".sql";
    const first = await directory();
    const manifest = await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const tracked = complete((await draftReview(first, target)).review);
    // A reviewer cites the license header of an SQL script, which no draft lists as a notice.
    const components = tracked.licenseInventory.components;
    const drafted = components.find(component => component.id === id);
    if (drafted) {
      drafted.notices.push(script);
      Object.assign(drafted.noticeSha256, noticeHashes(manifest, [script]));
    } else {
      components.push({
        id,
        licenses: ["MIT"],
        status: "verified",
        evidence: ["Owned contract-test fixture"],
        files: [script],
        notices: [script],
        noticeSha256: noticeHashes(manifest, [script]),
      });
    }

    // An identical rebuild keeps the whole review, which the release gate accepts.
    expect(mergeReview(await draftReview(first, target), tracked)).toEqual({
      review: tracked,
      changes: [],
    });
    const release = await releaseCandidate(tracked, target, { hostEvidence: hostEvidence[target] });
    await expect(validateArtifact(release, target)).resolves.toMatchObject({ target });

    // A changed script reopens the component that cites it, and only that one, which still cites it.
    const files = { [script]: "a changed license header" };
    const changed = await directory();
    await createCandidate(changed, target, { hostEvidence: hostEvidence[target], files });
    const { review, changes } = mergeReview(await draftReview(changed, target), tracked);
    expect(changes).toEqual([id + ": license notice changed: " + script]);
    expect(review.licenseInventory.components.find(component => component.id === id))
      .toMatchObject({
        status: "pending",
        notices: expect.arrayContaining([script]),
        evidence: [],
      });
  },
  2 * twoCandidates,
);

it(
  "a drafted component keeps a file that a reviewer credits to it as well, while the file ships",
  async () => {
    const target = "windows-x64";
    const files = { "share/extra.txt": "a file that a later build no longer ships" };
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target], files });
    const tracked = complete((await draftReview(first, target)).review);
    // HypoPG compiles code that it copies from PostgreSQL into its library, so a reviewer credits both.
    const components = tracked.licenseInventory.components;
    components.find(component => component.id === "postgresql")!.files.push("lib/hypopg.dll");
    components.find(component => component.id === "hypopg")!.files.push("share/extra.txt");

    // An identical rebuild keeps the whole review, which the release gate accepts.
    expect(mergeReview(await draftReview(first, target), tracked)).toEqual({
      review: tracked,
      changes: [],
    });
    const release = await releaseCandidate(tracked, target, {
      hostEvidence: hostEvidence[target],
      files,
    });
    await expect(validateArtifact(release, target)).resolves.toMatchObject({ target });

    // A credited file that no longer ships leaves the component that credited it.
    const later = await directory();
    await createCandidate(later, target, { hostEvidence: hostEvidence[target] });
    const { changes } = mergeReview(await draftReview(later, target), tracked);
    expect(changes).toContain("hypopg: files removed: share/extra.txt");
    expect(changes).not.toContain("postgresql: files removed: lib/hypopg.dll");
  },
  3 * twoCandidates,
);

it("a toolchain component covers only the images that the current build ships", () => {
  const component = (id: string, files: string[]) => ({
    id,
    ...id === "postgresql" ? { noticeSignatures: [] } : {},
    licenses: ["MIT"],
    status: "verified" as const,
    evidence: ["Owned contract-test fixture"],
    files,
    notices: [],
    noticeSha256: {},
  });
  const host = { os: "fixture", cpu: "fixture", libraries: [] };
  // The path still ships, but as a link to the library, which is no longer an image.
  const draft: Draft = {
    review: {
      licenseInventory: {
        status: "pending",
        components: [
          component("postgresql", ["lib/libpq.so", "lib/libpq.so.5"]),
          component("compiler-rt", ["lib/libpq.so.5"]),
        ],
      },
      hostRequirements: { status: "pending", ...host },
    },
    payloadSha256: new Map(),
    noticeExamples: new Map(),
  };
  const tracked: Review = {
    licenseInventory: {
      status: "verified",
      components: [
        component("postgresql", ["lib/libpq.so", "lib/libpq.so.5"]),
        component("compiler-rt", ["lib/libpq.so", "lib/libpq.so.5"]),
      ],
    },
    hostRequirements: { status: "verified", ...host },
  };
  const { review, changes } = mergeReview(draft, tracked);
  expect(changes).toEqual(["compiler-rt: files removed: lib/libpq.so"]);
  expect(
    review.licenseInventory.components.find(entry => entry.id === "compiler-rt")?.files,
  ).toEqual(["lib/libpq.so.5"]);
});

it(
  "a host library keeps its review whatever the casing of its name",
  async () => {
    const target = "windows-x64";
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const tracked = complete((await draftReview(first, target)).review);
    // Windows resolves DLL names case-insensitively, and so does the release gate.
    tracked.hostRequirements.libraries.find(library => library.name === "kernel32.dll")!.name =
      "KERNEL32.DLL";
    expect(mergeReview(await draftReview(first, target), tracked)).toEqual({
      review: tracked,
      changes: [],
    });
    const release = await releaseCandidate(tracked, target, { hostEvidence: hostEvidence[target] });
    await expect(validateArtifact(release, target)).resolves.toMatchObject({ target });

    // A new import reopens the host requirements, which keep the review of the renamed library.
    const evidence = remeasured(
      hostEvidence[target],
      target,
      "kernel32.dll, advapi32.dll",
    );
    const changed = await directory();
    await createCandidate(changed, target, { hostEvidence: evidence });
    const { review, changes } = mergeReview(await draftReview(changed, target), tracked);
    expect(changes).toEqual(["host requirements: libraries added: advapi32.dll"]);
    expect(review.hostRequirements.libraries.find(library => library.name === "KERNEL32.DLL"))
      .toMatchObject({ license: "LicenseRef-Microsoft-Windows", evidence: "fixture" });
  },
  2 * twoCandidates,
);

it(
  "a host prerequisite that a reviewer adds is kept, while a measured import that disappears reopens the review",
  async () => {
    const target = "windows-x64";
    const evidence = remeasured(
      hostEvidence[target],
      target,
      "kernel32.dll, advapi32.dll",
    );
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: evidence });
    const tracked = complete((await draftReview(first, target)).review);
    // The native proof loaded mswsock.dll through another library, so a reviewer records it as well.
    tracked.hostRequirements.libraries.push({
      name: "mswsock.dll",
      requirement: "fixture",
      license: "LicenseRef-Microsoft-Windows",
      evidence: "Loaded by the native proof",
    });
    expect(mergeReview(await draftReview(first, target), tracked)).toEqual({
      review: tracked,
      changes: [],
    });

    // A build that no longer imports advapi32.dll reopens the requirements and keeps the added entry.
    const later = await directory();
    await createCandidate(later, target, { hostEvidence: hostEvidence[target] });
    const { review, changes } = mergeReview(await draftReview(later, target), tracked);
    expect(changes).toEqual(["host requirements: libraries removed: advapi32.dll"]);
    expect(review.hostRequirements.libraries.find(library => library.name === "mswsock.dll"))
      .toMatchObject({ evidence: "Loaded by the native proof" });
  },
  2 * twoCandidates,
);

it(
  "a host prerequisite that a reviewer adds stays when the build imports it for a while",
  async () => {
    const target = "windows-x64";
    const imports = (list: string) => remeasured(hostEvidence[target], target, list);
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const tracked = complete((await draftReview(first, target)).review);
    tracked.hostRequirements.libraries.push({
      name: "mswsock.dll",
      requirement: "fixture",
      license: "LicenseRef-Microsoft-Windows",
      evidence: "Loaded by the native proof",
    });

    // A later build imports it directly while another new import reopens the review.
    const second = await directory();
    await createCandidate(second, target, {
      hostEvidence: imports("kernel32.dll, mswsock.dll, advapi32.dll"),
    });
    const reopened = mergeReview(await draftReview(second, target), tracked).review;

    // When the direct import disappears again, the reviewer's entry and evidence remain.
    const third = await directory();
    await createCandidate(third, target, { hostEvidence: hostEvidence[target] });
    const { review, changes } = mergeReview(await draftReview(third, target), reopened);
    expect(changes).toEqual(["host requirements: libraries removed: advapi32.dll"]);
    expect(review.hostRequirements.libraries.find(library => library.name === "mswsock.dll"))
      .toMatchObject({ evidence: "Loaded by the native proof" });
  },
  3 * twoCandidates,
);

/** Round-trips the generated file for a legacy review with explicit decisions. */
function rereadLegacyDraft(previous: Review, merged: Review): Review {
  const target = "windows-x64";
  const tracked = parseReview(JSON.stringify({ target, ...previous }), "review.json", target);
  const file = reviewFileFor(target, merged, tracked.file);
  return parseReview(JSON.stringify(file), "copied.json", target).review;
}

it("a draft reports a tracked review that was never approved as a whole", async () => {
  const candidate = await directory();
  await createCandidate(candidate, "windows-x64", { hostEvidence: hostEvidence["windows-x64"] });
  const tracked = complete((await draftReview(candidate, "windows-x64")).review);
  tracked.licenseInventory.status = "pending";
  const { review, changes } = mergeReview(await draftReview(candidate, "windows-x64"), tracked);
  expect(review.licenseInventory.status).toBe("pending");
  expect(changes).toEqual(["license inventory: not verified yet"]);
  expect(rereadLegacyDraft(tracked, review).licenseInventory.status).toBe("pending");
});

it("an unchanged component that is still pending keeps the evidence written so far", async () => {
  const candidate = await directory();
  await createCandidate(candidate, "windows-x64", { hostEvidence: hostEvidence["windows-x64"] });
  const tracked = complete((await draftReview(candidate, "windows-x64")).review);
  // A reviewer saved a review in progress; nothing about the component changed since.
  const pgvector = tracked.licenseInventory.components.find(component =>
    component.id === "pgvector"
  )!;
  pgvector.status = "pending";
  pgvector.evidence = ["Compared the license files of both releases"];
  const { review, changes } = mergeReview(await draftReview(candidate, "windows-x64"), tracked);
  expect(changes).toEqual(["pgvector: not verified yet"]);
  expect(review.licenseInventory.status).toBe("pending");
  expect(review.licenseInventory.components.find(component => component.id === "pgvector"))
    .toEqual(pgvector);
  expect(
    rereadLegacyDraft(tracked, review).licenseInventory.components.find(part =>
      part.id === "pgvector"
    ),
  )
    .toMatchObject({ status: "pending", evidence: pgvector.evidence });
});

it(
  "the release gap names what the release gate would still reject in a review",
  async () => {
    const target = "windows-x64";
    const candidate = await directory();
    await createCandidate(candidate, target, { hostEvidence: hostEvidence[target] });
    const review = complete((await draftReview(candidate, target)).review);
    await expect(releaseReviewGap(candidate, target, review)).resolves.toBeUndefined();
    // Marked verified without evidence: unchanged against the tracked review, but not releasable.
    review.licenseInventory.components.find(component => component.id === "pgvector")!.evidence =
      [];
    await expect(releaseReviewGap(candidate, target, review)).resolves.toBe(
      "unresolved license component: pgvector",
    );
    review.hostRequirements.status = "pending";
    await expect(releaseReviewGap(candidate, target, review)).resolves.toMatch(/unresolved/);
  },
  twoCandidates,
);

it(
  "a tracked review with two components under one ID is refused before any draft is written",
  async () => {
    const target = "windows-x64";
    const candidate = await directory();
    await createCandidate(candidate, target, { hostEvidence: hostEvidence[target] });
    const tracked = complete((await draftReview(candidate, target)).review);
    const pgvector = tracked.licenseInventory.components.find(component =>
      component.id === "pgvector"
    )!;
    // The merge would keep the first entry and drop this one, and report that the review still matches.
    tracked.licenseInventory.components.push({ ...pgvector, evidence: ["another review"] });
    const reviewFile = join(await directory(), "review.json");
    await writeFile(reviewFile, JSON.stringify({ target, ...tracked }));
    await expect(readTrackedReview(reviewFile, target)).rejects.toThrow(
      "duplicate license component: pgvector",
    );
  },
  twoCandidates,
);

it(
  "pending host requirements stay unresolved in the manifest while the reviewed licenses still count",
  async () => {
    const target = "windows-x64";
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const reviewed = complete((await draftReview(first, target)).review);
    const trackedReview: Review = {
      ...reviewed,
      hostRequirements: { ...reviewed.hostRequirements, status: "pending" },
    };
    const manifest = await createCandidate(await directory(), target, {
      hostEvidence: hostEvidence[target],
      trackedReview,
    });
    expect(manifest.hostRequirements).toBeNull();
    expect(manifest.licenseInventory).toEqual(reviewed.licenseInventory);
    expect(rereadLegacyDraft(trackedReview, trackedReview).hostRequirements.status).toBe("pending");
  },
  twoCandidates,
);

it(
  "packaging from a tracked review reports a source notice that the candidate lacks",
  async () => {
    const target = "windows-x64";
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const reviewed = complete((await draftReview(first, target)).review);
    // The merge drops a notice that no longer ships from every component that the tracked review has, so
    // only a component that it lacks reaches the manifest with the notice as the draft read it.
    const trackedReview: Review = {
      ...reviewed,
      licenseInventory: {
        ...reviewed.licenseInventory,
        components: reviewed.licenseInventory.components.filter(component =>
          component.id !== "hypopg"
        ),
      },
    };
    await expect(createCandidate(await directory(), target, {
      hostEvidence: hostEvidence[target],
      remove: ["notices/hypopg.txt"],
      trackedReview,
    })).rejects.toThrow("missing source notice: notices/hypopg.txt");
  },
  twoCandidates,
);

it("requires the target in a saved review to match the requested Linux architecture", () => {
  const review = {
    licenseInventory: { components: [] },
    hostRequirements: { os: "", cpu: "", libraries: [] },
  };
  const read = (file: unknown) =>
    parseReview(JSON.stringify(file), "review.json", "linux-x64-glibc");
  expect(() => read({ ...review, target: "linux-arm64-glibc" })).toThrow(
    /linux-arm64-glibc.*linux-x64-glibc/,
  );
  expect(() => read(review)).toThrow(/target/);
  expect(read({ ...review, target: "linux-x64-glibc" }).review.licenseInventory.status).toBe(
    "pending",
  );
});

it("a missing review file reads as none, and a malformed one is refused", async () => {
  const reviewFile = join(await directory(), "review.json");
  const target = "windows-x64";
  const read = () => readTrackedReview(reviewFile, target);
  await expect(read()).resolves.toBeUndefined();

  const pending: Review = {
    licenseInventory: { status: "pending", components: [] },
    hostRequirements: { status: "pending", os: "", cpu: "", libraries: [] },
  };
  await writeFile(reviewFile, JSON.stringify({ target, ...pending }));
  expect((await read())!.review).toEqual(pending);

  // A measured flag that is not a boolean would mark a measured library as one that a reviewer added.
  const library = {
    name: "kernel32.dll",
    requirement: "",
    license: "",
    evidence: "",
    measured: "true",
  };
  await writeFile(
    reviewFile,
    JSON.stringify({
      target,
      ...pending,
      hostRequirements: { ...pending.hostRequirements, libraries: [library] },
    }),
  );
  await expect(read()).rejects.toThrow(
    "invalid measured flag: kernel32.dll",
  );

  // The merge matches names case-insensitively and would carry only one of two entries forward.
  const glibc = { name: "glibc", requirement: "GLIBC_2.35 or newer", license: "", evidence: "" };
  await writeFile(
    reviewFile,
    JSON.stringify({
      target,
      ...pending,
      hostRequirements: {
        ...pending.hostRequirements,
        libraries: [glibc, { ...glibc, name: "GLIBC", requirement: "GLIBC_2.17 or newer" }],
      },
    }),
  );
  await expect(read()).rejects.toThrow("duplicate host library: GLIBC");

  await writeFile(reviewFile,
    JSON.stringify({ target, licenseInventory: pending.licenseInventory }));
  await expect(read()).rejects.toThrow("must contain licenseInventory");
});

it("new or vanished license text in a source tree reopens that source's review and says where", async () => {
  const target = "windows-x64";
  const first = await directory();
  await createCandidate(first, target, { hostEvidence: fixtureEvidence(target) });
  const tracked = complete((await draftReview(first, target)).review);

  const evidence = reviewFileFor(target, tracked);
  expect(JSON.stringify(evidence)).not.toContain('"status":');
  const roundTrip = parseReview(JSON.stringify(evidence), "review.json", target).review;
  expect(roundTrip).toEqual({
    ...tracked,
    licenseInventory: {
      ...tracked.licenseInventory,
      components: tracked.licenseInventory.components.map(part => ({
        ...part,
        licenses: part.licenses.toSorted(),
        files: part.files.toSorted(),
      })),
    },
  });

  const vixie =
    "Copyright YYYY by Paul Vixie | May be sold if buildable source is provided to buyer";
  const scan = fixtureNoticeScan();
  scan["pg_cron"] = { [vixie]: ["src/entry.c", "src/misc.c", "include/cron.h", "src/job.c"] };
  const changed = await directory();
  await createCandidate(changed, target, {
    hostEvidence: fixtureEvidence(target),
    noticeSignatures: noticeSignatureExamples(scan),
  });
  const current = await draftReview(changed, target);
  const { review, changes } = mergeReview(current, tracked);
  // Three example files point the reviewer to the new text.
  expect(changes).toEqual([
    `pg_cron: license text added: ${
      JSON.stringify(vixie)
    } in src/entry.c, src/misc.c, include/cron.h`,
    'pg_cron: license text gone: "Copyright (c) YYYY pg_cron fixture authors"',
  ]);
  const pending = review.licenseInventory.components.filter(component =>
    component.status === "pending"
  );
  expect(pending.map(component => component.id)).toEqual(["pg_cron"]);
  expect(pending[0]).toMatchObject({
    noticeSignatures: [vixie],
    evidence: [],
    licenses: ["MIT", "Vixie-Cron", "BSD-4.3TAHOE"],
  });

  // A reviewer added links after the first draft. Regenerating must use the latest tracked file.
  Object.assign(evidence, { reviewLink: "root" });
  Object.assign(evidence.licenseInventory, { reviewLink: "inventory" });
  Object.assign(evidence.licenseInventory.components.find(part => part.id === "pg_cron")!, {
    reviewLink: "cron",
  });
  Object.assign(evidence.hostRequirements, { reviewLink: "host" });
  Object.assign(evidence.hostRequirements.libraries[0]!, { reviewLink: "library" });
  const latest = parseReview(JSON.stringify(evidence), "review.json", target);
  const regenerated = mergeReview(current, latest.review).review;
  const edited = reviewFileFor(target, regenerated, latest.file);
  expect(edited).toMatchObject({
    reviewLink: "root",
    licenseInventory: { reviewLink: "inventory" },
    hostRequirements: { reviewLink: "host" },
  });
  expect(edited.hostRequirements.libraries[0]).toHaveProperty("reviewLink", "library");
  expect(edited.licenseInventory.components.find(part => part.id === "pg_cron"))
    .toMatchObject({ reviewLink: "cron", noticeSignatures: [vixie], evidence: [] });
  // Copying a reopened draft cannot satisfy the gate until its missing evidence is supplied.
  const copiedStatus = () =>
    parseReview(JSON.stringify(edited), "review.json", target).review.licenseInventory.status;
  expect(copiedStatus()).toBe("pending");
  edited.licenseInventory.components.find(part => part.id === "pg_cron")!.evidence.push(
    "Reviewed the changed cron notices.",
  );
  expect(copiedStatus()).toBe("verified");

  delete tracked.licenseInventory.components.find(component => component.id === "postgresql")!
    .noticeSignatures;
  expect(() => parseReview(JSON.stringify({ target, ...tracked }), "review.json", target))
    .toThrow("missing reviewed notice signatures for source: postgresql");
});
