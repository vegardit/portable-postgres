/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks that review drafts cover every shipped file and that tracked reviews reach the release gate. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  type ArtifactTarget,
  type HostEvidence,
  releaseVisualStudioEditions,
  validateArtifact,
  visualStudioEditionEvidence,
} from "../binaries/artifact/artifact.ts";
import {
  type Draft,
  draftReview,
  mergeReview,
  readTrackedReview,
  releaseReviewGap,
  type Review,
  reviewCandidate,
} from "../binaries/artifact/review.ts";
import { sources } from "../binaries/sources/sources.ts";
import {
  complete,
  createCandidate,
  fixtureEvidence,
  noticeHashes,
  remeasured,
  toolchainParts,
} from "./candidate.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const created of temporary.splice(0)) {
    await rm(created, { recursive: true, force: true });
  }
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "portable-postgres-review-"));
  temporary.push(path);
  return path;
}

const hostEvidence: Record<ArtifactTarget, HostEvidence[]> = {
  "windows-x64": remeasured(
    fixtureEvidence("windows-x64"),
    "windows-x64",
    "kernel32.dll, vcruntime140.dll",
  ),
  "linux-x64-glibc": fixtureEvidence("linux-x64-glibc"),
};

/** Builds and validates two complete candidates, which takes longer than the default limit on a busy host. */
const twoCandidates = 30_000;

async function draftAndRelease(target: ArtifactTarget): Promise<Review> {
  const candidate = await directory();
  const manifest = await createCandidate(candidate, target, { hostEvidence: hostEvidence[target] });
  const { review: draft } = await draftReview(candidate, target);

  // Every payload path needs a component, and licences stay empty until a person reviews them.
  const covered = new Set(draft.licenseInventory.components.flatMap(component => component.files));
  expect(manifest.files.filter(file => !covered.has(file.path))).toEqual([]);
  expect(draft.licenseInventory.status).toBe("pending");
  for (const component of draft.licenseInventory.components) {
    expect(component).toMatchObject({ licenses: [], evidence: [], status: "pending" });
  }

  // A review reads the shipped licence texts and the toolchain line, so the draft records both.
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
  await writeFile(reviewFile, JSON.stringify(review));
  const release = await directory();
  await createCandidate(release, target, {
    ...options,
    trackedReview: (await readTrackedReview(reviewFile))!,
  });
  return release;
}

it(
  "Windows draft credits PE images to the MSVC runtime and lists required host libraries",
  async () => {
    const draft = await draftAndRelease("windows-x64");
    const toolchain = draft.licenseInventory.components.find(component =>
      component.id === "msvc-runtime"
    )!;
    expect(toolchain.files).toContain("bin/postgres.exe");
    expect(toolchain.files).toContain("lib/vector.dll");
    // Besides the images, the runtime component holds only the project's notice for the linked code.
    expect(toolchain.files.filter(path => path.endsWith(".sql") || path.startsWith("notices/")))
      .toEqual(["notices/msvc-runtime.txt"]);
    expect(toolchain.notices).toEqual(["notices/msvc-runtime.txt"]);
    expect(
      draft.licenseInventory.components.find(component => component.id === "postgresql")!.files,
    ).not.toContain("notices/msvc-runtime.txt");
    expect(draft.hostRequirements.libraries.map(library => library.name)).toEqual([
      "vcruntime140.dll",
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

it(
  "a draft carries the tracked review forward and reopens only what changed",
  async () => {
    const target = "windows-x64";
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const tracked = complete((await draftReview(first, target)).review);

    // A rebuild with the same licence texts, such as most source updates, keeps the whole review.
    const same = await directory();
    await createCandidate(same, target, { hostEvidence: hostEvidence[target] });
    expect(mergeReview(await draftReview(same, target), tracked)).toEqual({
      review: tracked,
      changes: [],
    });

    // A changed licence text and host library each reopen exactly what they affect.
    const changedEvidence = remeasured(
      hostEvidence[target],
      target,
      "kernel32.dll, vcruntime140.dll, advapi32.dll",
    );
    const files = { "notices/pgvector.txt": "a changed licence text" };
    const changed = await directory();
    await createCandidate(changed, target, { hostEvidence: changedEvidence, files });
    const { review, changes } = mergeReview(await draftReview(changed, target), tracked);
    expect(changes).toEqual([
      "pgvector: licence notice changed: notices/pgvector.txt",
      "host requirements: libraries added: advapi32.dll",
    ]);
    const pending = review.licenseInventory.components.filter(component =>
      component.status === "pending"
    );
    expect(pending.map(component => component.id)).toEqual(["pgvector"]);
    for (const component of pending) {
      // The previous licences are a starting point; the evidence must be written again.
      expect(component).toMatchObject({ licenses: ["MIT"], evidence: [] });
    }
    expect(review.licenseInventory.status).toBe("pending");
    expect(review.hostRequirements.status).toBe("pending");
    expect(review.hostRequirements.libraries.map(library => library.license)).toEqual([
      "LicenseRef-Microsoft-Windows",
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
  "a new Visual Studio line and a changed runtime notice reopen the runtime review, and the line blocks releases",
  async () => {
    const target = "windows-x64";
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const tracked = complete((await draftReview(first, target)).review);

    const lineEvidence = toolchainParts[target][0]!.evidence;
    const newLine = hostEvidence[target].map(entry =>
      entry.component === lineEvidence ? { ...entry, version: "19" } : entry
    );
    const files = { "notices/msvc-runtime.txt": "a reworded notice" };
    const changed = await directory();
    await createCandidate(changed, target, { hostEvidence: newLine, files });
    const { review, changes } = mergeReview(await draftReview(changed, target), tracked);
    expect(changes).toEqual([
      "msvc-runtime: licence notice changed: notices/msvc-runtime.txt",
      "msvc-runtime: toolchain changed from 18 to 19",
    ]);

    // Completing the review is not enough: the new line's licence terms were never reviewed.
    const release = await releaseCandidate(complete(review), target, {
      hostEvidence: newLine,
      files,
    });
    await expect(validateArtifact(release, target)).rejects.toThrow(
      "Visual Studio product line 19 has no reviewed licence terms",
    );
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

    // A changed licence text reopens it with its licences as a starting point and no evidence.
    const files = { "notices/pgvector.txt": "a changed licence text" };
    const changed = await directory();
    await createCandidate(changed, target, { hostEvidence: hostEvidence[target], files });
    const reopened = mergeReview(await draftReview(changed, target), tracked);
    expect(reopened.changes).toEqual([
      "pgvector: licence notice changed: notices/pgvector.txt",
      "bundled-code: licence notice changed: notices/pgvector.txt",
    ]);
    expect(
      reopened.review.licenseInventory.components.find(component =>
        component.id === "bundled-code"
      ),
    ).toMatchObject({ status: "pending", licenses: ["MIT"], evidence: [] });

    // Files that no longer ship are removed from it; a component with none left is dropped.
    tracked.licenseInventory.components.push(
      handAdded("partly-retired", ["lib/vector.dll", "lib/retired.dll"]),
      handAdded("retired", ["lib/retired.dll"]),
    );
    const { review, changes } = mergeReview(await draftReview(first, target), tracked);
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
    // A reviewer cites the licence header of an SQL script, which no draft lists as a notice.
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
    const files = { [script]: "a changed licence header" };
    const changed = await directory();
    await createCandidate(changed, target, { hostEvidence: hostEvidence[target], files });
    const { review, changes } = mergeReview(await draftReview(changed, target), tracked);
    expect(changes).toEqual([id + ": licence notice changed: " + script]);
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
      "kernel32.dll, vcruntime140.dll, advapi32.dll",
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
      "kernel32.dll, vcruntime140.dll, advapi32.dll",
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
      hostEvidence: imports("kernel32.dll, vcruntime140.dll, mswsock.dll, advapi32.dll"),
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

it("a draft reports a tracked review that was never approved as a whole", async () => {
  const candidate = await directory();
  await createCandidate(candidate, "windows-x64", { hostEvidence: hostEvidence["windows-x64"] });
  const tracked = complete((await draftReview(candidate, "windows-x64")).review);
  tracked.licenseInventory.status = "pending";
  const { review, changes } = mergeReview(await draftReview(candidate, "windows-x64"), tracked);
  expect(review.licenseInventory.status).toBe("pending");
  expect(changes).toEqual(["licence inventory: not verified yet"]);
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
  pgvector.evidence = ["Compared the licence files of both releases"];
  const { review, changes } = mergeReview(await draftReview(candidate, "windows-x64"), tracked);
  expect(changes).toEqual(["pgvector: not verified yet"]);
  expect(review.licenseInventory.status).toBe("pending");
  expect(review.licenseInventory.components.find(component => component.id === "pgvector"))
    .toEqual(pgvector);
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
  "the review lists a Visual Studio edition that releases do not admit, whatever else it reopens",
  async () => {
    const target = "windows-x64";
    const first = await directory();
    await createCandidate(first, target, { hostEvidence: hostEvidence[target] });
    const tracked = complete((await draftReview(first, target)).review);

    // Build Tools of the reviewed line: the toolchain line is unchanged, so no component reopens for it.
    const buildTools = hostEvidence[target].map(entry =>
      entry.component === visualStudioEditionEvidence
        ? { ...entry, version: "Microsoft.VisualStudio.Product.BuildTools" }
        : entry
    );
    const edition = "release gate: Visual Studio edition Microsoft.VisualStudio.Product.BuildTools"
      + " is not admitted for releases; build with " + releaseVisualStudioEditions.join(", ");
    const files = { "notices/pgvector.txt": "a changed licence text" };
    const changed = await directory();
    await createCandidate(changed, target, { hostEvidence: buildTools, files });
    await expect(reviewCandidate(changed, target, tracked)).resolves.toMatchObject({
      changes: ["pgvector: licence notice changed: notices/pgvector.txt", edition],
    });
    await expect(reviewCandidate(changed, target, undefined)).resolves.toMatchObject({
      changes: ["no tracked review yet: every component needs a review", edition],
    });

    // When nothing reopens, the release gate names the same gap, which the review lists once.
    const same = await directory();
    await createCandidate(same, target, { hostEvidence: buildTools });
    await expect(reviewCandidate(same, target, tracked)).resolves.toMatchObject({
      changes: [edition],
    });
  },
  3 * twoCandidates,
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
    await writeFile(reviewFile, JSON.stringify(tracked));
    await expect(readTrackedReview(reviewFile)).rejects.toThrow(
      "duplicate license component: pgvector",
    );
  },
  twoCandidates,
);

it(
  "pending host requirements stay unresolved in the manifest while the reviewed licences still count",
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

it("a missing review file reads as none, and a malformed one is refused", async () => {
  const reviewFile = join(await directory(), "review.json");
  await expect(readTrackedReview(reviewFile)).resolves.toBeUndefined();

  const pending: Review = {
    licenseInventory: { status: "pending", components: [] },
    hostRequirements: { status: "pending", os: "", cpu: "", libraries: [] },
  };
  await writeFile(reviewFile, JSON.stringify(pending));
  await expect(readTrackedReview(reviewFile)).resolves.toEqual(pending);

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
      ...pending,
      hostRequirements: { ...pending.hostRequirements, libraries: [library] },
    }),
  );
  await expect(readTrackedReview(reviewFile)).rejects.toThrow(
    "invalid measured flag: kernel32.dll",
  );

  // The merge matches names case-insensitively and would carry only one of two entries forward.
  const glibc = { name: "glibc", requirement: "GLIBC_2.35 or newer", license: "", evidence: "" };
  await writeFile(
    reviewFile,
    JSON.stringify({
      ...pending,
      hostRequirements: {
        ...pending.hostRequirements,
        libraries: [glibc, { ...glibc, name: "GLIBC", requirement: "GLIBC_2.17 or newer" }],
      },
    }),
  );
  await expect(readTrackedReview(reviewFile)).rejects.toThrow("duplicate host library: GLIBC");

  await writeFile(reviewFile, JSON.stringify({ licenseInventory: pending.licenseInventory }));
  await expect(readTrackedReview(reviewFile)).rejects.toThrow("must contain licenseInventory");
});
