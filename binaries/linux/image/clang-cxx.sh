#!/usr/bin/env bash
# Builds ICU with LLVM's C++ runtimes while retaining a trace of every shipped link.
set -euo pipefail
llvm=${LLVM_MAJOR:?The pinned LLVM major must be supplied}
link=1
for argument in "$@"; do
  case "$argument" in -c | -E | -S | -M | -MM | --version) link=0 ;; esac
done
flags=(-stdlib=libc++ -nostdlib++)
compiler="clang++-$llvm"
runtime="/usr/lib/llvm-$llvm/lib"
if [[ ${PORTABLE_PG_LIBC:-glibc} == musl ]]; then
  compiler="/usr/lib/llvm$llvm/bin/clang++"
  runtime=/opt/portable-llvm/lib
  flags+=(-nostdinc++ -isystem /opt/portable-llvm/include/c++/v1)
else
  flags+=(--config="/usr/lib/llvm-$llvm/bin/clang.cfg")
fi
if [[ $link == 0 ]]; then
  exec "$compiler" "${flags[@]}" "$@"
fi
# Static LLVM libraries avoid depending on a host's C++ runtime. The group resolves
# references between libc++, its ABI implementation and its exception unwinder.
exec "$compiler" "${flags[@]}" "$@" -x none -Wl,--start-group \
  "$runtime/libc++.a" "$runtime/libc++abi.a" "$runtime/libunwind.a" -Wl,--end-group -lpthread -ldl -lm
