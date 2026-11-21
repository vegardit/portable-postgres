/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Guards that a timed-out build step cannot leave the tools it started running, and how tool queries fail. */
import { once } from "node:events";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { capture, run } from "../binaries/process.ts";

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
  // Only the descendant holds the remote end. Its exit closes the connection even if it is still a zombie.
  let peer: Socket | undefined;
  let socketError: NodeJS.ErrnoException | undefined;
  const server = createServer(socket => {
    peer = socket;
    socket.on("error", error => {
      socketError = error;
    });
    socket.resume();
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    // A detached Windows child survives a parent-only kill, like a compiler started by cmd.exe.
    const parent = `
      require("node:child_process").spawn(process.execPath, [
        "-e", "require('node:net').connect(${port}, '127.0.0.1')"
      ], { detached: process.platform === "win32", stdio: "ignore" });
      setInterval(() => {}, 1000);`;
    await expect(run(process.execPath, ["-e", parent], { timeout: 5000 })).rejects.toThrow(
      "timed out",
    );
    expect(peer, "the descendant must connect before the timeout").toBeDefined();
    await expect.poll(() => peer?.closed, { timeout: 5000 }).toBe(true);
    if (socketError && socketError.code !== "ECONNRESET") throw socketError;
  } finally {
    // A surviving fixture exits when its only connection closes.
    peer?.destroy();
    server.close();
  }
}, 30_000);
