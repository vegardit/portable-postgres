/** Limits test discovery to project-owned tests; upstream checkouts are read-only research inputs. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["_refs/**", "binaries/work/**", "binaries/output/**", "dist/**", "node_modules/**"],
    // Many tests hash and validate whole fixture candidates, which can take longer than Vitest's default of
    // five seconds on a busy host. Tests that build several candidates set a longer limit of their own.
    testTimeout: 30_000,
  },
});
