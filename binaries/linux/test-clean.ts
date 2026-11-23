/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Tests a trusted native archive in a pinned consumer image without Node.js, compilers, or network access. */
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setReadablePermissions } from "../artifact/assemble.ts";
import { assertNativeTapFiles } from "../native-proof.ts";
import baseline from "./base.json" with { type: "json" };
import { fileSha256 } from "../hash.ts";
import { outputRoot, root } from "../paths.ts";
import { capture } from "../process.ts";

const archiveArgument = process.argv[2];
if (!archiveArgument) {
  throw new Error("Usage: pnpm binaries:test:linux:clean <trusted-native-archive.tar.gz>");
}
const archive = resolve(archiveArgument);
const image = baseline.image;
const archiveSha256 = await fileSha256(archive);
const output = outputRoot;
await mkdir(output, { recursive: true });
const evidence = await mkdtemp(join(output, "consumer-proof-"));
const fixture = join(evidence, "proof");
await mkdir(join(fixture, "binaries/linux"), { recursive: true });
await mkdir(join(fixture, "tests"), { recursive: true });
await cp(join(root, "binaries/linux/smoke.sh"), join(fixture, "binaries/linux/smoke.sh"));
await cp(join(root, "tests/native"), join(fixture, "tests/native"), { recursive: true });
// docker cp keeps these modes, and the proof reads the scripts as nobody, so a restrictive umask must
// not decide them. The evidence directory around the fixture stays private.
await setReadablePermissions(fixture);

function docker(args: string[]): string {
  return capture("docker", args, { timeout: 180_000 });
}

// The shell command is fixed; the archive path is passed to docker cp as a separate argument.
const container = docker([
  "create",
  "--platform",
  "linux/amd64",
  "--network",
  "none",
  "--env",
  "NATIVE_CLEAN_CONSUMER=1",
  "--entrypoint",
  "bash",
  image,
  "-c",
  "mkdir -p /opt/installation && tar -xzf /tmp/installation.tar.gz -C /opt/installation && exec bash /proof/binaries/linux/smoke.sh /opt/installation",
]).trim();
/** Copies only the diagnostic directory from the reported proof stage, which excludes its credentials. */
function retainLogs(
  outputLog: string,
  marker: "NATIVE_PROOF_DIRECTORY=" | "Native proof evidence: ",
): void {
  const logs = outputLog.split(/\r?\n/).find(line => line.startsWith(marker))?.slice(marker.length);
  if (!logs || !/^\/tmp\/portable-postgres-proof\.\w+\/logs$/.test(logs)) {
    throw new Error("The clean native consumer did not report " + marker.trimEnd());
  }
  docker(["cp", container + ":" + logs + "/.", evidence]);
}
let failed = false;
let cleanupFailure: Error | undefined;
try {
  await writeFile(
    join(evidence, "consumer.json"),
    JSON.stringify({ container, image, archiveSha256 }, null, 2),
  );
  docker(["cp", archive, container + ":/tmp/installation.tar.gz"]);
  docker(["cp", fixture, container + ":/proof"]);
  const outputLog = docker(["start", "--attach", container]);
  console.log(outputLog);
  await writeFile(join(evidence, "consumer.log"), outputLog);
  if (docker(["inspect", "--format", "{{.State.ExitCode}}", container]).trim() !== "0") {
    throw new Error("The clean native consumer exited unsuccessfully");
  }
  // Only the final marker proves that the standalone pg_textsearch run and shutdown finished.
  retainLogs(outputLog, "NATIVE_PROOF_DIRECTORY=");
  await assertNativeTapFiles(evidence);
} catch (error) {
  failed = true;
  // Capture diagnostics from Docker before removing this proof's container.
  await writeFile(join(evidence, "failure.log"), String(error)).catch(
    (diagnosticError: unknown) => {
      console.warn("Could not save clean consumer diagnostics", diagnosticError);
    },
  );
  try {
    // Docker keeps stdout even when the attached client times out or the exit-status check fails.
    retainLogs(docker(["logs", container]), "Native proof evidence: ");
  } catch (diagnosticError) {
    console.warn("Could not retain clean consumer diagnostics", diagnosticError);
  }
  console.error(`Clean native consumer evidence: ${evidence}`);
  throw error;
} finally {
  try {
    docker(["rm", "--force", container]);
  } catch (error) {
    cleanupFailure = error as Error;
    if (failed) console.warn(`Could not remove clean consumer container ${container}`, error);
  }
}
if (cleanupFailure) throw cleanupFailure;
console.log("Clean native consumer passed; retained evidence: " + evidence);
