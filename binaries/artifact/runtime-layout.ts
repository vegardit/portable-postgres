/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Defines the PostgreSQL runtime payload shared by assembly and artifact validation. */
import { posix } from "node:path";

/** Every target that the project builds and validates; a release also needs targets without a recipe yet. */
export const artifactTargets = ["linux-x64-glibc", "windows-x64"] as const;
export type ArtifactTarget = (typeof artifactTargets)[number];

export const extensionNames = {
  pgvector: "vector",
  timescaledb: "timescaledb",
  pg_textsearch: "pg_textsearch",
  hypopg: "hypopg",
  plpgsql_check: "plpgsql_check",
  pg_cron: "pg_cron",
  pg_partman: "pg_partman",
  pgtap: "pgtap",
} as const;

export const corePrograms = [
  "clusterdb",
  "createdb",
  "createuser",
  "dropdb",
  "dropuser",
  "ecpg",
  "initdb",
  "pg_amcheck",
  "pg_archivecleanup",
  "pg_basebackup",
  "pg_checksums",
  "pg_combinebackup",
  "pg_config",
  "pg_controldata",
  "pg_createsubscriber",
  "pg_ctl",
  "pg_dump",
  "pg_dumpall",
  "pg_isready",
  "pg_receivewal",
  "pg_recvlogical",
  "pg_resetwal",
  "pg_restore",
  "pg_rewind",
  "pg_test_fsync",
  "pg_test_timing",
  "pg_upgrade",
  "pg_verifybackup",
  "pg_waldump",
  "pg_walsummary",
  "pgbench",
  "postgres",
  "psql",
  "reindexdb",
  "vacuumdb",
] as const;

const clientLibrary = /^lib(?:ecpg(?:_compat)?|pgtypes|pq)$/;
/** The server modules outside conversion_procs that PostgreSQL always builds. */
const coreModules = ["dict_snowball", "libpqwalreceiver", "pgoutput", "plpgsql"] as const;
const coreModule = new RegExp("^(?:" + coreModules.join("|") + ")$");
/** The conversion_procs modules of PostgreSQL 18; the server loads them when a client converts encodings. */
const encodingModules = [
  "cyrillic_and_mic",
  "euc2004_sjis2004",
  "euc_cn_and_mic",
  "euc_jp_and_sjis",
  "euc_kr_and_mic",
  "euc_tw_and_big5",
  "latin2_and_win1250",
  "latin_and_mic",
  "utf8_and_big5",
  "utf8_and_cyrillic",
  "utf8_and_euc2004",
  "utf8_and_euc_cn",
  "utf8_and_euc_jp",
  "utf8_and_euc_kr",
  "utf8_and_euc_tw",
  "utf8_and_gb18030",
  "utf8_and_gbk",
  "utf8_and_iso8859",
  "utf8_and_iso8859_1",
  "utf8_and_johab",
  "utf8_and_sjis",
  "utf8_and_sjis2004",
  "utf8_and_uhc",
  "utf8_and_win",
] as const;
/**
 * The server modules that every runtime must ship, without their `.so` or `.dll` suffix. The build installs
 * whatever it produced, so a module that is missing from it, such as one deleted from a reused SDK, would
 * otherwise pass unnoticed until a client asks for that conversion.
 */
export const requiredModules: readonly string[] = [...coreModules, ...encodingModules];
// Every encoding conversion module is named `<from>_and_<to>` except euc2004_sjis2004. The runtime keeps
// any module of that form, so a conversion that a later PostgreSQL release adds still ships; the list above
// only states what must be there.
const encodingModule = /^(?:[a-z0-9_]+_and_[a-z0-9_]+|euc2004_sjis2004)$/;
/** Extension sources that install only SQL and control files, without a native library. */
export const sqlOnlyExtensions: ReadonlySet<string> = new Set(["pg_partman", "pgtap"]);
const nativeExtensions = Object.entries(extensionNames)
  .filter(([source]) => !sqlOnlyExtensions.has(source))
  .map(([, name]) => name);
const sqlExtensions = new Set(["plpgsql", ...Object.values(extensionNames)]);

export function includesRuntimePath(path: string, target: ArtifactTarget): boolean {
  const windows = target === "windows-x64";
  const directory = posix.dirname(path);
  const name = posix.basename(path);
  if (path.startsWith("bin/")) {
    return directory === "bin"
      && (corePrograms.some(program => name === program + (windows ? ".exe" : ""))
        || (windows && name.endsWith(".dll") && clientLibrary.test(name.slice(0, -4))));
  }
  if (path.startsWith("lib/")) {
    if (directory !== "lib") return false;
    const library = windows ? (/^(.+)\.dll$/.exec(name)) : (/^(.+)\.so((?:\.\d+)*)$/.exec(name));
    const stem = library?.[1];
    if (!stem) return false;
    if (!windows && clientLibrary.test(stem)) return true;
    if (library[2]) return false;
    return coreModule.test(stem) || encodingModule.test(stem)
      || nativeExtensions.some(extension => stem === extension)
      || /^timescaledb-\d+(?:\.\d+)*$/.test(stem)
      || (windows && stem === "pgevent");
  }
  if (path.startsWith("share/extension/")) {
    // Auxiliary controls can carry versioned settings, so they follow the same ownership as SQL.
    // CREATE EXTENSION reads only versioned scripts; an unversioned `<name>.sql`, which some make
    // installs add, is never loaded and would ship on one target only.
    const extension = (/^([a-z_]+)(?:(?:--[^/]+)?\.control|--[^/]+\.sql)$/.exec(name))?.[1];
    return directory === "share/extension" && extension !== undefined
      && sqlExtensions.has(extension);
  }
  if (path.startsWith("share/tsearch_data/")) {
    return directory === "share/tsearch_data"
      && /^(?:[a-z]+\.stop|(?:hunspell|ispell)_sample(?:_long|_num)?\.(?:affix|dict)|synonym_sample\.syn|thesaurus_sample\.ths)$/
        .test(name);
  }
  // The make and Meson installs provide different optional documentation. Notices are collected separately.
  return path !== "share/doc" && !path.startsWith("share/doc/");
}
