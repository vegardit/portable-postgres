/* Forwards Clang's original Windows linker command line to the build's provenance recorder. */
#include <windows.h>
#include <wchar.h>
#include <stdlib.h>

int wmain(void)
{
    const wchar_t *python = _wgetenv(L"PORTABLE_PG_PYTHON");
    const wchar_t *script = _wgetenv(L"PORTABLE_PG_TRACE");
    if (!python || !script) return 1;
    const wchar_t *args = GetCommandLineW();
    if (*args == L'"') {
        args = wcschr(args + 1, L'"');
        if (!args) return 1;
        ++args;
    } else {
        args += wcscspn(args, L" \t");
    }
    size_t count = wcslen(python) + wcslen(script) + wcslen(args) + 8;
    wchar_t *command = calloc(count, sizeof(*command));
    if (!command) return 1;
    swprintf(command, count, L"\"%ls\" \"%ls\" %ls", python, script, args);
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION child = {0};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(python, command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &child)) return 1;
    CloseHandle(child.hThread);
    WaitForSingleObject(child.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(child.hProcess, &code);
    CloseHandle(child.hProcess);
    free(command);
    return (int)code;
}
