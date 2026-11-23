/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/**
 * Records the reviewer's approval of a locally edited review or a Build draft for the checked-out tree.
 * The committed review supplies earlier evidence. The working file supplies the bytes the reviewer may replace.
 */
import { constants as bufferLimits } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  approveReview,
  parseReview,
  readTrackedReview,
  type Review,
  reviewFiles,
} from "./artifact/review.ts";
import { readOptionalText, writeJson } from "./files.ts";
import { root } from "./paths.ts";
import { capture } from "./process.ts";

const usage =
  "Usage: pnpm binaries:approve linux-x64-glibc|windows-x64 [build-run-id] [--note text] [--yes]";
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { note: { type: "string" }, yes: { type: "boolean" } },
});
const [target, runId] = positionals;
if (
  (target !== "linux-x64-glibc" && target !== "windows-x64") || positionals.length > 2
  || (runId !== undefined && !/^\d+$/.test(runId))
) {
  throw new Error(usage);
}
const path = reviewFiles[target];
const original = await readOptionalText(path);
if (original === undefined) throw new Error("No review file to approve: " + path);
const working = parseReview(original, path);
const file = relative(root, path).replaceAll("\\", "/");
const head = capture("git", ["rev-parse", "HEAD"]).trim();
const changed = capture("git", ["status", "--porcelain", "--", file]).trim() !== "";
if (runId !== undefined && changed) {
  throw new Error("The review file has local changes that the run's draft lacks: " + path);
}
// An edited draft may have replaced all evidence of the preceding review in the working file.
let tracked: Review | undefined = working;
if (changed) {
  const exists = capture("git", ["ls-tree", "--name-only", head, "--", file]).trim() !== "";
  const blob = head + ":" + file;
  tracked = exists
    ? parseReview(capture("git", ["cat-file", "blob", blob], {
      maxBuffer: bufferLimits.MAX_STRING_LENGTH,
    }), blob)
    : undefined;
}

let review = working;
let source: string | undefined;
if (runId !== undefined) {
  // Resolve the checkout's configured GitHub repository once. An ambient GH_REPO can name a different checkout.
  const url = new URL(capture("gh", ["repo", "view", "--json", "url", "--jq", ".url"], {
    env: { ...process.env, GH_REPO: "" },
  }).trim());
  const repository = url.pathname.slice(1);
  const repoArgs = ["--repo", url.host + "/" + repository];
  const api = (endpoint: string): string =>
    capture("gh", ["api", `repos/${repository}/${endpoint}`, "--hostname", url.host]);
  const run = JSON.parse(api("actions/runs/" + runId)) as {
    repository: { full_name: string };
    path: string;
    head_sha: string;
    event: string;
    referenced_workflows?: Array<{ path: string; sha: string }>;
  };
  if (run.repository.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`Build run ${runId} belongs to another repository.`);
  }
  const build = ".github/workflows/build.yml";
  const workflow = run.path.split("@")[0];
  // Release calls the same local Build recipe at the caller's commit.
  const releaseBuild = workflow === ".github/workflows/release.yml"
    && run.event === "workflow_dispatch"
    && run.referenced_workflows?.some(ref =>
      ref.path.split("@")[0] === repository + "/" + build && ref.sha === run.head_sha
    );
  if (workflow !== build && !releaseBuild) {
    throw new Error(`Run ${runId} is not from this repository's Build workflow.`);
  }
  const directory = await mkdtemp(join(tmpdir(), "portable-postgres-approve-"));
  try {
    capture("gh", [
      "run",
      "download",
      runId,
      "--name",
      `review-draft-${target}`,
      "--dir",
      directory,
      ...repoArgs,
    ], { timeout: 120_000 });
    const prefix = join(directory, `review-draft-${target}`);
    // PR metadata names the head commit, while checkout normally builds GitHub's merge commit.
    const revision = (await readOptionalText(prefix + ".git"))?.trim();
    const identity = /^([a-f\d]{40})\r?\n([a-f\d]{40})$/.exec(revision ?? "");
    if (!identity) {
      throw new Error(
        `Build run ${runId} has no valid checkout tree record. Use a fresh Build run.`,
      );
    }
    const commit = identity[1]!;
    const tree = identity[2]!;
    if (tree !== capture("git", ["rev-parse", head + "^{tree}"]).trim()
      || (run.head_sha !== head && commit !== head))
    {
      throw new Error(
        `Build run ${runId} at ${commit} does not match this checkout's commit and tree. Update the branch and rebuild.`,
      );
    }
    if (run.event === "pull_request") {
      // GitHub expands github.sha in the job step name at run time. It still identifies the built merge
      // after the PR's live merge ref moves, even when the reviewer checked out only the PR head.
      const { jobs } = JSON.parse(
        capture("gh", ["run", "view", runId, ...repoArgs, "--json", "jobs"]),
      ) as {
        jobs: Array<{ name: string; steps: Array<{ name: string; conclusion: string }> }>;
      };
      const job = jobs.find(candidate => candidate.name === `Build (${target})`);
      if (!job?.steps.some(step =>
        step.name === "Report: licence review changes at " + commit && step.conclusion === "success"
      )) {
        throw new Error(
          `Build run ${runId} does not confirm the checkout commit. Use a fresh Build run.`,
        );
      }
      if (commit !== run.head_sha) {
        const merge = JSON.parse(api("git/commits/" + commit)) as {
          parents: Array<{ sha: string }>;
          tree: { sha: string };
        };
        if (merge.parents.length !== 2 || merge.parents[1]?.sha !== run.head_sha
          || merge.tree.sha !== tree)
        {
          throw new Error(`Build run ${runId} does not match the PR merge commit and tree.`);
        }
      }
    } else if (commit !== run.head_sha || head !== run.head_sha) {
      throw new Error(`Build run ${runId} does not match this checkout's commit.`);
    }
    const draft = await readTrackedReview(prefix + ".json");
    if (draft === undefined) {
      throw new Error(`Build run ${runId} has no review draft for ${target}`);
    }
    review = draft;
    source = `Build run ${runId} at ${commit.slice(0, 7)}`;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const { review: verified, approved } = approveReview(review, tracked, {
  date: new Date().toISOString().slice(0, 10),
  ...source === undefined ? {} : { source },
  ...values.note === undefined ? {} : { note: values.note },
});
// Hand edits can already contain the final bytes and still need the reviewer's confirmation.
if (approved.length === 0 && isDeepStrictEqual(verified, working)) {
  console.log(
    `Nothing to approve: ${file} is verified${
      runId === undefined ? "" : " and matches the build draft"
    }.`,
  );
} else {
  console.log(`Approving the licence review of ${target} (${file}):`);
  for (const part of approved) console.log("- " + part);
  if (!values.yes) {
    // A prompt that nobody can answer must not count as consent.
    if (!process.stdin.isTTY) throw new Error("Confirm in a terminal, or pass --yes");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question("Approve these parts as reviewed? [y/N] ");
    prompt.close();
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error("Not approved; nothing written.");
  }
  if (capture("git", ["rev-parse", "HEAD"]).trim() !== head) {
    throw new Error("The checkout changed during approval. Check the review and approve again.");
  }
  await writeJson(path, verified, original);
  console.log(`Approved. Commit ${file} to release builds with this review.`);
}
