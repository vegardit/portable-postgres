#!/usr/bin/env bash
#
# SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
# SPDX-FileContributor: Sebastian Thomschke
# SPDX-License-Identifier: Apache-2.0
# SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres

# Compiles the macOS development installation and makes it relocatable; runtime assembly excludes
# build-support files. Runs on the stock /bin/bash 3.2 of macOS, so it avoids Bash 4 features.
set -euo pipefail
work_root=${PORTABLE_PG_WORK:?A fresh build directory must be supplied by the TypeScript orchestrator}
source_root="$work_root/sources"
install_root=${PORTABLE_PG_PREFIX:?A fresh installation directory must be supplied}
build_jobs=${BUILD_JOBS:?The parallel job count must be supplied by the TypeScript orchestrator}
: "${DEVELOPER_DIR:?The pinned Xcode from base.json must be supplied by the TypeScript orchestrator}"
: "${MACOSX_DEPLOYMENT_TARGET:?The deployment target from base.json must be supplied}"
# The system tools first, so that the build uses Apple's Perl, Bison and Flex rather than Homebrew's.
# CMake comes from Homebrew, later in PATH.
export PATH="$install_root/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
mkdir -p "$install_root"

# Every link through the compiler driver stores Apple's linker map under the output's LC_UUID, which
# relocation and signing keep. Packaging reads the maps from this directory, so its name must match
# linkRecordsDirectory in links.ts. A map names its inputs relative to the directory the link ran in, so
# the record starts with that directory. Header padding leaves room for the relocation below.
link_records="$work_root/link-records"
mkdir -p "$link_records"
printf '%s\n' "$work_root" > "$link_records/build-root"
compiler="$work_root/clang-with-link-map"
cat > "$compiler" <<'EOF'
#!/bin/bash
set -e
link=1
output=
previous=
for argument in "$@"; do
  case "$argument" in -c | -E | -S | -M | -MM) link=0 ;; esac
  if [ "$previous" = "-o" ]; then output=$argument; fi
  previous=$argument
done
if [ "$link" = 0 ] || [ -z "$output" ]; then exec xcrun clang "$@"; fi
map=$(mktemp "$PORTABLE_PG_LINK_RECORDS/link.XXXXXX")
trap 'rm -f "$map" "$map.record"' EXIT
xcrun clang "$@" -Wl,-headerpad_max_install_names "-Wl,-map,$map"
if [ -s "$map" ]; then
  uuid=$(otool -l "$output" | awk '$1 == "uuid" { print tolower($2); exit }' | tr -d '-')
  if [ -n "$uuid" ]; then
    # Publish only a complete record; a failed copy must also fail the compiler invocation.
    { printf '# link directory: %s\n' "$PWD"; cat "$map"; } > "$map.record"
    mv -f "$map.record" "$PORTABLE_PG_LINK_RECORDS/$uuid.map"
  fi
fi
EOF
chmod +x "$compiler"
export CC=$compiler PORTABLE_PG_LINK_RECORDS=$link_records

cd "$source_root/postgresql"
# readline is GPL; optional runtime libraries remain excluded until their closure is reviewed.
./configure --prefix="$install_root" --without-readline --without-zlib --without-icu \
  --without-lz4 --without-zstd > "$work_root/postgresql-configure.log"
make -j"$build_jobs" > "$work_root/postgresql-build.log" 2>&1
make install > "$work_root/postgresql-install.log" 2>&1

for extension in pgvector pg_textsearch hypopg plpgsql_check pg_cron; do
  echo "Building $extension against $(pg_config --version)"
  # pgvector defaults to machine-specific instructions unless OPTFLAGS is explicitly empty.
  make -C "$source_root/$extension" -j"$build_jobs" PG_CONFIG="$install_root/bin/pg_config" OPTFLAGS= \
    > "$work_root/$extension-build.log" 2>&1
  make -C "$source_root/$extension" PG_CONFIG="$install_root/bin/pg_config" OPTFLAGS= install \
    > "$work_root/$extension-install.log" 2>&1
done

cmake -S "$source_root/timescaledb" -B "$work_root/timescaledb-build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DPG_CONFIG="$install_root/bin/pg_config" -DAPACHE_ONLY=ON \
  -DUSE_OPENSSL=OFF -DUSE_TELEMETRY=OFF -DSEND_TELEMETRY_DEFAULT=OFF -DREGRESS_CHECKS=OFF \
  > "$work_root/timescaledb-configure.log" 2>&1
cmake --build "$work_root/timescaledb-build" --parallel "$build_jobs" \
  > "$work_root/timescaledb-build.log" 2>&1
cmake --install "$work_root/timescaledb-build" \
  > "$work_root/timescaledb-install.log" 2>&1

# NO_BGW alone still installs Python helpers; clear SCRIPTS as well.
make -C "$source_root/pg_partman" PG_CONFIG="$install_root/bin/pg_config" NO_BGW=1 SCRIPTS= install \
  > "$work_root/pg_partman-install.log" 2>&1
make -C "$source_root/pgtap" PG_CONFIG="$install_root/bin/pg_config" install \
  > "$work_root/pgtap-install.log" 2>&1

images=()
while IFS= read -r candidate; do
  case "$(file -b "$candidate")" in Mach-O*) images+=("$candidate") ;; esac
done < <(find "$install_root/bin" "$install_root/lib" -type f | sort)
if [ "${#images[@]}" -eq 0 ]; then
  echo 'No native image found in the installation' >&2
  exit 1
fi

# The build refers to bundled libraries by their absolute install paths. Relative names and search paths
# must keep working after the installation moves; packaging checks every load command of the candidate
# (binaries/macos/runtime.ts). Changing a load command invalidates the linker's signature, and arm64 macOS
# runs no unsigned code, so every image is signed again, ad hoc.
for image in "${images[@]}"; do
  name=${image#"$install_root"/}
  # Read completely before install_name_tool rewrites the file.
  dependencies=$(otool -L "$image" | tail -n +2 | awk '{ print $1 }' | { grep -F "$install_root/" || true; })
  bundled=0
  while IFS= read -r dependency; do
    if [ -z "$dependency" ]; then continue; fi
    install_name_tool -change "$dependency" "@rpath/$(basename "$dependency")" "$image"
    bundled=1
  done <<< "$dependencies"
  case "$(file -b "$image")" in
    *"dynamically linked shared library"*)
      install_name_tool -id "@rpath/$(basename "$image")" "$image"
      ;;
  esac
  if [ "$bundled" = 1 ]; then
    # From the image's directory up to the installation root, then into lib.
    up=$(dirname "$name" | sed -E 's#[^/]+#..#g')
    install_name_tool -add_rpath "@loader_path/$up/lib" "$image"
  fi
  codesign --force --sign - "$image"
done

excluded_component=$(find "$install_root" \( -iname '*-tsl*' -o -iname '*partman_bgw*' -o -name '*.py' -o -name 'pg_prove' \) -print -quit)
if [ -n "$excluded_component" ]; then
  echo 'Excluded component found in candidate installation' >&2
  exit 1
fi
echo "Built development installation: $install_root"
