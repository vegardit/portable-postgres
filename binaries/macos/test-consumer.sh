#!/usr/bin/env bash
#
# SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
# SPDX-FileContributor: Sebastian Thomschke
# SPDX-License-Identifier: Apache-2.0
# SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres

# Tests a macOS archive as a user without build tools receives it: downloaded through a browser, unpacked
# with the stock tar, and moved before first use. It refuses to run while any compiler is reachable, so the
# caller must hide Xcode and the Command Line Tools first; the Build workflow does that on its runner.
# Runs on the stock /bin/bash 3.2 of macOS without Node.js. Usage: bash test-consumer.sh <archive.tar.gz>
set -euo pipefail
project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ $# -ne 1 || ! -f $1 ]]; then
  echo 'Usage: bash test-consumer.sh <archive.tar.gz>' >&2
  exit 2
fi
archive="$(cd -- "$(dirname -- "$1")" && pwd)/$(basename -- "$1")"

# /usr/bin/clang, gcc, cc and make are stubs on every Mac; only a developer directory makes them work.
if xcrun --find clang > /dev/null 2>&1; then
  echo 'A compiler is reachable through xcrun; hide Xcode and the Command Line Tools first' >&2
  exit 1
fi
for tool in node npm pnpm cmake docker brew; do
  if command -v "$tool" > /dev/null 2>&1; then
    echo "Unexpected tool in the consumer: $tool" >&2
    exit 1
  fi
done
echo "macOS $(sw_vers -productVersion) ($(sw_vers -buildVersion)) on $(uname -m); no compiler reachable"
echo "Gatekeeper: $(spctl --status 2>&1 || true)"

work=$(mktemp -d /tmp/portable-postgres-consumer.XXXXXXXX)
printf 'Consumer evidence: %s\n' "$work"
# A browser marks every download with a quarantine attribute; unpacking passes it on to the files.
download="$work/$(basename -- "$archive")"
cp -- "$archive" "$download"
xattr -w com.apple.quarantine "0081;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$download"
mkdir "$work/unpacked"
/usr/bin/tar -xzf "$download" -C "$work/unpacked"
for program in bin/initdb bin/postgres; do
  if xattr -p com.apple.quarantine "$work/unpacked/$program" > /dev/null 2>&1; then
    echo "$program: quarantined after unpacking"
  else
    echo "$program: not quarantined after unpacking"
  fi
done
status=0
"$work/unpacked/bin/initdb" --version > "$work/first-launch.log" 2>&1 || status=$?
echo "First launch of a quarantined download (bin/initdb --version): exit $status: $(cat "$work/first-launch.log")"
if [[ $status -ne 0 ]]; then
  # The documented user step for a quarantined download.
  echo 'Removing the quarantine attribute, as a user must for this download'
  xattr -dr com.apple.quarantine "$work/unpacked"
fi

# Moved after unpacking, as a consumer may move an installation; no load command may reach the old place.
installation="$work/relocated"
mv "$work/unpacked" "$installation"
installation=$(cd -- "$installation" && pwd -P)
# Keep the proof directory marker in stdout. The host validates its TAP files after restoring the tools.
bash "$project_root/binaries/linux/smoke.sh" "$installation" | tee "$work/smoke.log"

# The loader reports what each process really loads. It strips DYLD_ variables when it starts a protected
# system program such as a shell, so the variable goes straight to the archive's own programs.
loaded="$work/loaded-libraries.txt"
DYLD_PRINT_LIBRARIES=1 "$installation/bin/psql" --version 2> "$loaded"
# Single-user mode connects as the operating system user, whom initdb makes the superuser by default.
"$installation/bin/initdb" -D "$work/loader-data" --auth=trust --no-locale > "$work/loader-initdb.log"
printf "CREATE EXTENSION vector;\nSELECT '[1,2]'::vector;\n" \
  | DYLD_PRINT_LIBRARIES=1 "$installation/bin/postgres" --single -D "$work/loader-data" \
    -c shared_preload_libraries=timescaledb,pg_textsearch -c timescaledb.telemetry_level=off postgres \
    > "$work/loader-postgres.log" 2>> "$loaded"
paths=$(sed -n 's/^dyld\[[0-9]*\]: <[^>]*> //p' "$loaded")
for expected in lib/libpq.5.dylib lib/libssl.3.dylib lib/libcrypto.3.dylib lib/vector.dylib lib/pg_textsearch.dylib lib/timescaledb.dylib; do
  if ! grep -F "$installation/" <<< "$paths" | grep -q -F "/$(basename "$expected")"; then
    echo "The loader trace lacks the bundled $expected" >&2
    exit 1
  fi
done
foreign=$(grep -v -F "$installation/" <<< "$paths" | grep -v -E '^/(usr/lib|System/Library)/' || true)
if [[ -n $foreign ]]; then
  echo "Loaded from outside the archive and macOS:" >&2
  echo "$foreign" >&2
  exit 1
fi
echo "Loaded only the archive's and macOS's own libraries: $(wc -l <<< "$paths" | tr -d ' ') images"
echo 'Consumer SQL and loader checks passed. The host must still validate the TAP files.'
