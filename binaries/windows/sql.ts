/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sqlOnlyExtensions } from "../artifact/runtime-layout.ts";
import { sources } from "../sources/sources.ts";

/** Installs the PG18 SQL-only profiles; no pg_partman worker, Python helpers, or pgTAP runner is included. */
export async function installWindowsSql(sourceRoot: string, prefix: string): Promise<void> {
  const destination = join(prefix, "share/extension");
  await mkdir(destination, { recursive: true });
  for (const id of sqlOnlyExtensions) {
    const source = sources.find(candidate => candidate.id === id);
    if (!source) throw new Error("Missing SQL extension source pin: " + id);
    // pgmq keeps its extension beside client libraries that the runtime does not ship.
    const directory = id === "pgmq" ? join(sourceRoot, id, "pgmq-extension") : join(sourceRoot, id);
    await cp(join(directory, id + ".control"), join(destination, id + ".control"));
    if (id === "pgmq") {
      // As upstream's Makefile installs it: the current script under its version, and the upgrade scripts.
      await cp(
        join(directory, "sql/pgmq.sql"),
        join(destination, id + "--" + source.version + ".sql"),
      );
      for (const file of await readdir(join(directory, "sql"))) {
        if (file.includes("--") && file.endsWith(".sql")) {
          await cp(join(directory, "sql", file), join(destination, file));
        }
      }
    } else if (id === "pg_partman") {
      // Types and tables must exist before functions and procedures refer to them.
      const inputs: Buffer[] = [];
      for (const category of ["types", "tables", "functions", "procedures"]) {
        for (const file of (await readdir(join(directory, "sql", category))).sort()) {
          if (file.endsWith(".sql")) {
            inputs.push(await readFile(join(directory, "sql", category, file)));
          }
        }
      }
      await writeFile(
        join(destination, id + "--" + source.version + ".sql"),
        Buffer.concat(inputs),
      );
      for (const file of await readdir(join(directory, "updates"))) {
        if (file.endsWith(".sql")) {
          await cp(join(directory, "updates", file), join(destination, file));
        }
      }
    } else {
      // PG18 needs no compatibility patches. The template exposes a numeric major.minor version.
      const template = await readFile(join(directory, "sql/pgtap.sql.in"), "utf8");
      const sql = template.replaceAll("MODULE_PATHNAME", "pgtap")
        .replaceAll("__OS__", "mswin32")
        .replaceAll("__VERSION__", source.version.split(".").slice(0, 2).join("."));
      await writeFile(join(destination, id + "--" + source.version + ".sql"), sql);
      for (const file of await readdir(join(directory, "sql"))) {
        if (!file.includes("--")) continue;
        if (file.endsWith(".sql.in")) {
          await cp(join(directory, "sql", file), join(destination, file.slice(0, -3)));
        } else if (file.endsWith(".sql")) {
          await cp(join(directory, "sql", file), join(destination, file));
        }
      }
    }
  }
}
