#!/usr/bin/env bash
# Builds the shared OpenSSL runtime with the target's compiler and linker tracing environment.
set -euo pipefail
target=${1:?OpenSSL target required}
source_dir=${2:?OpenSSL source required}
prefix=${PORTABLE_PG_PREFIX:?SDK directory required}
mkdir -p "$PORTABLE_PG_WORK/openssl-build"
cd "$PORTABLE_PG_WORK/openssl-build"
# Keep the SDK prefix for installation. Provider and configuration lookups must survive relocation.
modulesdir=/etc/ssl/ossl-modules
perl "$source_dir/Configure" "$target" shared no-module no-engine no-tests no-apps \
  --prefix="$prefix" --openssldir=/etc/ssl --libdir=lib > "$PORTABLE_PG_WORK/openssl-configure.log"
make -j"$BUILD_JOBS" MODULESDIR="$modulesdir" > "$PORTABLE_PG_WORK/openssl-build.log" 2>&1
make MODULESDIR="$modulesdir" install_runtime_libs install_dev > "$PORTABLE_PG_WORK/openssl-install.log" 2>&1
