@echo off
:: SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
:: SPDX-FileContributor: Sebastian Thomschke
:: SPDX-License-Identifier: Apache-2.0
:: SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres

REM Builds the PostgreSQL development installation and native extensions with MSVC for binaries\windows\build.ts.
setlocal
for %%I in ("%~dp0..\..") do set "PROJECT_ROOT=%%~fI"
REM The TypeScript driver supplies fresh per-build directories; a shared default could mix earlier build output.
if not defined PORTABLE_PG_WORK (
  echo PORTABLE_PG_WORK must name a fresh build directory. Run pnpm binaries:build:windows instead.
  exit /b 1
)
if not defined PORTABLE_PG_PREFIX (
  echo PORTABLE_PG_PREFIX must name a fresh installation directory. Run pnpm binaries:build:windows instead.
  exit /b 1
)
if not defined BUILD_JOBS (
  echo BUILD_JOBS must give the parallel compile job count. Run pnpm binaries:build:windows instead.
  exit /b 1
)
REM The driver selects Visual Studio and records evidence for the same installation, so this script never selects one.
if not defined PORTABLE_PG_VISUAL_STUDIO (
  echo PORTABLE_PG_VISUAL_STUDIO must name the Visual Studio installation. Run pnpm binaries:build:windows instead.
  exit /b 1
)
set "WORK_ROOT=%PORTABLE_PG_WORK%"
set "PG_PREFIX=%PORTABLE_PG_PREFIX%"
set "VS_ROOT=%PORTABLE_PG_VISUAL_STUDIO%"
set "PYTHON_BUILD=%PROJECT_ROOT%\binaries\work\windows-toolchain\Scripts\python.exe"
if not exist "%PYTHON_BUILD%" (
  echo Install the hash-pinned Windows build requirements first.
  exit /b 1
)
call "%VS_ROOT%\VC\Auxiliary\Build\vcvars64.bat" > "%WORK_ROOT%\windows-toolchain.log" 2>&1
if errorlevel 1 exit /b 1
if not defined VCToolsVersion exit /b 1
REM The driver records the toolset that vcvars64.bat selected as evidence of the compiler that built the images.
> "%WORK_ROOT%\windows-msvc-toolset.txt" echo %VCToolsVersion%
REM link.exe reads _LINK_ on every link, so Meson, CMake and nmake builds all record the Microsoft code they link:
REM the map supplies member names, and each image link also records its resolved library paths.
set "_LINK_=/MAP /VERBOSE:LIB"
REM The Windows link check resolves the libraries that the maps name against this environment.
node "%PROJECT_ROOT%\binaries\windows\link-recipe.ts" environment
if errorlevel 1 exit /b 1
set "PATH=%WORK_ROOT%\windows-tools\winflexbison;%VS_ROOT%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
REM NOTE: Git's MSYS Perl rewrites MSVC switches as paths; reconsider when using native Windows Perl.
set "MSYS2_ARG_CONV_EXCL=*"
cmake -S "%PROJECT_ROOT%\binaries\windows\icu" -B "%WORK_ROOT%\windows-icu" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="%PG_PREFIX%" -DICU_ROOT="%WORK_ROOT%\windows-sources\icu" > "%WORK_ROOT%\icu-configure.log" 2>&1
if errorlevel 1 exit /b 1
node "%PROJECT_ROOT%\binaries\windows\link-recipe.ts" ninja "%WORK_ROOT%\windows-icu\CMakeFiles\rules.ninja"
if errorlevel 1 exit /b 1
cmake --build "%WORK_ROOT%\windows-icu" --parallel %BUILD_JOBS% > "%WORK_ROOT%\icu-build.log" 2>&1
if errorlevel 1 exit /b 1
cmake --install "%WORK_ROOT%\windows-icu" > "%WORK_ROOT%\icu-install.log" 2>&1
if errorlevel 1 exit /b 1
set "ICU_ROOT=%PG_PREFIX%"
REM OpenSSL's Windows build needs a Perl that uses native Windows paths.
set "PATH=%WORK_ROOT%\windows-tools\nasm;%PATH%"
if not defined OPENSSL_BUILD_PERL set "OPENSSL_BUILD_PERL=C:\Strawberry\perl\bin\perl.exe"
pushd "%WORK_ROOT%\windows-sources\openssl" || exit /b 1
REM Keep OpenSSL's Program Files provider path. The copies below install the DLLs into our SDK.
"%OPENSSL_BUILD_PERL%" Configure VC-WIN64A shared no-makedepend no-module no-engine no-tests no-apps --libdir=lib > "%WORK_ROOT%\openssl-configure.log" 2>&1
if errorlevel 1 exit /b 1
nmake /nologo build_generated > "%WORK_ROOT%\openssl-generated-build.log" 2>&1
if errorlevel 1 exit /b 1
REM Build each DLL separately so the link audit can bind the map and inputs to its finished bytes.
for %%L in (crypto ssl) do (
  node "%PROJECT_ROOT%\binaries\windows\link-recipe.ts" trace lib%%L-3-x64.dll nmake /nologo lib%%L-3-x64.dll > "%WORK_ROOT%\openssl-%%L-build.log" 2>&1
  if errorlevel 1 exit /b 1
)
REM install_dev starts another nmake that can relink libssl after its evidence was recorded.
REM Install the traced DLLs and just the headers and import libraries the SDK needs.
mkdir "%PG_PREFIX%\include\openssl"
if errorlevel 1 exit /b 1
copy /y "include\openssl\*.h" "%PG_PREFIX%\include\openssl\" > nul
if errorlevel 1 exit /b 1
copy /y "ms\applink.c" "%PG_PREFIX%\include\openssl\" > nul
if errorlevel 1 exit /b 1
for %%L in (crypto ssl) do (
  copy /y lib%%L-3-x64.dll "%PG_PREFIX%\bin\" > nul
  if errorlevel 1 exit /b 1
  copy /y lib%%L.lib "%PG_PREFIX%\lib\" > nul
  if errorlevel 1 exit /b 1
)
popd
set "OPENSSL_ROOT_DIR=%PG_PREFIX%"
set "PKG_CONFIG_PATH=%PG_PREFIX%\lib\pkgconfig"
set "PKG_CONFIG_LIBDIR=%PKG_CONFIG_PATH%"
set "INCLUDE=%PG_PREFIX%\include;%INCLUDE%"
set "LIB=%PG_PREFIX%\lib;%LIB%"
"%PYTHON_BUILD%" -m mesonbuild.mesonmain setup "%WORK_ROOT%\windows-postgresql" "%WORK_ROOT%\windows-sources\postgresql" --prefix "%PG_PREFIX%" --native-file "%PG_PREFIX%\icu-dependencies.ini" --buildtype release --backend ninja -Db_vscrt=md -Db_pch=true -Dreadline=disabled -Dzlib=disabled -Dicu=enabled -Dssl=openssl -Dlz4=disabled -Dzstd=disabled -Dnls=disabled -Dplperl=disabled -Dplpython=disabled -Dpltcl=disabled -Dlibxml=disabled -Dlibxslt=disabled -Dldap=disabled -Dgssapi=disabled -Ddocs=disabled -Dtap_tests=disabled > "%WORK_ROOT%\windows-postgresql-configure.log" 2>&1
if errorlevel 1 (
  type "%WORK_ROOT%\windows-postgresql-configure.log"
  exit /b 1
)
node "%PROJECT_ROOT%\binaries\windows\link-recipe.ts" ninja "%WORK_ROOT%\windows-postgresql\build.ninja"
if errorlevel 1 exit /b 1
ninja -C "%WORK_ROOT%\windows-postgresql" -j%BUILD_JOBS% > "%WORK_ROOT%\windows-postgresql-build.log" 2>&1
if errorlevel 1 exit /b 1
"%PYTHON_BUILD%" -m mesonbuild.mesonmain install -C "%WORK_ROOT%\windows-postgresql" --no-rebuild > "%WORK_ROOT%\windows-postgresql-install.log" 2>&1
if errorlevel 1 exit /b 1
call "%PROJECT_ROOT%\binaries\windows\build-extensions.cmd"
if errorlevel 1 exit /b 1
echo Built PostgreSQL and native extensions.
