"""Bind each MinGW image to LLD's resolved inputs and loaded archive members at link time."""

import ctypes
from ctypes import wintypes
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from uuid import uuid4


def arguments(args):
    """Clang moves long linker invocations into Windows-quoted response files."""
    split = ctypes.windll.shell32.CommandLineToArgvW
    split.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
    split.restype = ctypes.POINTER(wintypes.LPWSTR)
    for arg in args:
        if not arg.startswith("@"):
            yield arg
            continue
        data = Path(arg[1:]).read_bytes()
        encoding = "utf-16" if data.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
        count = ctypes.c_int()
        values = split("link " + data.decode(encoding).replace("\r", " ").replace("\n", " "), ctypes.byref(count))
        if not values:
            raise ValueError("Invalid linker response file: " + arg)
        try:
            yield from arguments([values[i] for i in range(1, count.value)])
        finally:
            ctypes.windll.kernel32.LocalFree(ctypes.cast(values, ctypes.c_void_p))


def main():
    work = Path(os.environ["PORTABLE_PG_WORK"]).resolve()
    toolchain = (work / "msys64/clang64").resolve()
    records = work / "link-records"
    rsp = records / (uuid4().hex + ".rsp")
    args = sys.argv[1:]
    linker = toolchain / "bin/ld.lld.exe"
    expanded = list(arguments(args))
    # Clang supplies a default -o even for Meson's version query. LLD emits no image or input record.
    if "--version" in expanded or "--help" in expanded:
        return subprocess.call([str(linker), *args])
    proc = subprocess.run([str(linker), *args, "--Xlink=-verbose", "--Xlink=-linkreprofullpathrsp:" + str(rsp)],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if proc.returncode:
        sys.stderr.buffer.write(proc.stdout)
        return proc.returncode
    if "-o" not in expanded:
        sys.stdout.buffer.write(proc.stdout)
        return 0
    image = Path(expanded[expanded.index("-o") + 1])
    libraries = {}
    external = []
    inputs = [Path(line.strip('"')).resolve() for line in rsp.read_text(encoding="utf-8-sig").splitlines()]
    for path in inputs:
        # Build-only MSYS packages share the extraction root with the native toolchain.
        if not path.is_relative_to(work) or (path.is_relative_to(work / "msys64") and not path.is_relative_to(toolchain)):
            external.append(str(path))
        if path.suffix.lower() in (".a", ".lib"):
            libraries.setdefault(path.name.lower(), set()).add(path)
    selected = set()
    for line in proc.stdout.decode(errors="replace").splitlines():
        match = re.fullmatch(r"ld\.lld: Reading (.+\.(?:a|lib))\((.+)\)", line, re.I)
        if match:
            name, member = match.groups()
            paths = libraries.get(Path(name).name.lower(), set())
            if len(paths) != 1:
                external.append("unresolved archive: " + name)
            elif (path := next(iter(paths))).is_relative_to(toolchain):
                selected.add(path.relative_to(toolchain).as_posix() + "(" + member + ")")
        elif not line.startswith("ld.lld: ") or "warning:" in line:
            print(line)
    for path in inputs:
        if path.is_relative_to(toolchain) and path.suffix.lower() in (".obj", ".o"):
            selected.add(path.relative_to(toolchain).as_posix())
        if path.suffix.lower() == ".lib" or re.search(r"(?:libgcc|libstdc\+\+|libmsys|cygwin)", path.name, re.I):
            external.append(str(path))
    digest = sha256(image.read_bytes()).hexdigest()
    (records / (digest + ".json")).write_text(json.dumps({"image": image.name.lower(), "external": sorted(set(external)), "selected": sorted(selected)}))
    rsp.unlink()
    return 0


if __name__ == "__main__":
    sys.exit(main())
