#!/usr/bin/env bash
# Builds the native Windows SDK with the pinned CLANG64 tools in this build's private MSYS2 root.
set -euo pipefail
export PATH="/usr/bin:$PATH"
work=$(cygpath -u "$PORTABLE_PG_WORK")
sdk="$work/postgresql-sdk"
src="$work/windows-sources"
root=$(cygpath -u "$PORTABLE_PG_ROOT")
python=$(cygpath -u "$PORTABLE_PG_PYTHON")
cmake=$(cygpath -u "$PORTABLE_PG_CMAKE")
export PATH="$sdk/bin:/clang64/bin:/usr/bin:$work/windows-tools/winflexbison:$(dirname "$cmake"):$(dirname "$python"):$(cygpath -u "${SYSTEMROOT:-${SystemRoot:-C:/Windows}}")/System32"
export CC=clang CXX=clang++ AR=llvm-ar RANLIB=llvm-ranlib
cd "$work"
mkdir -p link-records tmp "$sdk"
export TEMP="$(cygpath -m "$work/tmp")"
export TMP="$TEMP"
export TMPDIR="$work/tmp"
clang -municode "$root/binaries/windows/trace-ld.c" -o trace-ld.exe
# Clang loads these private configuration files for links issued by all four build systems.
for driver in clang clang++; do
  printf '%s\n' "--ld-path=$(cygpath -m "$work/trace-ld.exe")" > "/clang64/bin/$driver.cfg"
done
export LDFLAGS="-Wl,--strip-debug"
# PGXS propagates the PostgreSQL build flags and some extension Makefiles append -g.
# The linker flag applies to their final DLLs as well.
jobs=${BUILD_JOBS:?missing parallel build count}
prefix=$(cygpath -m "$sdk")

echo 'Building zlib and LZ4'
"$cmake" -S "$root/binaries/compression" -B compression -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$prefix" -DSOURCE_ROOT="$(cygpath -m "$src")" > compression-configure.log 2>&1
"$cmake" --build compression --parallel "$jobs" > compression-build.log 2>&1
"$cmake" --install compression > compression-install.log 2>&1

echo 'Building OpenSSL'
(
  cd "$src/openssl"
  program_files=$(cygpath -m -F 38)
  modules="$program_files/OpenSSL/lib/ossl-modules"
  perl Configure mingw64 shared no-module no-engine no-tests no-apps no-makedepend \
    --prefix="$prefix" --openssldir="$program_files/Common Files/SSL" --libdir=lib > "$work/openssl-configure.log" 2>&1
  make -j"$jobs" MODULESDIR="$modules" > "$work/openssl-build.log" 2>&1
  make MODULESDIR="$modules" install_runtime_libs install_dev > "$work/openssl-install.log" 2>&1
)

echo 'Building ICU'
mkdir icu-build
(
  cd icu-build
  bash "$src/icu/source/configure" --build=x86_64-w64-mingw32 --host=x86_64-w64-mingw32 \
    --prefix="$sdk" --enable-shared --disable-static --with-data-packaging=library \
    --disable-tests --disable-samples --disable-extras --disable-icuio > "$work/icu-configure.log" 2>&1
  make -j"$jobs" > "$work/icu-build.log" 2>&1
  make install > "$work/icu-install.log" 2>&1
)
major=$(awk '$1=="#define" && $2=="U_ICU_VERSION_MAJOR_NUM" {print $3}' "$src/icu/source/common/unicode/uvernum.h")
[[ $major =~ ^[0-9]+$ ]]
# Link only the generated data object. The ordinary DLL rule adds executable startup code.
MSYS2_ARG_CONV_EXCL='*' lld-link -dll -noentry -nodefaultlib -machine:x64 "-export:icudt${major}_dat,DATA" \
  "-out:$prefix/bin/icudt$major.dll" "icu-build/data/out/tmp/icudt${major}l_dat.o"
cp /clang64/bin/{libc++.dll,libwinpthread-1.dll} "$sdk/bin/"

echo 'Building PostgreSQL'
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
# Native Perl and winflexbison give Meson's Windows generators the same path syntax as Ninja.
"$python" -m mesonbuild.mesonmain setup windows-postgresql "$src/postgresql" --prefix "$prefix" \
  --buildtype release -Db_pch=true -Dreadline=disabled -Dzlib=enabled -Dicu=enabled -Dssl=openssl \
  -Dlz4=enabled -Dzstd=disabled -Dnls=disabled -Dplperl=disabled -Dplpython=disabled -Dpltcl=disabled \
  -Dlibxml=disabled -Dlibxslt=disabled -Dldap=disabled -Dgssapi=disabled -Ddocs=disabled \
  -Dtap_tests=disabled -Dllvm=disabled -Dlibcurl=disabled -DBISON=win_bison -DFLEX=win_flex \
  "-DPERL=$PORTABLE_PG_PERL" > windows-postgresql-configure.log 2>&1
ninja -C windows-postgresql -j"$jobs" > windows-postgresql-build.log 2>&1
"$python" -m mesonbuild.mesonmain install -C windows-postgresql --no-rebuild > windows-postgresql-install.log 2>&1

for extension in pgvector hypopg pg_textsearch plpgsql_check pg_cron; do
  echo "Building $extension"
  make -C "$src/$extension" -j"$jobs" PG_CONFIG="$prefix/bin/pg_config.exe" OPTFLAGS= CC=clang > "$extension-build.log" 2>&1
  make -C "$src/$extension" PG_CONFIG="$prefix/bin/pg_config.exe" OPTFLAGS= CC=clang install > "$extension-install.log" 2>&1
done
echo 'Building Apache-only TimescaleDB'
"$cmake" -S "$src/timescaledb" -B windows-timescaledb -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DPG_CONFIG="$prefix/bin/pg_config.exe" -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DAPACHE_ONLY=ON \
  -DUSE_OPENSSL=OFF -DUSE_TELEMETRY=OFF -DSEND_TELEMETRY_DEFAULT=OFF -DREGRESS_CHECKS=OFF > timescaledb-configure.log 2>&1
"$cmake" --build windows-timescaledb --parallel "$jobs" > timescaledb-build.log 2>&1
"$cmake" --install windows-timescaledb > timescaledb-install.log 2>&1
