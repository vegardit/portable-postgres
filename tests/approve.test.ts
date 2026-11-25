/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Exercises approval through its CLI with a real checkout and a local substitute for GitHub's artifact download. */
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Review } from "../binaries/artifact/review.ts";
import { capture } from "../binaries/process.ts";

it("approves the checked build tree or a locally edited draft against its committed baseline",
  async () => {
    const checkout = await mkdtemp(join(tmpdir(), "portable-postgres-approve-test-"));
    const args = process.argv;
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const log = vi.spyOn(console, "log");
    const target = "linux-x64-glibc";
    const path = join(checkout, "binaries/linux/review.json");
    const git = (...command: string[]) => capture("git", ["-C", checkout, ...command]).trim();
    const commit = (message: string) => git("commit", "--allow-empty", "-qm", message);
    const original: Review = {
      licenseInventory: {
        status: "verified",
        components: [{
          id: "pgvector",
          files: ["notice"],
          notices: ["notice"],
          noticeSignatures: [],
          noticeSha256: { notice: "1".repeat(64) },
          licenses: ["MIT"],
          evidence: ["Reviewed grant."],
          status: "verified",
        }],
      },
      hostRequirements: { status: "verified", libraries: [], os: "Linux", cpu: "x64" },
    };
    const draft = structuredClone(original);
    draft.licenseInventory.status = "pending";
    const vector = draft.licenseInventory.components[0]!;
    vector.status = "pending";
    vector.evidence = [];
    vector.noticeSha256["notice"] = "2".repeat(64);
    const cli = async (...positionals: string[]) => {
      vi.resetModules();
      process.argv = [process.execPath, "approve.ts", target, ...positionals];
      await import("../binaries/approve.ts");
    };
    try {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
      await mkdir(join(checkout, "binaries/linux"), { recursive: true });
      await writeFile(path, JSON.stringify(original));
      git("init", "-q");
      git("config", "user.name", "fixture");
      git("config", "user.email", "test@example.invalid");
      git("config", "commit.gpgsign", "false");
      git("add", ".");
      commit("common base");
      const base = git("rev-parse", "HEAD");
      commit("PR head");
      const head = git("rev-parse", "HEAD");
      const headTree = git("rev-parse", "HEAD^{tree}");
      git("checkout", "-q", "--detach", base);
      await writeFile(join(checkout, "base-only"), "change from the base branch");
      git("add", "base-only");
      commit("advanced base");
      git("merge", "--no-ff", "-qm", "PR merge", head);
      let built = git("rev-parse", "HEAD");
      let builtTree = git("rev-parse", "HEAD^{tree}");
      let checkoutSha = built;
      const repository = "example/portable-postgres";
      const workflow = ".github/workflows/build.yml";
      const references: Array<{ path: string; sha: string }> = [];
      const run = {
        repository: { full_name: repository },
        path: workflow,
        head_sha: head,
        event: "pull_request",
        referenced_workflows: references,
      };
      git("checkout", "-q", "--detach", head);
      vi.doMock(import("../binaries/paths.ts"),
        () => ({ root: checkout, workRoot: checkout, outputRoot: checkout }));
      vi.doMock(import("../binaries/process.ts"), async importOriginal => ({
        ...await importOriginal(),
        capture(command: string, options: readonly string[]) {
          if (command === "git") return capture("git", ["-C", checkout, ...options]);
          if (command === "gh" && options[0] === "repo") return "https://github.com/" + repository;
          if (command === "gh" && options[0] === "api") {
            if (options[1] === `repos/${repository}/actions/runs/123`) return JSON.stringify(run);
            if (options[1] === `repos/${repository}/git/commits/${built}`) {
              return JSON.stringify({
                tree: { sha: git("rev-parse", built + "^{tree}") },
                parents: git("show", "-s", "--format=%P", built).split(" ").map(sha => ({ sha })),
              });
            }
            throw new Error("Unexpected endpoint: " + options[1]);
          }
          if (command === "gh" && options[1] === "view") {
            return JSON.stringify({
              headSha: run.head_sha,
              jobs: [{
                name: `Build (${target})`,
                steps: [{
                  name: "Report: licence review changes at " + checkoutSha,
                  conclusion: "success",
                }],
              }],
            });
          }
          if (command !== "gh" || options[1] !== "download") {
            throw new Error("Unexpected tool: " + command);
          }
          const dir = options[options.indexOf("--dir") + 1]!;
          writeFileSync(join(dir, "review-draft-" + target + ".json"), JSON.stringify(draft));
          writeFileSync(join(dir, "review-draft-" + target + ".git"),
            built + "\n" + builtTree + "\n");
          return "";
        },
      }));
      await expect(cli("123", "--yes")).rejects.toThrow(/tree/);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
      const rejectRun = async (reason: RegExp) => {
        await expect(cli("123", "--yes")).rejects.toThrow(reason);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
      };
      // A forged tree in the sidecar cannot hide the extra file in GitHub's merge commit.
      builtTree = headTree;
      await rejectRun(/tree/);
      built = head;
      run.path = ".github/workflows/update-sources.yml";
      await rejectRun(/workflow/);
      run.path = workflow;
      run.event = "push";
      run.head_sha = base;
      await rejectRun(/commit/);
      run.repository.full_name = "other/portable-postgres";
      await rejectRun(/repository/);
      run.repository.full_name = repository;
      run.head_sha = head;
      run.path = ".github/workflows/release.yml";
      run.event = "workflow_dispatch";
      await rejectRun(/workflow/);
      run.referenced_workflows = [{
        path: repository + "/" + workflow + "@refs/heads/main",
        sha: head,
      }];
      await cli("123", "--yes");
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        licenseInventory: { status: "verified" },
      });
      await writeFile(path, JSON.stringify(original));
      run.path = workflow;
      run.event = "pull_request";
      // The mock job records the checkout independently of the downloaded sidecar.
      await rejectRun(/commit/);
      git("checkout", "-q", "--detach", base);
      commit("base with the same tree");
      git("merge", "--no-ff", "-qm", "PR merge with the same tree", head);
      built = git("rev-parse", "HEAD");
      builtTree = git("rev-parse", "HEAD^{tree}");
      checkoutSha = built;
      expect(builtTree).toBe(headTree);
      run.head_sha = base;
      await rejectRun(/commit/);
      run.head_sha = head;
      await cli("123", "--yes");
      await writeFile(path, JSON.stringify(original));
      git("checkout", "-q", "--detach", head);
      await cli("123", "--yes");
      const saved = async () =>
        (JSON.parse(await readFile(path, "utf8")) as Review).licenseInventory.components[0]!;
      expect((await saved()).evidence.at(-1)).toContain("Build run 123 at " + built.slice(0, 7));
      await writeFile(path, JSON.stringify(draft));
      await cli("--yes");
      await expect(saved()).resolves.toMatchObject({
        status: "verified",
        noticeSha256: vector.noticeSha256,
        evidence: ["Reviewed grant.", expect.stringContaining("accepted licence notice changed")],
      });
      const relabelled = JSON.parse(await readFile(path, "utf8")) as Review;
      relabelled.licenseInventory.components[0]!.licenses = ["BSD-3-Clause"];
      // The first approval is still uncommitted. Its dated entry accepted the old licence.
      const withoutReason = JSON.stringify(relabelled);
      await writeFile(path, withoutReason);
      await expect.soft(cli("--yes")).rejects.toThrow(/changed licences need new evidence/);
      await expect.soft(readFile(path, "utf8")).resolves.toBe(withoutReason);
      relabelled.licenseInventory.components[0]!.evidence.push("Read the BSD grant.");
      const editedBytes = JSON.stringify(relabelled);
      await writeFile(path, editedBytes);
      log.mockClear();
      await expect.soft(cli()).rejects.toThrow("Confirm in a terminal");
      expect.soft(log.mock.calls.flat()).toContain(
        "- pgvector: BSD-3-Clause, accepting licence notice changed: notice",
      );
      await expect(readFile(path, "utf8")).resolves.toBe(editedBytes);
      await cli("--yes");
      const hostOnly = structuredClone(original);
      hostOnly.hostRequirements.status = "pending";
      const pendingHost = JSON.stringify(hostOnly);
      await writeFile(path, pendingHost);
      await expect.soft(cli("--yes", "--note", "Checked the host.")).rejects.toThrow(/--note/);
      await expect.soft(readFile(path, "utf8")).resolves.toBe(pendingHost);
      await writeFile(path, JSON.stringify(original));
      log.mockClear();
      await cli();
      expect(log.mock.calls.flat()).toContain(
        "Nothing to approve: binaries/linux/review.json is verified.",
      );
    } finally {
      log.mockRestore();
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      process.argv = args;
      vi.doUnmock("../binaries/process.ts");
      vi.doUnmock("../binaries/paths.ts");
      vi.resetModules();
      await rm(checkout, { recursive: true, force: true });
    }
  }, 30_000);
