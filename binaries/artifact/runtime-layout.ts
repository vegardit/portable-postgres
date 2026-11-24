/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Defines the PostgreSQL runtime payload shared by assembly and artifact validation. */
import { posix } from "node:path";

/** Every target that the project builds and validates; a release needs an archive for each. */
export const artifactTargets = ["linux-x64-glibc", "windows-x64", "macos-arm64"] as const;
export type ArtifactTarget = (typeof artifactTargets)[number];

/** Narrows a command-line argument to a target. */
export function isArtifactTarget(value: string | undefined): value is ArtifactTarget {
  return (artifactTargets as ReadonlyArray<string | undefined>).includes(value);
}

/** The suffix of server modules and extension libraries, which PostgreSQL's DLSUFFIX sets per platform. */
export function moduleSuffix(target: ArtifactTarget): string {
  return target === "windows-x64" ? ".dll" : target === "macos-arm64" ? ".dylib" : ".so";
}

/** The client library that every runtime ships, by the name that programs load it under. */
export function clientLibraryPath(target: ArtifactTarget): string {
  return target === "windows-x64"
    ? "bin/libpq.dll"
    : target === "macos-arm64"
      ? "lib/libpq.5.dylib"
      : "lib/libpq.so.5";
}

export const extensionNames = {
  pgvector: "vector",
  timescaledb: "timescaledb",
  pg_textsearch: "pg_textsearch",
  hypopg: "hypopg",
  plpgsql_check: "plpgsql_check",
  pg_cron: "pg_cron",
  pg_partman: "pg_partman",
  pgtap: "pgtap",
  pgmq: "pgmq",
} as const;

/**
 * The modules from PostgreSQL's contrib directory that every runtime ships. PostgreSQL's own source builds
 * them, so they have no source pin of their own; every other contrib module stays out of the runtime.
 */
export const contribExtensions = [
  "btree_gist",
  "citext",
  "hstore",
  "ltree",
  "pg_stat_statements",
  "pg_trgm",
  "pgcrypto",
  "unaccent",
] as const;

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

/** Recognizes linked macOS client libraries by their versioned names or unversioned aliases. */
export function isMacOSClientLibrary(path: string): boolean {
  const stem = /^(.+?)(?:\.\d+)*\.dylib$/.exec(posix.basename(path))?.[1];
  return posix.dirname(path) === "lib" && stem !== undefined && clientLibrary.test(stem);
}

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
 * The server modules that every runtime must ship, without their `moduleSuffix`. The build installs
 * whatever it produced, so a module that is missing from it, such as one deleted from a reused SDK, would
 * otherwise pass unnoticed until a client asks for that conversion.
 */
export const requiredModules: readonly string[] = [...coreModules, ...encodingModules];
// Every encoding conversion module is named `<from>_and_<to>` except euc2004_sjis2004. The runtime keeps
// any module of that form, so a conversion that a later PostgreSQL release adds still ships; the list above
// only states what must be there.
const encodingModule = /^(?:[a-z0-9_]+_and_[a-z0-9_]+|euc2004_sjis2004)$/;
/** Extension sources that install only SQL and control files, without a native library. */
export const sqlOnlyExtensions: ReadonlySet<string> = new Set(["pg_partman", "pgtap", "pgmq"]);
/** Every extension that a runtime ships besides PL/pgSQL, as source ID and name, in manifest order. */
export const bundledExtensions: ReadonlyArray<readonly [string, string]> = [
  ...Object.entries(extensionNames),
  ...contribExtensions.map(name => ["postgresql", name] as const),
];

export const unaccentRules = "share/tsearch_data/unaccent.rules";

/** ICU's shared code and complete locale data, excluding build tools and optional I/O libraries. */
export function isIcuLibrary(path: string, target: ArtifactTarget): boolean {
  if (target === "windows-x64") return /^bin\/icu(?:uc|in|dt)\d+\.dll$/.test(path);
  return target === "macos-arm64"
    ? /^lib\/libicu(?:uc|i18n|data)(?:\.\d+)*\.dylib$/.test(path)
    : /^lib\/libicu(?:uc|i18n|data)\.so(?:\.\d+)*$/.test(path);
}

/** Identifies ICU's locale-data library, whose byte layout must contain no executable code. */
export function isIcuDataLibrary(path: string, target: ArtifactTarget): boolean {
  return isIcuLibrary(path, target)
    && (path.startsWith("bin/icudt") || path.startsWith("lib/libicudata"));
}

/** Names that the loader needs for the ICU major version recorded in a candidate's source pins. */
export function requiredIcuLibraries(target: ArtifactTarget, version: string): string[] {
  const major = version.split(".")[0]!;
  if (target === "windows-x64") return ["uc", "in", "dt"].map(part => `bin/icu${part}${major}.dll`);
  return ["uc", "i18n", "data"].map(part =>
    target === "macos-arm64" ? `lib/libicu${part}.${major}.dylib` : `lib/libicu${part}.so.${major}`
  );
}

/** The loader names of the two shared libraries for the pinned OpenSSL 3 ABI. */
export function opensslLibraries(target: ArtifactTarget): string[] {
  return ["ssl", "crypto"].map(name =>
    target === "windows-x64"
      ? `bin/lib${name}-3-x64.dll`
      : target === "macos-arm64"
        ? `lib/lib${name}.3.dylib`
        : `lib/lib${name}.so.3`
  );
}

/** Loader names of the shared libraries used by PostgreSQL's compression methods. */
export function compressionLibraries(target: ArtifactTarget): Record<"zlib" | "lz4", string> {
  if (target === "windows-x64") return { zlib: "bin/libz.dll", lz4: "bin/lz4.dll" };
  if (target === "macos-arm64") return { zlib: "lib/libz.1.dylib", lz4: "lib/liblz4.1.dylib" };
  return { zlib: "lib/libz.so.1", lz4: "lib/liblz4.so.1" };
}

/** Identifies runtime dependencies built separately from PostgreSQL and its extensions. */
export function librarySource(path: string, target: ArtifactTarget): string | undefined {
  for (const [source, library] of Object.entries(compressionLibraries(target))) {
    if (path === library) return source;
  }
  if (isIcuLibrary(path, target)) return "icu";
  if (opensslLibraries(target).includes(path)) return "openssl";
  return undefined;
}

export function includesRuntimePath(path: string, target: ArtifactTarget): boolean {
  if (librarySource(path, target)) return true;
  // ICU installs make fragments and data-building tools here; runtime data is in its shared library.
  if (/^share\/(?:icu|man)(?:\/|$)/.test(path)) return false;
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
    if (target === "macos-arm64" && isMacOSClientLibrary(path)) return true;
    // Only Linux client libraries have a version after the file suffix, such as libpq.so.5.
    const library = windows
      ? (/^(.+)\.dll$/.exec(name))
      : target === "macos-arm64"
        ? (/^(.+)\.dylib$/.exec(name))
        : (/^(.+)\.so((?:\.\d+)*)$/.exec(name));
    const stem = library?.[1];
    if (!stem) return false;
    if (target === "linux-x64-glibc" && clientLibrary.test(stem)) return true;
    if (library[2]) return false;
    return coreModule.test(stem) || encodingModule.test(stem)
      || bundledExtensions.some(([id, extension]) =>
        stem === extension && !sqlOnlyExtensions.has(id)
      )
      || /^timescaledb-\d+(?:\.\d+)*$/.test(stem)
      || (windows && stem === "pgevent");
  }
  if (path.startsWith("share/extension/")) {
    // Auxiliary controls can carry versioned settings, so they follow the same ownership as SQL.
    // CREATE EXTENSION reads only versioned scripts; an unversioned `<name>.sql`, which some make
    // installs add, is never loaded and would ship on one target only.
    const extension = (/^([a-z_]+)(?:(?:--[^/]+)?\.control|--[^/]+\.sql)$/.exec(name))?.[1];
    return directory === "share/extension" && extension !== undefined
      && (extension === "plpgsql"
        || bundledExtensions.some(([, selected]) => selected === extension));
  }
  if (path.startsWith("share/tsearch_data/")) {
    if (path === unaccentRules) return true;
    return directory === "share/tsearch_data"
      && /^(?:[a-z]+\.stop|(?:hunspell|ispell)_sample(?:_long|_num)?\.(?:affix|dict)|synonym_sample\.syn|thesaurus_sample\.ths)$/
        .test(name);
  }
  // The make and Meson installs provide different optional documentation. Notices are collected separately.
  return path !== "share/doc" && !path.startsWith("share/doc/");
}
