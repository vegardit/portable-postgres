# Builds ICU's common, internationalization and full data libraries with MSVC.
# The upstream source lists keep this recipe aligned with the pinned release.
cmake_minimum_required(VERSION 3.24)
project(portable_postgres_icu LANGUAGES C CXX)
if(NOT MSVC)
  message(FATAL_ERROR "This recipe requires MSVC")
endif()
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreadedDLL)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/lib")
file(TO_CMAKE_PATH "${ICU_ROOT}" ICU_ROOT)
set(ICU_SOURCE "${ICU_ROOT}/source")
file(STRINGS "${ICU_SOURCE}/common/unicode/uvernum.h" ICU_VERSION_LINE
  REGEX "^#define U_ICU_VERSION_MAJOR_NUM ")
string(REGEX REPLACE ".* ([0-9]+)$" "\\1" ICU_MAJOR "${ICU_VERSION_LINE}")
include_directories("${ICU_SOURCE}/common" "${ICU_SOURCE}/i18n" "${ICU_SOURCE}/tools/toolutil")
add_compile_definitions(U_PLATFORM_USES_ONLY_WIN32_API=1 _CRT_SECURE_NO_WARNINGS)
add_compile_options(/utf-8 /bigobj)

function(icu_sources component output)
  set(list "${ICU_SOURCE}/${component}/sources.txt")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${list}")
  file(STRINGS "${list}" files REGEX "^[a-zA-Z0-9_-]+\\.(c|cpp)$")
  list(TRANSFORM files PREPEND "${ICU_SOURCE}/${component}/")
  set(${output} "${files}" PARENT_SCOPE)
endfunction()

# The bootstrap data exports the same entry point as the complete data library.
# ICU's data generator needs the common library before it can produce that library.
add_library(icu_stubdata SHARED "${ICU_SOURCE}/stubdata/stubdata.cpp")
set_target_properties(icu_stubdata PROPERTIES OUTPUT_NAME "icudt${ICU_MAJOR}")
icu_sources(common common_sources)
add_library(icuuc SHARED ${common_sources})
target_compile_definitions(icuuc PRIVATE U_COMMON_IMPLEMENTATION)
target_link_libraries(icuuc PRIVATE icu_stubdata advapi32)
# Distinct import names keep the link audit independent of Windows SDK libraries named icuuc and icuin.
set_target_properties(icuuc PROPERTIES OUTPUT_NAME "icuuc${ICU_MAJOR}" ARCHIVE_OUTPUT_NAME portable_icuuc)
icu_sources(i18n i18n_sources)
add_library(icuin SHARED ${i18n_sources})
target_compile_definitions(icuin PRIVATE U_I18N_IMPLEMENTATION)
target_link_libraries(icuin PRIVATE icuuc)
set_target_properties(icuin PROPERTIES OUTPUT_NAME "icuin${ICU_MAJOR}" ARCHIVE_OUTPUT_NAME portable_icuin)
icu_sources(tools/toolutil tool_sources)
add_library(icu_toolutil STATIC ${tool_sources})
target_compile_definitions(icu_toolutil PUBLIC U_TOOLUTIL_IMPLEMENTATION)
target_link_libraries(icu_toolutil PUBLIC icuuc icuin)
add_executable(genccode "${ICU_SOURCE}/tools/genccode/genccode.c")
target_link_libraries(genccode PRIVATE icu_toolutil)

set(data "${ICU_SOURCE}/data/in/icudt${ICU_MAJOR}l.dat")
set(data_object "${CMAKE_BINARY_DIR}/icudt${ICU_MAJOR}l_dat.obj")
add_custom_command(OUTPUT "${data_object}"
  # The data file's endian suffix is not part of the symbol imported by ICU's common library.
  COMMAND genccode -o -e "icudt${ICU_MAJOR}" -d "${CMAKE_BINARY_DIR}" "${data}"
  DEPENDS genccode "${data}" VERBATIM)
add_library(icudata SHARED "${data_object}")
set_source_files_properties("${data_object}" PROPERTIES EXTERNAL_OBJECT TRUE GENERATED TRUE)
set_target_properties(icudata PROPERTIES
  LINKER_LANGUAGE C OUTPUT_NAME "icudt${ICU_MAJOR}"
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/data"
  ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/data")
target_link_options(icudata PRIVATE /NOENTRY /NODEFAULTLIB)

install(TARGETS icuuc icuin icudata RUNTIME DESTINATION bin ARCHIVE DESTINATION lib)
configure_file("${CMAKE_CURRENT_SOURCE_DIR}/meson.ini"
  "${CMAKE_INSTALL_PREFIX}/icu-dependencies.ini" COPYONLY)
install(DIRECTORY "${ICU_SOURCE}/common/unicode" "${ICU_SOURCE}/i18n/unicode" DESTINATION include
  FILES_MATCHING PATTERN "*.h")
