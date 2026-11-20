# Builds native extensions lacking a complete Windows recipe against the exact PostgreSQL SDK.
cmake_minimum_required(VERSION 3.24)
project(portable_postgres_windows_extensions LANGUAGES C)
file(TO_CMAKE_PATH "${PG_ROOT}" PG_ROOT)
file(TO_CMAKE_PATH "${SOURCE_ROOT}" SOURCE_ROOT)
if(NOT MSVC)
  message(FATAL_ERROR "This recipe requires MSVC")
endif()
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreadedDLL)
include_directories(
  "${PG_ROOT}/include/server/port/win32_msvc"
  "${PG_ROOT}/include/server/port/win32"
  "${PG_ROOT}/include/server"
  "${PG_ROOT}/include"
)
add_library(hypopg MODULE
  "${SOURCE_ROOT}/hypopg/hypopg.c"
  "${SOURCE_ROOT}/hypopg/hypopg_index.c"
  "${SOURCE_ROOT}/hypopg/import/hypopg_import.c"
  "${SOURCE_ROOT}/hypopg/import/hypopg_import_index.c"
)
target_link_libraries(hypopg PRIVATE "${PG_ROOT}/lib/postgres.lib")
target_include_directories(hypopg PRIVATE "${SOURCE_ROOT}/hypopg")
# NOTE: The pinned pg_textsearch Makefile.win omits source files and fails at link time.
# Reconsider this source discovery when an upstream Windows recipe covers the pinned release.
file(GLOB_RECURSE TEXTSEARCH_SOURCES CONFIGURE_DEPENDS "${SOURCE_ROOT}/pg_textsearch/src/*.c")
add_library(pg_textsearch MODULE ${TEXTSEARCH_SOURCES})
target_include_directories(pg_textsearch PRIVATE "${SOURCE_ROOT}/pg_textsearch/src")
# Match upstream's Windows build by reading the version from the control file we install.
set(TEXTSEARCH_CONTROL "${SOURCE_ROOT}/pg_textsearch/pg_textsearch.control")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${TEXTSEARCH_CONTROL}")
file(STRINGS "${TEXTSEARCH_CONTROL}" TEXTSEARCH_VERSION_SETTING REGEX "^[ \t]*default_version[ \t]*=")
if(NOT TEXTSEARCH_VERSION_SETTING MATCHES "^[ \t]*default_version[ \t]*=[ \t]*'([^']+)'")
  message(FATAL_ERROR "Could not read default_version from ${TEXTSEARCH_CONTROL}")
endif()
set(TEXTSEARCH_VERSION "${CMAKE_MATCH_1}")
target_compile_definitions(pg_textsearch PRIVATE PG_TEXTSEARCH_VERSION="${TEXTSEARCH_VERSION}")
target_link_libraries(pg_textsearch PRIVATE "${PG_ROOT}/lib/postgres.lib")
# Match the upstream Makefile: the current base script and the upgrade scripts, without older base scripts.
file(GLOB TEXTSEARCH_UPGRADES "${SOURCE_ROOT}/pg_textsearch/sql/pg_textsearch--*--*.sql")
install(FILES
  "${SOURCE_ROOT}/pg_textsearch/sql/pg_textsearch--${TEXTSEARCH_VERSION}.sql"
  ${TEXTSEARCH_UPGRADES}
  "${TEXTSEARCH_CONTROL}"
  DESTINATION "${PG_ROOT}/share/extension")
add_library(pg_cron MODULE
  "${SOURCE_ROOT}/pg_cron/src/entry.c"
  "${SOURCE_ROOT}/pg_cron/src/job_metadata.c"
  "${SOURCE_ROOT}/pg_cron/src/misc.c"
  "${SOURCE_ROOT}/pg_cron/src/pg_cron.c"
  "${SOURCE_ROOT}/pg_cron/src/task_states.c"
)
target_include_directories(pg_cron PRIVATE "${SOURCE_ROOT}/pg_cron/include")
target_compile_definitions(pg_cron PRIVATE WIN32_NO_STATUS strcasecmp=_stricmp)
# PostgreSQL was built without NLS; linking libintl would add an unnecessary runtime dependency.
target_link_libraries(pg_cron PRIVATE "${PG_ROOT}/lib/postgres.lib" "${PG_ROOT}/lib/libpq.lib" ws2_32)
install(TARGETS hypopg pg_textsearch pg_cron LIBRARY DESTINATION "${PG_ROOT}/lib")
file(GLOB HYPOPG_SQL "${SOURCE_ROOT}/hypopg/*--*.sql")
file(GLOB CRON_SQL "${SOURCE_ROOT}/pg_cron/*--*--*.sql")
install(FILES ${HYPOPG_SQL} "${SOURCE_ROOT}/hypopg/hypopg.control" DESTINATION "${PG_ROOT}/share/extension")
install(FILES ${CRON_SQL} "${SOURCE_ROOT}/pg_cron/pg_cron.control" DESTINATION "${PG_ROOT}/share/extension")
install(FILES "${SOURCE_ROOT}/pg_cron/pg_cron.sql" DESTINATION "${PG_ROOT}/share/extension" RENAME pg_cron--1.0.sql)
