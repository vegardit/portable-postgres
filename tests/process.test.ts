/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Guards that a timed-out build step cannot leave the tools it started running, and how tool queries fail. */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { capture, run } from "../binaries/process.ts";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A killed orphan stays a zombie until init reaps it, which a container's init may never do.
  if (process.platform !== "linux") return true;
  try {
    return !/^\d+ \(.*\) Z /s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

it("a tool query returns what the tool printed", () => {
  expect(capture(process.execPath, ["-e", "console.log('18.1.8')"]).trim()).toBe("18.1.8");
});

it("a failed tool query reports the exit status and what the tool wrote", () => {
  const failing = "console.error('no such instance'); process.exit(3)";
  expect(() => capture(process.execPath, ["-e", failing])).toThrow(
    /failed \(3\)\nno such instance$/,
  );
  expect(() => capture(join(tmpdir(), "portable-postgres-no-such-tool"), [])).toThrow("ENOENT");
});

it("a timeout stops the programs that the build step started", async () => {
  const directory = await mkdtemp(join(tmpdir(), "portable-postgres-process-"));
  const pidFile = join(directory, "descendant.pid");
  // On Windows a Node child would die with its Node parent through libuv's job object;
  // a detached child behaves like a compiler started by cmd.exe and survives on its own.
  const parent = `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: process.platform === "win32",
      stdio: "ignore",
    });
    require("node:fs").writeFileSync(process.env.DESCENDANT_PID_FILE, String(descendant.pid));
    setInterval(() => {}, 1000);`;
  let descendant: number | undefined;
  try {
    await expect(
      run(process.execPath, ["-e", parent], {
        env: { ...process.env, DESCENDANT_PID_FILE: pidFile },
        timeout: 5000,
      }),
    ).rejects.toThrow("timed out");
    expect(existsSync(pidFile), "the descendant must start before the timeout").toBe(true);
    descendant = Number(readFileSync(pidFile, "utf8"));
    for (let wait = 0; wait < 50 && isRunning(descendant); wait++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(isRunning(descendant)).toBe(false);
  } finally {
    if (descendant !== undefined && isRunning(descendant)) process.kill(descendant, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
