# SPDX-License-Identifier: Apache-2.0

"""Check the provider search directory reported by a relocated archive's own libcrypto."""

import ctypes
import os
import sys
from pathlib import Path

OPENSSL_INFO_MODULES_DIR = 1003  # Public selector from openssl/crypto.h
installation = Path(sys.argv[1]).resolve(strict=True)
if os.name == "nt":
  libraries = installation / "bin"
  # CI inspects the archive on the same host that configured OpenSSL.
  program_files = os.environ.get("ProgramW6432") or os.environ["ProgramFiles"]
  expected = Path(program_files) / "OpenSSL/lib/ossl-modules"
else:
  libraries = installation / "lib"
  expected = Path("/etc/ssl/ossl-modules")

(library,) = libraries.glob("libcrypto*")
info = ctypes.CDLL(str(library)).OPENSSL_info
info.argtypes = [ctypes.c_int]
info.restype = ctypes.c_char_p
reported = info(OPENSSL_INFO_MODULES_DIR)
if reported is None or Path(os.fsdecode(reported)) != expected:
  sys.exit(f"{library} reported provider directory {reported!r}, expected {expected}")
print(f"{library.name} provider directory: {expected}")
