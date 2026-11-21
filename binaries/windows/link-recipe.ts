/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Captures the MSVC environment and gives parallel Ninja links separate input records. */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileSha256 } from "../hash.ts";

export const linkEnvironmentFile = "windows-link-environment.txt";

/** Binds the map and the explicit and implicit library paths to the bytes produced by this link. */
export async function recordLink(output: string, searched: Iterable<string>): Promise<void> {
  const [imageHash, mapHash, data] = await Promise.all([
    fileSha256(output),
    fileSha256(output.slice(0, -extname(output).length) + ".map"),
    readFile(output + ".inputs"),
  ]);
  // MSVC encodes non-ASCII paths in its response file as UTF-16. Default libraries can carry an option prefix.
  const text = data.toString(
    data.length >= 2 && data.readUInt16LE(0) === 0xFE_FF ? "utf16le" : "utf8",
  );
  const libraries = new Set(searched);
  for (const line of text.split(/\r?\n/)) {
    const path = line.trim().replaceAll(/^"|"$/g, "").replace(/^[/-](?:defaultlib|wholearchive):/i,
      "");
    if (!/\.(?:a|lib)$/i.test(path)) continue;
    if (!isAbsolute(path)) throw new Error("Unresolved library path for " + output + ": " + path);
    libraries.add(path);
  }
  await writeFile(output + ".link.json",
    JSON.stringify({ imageHash, mapHash, libraries: [...libraries] }));
}

if (import.meta.main) {
  const [command, path] = process.argv.slice(2);
  if (command === "environment") {
    const lines = ["VCToolsInstallDir", "WindowsSDKVersion", "LIB"].map(name => {
      const value = process.env[name];
      if (!value) throw new Error("vcvars64 did not set " + name);
      return name + "=" + value;
    });
    await writeFile(join(process.env["PORTABLE_PG_WORK"]!, linkEnvironmentFile),
      lines.join("\r\n") + "\r\n");
  } else if (command === "ninja" && path) {
    // _LINK_ is shared by all jobs. Only Ninja knows the individual output path, including for rspfile links.
    const rules = await readFile(path, "utf8");
    const directory = dirname(path);
    const build = basename(directory) === "CMakeFiles" ? dirname(directory) : directory;
    const helper = 'node "' + relative(build, import.meta.filename) + '" trace ';
    const updated = rules.replaceAll(
      /^rule (?:c_LINKER(?:_RSP)?|C_(?:MODULE|SHARED)_LIBRARY_LINKER__\S+)\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|$))+/gm,
      rule => {
        // CMake hides successful linker stdout inside vs_link_dll. Trace the linker inside that command.
        const traced = rule.replace(/^( command = )("link")/m, "$1" + helper + "$out $2")
          .replace(/(-- )("[^"]*\\link\.exe")/i, "$1" + helper + "$TARGET_FILE $2");
        if (traced === rule) throw new Error("Unrecognized MSVC link command in " + path);
        return traced;
      },
    );
    if (updated === rules) throw new Error("No MSVC image link rule found in " + path);
    await writeFile(path, updated);
  } else if (command === "trace" && path) {
    const [program, ...args] = process.argv.slice(4);
    if (!program) throw new Error("Missing program for " + path);
    const child = spawn(program, args, {
      stdio: ["inherit", "pipe", "inherit"],
      env: {
        ...process.env,
        VSLANG: "1033",
        _LINK_: (process.env["_LINK_"] ?? "") + ' /LINKREPROFULLPATHRSP:"' + path + '.inputs"',
      },
    });
    child.stdout.pipe(process.stdout, { end: false });
    // The response file omits libraries requested by directives in COFF objects. Keep their resolved paths too.
    const searched = new Set<string>();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const [[code]] = await Promise.all([
      once(child, "close"),
      (async () => {
        for await (const line of lines) {
          const found = /^\s*Searching (.+\.(?:lib|a)):\s*$/i.exec(line);
          if (found) searched.add(resolve(found[1]!));
        }
      })(),
    ]);
    if (code === 0) await recordLink(path, searched);
    else process.exitCode = typeof code === "number" ? code : 1;
  } else {
    throw new Error("Expected environment, ninja <rules file>, or trace <output> <program> [args]");
  }
}
