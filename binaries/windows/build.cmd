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
"%PYTHON_BUILD%" -m mesonbuild.mesonmain setup "%WORK_ROOT%\windows-postgresql" "%WORK_ROOT%\windows-sources\postgresql" --prefix "%PG_PREFIX%" --native-file "%PG_PREFIX%\icu-dependencies.ini" --buildtype release --backend ninja -Db_vscrt=md -Db_pch=true -Dreadline=disabled -Dzlib=disabled -Dicu=enabled -Dssl=none -Dlz4=disabled -Dzstd=disabled -Dnls=disabled -Dplperl=disabled -Dplpython=disabled -Dpltcl=disabled -Dlibxml=disabled -Dlibxslt=disabled -Dldap=disabled -Dgssapi=disabled -Ddocs=disabled -Dtap_tests=disabled > "%WORK_ROOT%\windows-postgresql-configure.log" 2>&1
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
