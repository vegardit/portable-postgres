/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Compares the review evidence in Git with a built payload and derives its manifest review state. */
import { join } from "node:path";
import * as z from "zod";
import { readOptionalText } from "../files.ts";
import { root } from "../paths.ts";
import { sources } from "../sources/sources.ts";
import {
  type ArtifactManifest,
  type ArtifactOptions,
  type ArtifactTarget,
  describeArtifact,
  firstIssue,
  type HostRequirements,
  isNativeImage,
  type LicenseInventory,
  licenseInventorySchema,
  macOSParserEvidence,
  measuredHostRequirements,
  payloadHashes,
  releaseLicenseGap,
  reviewedHostRequirementsSchema,
  sourceReviewGap,
  toolchainComponents,
  toolchainNotices,
  toolchainImages,
  validateArtifact,
  writeDescribedManifest,
} from "./artifact.ts";
import { compareOrdinal } from "./notice-scan.ts";
import {
  artifactTargets,
  librarySource,
  mingwRuntimeDlls,
  mingwSourcePrefix,
  sqlOnlyExtensions,
} from "./runtime-layout.ts";

/**
 * The tracked per-target review: the license inventory and host requirements for one payload file list.
 * Host requirements in a review file may stay pending while the manifest only records verified ones, and a
 * draft leaves the fields that a reviewer fills in empty. The manifest writer refuses a verified review
 * that still has empty fields.
 */
const reviewSchema = z.object({
  licenseInventory: licenseInventorySchema,
  hostRequirements: reviewedHostRequirementsSchema,
});
export type Review = z.infer<typeof reviewSchema>;
// A fresh review file records evidence. The build derives the corresponding manifest statuses.
const componentFields = licenseInventorySchema.shape.components.element.omit({ status: true });
const hostFields = reviewedHostRequirementsSchema.omit({ status: true });
const reviewTarget = z.enum(artifactTargets, "missing or unsupported review target");
const reviewFileSchema = z.object({
  target: reviewTarget,
  licenseInventory: z.object({
    components: z.array(componentFields.extend({
      licenses: componentFields.shape.licenses.transform(licenses =>
        licenses.toSorted(compareOrdinal)
      ),
      files: componentFields.shape.files.transform(files => files.toSorted(compareOrdinal)),
    })),
  }),
  hostRequirements: hostFields,
});

// Preserve an explicit pending decision when opening an older review. New files derive readiness
// from their evidence; the merge and release validator still check it against the actual payload.
const legacyStatus = z.enum(["pending", "verified"]).optional();
const readableReviewSchema = z.object({
  target: reviewTarget,
  licenseInventory: z.object({
    status: legacyStatus,
    components: z.array(componentFields.extend({ status: legacyStatus })),
  }),
  hostRequirements: hostFields.extend({ status: legacyStatus }),
}).transform(({ licenseInventory, hostRequirements }) => {
  const components = licenseInventory.components.map(component => ({
    ...component,
    status: component.status !== "pending" && component.licenses.length > 0
        && component.evidence.length > 0
      ? "verified" as const
      : "pending" as const,
  }));
  const hostComplete = hostRequirements.os.trim() && hostRequirements.cpu.trim()
    && hostRequirements.libraries.length > 0
    && hostRequirements.libraries.every(library =>
      library.requirement.trim() && library.license.trim() && library.evidence.trim()
    );
  return {
    licenseInventory: {
      components,
      status: licenseInventory.status !== "pending" && components.length > 0
          && components.every(component => component.status === "verified")
        ? "verified"
        : "pending",
    },
    hostRequirements: {
      ...hostRequirements,
      status: hostRequirements.status !== "pending" && hostComplete ? "verified" : "pending",
    },
  };
}).pipe(reviewSchema);
const pinnedSourceIds: ReadonlySet<string> = new Set(sources.map(source => source.id));
type ReviewedHostRequirements = Review["hostRequirements"];
type ReviewFile = z.input<typeof readableReviewSchema>;
type TrackedReview = { file: ReviewFile; review: Review };

/** Keep reviewer annotations and explicit legacy holds. Known build fields always come from the new draft. */
function reviewAnnotations(previous: object | undefined, fields: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(previous ?? {}).filter(([key, value]) =>
      !Object.hasOwn(fields, key) || (key === "status" && value === "pending")
    ),
  );
}

/** Produces a new review file using the current build and the annotations on surviving tracked records. */
export function reviewFileFor(
  target: ArtifactTarget,
  review: Review,
  previous?: ReviewFile,
): ReviewFile {
  const draft = reviewFileSchema.parse({ target, ...review });
  if (!previous) return draft;
  requireReviewTarget(previous.target, target);
  const inventory = previous.licenseInventory;
  const host = previous.hostRequirements;
  return {
    ...reviewAnnotations(previous, reviewFileSchema.shape),
    target,
    licenseInventory: {
      ...reviewAnnotations(inventory, licenseInventorySchema.shape),
      components: draft.licenseInventory.components.map(component => ({
        ...reviewAnnotations(inventory.components.find(part => part.id === component.id),
          licenseInventorySchema.shape.components.element.shape),
        ...component,
      })),
    },
    hostRequirements: {
      ...reviewAnnotations(host, reviewedHostRequirementsSchema.shape),
      ...draft.hostRequirements,
      libraries: draft.hostRequirements.libraries.map(library => ({
        ...reviewAnnotations(host.libraries.find(part => sameLibrary(part, library)),
          hostFields.shape.libraries.element.shape),
        ...library,
      })),
    },
  };
}

function requireReviewTarget(actual: ArtifactTarget, expected: ArtifactTarget): void {
  if (actual !== expected) throw new Error(`Review for ${actual} cannot be used for ${expected}`);
}

type Component = LicenseInventory["components"][number];

/**
 * A drafted review and the SHA-256 of every regular payload file of the candidate it describes. Any shipped
 * file can be a notice, so merging needs the hashes of files that no drafted component cites.
 */
export type Draft = {
  review: Review;
  payloadSha256: ReadonlyMap<string, string>;
  /** Example files of each source's notice signatures, which tell a reviewer where new license text is. */
  noticeExamples: ReadonlyMap<string, Readonly<Record<string, readonly string[]>>>;
};

/** Each target's tracked review lives next to its build recipe. */
export const reviewFiles: Record<ArtifactTarget, string> = {
  "linux-arm64-glibc": join(root, "binaries/linux/review-arm64-glibc.json"),
  "linux-x64-glibc": join(root, "binaries/linux/review-x64-glibc.json"),
  "linux-x64-musl": join(root, "binaries/linux/review-x64-musl.json"),
  "linux-arm64-musl": join(root, "binaries/linux/review-arm64-musl.json"),
  "windows-x64": join(root, "binaries/windows/review.json"),
  "macos-arm64": join(root, "binaries/macos/review.json"),
};

/** Reads the target's evidence and derives the initial status for comparison with a build. */
export async function readTrackedReview(
  path: string,
  target: ArtifactTarget,
): Promise<TrackedReview | undefined> {
  const text = await readOptionalText(path);
  if (text === undefined) return undefined;
  return parseReview(text, path, target);
}

/** Validates the same review format on disk, in Git, and in downloaded drafts. */
export function parseReview(text: string, path: string, target: ArtifactTarget): TrackedReview {
  const input: unknown = JSON.parse(text);
  const result = readableReviewSchema.safeParse(input);
  const problem = result.success
    ? sourceReviewGap(result.data.licenseInventory, pinnedSourceIds)
    : firstIssue(result.error);
  if (!result.success || problem !== undefined) {
    throw new Error(
      `Review file must contain licenseInventory and hostRequirements; ${problem}: ${path}`,
    );
  }
  // Keep the validated source record alongside the fields used to build the manifest.
  const file = input as ReviewFile;
  requireReviewTarget(file.target, target);
  return { file, review: result.data };
}

/**
 * Writes the manifest of a newly assembled candidate with the review that it can claim: the tracked review,
 * with every part that no longer matches the candidate reopened as pending. Without a tracked review the
 * build stays pending and host requirements stay `null`.
 */
export async function writeReviewedManifest(
  installation: string,
  options: Omit<ArtifactOptions, "licenseInventory" | "hostRequirements">,
  tracked: Review | undefined,
): Promise<ArtifactManifest> {
  const manifest = await describeArtifact(installation, options);
  if (tracked === undefined) return writeDescribedManifest(installation, manifest);
  // The candidate is drafted before the validation that writing runs, which still refuses whatever it
  // would refuse without a review; the draft only has to describe such a candidate without failing first.
  const { review } = mergeReview(await draftManifest(installation, manifest), tracked);
  return writeDescribedManifest(installation, { ...manifest, ...manifestReview(review) });
}

/**
 * The review as a manifest records it: pending host requirements are unresolved, so `null`, because the
 * manifest uses `null` for unresolved prerequisites.
 */
function manifestReview(review: Review): {
  licenseInventory: LicenseInventory;
  hostRequirements: HostRequirements | null;
} {
  const { status, ...host } = review.hostRequirements;
  return {
    licenseInventory: review.licenseInventory,
    hostRequirements: status === "verified" ? { status, ...host } : null,
  };
}

/** Returns why release validation would still reject the candidate with this review, if it would. */
export async function releaseReviewGap(
  installation: string,
  target: ArtifactTarget,
  review: Review,
): Promise<string | undefined> {
  return releaseLicenseGap(installation, target, manifestReview(review));
}

/**
 * Drafts a pending review for a validated candidate. It assigns every payload file to a component but
 * leaves licenses and evidence empty: source declarations do not establish the license of emitted files.
 */
export async function draftReview(installation: string, target: ArtifactTarget): Promise<Draft> {
  return draftManifest(
    installation,
    await validateArtifact(installation, target, { mode: "candidate" }),
  );
}

/** Drafts a pending review from the manifest of a candidate, which need not have been validated yet. */
async function draftManifest(installation: string, manifest: ArtifactManifest): Promise<Draft> {
  const target = manifest.target;
  const hashes = payloadHashes(manifest);
  // The review approves the license texts it reads, so the draft records which ones this build ships.
  // Validating the candidate reports a notice that does not ship as missing.
  const noticeSha256 = (notices: readonly string[]): Record<string, string> =>
    shippedNoticeSha256(hashes, notices);
  const noticeExamples = new Map<string, Record<string, string[]>>();
  const components: LicenseInventory["components"] = manifest.sources.map(source => {
    // PostgreSQL's source also builds the selected contrib modules, so one source can have several.
    const extensions = manifest.extensions.filter(candidate => candidate.sourceId === source.id);
    const examples = Object.fromEntries(
      source.noticeSignatures.map(({ signature, files }) => [signature, files]),
    );
    noticeExamples.set(source.id, examples);
    const compiler = target === "windows-x64" && !sqlOnlyExtensions.has(source.id)
      ? manifest.hostEvidence.find(entry => entry.component === mingwSourcePrefix + source.id)
      : undefined;
    return {
      id: source.id,
      ...compiler ? { toolchain: compiler.version } : {},
      licenses: [],
      status: "pending",
      files: [
        ...source.notices,
        ...extensions.flatMap(extension => [
          extension.control,
          ...extension.sql,
          ...extension.libraries,
        ]),
        ...manifest.files.filter(file => librarySource(file.path, target) === source.id)
          .map(file => file.path),
      ],
      notices: [...source.notices],
      noticeSha256: noticeSha256(source.notices),
      // The license text that the source tree carries, which the review covers along with the notices.
      noticeSignatures: Object.keys(examples),
      evidence: [],
    };
  });
  const assigned = new Set([
    ...components.flatMap(component => component.files),
    ...toolchainNotices(target),
    ...mingwRuntimeDlls,
  ]);
  // PostgreSQL's own build installs everything that no extension or notice accounts for.
  const postgresql = components.find(component => component.id === "postgresql")!;
  if (target === "macos-arm64") {
    const generators = manifest.hostEvidence.find(entry => entry.component === macOSParserEvidence);
    if (generators) postgresql.toolchain = generators.version;
  }
  postgresql.files.push(
    ...manifest.files.map(file => file.path).filter(path => !assigned.has(path)),
  );
  const images: string[] = [];
  const toolchainParts = toolchainComponents[target];
  if (toolchainParts.length > 0) {
    for (const file of manifest.files) {
      if (file.kind === "file" && await isNativeImage(join(installation, file.path))) {
        images.push(file.path);
      }
    }
  }
  for (const part of toolchainParts) {
    const toolchain = manifest.hostEvidence.find(entry => entry.component === part.evidence)
      ?.version;
    const notices = part.notice === undefined ? [] : [part.notice];
    components.push({
      id: part.id,
      licenses: [],
      status: "pending",
      files: [...notices, ...toolchainImages(part.id, images, target)],
      notices,
      noticeSha256: noticeSha256(notices),
      // A candidate without toolchain evidence still drafts; release validation then names the gap.
      ...toolchain === undefined ? {} : { toolchain },
      evidence: [],
    });
  }
  const libraries = measuredHostRequirements(manifest).map(library => ({
    ...library,
    license: "",
    evidence: "",
    measured: true,
  }));
  return {
    review: {
      licenseInventory: { status: "pending", components },
      hostRequirements: { status: "pending", os: "", cpu: "", libraries },
    },
    payloadSha256: hashes,
    noticeExamples,
  };
}

/**
 * Drafts the review of a candidate from the target's tracked review, if it has one, and lists what blocks
 * a release: the parts that the merge reopens, and, when the merge
 * reopens nothing, what the release gate would still reject.
 */
export async function reviewCandidate(
  installation: string,
  target: ArtifactTarget,
  tracked: Review | undefined,
): Promise<{ review: Review; changes: string[] }> {
  const draft = await draftReview(installation, target);
  const { review, changes } = tracked
    ? mergeReview(draft, tracked)
    : { review: draft.review, changes: ["no tracked review yet: every component needs a review"] };
  if (changes.length === 0) {
    // The merge only compares with the tracked review; the release gate also checks its completeness.
    const gap = await releaseReviewGap(installation, target, review);
    if (gap !== undefined) changes.push("release gate: " + gap);
  }
  return { review, changes };
}

const difference = (left: readonly string[], right: readonly string[]): string[] =>
  left.filter(value => !right.includes(value));

/** The SHA-256 of each notice that ships as a regular payload file; a notice that does not has none. */
function shippedNoticeSha256(
  payloadSha256: ReadonlyMap<string, string>,
  notices: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    notices.flatMap(notice => {
      const digest = payloadSha256.get(notice);
      return digest === undefined ? [] : [[notice, digest]];
    }),
  );
}

/** How many changed notice signatures a reopened component lists; a major update can change many. */
const listedSignatures = 20;

/**
 * How a reviewed component differs from the build: the reviewed values that a source or toolchain update
 * changed. Every list is empty while the review still describes the build. A signature is a file's normalized
 * notice lines, or a license file's path and digest (see notice-scan.ts).
 */
type ComponentDifference = {
  signaturesAdded: string[];
  signaturesGone: string[];
  noticesChanged: string[];
  filesAdded: string[];
  filesRemoved: string[];
  toolchain?: string;
};

function componentDifference(previous: Component, current: Component): ComponentDifference {
  const scanned = current.noticeSignatures ?? [];
  const reviewed = previous.noticeSignatures ?? [];
  return {
    signaturesAdded: difference(scanned, reviewed),
    signaturesGone: difference(reviewed, scanned),
    noticesChanged: [...new Set([...previous.notices, ...current.notices])].filter(notice =>
      previous.noticeSha256[notice] !== current.noticeSha256[notice]
      || previous.notices.includes(notice) !== current.notices.includes(notice)
    ),
    filesAdded: difference(current.files, previous.files),
    filesRemoved: difference(previous.files, current.files),
    ...previous.toolchain === current.toolchain ? {} : {
      toolchain: "toolchain changed from " + (previous.toolchain ?? "none") + " to "
        + (current.toolchain ?? "none"),
    },
  };
}

/**
 * Explains why a previously reviewed component no longer matches the build; empty when it still does. Each new
 * signature comes with files that carry it, so a reviewer knows where to read the new license text.
 */
function componentChanges(
  previous: Component,
  current: Component,
  examples?: Readonly<Record<string, readonly string[]>>,
): string[] {
  const change = componentDifference(previous, current);
  const shorten = (signature: string): string =>
    JSON.stringify(signature.length > 300 ? signature.slice(0, 300) + "…" : signature);
  const signatures = [
    ...change.signaturesAdded.map(signature => {
      const files = examples?.[signature] ?? [];
      return "license text added: " + shorten(signature)
        + (files.length > 0 ? " in " + files.join(", ") : "");
    }),
    ...change.signaturesGone.map(signature => "license text gone: " + shorten(signature)),
  ];
  return [
    ...signatures.length <= listedSignatures ? signatures : [
      ...signatures.slice(0, listedSignatures),
      `${signatures.length - listedSignatures} more notice signature changes`,
    ],
    ...change.noticesChanged.length > 0
      ? ["license notice changed: " + change.noticesChanged.join(", ")]
      : [],
    ...change.filesAdded.length > 0 ? ["files added: " + change.filesAdded.join(", ")] : [],
    ...change.filesRemoved.length > 0 ? ["files removed: " + change.filesRemoved.join(", ")] : [],
    ...change.toolchain === undefined ? [] : [change.toolchain],
  ];
}

/** The toolchain components of every target, which cover exactly the images that the draft finds. */
const toolchainIds: ReadonlySet<string> = new Set(
  Object.values(toolchainComponents).flatMap(parts => parts.map(part => part.id)),
);

/**
 * Carries a tracked review forward to a new draft. A component stays as reviewed while its files, license
 * texts and toolchain line are unchanged, and one that is still pending is listed as not verified yet; a
 * changed component is reopened with the current values and its previous licenses as a starting point.
 * Reopened components keep no evidence, because evidence must describe the review of the current values,
 * so the pull request must supply evidence for the changed payload.
 *
 * A reviewer can cite further notices on any component; a notice can be any shipped file, such as an SQL
 * script with a license header. A cited notice is kept while it ships, compared by its current hash.
 * A reviewer can also credit a drafted source component with further files, such as an extension library
 * that compiles code copied from PostgreSQL; such a credit is kept while its file ships.
 * Components that a reviewer added, such as code that a source bundles, have no counterpart in the
 * draft. They are compared with what the draft says ships: the files that still ship and their notices.
 * A component none of whose files still ship is dropped.
 */
export function mergeReview(
  { review: draft, payloadSha256, noticeExamples }: Draft,
  previous: Review,
): { review: Review; changes: string[] } {
  const changes: string[] = [];
  const reopen = (reviewed: Component, current: Component): Component => {
    const reasons = componentChanges(reviewed, current, noticeExamples.get(current.id));
    if (reasons.length === 0) {
      // A review in progress keeps its evidence, which still describes the same values.
      if (reviewed.status !== "verified") changes.push(reviewed.id + ": not verified yet");
      return reviewed;
    }
    changes.push(...reasons.map(reason => current.id + ": " + reason));
    return { ...current, licenses: [...reviewed.licenses], status: "pending", evidence: [] };
  };
  // A notice that no longer ships as a regular file has no hash, which reports it as changed, as the
  // release gate would reject it.
  const citing = (component: Component, notices: readonly string[]): Component => {
    const shipped = [...new Set(notices)].filter(notice => payloadSha256.has(notice));
    return {
      ...component,
      notices: shipped,
      noticeSha256: shippedNoticeSha256(payloadSha256, shipped),
    };
  };
  const shipped = new Set(draft.licenseInventory.components.flatMap(component => component.files));
  const components = draft.licenseInventory.components.map(current => {
    const reviewed = previous.licenseInventory.components.find(component =>
      component.id === current.id
    );
    if (reviewed === undefined) {
      changes.push(current.id + ": new component");
      return current;
    }
    // A toolchain component covers exactly the current images, which only the draft knows.
    const credited = toolchainIds.has(current.id)
      ? []
      : reviewed.files.filter(file => shipped.has(file) && !current.files.includes(file));
    return reopen(
      reviewed,
      citing({ ...current, files: [...current.files, ...credited] }, [
        ...current.notices,
        ...reviewed.notices,
      ]),
    );
  });
  for (const reviewed of previous.licenseInventory.components) {
    if (components.some(current => current.id === reviewed.id)) continue;
    const files = reviewed.files.filter(file => shipped.has(file));
    if (files.length === 0 || toolchainIds.has(reviewed.id)) {
      changes.push(reviewed.id + ": no longer shipped");
      continue;
    }
    components.push(reopen(reviewed, citing({ ...reviewed, files }, reviewed.notices)));
  }
  // Removing an entire component also changes the review, even if every remaining part matches.
  const verified = changes.length === 0 && previous.licenseInventory.status === "verified"
    && components.every(component => component.status === "verified");
  if (!verified && changes.length === 0) changes.push("license inventory: not verified yet");
  return {
    review: {
      licenseInventory: { status: verified ? "verified" : "pending", components },
      hostRequirements: mergeHostRequirements(draft, previous, changes),
    },
    changes,
  };
}

type HostLibrary = ReviewedHostRequirements["libraries"][number];

/** Library names compare case-insensitively, as Windows resolves DLL names and as the release gate matches them. */
const sameLibrary = (left: { name: string }, right: { name: string }): boolean =>
  left.name.toLowerCase() === right.name.toLowerCase();

/** Compares the build measurement with the previously reviewed host libraries. */
function hostLibraryChanges(
  current: readonly HostLibrary[],
  reviewed: readonly HostLibrary[],
): string[] {
  const added = current.filter(library => !reviewed.some(other => sameLibrary(library, other)))
    .map(library => library.name);
  // A build cannot measure manual prerequisites. An edited review can explicitly change or remove them.
  const removed = reviewed.filter(library =>
    library.measured === true
    && !current.some(other => sameLibrary(library, other))
  ).map(library => library.name);
  const edits = current.flatMap(library => {
    const earlier = reviewed.find(candidate => sameLibrary(candidate, library));
    if (!earlier) return [];
    const changes: string[] = [];
    if (library.requirement !== "" && library.requirement !== earlier.requirement) {
      changes.push(library.name + " now requires " + library.requirement);
    }
    return changes;
  });
  return [
    ...added.length > 0 ? ["libraries added: " + added.join(", ")] : [],
    ...removed.length > 0 ? ["libraries removed: " + removed.join(", ")] : [],
    ...edits,
  ];
}

/** Keeps reviewed host requirements while the required libraries and measured requirements match. */
function mergeHostRequirements(
  draft: Review,
  previous: Review,
  changes: string[],
): ReviewedHostRequirements {
  const current = draft.hostRequirements.libraries;
  const reviewed = previous.hostRequirements.libraries;
  // A library that a reviewer added, such as one that another library loads, is kept.
  const additions = reviewed.filter(library =>
    library.measured !== true && !current.some(other => sameLibrary(library, other))
  );
  const differences = hostLibraryChanges(current, reviewed);
  changes.push(...differences.map(change => "host requirements: " + change));
  const unchanged = differences.length === 0;
  if (unchanged && previous.hostRequirements.status === "verified") {
    return previous.hostRequirements;
  }
  if (unchanged) changes.push("host requirements: not verified yet");
  return {
    status: "pending",
    os: previous.hostRequirements.os,
    cpu: previous.hostRequirements.cpu,
    libraries: [
      ...current.map(library => {
        const earlier = reviewed.find(candidate => sameLibrary(candidate, library));
        if (!earlier) return library;
        // A reviewed entry keeps its origin, so one that a reviewer added stays when the import goes away.
        if (library.requirement === "" || library.requirement === earlier.requirement) {
          return earlier;
        }
        // The evidence described the earlier requirement. A review file is complete once every field
        // is filled in, so copying this draft unchanged would otherwise approve the new requirement.
        return { ...earlier, requirement: library.requirement, evidence: "" };
      }),
      ...additions,
    ],
  };
}
