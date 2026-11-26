/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Checks that an Apache-only TimescaleDB build is refused once it compiles code under the Timescale License. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { requireApacheOnlyTimescaleDB } from "../binaries/timescaledb.ts";
import { temporaryDirectories } from "./temporary-directories.ts";

const { directory, cleanup } = temporaryDirectories("timescaledb");
afterEach(cleanup);

it("a TimescaleDB build that compiles a file under tsl/ is refused, however the database names it", async () => {
  const work = await directory();
  const source = join(work, "sources", "timescaledb");
  const build = join(work, "timescaledb-build");
  await mkdir(build, { recursive: true });
  await mkdir(join(source, "src", "loader"), { recursive: true });
  const apache = "This file and its contents are licensed under the Apache License 2.0.";
  const tsl = "This file and its contents are licensed under the Timescale License.";
  const unit = join(source, "src", "hypertable.c");
  await writeFile(unit, `/* ${apache} */\nint hypertable;\n/* ${tsl} */\n`);
  await writeFile(join(source, "src", "loader", "tsl_stub.c"), `/* ${apache} */\n`);
  const database = (entries: Array<{ directory: string; file: string }>) =>
    writeFile(join(build, "compile_commands.json"), JSON.stringify(entries));

  await database([
    { directory: build, file: join(source, "src", "hypertable.c") },
    // The TSL loader stub in the Apache source tree is not TSL code.
    { directory: join(source, "src"), file: "loader/tsl_stub.c" },
  ]);
  await expect(requireApacheOnlyTimescaleDB(build, source)).resolves.toBeUndefined();

  // A changed license on an existing translation unit leaves its compile database entry unchanged.
  await writeFile(unit,
    `/*\n * ${tsl}\n * Please see the included NOTICE.\n */\nint hypertable;\n`);
  await expect(requireApacheOnlyTimescaleDB(build, source)).rejects.toThrow(
    "compiled code under the Timescale License:\n" + unit,
  );
  await writeFile(unit, `/* ${apache} */\nint hypertable;\n`);

  await database([
    { directory: build, file: join(source, "src", "hypertable.c") },
    { directory: join(source, "src"), file: "../tsl/src/compression/compression.c" },
  ]);
  await expect(requireApacheOnlyTimescaleDB(build, source)).rejects.toThrow(
    "compiled code under the Timescale License:\n"
      + join(source, "tsl", "src", "compression", "compression.c"),
  );

  await database([]);
  await expect(requireApacheOnlyTimescaleDB(build, source)).rejects.toThrow("compiled nothing");
});
