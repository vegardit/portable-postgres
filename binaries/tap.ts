/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Interprets native pgTAP output; SQL success alone cannot establish assertion success. */
import { Parser } from "tap-parser";

export function assertTap(text: string, count: number, expectedFailures = 0): void {
  const parser = new Parser({ strict: true });
  parser.end(text);
  const results = parser.results;
  if (
    // A bail-out stops the run; the deliberate failure case must not let it pass as the expected outcome.
    results?.bailout !== false || results.count !== count || results.skip !== 0
    || results.todo !== 0
    || results.fail !== expectedFailures
    || results.pass !== count - expectedFailures || (expectedFailures === 0 && !results.ok)
  ) {
    throw new Error(
      `TAP proof failed: expected ${count} assertions and ${expectedFailures} failures; got ${
        JSON.stringify(results)
      }`,
    );
  }
}
