/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Runs build tools from the repository root and fails on any unsuccessful exit. */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { root } from "./paths.ts";

/** A native build step may run for a long time, but a hung tool must not block a build forever. */
const buildTimeout = 1_800_000;

/** Parallel compile jobs for every build script; CI sets BUILD_JOBS to the runner's processor count. */
export function buildJobs(): string {
  const jobs = process.env["BUILD_JOBS"] ?? "4";
  if (!/^[1-9]\d*$/.test(jobs)) throw new Error("BUILD_JOBS must be a positive integer: " + jobs);
  return jobs;
}

/** POSIX children get their own process group so that one signal reaches every descendant. */
const ownGroup = process.platform !== "win32";

/**
 * Stops a child and everything it started. Killing only the direct child would leave compilers
 * running, because neither cmd.exe nor a shell passes its termination on to the programs it runs.
 */
function stopTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const taskkill = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe");
    const result = spawnSync(taskkill, ["/T", "/F", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 60_000,
    });
    if (result.status !== 0) child.kill();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Runs a short query of a tool and returns what it printed. It buffers the output and stops only the tool
 * itself on a timeout, so builds and anything that starts further programs belong to `run`.
 */
export function capture(
  command: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options,
    timeout: options.timeout ?? 60_000,
  });
  // Covers a tool that is not installed and one that ran into the timeout.
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const failure = `${command} ${args.join(" ")} failed (${result.signal ?? result.status})`;
    const output = [result.stderr, result.stdout].map(text => text.trim()).filter(Boolean);
    throw new Error([failure, ...output].join("\n"));
  }
  return result.stdout;
}

export async function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdout?: "inherit" | number; timeout?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? buildTimeout;
  const child = spawn(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: ["inherit", options.stdout ?? "inherit", "inherit"],
    windowsHide: true,
    detached: ownGroup,
  });
  // A separate process group no longer receives terminal interrupts, so they are passed on.
  const forward = (signal: NodeJS.Signals): void => stopTree(child, signal);
  const signals: NodeJS.Signals[] = ownGroup ? ["SIGINT", "SIGTERM", "SIGHUP"] : [];
  for (const signal of signals) process.on(signal, forward);
  const deadline = { passed: false };
  const timer = setTimeout(() => {
    deadline.passed = true;
    stopTree(child, "SIGKILL");
  }, timeout);
  try {
    const [status, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, exitSignal) => resolve([code, exitSignal]));
      },
    );
    if (deadline.passed) throw new Error(`${command} timed out after ${timeout} ms`);
    if (status !== 0) throw new Error(`${command} failed (${signal ?? status})`);
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.off(signal, forward);
  }
}
