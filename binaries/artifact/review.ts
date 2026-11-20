/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Reads tracked licence reviews into builds and drafts new reviews from a candidate; drafts never approve anything. */
import { join } from "node:path";
import * as z from "zod";
import { readOptionalText } from "../files.ts";
import { root } from "../paths.ts";
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
  measuredHostRequirements,
  payloadHashes,
  releaseLicenseGap,
  reviewedHostRequirementsSchema,
  toolchainComponents,
  toolchainNotices,
  validateArtifact,
  visualStudioReleaseGap,
  writeDescribedManifest,
} from "./artifact.ts";

/**
 * The tracked per-target review: the licence inventory and host requirements for one payload file list.
 * Host requirements in a review file may stay pending while the manifest only records verified ones, and a
 * draft leaves the fields that a reviewer fills in empty. The manifest writer refuses a verified review
 * that still has empty fields.
 */
const reviewSchema = z.object({
  licenseInventory: licenseInventorySchema,
  hostRequirements: reviewedHostRequirementsSchema,
});
export type Review = z.infer<typeof reviewSchema>;
type ReviewedHostRequirements = Review["hostRequirements"];

type Component = LicenseInventory["components"][number];

/**
 * A drafted review and the SHA-256 of every regular payload file of the candidate it describes. Any shipped
 * file can be a notice, so merging needs the hashes of files that no drafted component cites.
 * `toolchainGap` says why releases refuse the toolchain that built the candidate, such as Visual Studio
 * Build Tools; no review can resolve it, and a review that matches still leaves it in place.
 */
export type Draft = {
  review: Review;
  payloadSha256: ReadonlyMap<string, string>;
  toolchainGap?: string;
};

/** Each target's tracked review lives next to its build recipe. */
export const reviewFiles: Record<ArtifactTarget, string> = {
  "linux-x64-glibc": join(root, "binaries/linux/review.json"),
  "windows-x64": join(root, "binaries/windows/review.json"),
};

/** Returns the tracked review as written, or `undefined` while a target has none. */
export async function readTrackedReview(path: string): Promise<Review | undefined> {
  const text = await readOptionalText(path);
  if (text === undefined) return undefined;
  const review: unknown = JSON.parse(text);
  // The merge keeps a library without the measured flag as one that a reviewer added, and it rewrites this
  // file from what it read, so a file of another shape must stop here.
  const result = reviewSchema.safeParse(review);
  if (!result.success) {
    throw new Error(
      `Review file must contain licenseInventory and hostRequirements; ${
        firstIssue(result.error)
      }: ${path}`,
    );
  }
  // The file's own object, not the parsed copy, so that keys this version does not know stay in the review.
  return review as Review;
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
 * leaves licences and evidence empty: source declarations do not establish the licence of emitted files.
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
  // The review approves the licence texts it reads, so the draft records which ones this build ships.
  // Validating the candidate reports a notice that does not ship as missing.
  const noticeSha256 = (notices: readonly string[]): Record<string, string> =>
    shippedNoticeSha256(hashes, notices);
  const components: LicenseInventory["components"] = manifest.sources.map(source => {
    const extension = manifest.extensions.find(candidate => candidate.sourceId === source.id);
    return {
      id: source.id,
      licenses: [],
      status: "pending",
      files: [
        ...source.notices,
        ...extension ? [extension.control, ...extension.sql, ...extension.libraries] : [],
      ],
      notices: [...source.notices],
      noticeSha256: noticeSha256(source.notices),
      evidence: [],
    };
  });
  const assigned = new Set([
    ...components.flatMap(component => component.files),
    ...toolchainNotices(target),
  ]);
  // PostgreSQL's own build installs everything that no extension or notice accounts for.
  components.find(component => component.id === "postgresql")!.files.push(
    ...manifest.files.map(file => file.path).filter(path => !assigned.has(path)),
  );
  const images: string[] = [];
  for (const file of manifest.files) {
    if (file.kind === "file" && await isNativeImage(join(installation, file.path))) {
      images.push(file.path);
    }
  }
  for (const part of toolchainComponents[target]) {
    const toolchain = manifest.hostEvidence.find(entry => entry.component === part.evidence)
      ?.version;
    const notices = part.notice === undefined ? [] : [part.notice];
    components.push({
      id: part.id,
      licenses: [],
      status: "pending",
      files: [...notices, ...images],
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
  const toolchainGap = target === "windows-x64"
    ? visualStudioReleaseGap(manifest.hostEvidence)
    : undefined;
  return {
    review: {
      licenseInventory: { status: "pending", components },
      hostRequirements: { status: "pending", os: "", cpu: "", libraries },
    },
    payloadSha256: hashes,
    ...toolchainGap === undefined ? {} : { toolchainGap },
  };
}

/**
 * Drafts the review of a candidate from the target's tracked review, if it has one, and lists what blocks
 * a release: the parts that the merge reopens, a toolchain that releases refuse, and, when the merge
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
    // It reports only its first gap, which may be the toolchain gap listed below.
    const gap = await releaseReviewGap(installation, target, review);
    if (gap !== undefined && gap !== draft.toolchainGap) changes.push("release gate: " + gap);
  }
  // The reviewed toolchain line can match while the edition is refused, so no reopened part names it.
  if (draft.toolchainGap !== undefined) changes.push("release gate: " + draft.toolchainGap);
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

/** Explains why a previously reviewed component no longer matches the build; empty when it still does. */
function componentChanges(previous: Component, current: Component): string[] {
  const changes: string[] = [];
  const changedNotices = [...new Set([...previous.notices, ...current.notices])].filter(notice =>
    previous.noticeSha256[notice] !== current.noticeSha256[notice]
  );
  if (changedNotices.length > 0) {
    changes.push("licence notice changed: " + changedNotices.join(", "));
  }
  const added = difference(current.files, previous.files);
  const removed = difference(previous.files, current.files);
  if (added.length > 0) changes.push("files added: " + added.join(", "));
  if (removed.length > 0) changes.push("files removed: " + removed.join(", "));
  if (previous.toolchain !== current.toolchain) {
    changes.push(
      "toolchain changed from " + (previous.toolchain ?? "none") + " to "
        + (current.toolchain ?? "none"),
    );
  }
  return changes;
}

/** The toolchain components of every target, which cover exactly the images that the draft finds. */
const toolchainIds: ReadonlySet<string> = new Set(
  Object.values(toolchainComponents).flatMap(parts => parts.map(part => part.id)),
);

/**
 * Carries a tracked review forward to a new draft. A component stays as reviewed while its files, licence
 * texts and toolchain line are unchanged, and one that is still pending is listed as not verified yet; a
 * changed component is reopened with the current values and its previous licences as a starting point.
 * Reopened components keep no evidence, because evidence must describe the review of the current values,
 * and only `verified` approves them.
 *
 * A reviewer can cite further notices on any component; a notice can be any shipped file, such as an SQL
 * script with a licence header. A cited notice is kept while it ships, compared by its current hash.
 * A reviewer can also credit a drafted source component with further files, such as an extension library
 * that compiles code copied from PostgreSQL; such a credit is kept while its file ships.
 * Components that a reviewer added, such as code that a source bundles, have no counterpart in the
 * draft. They are compared with what the draft says ships: the files that still ship and their notices.
 * A component none of whose files still ship is dropped.
 */
export function mergeReview(
  { review: draft, payloadSha256 }: Draft,
  previous: Review,
): { review: Review; changes: string[] } {
  const changes: string[] = [];
  const reopen = (reviewed: Component, current: Component): Component => {
    const reasons = componentChanges(reviewed, current);
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
    if (files.length === 0) {
      changes.push(reviewed.id + ": no longer shipped");
      continue;
    }
    components.push(reopen(reviewed, citing({ ...reviewed, files }, reviewed.notices)));
  }
  const verified = previous.licenseInventory.status === "verified"
    && components.every(component => component.status === "verified");
  // Verified parts do not release anything while the inventory as a whole still awaits approval.
  if (!verified && changes.length === 0) changes.push("licence inventory: not verified yet");
  return {
    review: {
      licenseInventory: { status: verified ? "verified" : "pending", components },
      hostRequirements: mergeHostRequirements(draft, previous, changes),
    },
    changes,
  };
}

/**
 * Keeps reviewed host requirements while the required libraries and measured requirements match. Library
 * names compare case-insensitively, as Windows resolves DLL names and as the release gate matches them.
 */
function mergeHostRequirements(
  draft: Review,
  previous: Review,
  changes: string[],
): ReviewedHostRequirements {
  const current = draft.hostRequirements.libraries;
  const reviewed = previous.hostRequirements.libraries;
  const same = (left: { name: string }, right: { name: string }): boolean =>
    left.name.toLowerCase() === right.name.toLowerCase();
  const added = current.filter(library => !reviewed.some(other => same(library, other)))
    .map(library => library.name);
  // Only a measured library that the build no longer needs reopens the review. One that a reviewer added,
  // such as a library that another one loads, is kept.
  const unmeasured = reviewed.filter(library => !current.some(other => same(library, other)));
  const removed = unmeasured.filter(library => library.measured === true).map(library =>
    library.name
  );
  const additions = unmeasured.filter(library => library.measured !== true);
  const requirements = current.filter(library => {
    const earlier = reviewed.find(candidate => same(candidate, library));
    // Only measured requirements are drafted; the others are a reviewer's statement.
    return earlier !== undefined && library.requirement !== ""
      && library.requirement !== earlier.requirement;
  });
  if (added.length > 0) changes.push("host requirements: libraries added: " + added.join(", "));
  if (removed.length > 0) {
    changes.push("host requirements: libraries removed: " + removed.join(", "));
  }
  for (const library of requirements) {
    changes.push("host requirements: " + library.name + " now requires " + library.requirement);
  }
  const unchanged = added.length === 0 && removed.length === 0 && requirements.length === 0;
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
        const earlier = reviewed.find(candidate => same(candidate, library));
        return earlier
          // A reviewed entry keeps its origin, so one that a reviewer added stays when the import goes away.
          ? { ...earlier, requirement: library.requirement || earlier.requirement }
          : library;
      }),
      ...additions,
    ],
  };
}
