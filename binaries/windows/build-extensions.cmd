@echo off
:: SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
:: SPDX-FileContributor: Sebastian Thomschke
:: SPDX-License-Identifier: Apache-2.0
:: SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres

REM Builds pinned native extensions against the exact PostgreSQL SDK from build.cmd and inherited MSVC environment.
setlocal
set "PATH=%PG_PREFIX%\bin;%PATH%"
call :nmake_extension pgvector
if errorlevel 1 exit /b 1

cmake -S "%PROJECT_ROOT%\binaries\windows\extensions" -B "%WORK_ROOT%\windows-extra-build" -G Ninja "-DPG_ROOT=%PG_PREFIX%" "-DSOURCE_ROOT=%WORK_ROOT%\windows-sources" -DCMAKE_BUILD_TYPE=Release > "%WORK_ROOT%\windows-extra-configure.log" 2>&1
if errorlevel 1 exit /b 1
node "%PROJECT_ROOT%\binaries\windows\link-recipe.ts" ninja "%WORK_ROOT%\windows-extra-build\CMakeFiles\rules.ninja"
if errorlevel 1 exit /b 1
cmake --build "%WORK_ROOT%\windows-extra-build" --parallel %BUILD_JOBS% > "%WORK_ROOT%\windows-extra-build.log" 2>&1
if errorlevel 1 exit /b 1
cmake --install "%WORK_ROOT%\windows-extra-build" > "%WORK_ROOT%\windows-extra-install.log" 2>&1
if errorlevel 1 exit /b 1

"%PYTHON_BUILD%" -m mesonbuild.mesonmain setup "%WORK_ROOT%\windows-plpgsql-check" "%WORK_ROOT%\windows-sources\plpgsql_check" --buildtype release --backend ninja -Db_vscrt=md > "%WORK_ROOT%\windows-plpgsql-check-configure.log" 2>&1
if errorlevel 1 exit /b 1
node "%PROJECT_ROOT%\binaries\windows\link-recipe.ts" ninja "%WORK_ROOT%\windows-plpgsql-check\build.ninja"
if errorlevel 1 exit /b 1
ninja -C "%WORK_ROOT%\windows-plpgsql-check" -j%BUILD_JOBS% > "%WORK_ROOT%\windows-plpgsql-check-build.log" 2>&1
if errorlevel 1 exit /b 1
"%PYTHON_BUILD%" -m mesonbuild.mesonmain install -C "%WORK_ROOT%\windows-plpgsql-check" --no-rebuild > "%WORK_ROOT%\windows-plpgsql-check-install.log" 2>&1
if errorlevel 1 exit /b 1

cmake -S "%WORK_ROOT%\windows-sources\timescaledb" -B "%WORK_ROOT%\windows-timescaledb" -G Ninja "-DPG_CONFIG=%PG_PREFIX%\bin\pg_config.exe" -DCMAKE_BUILD_TYPE=Release -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DAPACHE_ONLY=ON -DUSE_OPENSSL=OFF -DUSE_TELEMETRY=OFF -DSEND_TELEMETRY_DEFAULT=OFF -DREGRESS_CHECKS=OFF > "%WORK_ROOT%\windows-timescaledb-configure.log" 2>&1
if errorlevel 1 exit /b 1
node "%PROJECT_ROOT%\binaries\windows\link-recipe.ts" ninja "%WORK_ROOT%\windows-timescaledb\CMakeFiles\rules.ninja"
if errorlevel 1 exit /b 1
cmake --build "%WORK_ROOT%\windows-timescaledb" --parallel %BUILD_JOBS% > "%WORK_ROOT%\windows-timescaledb-build.log" 2>&1
if errorlevel 1 exit /b 1
cmake --install "%WORK_ROOT%\windows-timescaledb" > "%WORK_ROOT%\windows-timescaledb-install.log" 2>&1
if errorlevel 1 exit /b 1
exit /b 0

:nmake_extension
  pushd "%WORK_ROOT%\windows-sources\%~1"
  REM Match PostgreSQL's dynamic CRT; the upstream default otherwise embeds LIBCMT in vector.dll.
  REM pgvector has one link in its private source directory.
  node "%PROJECT_ROOT%\binaries\windows\link-recipe.ts" trace vector.dll nmake /nologo /f Makefile.win "PGROOT=%PG_PREFIX%" "PG_CFLAGS=/MD /O2 /fp:fast" install > "%WORK_ROOT%\windows-%~1-build.log" 2>&1
  set "BUILD_STATUS=%ERRORLEVEL%"
  popd
exit /b %BUILD_STATUS%
