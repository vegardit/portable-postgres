/*
 * SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
 * SPDX-FileContributor: Sebastian Thomschke
 * SPDX-License-Identifier: Apache-2.0
 * SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres
 */

/** Locates the repository and its ignored build directories for every build-tool module. */
import { dirname, join } from "node:path";

export const root = dirname(import.meta.dirname);
export const workRoot = join(root, "binaries", "work");
export const outputRoot = join(root, "binaries", "output");
