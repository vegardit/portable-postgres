#!/usr/bin/env bash
#
# SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
# SPDX-FileContributor: Sebastian Thomschke
# SPDX-License-Identifier: Apache-2.0
# SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres

# Clang links through this script instead of GNU ld, as clang.cfg selects. When the build names a records
# directory, the script traces every input file and archive member of the link and stores the trace under
# the output's build ID. Packaging then checks what was copied into each image that a candidate ships,
# so a link that a recipe runs with its own flags cannot go unchecked.
set -euo pipefail
# The build's checks parse GNU ld's trace format.
linker=/usr/bin/ld.bfd
records=${PORTABLE_PG_LINK_RECORDS:-}
if [[ -z "$records" ]]; then
  exec "$linker" "$@"
fi
output=a.out
previous=
for argument in "$@"; do
  if [[ "$previous" == -o ]]; then output=$argument; fi
  case $argument in
    --output=*) output=${argument#--output=} ;;
    -o?*) output=${argument#-o} ;;
  esac
  previous=$argument
done
trace=$(mktemp "$records/link-tmp-XXXXXXXX")
trap 'rm -f "$trace"' EXIT
# The trace also stays in the build logs. The last --build-id option wins, so every output gets an ID
# even when a recipe passes its own.
"$linker" --trace --trace "$@" --build-id=sha1 | tee "$trace"
build_id=$(readelf --notes "$output" 2> /dev/null | sed -n 's/^ *Build ID: //p' || true)
# Outputs without a build ID, such as relocatable objects and failed configure probes, are never installed.
if [[ -n "$build_id" ]]; then
  mv "$trace" "$records/$build_id.trace"
fi
