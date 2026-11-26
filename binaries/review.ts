/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Writes a license review draft for a built candidate. It starts from the target's tracked review and
 * reopens only what changed, so a person reviews and verifies just the reopened parts.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  readTrackedReview,
  reviewCandidate,
  reviewFiles,
  reviewFileFor,
} from "./artifact/review.ts";
import { artifactTargets, isArtifactTarget } from "./artifact/runtime-layout.ts";
import { lastCandidate } from "./package.ts";
import { outputRoot } from "./paths.ts";
import { isLinuxTarget, linuxTargets } from "./linux/target.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { output: { type: "string" }, summary: { type: "string" } },
});
const [target, installation] = positionals;
if (!isArtifactTarget(target)) {
  throw new Error(
    `Usage: pnpm binaries:review ${artifactTargets.join("|")} [installation]`
      + " [--output draft.json] [--summary summary.md]",
  );
}
const output = join(outputRoot, isLinuxTarget(target) ? linuxTargets[target].output : target);
const candidate = resolve(installation ?? await lastCandidate(output));
const tracked = await readTrackedReview(reviewFiles[target], target);
const { review, changes } = await reviewCandidate(candidate, target, tracked?.review);
const path = values.output ? resolve(values.output) : join(output, "review-draft.json");
// A supplied installation needs no build here, so the default draft's directory may not exist yet.
if (!values.output) await mkdir(output, { recursive: true });
const draft = reviewFileFor(target, review, tracked?.file);
// Never replace an earlier draft, which may already hold review notes.
await writeFile(path, JSON.stringify(draft, null, 2) + "\n", { flag: "wx" });

const verdict = changes.length === 0
  ? "The tracked review passes the automated license checks for this build."
  : "These parts need a review before the next release:";
console.log("Wrote a review draft: " + path);
console.log(verdict);
for (const change of changes) console.log("- " + change);
if (values.summary) {
  await appendFile(
    values.summary,
    [
      `### License review: ${target}`,
      "",
      verdict,
      ...changes.length === 0 ? [] : ["", ...changes.map(change => "- " + change)],
      "",
    ].join("\n") + "\n",
  );
}
