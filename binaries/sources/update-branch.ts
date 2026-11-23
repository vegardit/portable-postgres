/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Refreshes the source updater's commit while preserving work reviewers push to the same pull request. */
import { appendFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { root } from "../paths.ts";
import { capture } from "../process.ts";
import { pinFiles } from "./update.ts";

const branch = "dependencies/sources";
const ref = "refs/heads/" + branch;
const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";
const subject = "chore: Update pinned sources";
const pins = Object.values(pinFiles).map(file => relative(root, file).split(sep).join("/"));

function git(repository: string, ...args: string[]): string {
  return capture("git", ["-C", repository, ...args]).trimEnd();
}

function remoteTip(repository: string): string {
  return git(repository, "ls-remote", "--heads", "origin", ref).split("\t")[0]!;
}

/** The inspected commit, an empty lease to create the branch, or undefined when a reviewer owns its changes. */
export function inspectUpdateBranch(repository: string, base: string): string | undefined {
  const tip = remoteTip(repository);
  if (!tip) return tip;
  git(repository, "fetch", "--no-tags", "origin", tip);
  const unmerged = git(repository, "rev-list", "--max-count=2", base + ".." + tip);
  if (!unmerged) return tip; // All of the old branch's work has reached the base.
  if (unmerged !== tip) return undefined;
  const identity = git(repository, "show", "-s", "--format=%ae%n%ce%n%s", tip);
  if (identity !== [botEmail, botEmail, subject].join("\n")) return undefined;
  const paths = git(repository, "diff-tree", "--no-commit-id", "--no-renames", "-r", "--name-only",
    tip);
  return paths !== "" && paths.split("\n").every(path => pins.includes(path)) ? tip : undefined;
}

/** A reviewer can push after inspection. Supply the exact inspected object ID, even when creating the ref. */
export function publishUpdateBranch(repository: string, expected: string, commit: string): boolean {
  const intended = git(repository, "rev-parse", "--verify", commit + "^{commit}");
  try {
    git(repository, "push", "--force-with-lease=" + ref + ":" + expected, "origin",
      intended + ":" + ref);
    return true;
  } catch (error) {
    // The server may have updated the ref before the connection failed.
    const observed = remoteTip(repository);
    if (observed === intended) return true;
    if (observed !== expected) return false;
    throw error;
  }
}

/** Publishes updated pins from the workflow checkout when its shared branch can be refreshed. */
export function refreshUpdateBranch(repository: string, baseRef: string, owner: string): boolean {
  if (!baseRef.startsWith("refs/heads/") || baseRef === "refs/heads/") {
    throw new Error("Select a branch ref as the base for the source-update pull request.");
  }
  if (baseRef === ref) {
    throw new Error("The source updater cannot use its own branch as the pull request base.");
  }
  // All bases share one head. Filter by repository owner so an identically named fork branch is independent.
  const bases = capture("gh", [
    "api",
    "--method",
    "GET",
    "--paginate",
    "repos/{owner}/{repo}/pulls",
    "-f",
    "state=open",
    "-f",
    "head=" + owner + ":" + branch,
    "--jq",
    ".[] | select(.head.repo.id == .base.repo.id) | .base.ref",
  ]);
  const conflict = bases.trimEnd().split(/\r?\n/).find(base =>
    base !== "" && "refs/heads/" + base !== baseRef
  );
  if (conflict) {
    throw new Error(branch + " already has an open pull request into " + conflict + ".");
  }
  const tip = inspectUpdateBranch(repository, "HEAD");
  if (tip === undefined) {
    console.log("Skipping the source update because the pull request contains reviewer changes.");
    return false;
  }
  git(repository, "-c", "user.name=github-actions[bot]", "-c", "user.email=" + botEmail, "commit",
    "--only", "-m", subject, "--", ...pins);
  // Reuse the open PR's commit when only the new commit's timestamp would differ.
  const same = tip !== ""
    && git(repository, "show", "-s", "--format=%P %T", tip)
      === git(repository, "show", "-s", "--format=%P %T", "HEAD");
  if (publishUpdateBranch(repository, tip, same ? tip : "HEAD")) return true;
  console.log(
    "Skipping the source update because the pull request branch changed during the refresh.",
  );
  return false;
}

if (import.meta.main) {
  const output = process.env["GITHUB_OUTPUT"];
  const baseRef = process.env["GITHUB_REF"];
  const owner = process.env["GITHUB_REPOSITORY_OWNER"];
  if (!output || !baseRef || !owner) {
    throw new Error("Missing GITHUB_OUTPUT, GITHUB_REF or GITHUB_REPOSITORY_OWNER");
  }
  if (refreshUpdateBranch(root, baseRef, owner)) {
    appendFileSync(output, `name=${branch}\n`);
  }
}
