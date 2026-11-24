/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Proves a relocated Windows runtime with native SQL and TAP; this harness retains owned failure evidence. */
import { spawnSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { validateArtifact } from "../artifact/artifact.ts";
import {
  assertNativeTap,
  isPortFailure,
  nativeTests,
  serverSettings,
  textsearchSettings,
} from "../native-proof.ts";
import { lastCandidate } from "../package.ts";
import { outputRoot } from "../paths.ts";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Windows x64 is required.");
}
const installation = resolve(
  process.argv[2] ?? await lastCandidate(join(outputRoot, "windows-x64")),
);
const output = join(outputRoot, "windows-x64");
await validateArtifact(installation, "windows-x64", { mode: "candidate" });
await mkdir(output, { recursive: true });
const proof = await mkdtemp(join(output, "native proof-"));
const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith("PG") && key.toUpperCase() !== "ICU_DATA"
  ),
);
env["LC_ALL"] = "C";
// Restrict DLL/tool search to the candidate and Windows; developer tools must not make this proof pass.
env["PATH"] = [join(installation, "bin"), join(systemRoot, "System32"), systemRoot].join(";");

function run(
  command: string,
  args: string[],
  log: string,
  expectedStatus: number | number[] = 0,
  // TAP output must contain only TAP lines; a psql notice or warning on stderr would break strict parsing.
  options: { separateStderr?: boolean } = {},
): { status: number | null; stdout: string } {
  const logPath = join(proof, log);
  const errorPath = options.separateStderr ? logPath + ".stderr.log" : logPath;
  const logFile = openSync(logPath, "w");
  const errors = options.separateStderr ? openSync(errorPath, "w") : logFile;
  let result;
  try {
    // Windows descendants can retain pipe handles after pg_ctl exits. Real files let startup finish.
    result = spawnSync(command, args, {
      cwd: proof,
      env,
      stdio: ["ignore", logFile, errors],
      windowsHide: true,
      timeout: 180_000,
    });
  } finally {
    closeSync(logFile);
    if (errors !== logFile) closeSync(errors);
  }
  if (result.error) throw result.error;
  if (
    !(Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus]).includes(
      result.status ?? -1,
    )
  ) {
    throw new Error(
      log + " failed; inspect " + logPath + (errorPath === logPath ? "" : " and " + errorPath),
    );
  }
  return { status: result.status, stdout: readFileSync(logPath, "utf8") };
}
const executable = (name: string): string => join(installation, "bin", name + ".exe");
const data = join(proof, "data");
const pgCtl = executable("pg_ctl");
const stopArgs = ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"];
const server = { starting: false };
try {
  const identity = run(join(systemRoot, "System32/whoami.exe"), [], "identity.log").stdout.trim();
  run(join(systemRoot, "System32/icacls.exe"), [
    proof,
    "/inheritance:r",
    "/grant:r",
    identity + ":(OI)(CI)F",
  ], "acl.log");
  const password = randomBytes(24).toString("hex");
  const passwordFile = join(proof, "password");
  const pgpass = join(proof, "pgpass");
  await writeFile(passwordFile, password + "\n");
  run(executable("initdb"), [
    "-D",
    data,
    "-U",
    "proof",
    "--pwfile=" + passwordFile,
    "--auth-host=scram-sha-256",
    "--auth-local=scram-sha-256",
    "--encoding=UTF8",
    "--no-locale",
  ], "initdb.log");
  await appendFile(join(data, "postgresql.conf"), await readFile(serverSettings, "utf8"));
  /** Starts the cluster on a free port with the given server log. */
  const startServer = async (logName: string): Promise<number> => {
    const serverLog = join(proof, logName);
    server.starting = true;
    for (let attempt = 1;; attempt++) {
      const port = randomInt(16_384, 49_152);
      const startup = run(
        pgCtl,
        [
          "-D",
          data,
          "-l",
          serverLog,
          "-o",
          "-p " + port,
          "-w",
          "-t",
          "30",
          "start",
        ],
        "start.log",
        [0, 1],
      );
      if (startup.status === 0) return port;
      // A retry may only follow an unusable port with no running server in this cluster.
      if (
        attempt >= 4
        || !existsSync(serverLog)
        || !isPortFailure(await readFile(serverLog, "utf8"))
        || run(pgCtl, ["-D", data, "status"], "start-status.log", [0, 3]).status !== 3
      ) {
        throw new Error(
          `PostgreSQL startup failed; inspect ${join(proof, "start.log")} and ${serverLog}`,
        );
      }
      await rename(serverLog, join(proof, `${basename(logName, ".log")}-${attempt}.log`));
      await rename(join(proof, "start.log"), join(proof, `start-${attempt}.log`));
    }
  };
  const connect = (port: number, database: string, host = "127.0.0.1"): string[] => [
    "-X",
    "-w",
    "-h",
    host,
    "-p",
    String(port),
    "-U",
    "proof",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
  ];
  const port = await startServer("server.log");
  // Any port and database: every start picks a free port, and the pg_textsearch run uses its own database.
  await writeFile(pgpass, "127.0.0.1:*:*:proof:" + password + "\n");
  env["PGPASSFILE"] = pgpass;
  const connection = connect(port, "postgres");
  run(executable("psql"), [...connection, "-f", join(nativeTests, "smoke.sql")], "sql.log");
  const client = ["-w", "-h", "127.0.0.1", "-p", String(port), "-U", "proof"];
  for (const codec of ["gzip", "lz4"]) {
    const database = "restore_" + codec;
    const archive = join(proof, codec + ".dump");
    const backup = join(proof, "backup-" + codec);
    run(executable("pg_dump"), [
      ...client,
      "-d",
      "postgres",
      "-Fc",
      "--compress=" + codec,
      "-t",
      "public.compression_sample",
      "-f",
      archive,
    ], codec + "-dump.log");
    run(executable("createdb"), [...client, database], codec + "-createdb.log");
    run(executable("pg_restore"), [...client, "--exit-on-error", "-d", database, archive],
      codec + "-restore.log");
    run(executable("psql"), [
      ...connect(port, database),
      "-f",
      join(nativeTests, "compression.sql"),
    ], codec + "-rows.log");
    run(executable("pg_basebackup"), [
      ...client,
      "-D",
      backup,
      "-Ft",
      "-X",
      "none",
      "--checkpoint=fast",
      "--compress=" + codec,
    ], codec + "-backup.log");
    const suffix = codec === "gzip" ? "gz" : codec;
    if ((await stat(join(backup, "base.tar." + suffix))).size === 0) {
      throw new Error("Empty base backup");
    }
    run(executable("pg_verifybackup"), ["--no-parse-wal", backup], codec + "-verifybackup.log");
  }
  const tap = run(
    executable("psql"),
    [
      ...connection,
      "-qAt",
      "-f",
      join(nativeTests, "tap.sql"),
    ],
    "results.tap",
    0,
    { separateStderr: true },
  );
  const failure = run(
    executable("psql"),
    [
      ...connection,
      "-qAt",
      "-f",
      join(nativeTests, "tap-failure.sql"),
    ],
    "failure.tap",
    0,
    { separateStderr: true },
  );
  await assertNativeTap(tap.stdout, failure.stdout);
  env["PGPASSFILE"] = join(proof, "no-credentials");
  const denied = run(executable("psql"), [...connection, "-c", "SELECT 1"], "denied.log", 2);
  if (!denied.stdout.includes("fe_sendauth: no password supplied")) {
    throw new Error(
      `Expected PostgreSQL to require a password; inspect ${join(proof, "denied.log")}`,
    );
  }
  run(pgCtl, stopArgs, "stop.log");
  run(pgCtl, ["-D", data, "status"], "status.log", 3);
  // Users may preload pg_textsearch alone, so it must not depend on TimescaleDB, which the run above
  // also preloads.
  env["PGPASSFILE"] = pgpass;
  await appendFile(join(data, "postgresql.conf"), await readFile(textsearchSettings, "utf8"));
  const tls = join(nativeTests, "tls");
  await copyFile(join(tls, "server-cn-only+server_ca.crt"), join(data, "server.crt"));
  await copyFile(join(tls, "server-cn-only.key"), join(data, "server.key"));
  await copyFile(join(tls, "pg_hba.conf"), join(data, "pg_hba.conf"));
  const textsearchPort = await startServer("server-textsearch.log");
  const hostname = "common-name.pg-ssltest.test";
  await appendFile(pgpass, hostname + ":*:*:proof:" + password + "\n");
  // Keep every case on the owned server, including the deliberately wrong hostname.
  env["PGHOSTADDR"] = "127.0.0.1";
  env["PGSSLMODE"] = "verify-full";
  // Keep libpq from reading the developer's certificates or revocation list. The proof uses no CRL.
  env["PGSSLROOTCERT"] = join(tls, "root_ca.crt");
  env["PGSSLCERTMODE"] = "disable";
  env["PGSSLCRL"] = join(proof, "no.crl");
  run(
    executable("psql"),
    [
      ...connect(textsearchPort, "postgres", hostname),
      "-q",
      "-c",
      "CREATE DATABASE textsearch_only",
    ],
    "textsearch-database.log",
  );
  run(
    executable("psql"),
    [
      ...connect(textsearchPort, "textsearch_only", hostname),
      "-f",
      join(nativeTests, "textsearch.sql"),
    ],
    "textsearch.log",
  );
  const tlsArgs = (host: string): string[] => [
    ...connect(textsearchPort, "postgres", host),
    "-qAt",
    "-c",
  ];
  const query = "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()";
  const connected = run(executable("psql"), [...tlsArgs(hostname), query], "tls.log");
  if (connected.stdout.trim() !== "t") throw new Error("Expected an encrypted connection");
  const expectDenied = (host: string, log: string, reason: string): void => {
    const result = run(executable("psql"), [...tlsArgs(host), "SELECT 1"], log, 2);
    if (!result.stdout.includes(reason)) throw new Error("Expected " + reason + " in " + log);
  };
  expectDenied("wrong.test", "tls-hostname.log", "does not match host name");
  env["PGSSLROOTCERT"] = join(tls, "client_ca.crt");
  expectDenied(hostname, "tls-ca.log", "certificate verify failed");
  env["PGSSLMODE"] = "disable";
  expectDenied(hostname, "tls-plaintext.log", "no encryption");
  run(pgCtl, stopArgs, "textsearch-stop.log");
  run(pgCtl, ["-D", data, "status"], "textsearch-status.log", 3);
  server.starting = false;
  console.log("Windows native SQL and TAP proof passed: " + proof);
} catch (error) {
  try {
    if (
      server.starting
      && run(pgCtl, ["-D", data, "status"], "failure-status.log", [0, 3]).status === 0
    ) {
      // This fresh data directory is owned by this proof, including a partially successful startup.
      run(pgCtl, stopArgs, "failure-stop.log");
    }
  } catch (cleanupError) {
    console.error(`Could not clean up the PostgreSQL proof at ${proof}`, cleanupError);
  }
  throw error;
}
