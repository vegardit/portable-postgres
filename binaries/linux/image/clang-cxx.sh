#!/usr/bin/env bash
# Builds ICU with LLVM's C++ runtimes while retaining a trace of every shipped link.
set -euo pipefail
llvm=${LLVM_MAJOR:?The pinned LLVM major must be supplied}
link=1
for argument in "$@"; do
  case "$argument" in -c | -E | -S | -M | -MM | --version) link=0 ;; esac
done
flags=(--config="/usr/lib/llvm-$llvm/bin/clang.cfg" -stdlib=libc++ -nostdlib++)
if [[ $link == 0 ]]; then
  exec "clang++-$llvm" "${flags[@]}" "$@"
fi
# Static LLVM libraries avoid depending on a host's C++ runtime. The group resolves
# references between libc++, its ABI implementation and its exception unwinder.
exec "clang++-$llvm" "${flags[@]}" "$@" -x none -Wl,--start-group \
  "/usr/lib/llvm-$llvm/lib/libc++.a" "/usr/lib/llvm-$llvm/lib/libc++abi.a" \
  "/usr/lib/llvm-$llvm/lib/libunwind.a" -Wl,--end-group -lpthread -ldl -lm
