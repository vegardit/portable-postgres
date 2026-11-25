# SPDX-License-Identifier: Apache-2.0
"""Pack a Windows installation at the ZIP root with reproducible entry metadata."""

import shutil
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def pack(installation, archive):
    with ZipFile(archive, "w") as output:
        for path in sorted(installation.rglob("*"), key=lambda item: item.as_posix()):
            name = path.relative_to(installation).as_posix()
            if path.is_symlink():
                raise ValueError(f"Unexpected symlink in Windows installation: {name}")
            directory = path.is_dir()
            entry = ZipInfo(name + ("/" if directory else ""), (2000, 1, 1, 0, 0, 0))
            entry.create_system = 0
            entry.external_attr = 0x10 if directory else 0x20
            if directory:
                output.writestr(entry, b"")
            else:
                entry.compress_type = ZIP_DEFLATED
                if hasattr(entry, "compress_level"):
                    entry.compress_level = 9
                else:
                    entry._compresslevel = 9  # Python before 3.13.
                entry.file_size = path.stat().st_size
                with path.open("rb") as source, output.open(entry, "w") as destination:
                    shutil.copyfileobj(source, destination)


if __name__ == "__main__":
    pack(Path(sys.argv[1]), sys.argv[2])
