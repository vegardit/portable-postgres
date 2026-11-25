# Builds the pinned compression libraries for PostgreSQL's private SDK on every target.
cmake_minimum_required(VERSION 3.16)
project(portable_compression LANGUAGES C)

set(CMAKE_INSTALL_LIBDIR lib)
set(ZLIB_BUILD_TESTING OFF CACHE BOOL "")
set(ZLIB_BUILD_STATIC OFF CACHE BOOL "")
add_subdirectory("${SOURCE_ROOT}/zlib" zlib)

# Upstream bundled mode builds a static library and omits the SDK installation.
set(LZ4_BUNDLED_MODE OFF)
set(BUILD_SHARED_LIBS ON CACHE BOOL "")
set(BUILD_STATIC_LIBS OFF CACHE BOOL "")
set(LZ4_BUILD_CLI OFF CACHE BOOL "")
set(LZ4_SHARED_MULTITHREAD OFF CACHE BOOL "")
add_subdirectory("${SOURCE_ROOT}/lz4/build/cmake" lz4)

if(MINGW)
  # Retain the Windows loader name used by the native artifact format.
  set_target_properties(lz4_shared PROPERTIES PREFIX "")
endif()

if(UNIX)
  # Ship one regular file under each loader name. Only the SDK needs the unversioned linker alias.
  foreach(library IN ITEMS zlib lz4_shared)
    get_target_property(abi ${library} SOVERSION)
    set_target_properties(${library} PROPERTIES VERSION "${abi}"
      INSTALL_NAME_DIR "${CMAKE_INSTALL_PREFIX}/lib")
  endforeach()
endif()
