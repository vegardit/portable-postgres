#!/usr/bin/env bash
#
# SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
# SPDX-FileContributor: Sebastian Thomschke
# SPDX-License-Identifier: Apache-2.0
# SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres

# Compiles the Linux development installation; runtime assembly excludes build-support files.
set -euo pipefail
work_root=${PORTABLE_PG_WORK:?A fresh build directory must be supplied by the TypeScript orchestrator}
source_root="$work_root/sources"
install_root=${PORTABLE_PG_PREFIX:?A fresh installation directory must be supplied}
build_jobs=${BUILD_JOBS:?The parallel job count must be supplied by the TypeScript orchestrator}
mkdir -p "$install_root"
export PATH="$install_root/bin:$PATH"
# GCC embeds GPL runtime helpers and CRT objects even without a libgcc shared dependency.
export CC=clang-${LLVM_MAJOR:?The LLVM major from base.json must be supplied by the TypeScript orchestrator}
# The build image's clang.cfg selects compiler-rt for every link and links through traced-ld, which
# records the input files and archive members of each link under the output's build ID. Packaging
# reads the records from this directory, so its name must match linkRecordsDirectory in links.ts.
link_records="$work_root/link-records"
mkdir -p "$link_records"
export PORTABLE_PG_LINK_RECORDS=$link_records
runtime_root=$("$CC" --print-resource-dir)/lib/linux
for runtime_file in clang_rt.crtbegin-x86_64.o clang_rt.crtend-x86_64.o libclang_rt.builtins-x86_64.a; do
  test -s "$runtime_root/$runtime_file"
done
# Without any flags, so that this proves the compiler's own default and not the flags of this script.
"$CC" -x c /dev/null -### > "$work_root/compiler-link-plan.log" 2>&1
if grep -qE '"-lgcc[^\"]*"|/gcc/[^\"]*/crt(begin|end)' "$work_root/compiler-link-plan.log"; then
  echo 'The compiler selected a forbidden GCC runtime contribution' >&2
  exit 1
fi

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
  -DCMAKE_BUILD_TYPE=Release -DPG_CONFIG="$install_root/bin/pg_config" -DAPACHE_ONLY=ON \
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
while IFS= read -r -d '' candidate; do
  if file -b "$candidate" | grep -qE '^ELF .*(executable|shared object)'; then images+=("$candidate"); fi
done < <(find "$install_root/bin" "$install_root/lib" -type f -print0)
if [[ ${#images[@]} -eq 0 ]]; then
  echo 'No native image found in the installation' >&2
  exit 1
fi

# Explicit relative loader paths must continue to work after moving the installation. Packaging checks
# the linker records of every image that the candidate ships, wherever it lies (binaries/linux/links.ts).
for image in "${images[@]}"; do
  patchelf --set-rpath '$ORIGIN/../lib:$ORIGIN' "$image"
done

excluded_component=$(find "$install_root" \( -iname '*-tsl*' -o -iname '*partman_bgw*' -o -name '*.py' -o -name 'pg_prove' \) -print -quit)
if [[ -n "$excluded_component" ]]; then
  echo 'Excluded component found in candidate installation' >&2
  exit 1
fi
echo "Built development installation: $install_root"
