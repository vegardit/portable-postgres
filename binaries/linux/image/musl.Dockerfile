# SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
# SPDX-License-Identifier: Apache-2.0
# SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres

# Builds native musl archives and provides the clean Alpine test environment.
ARG ALPINE_IMAGE=scratch
FROM node:26-alpine3.24 AS node

FROM ${ALPINE_IMAGE} AS consumer
RUN musl=$(apk info --installed --verbose musl) \
 && apk add --no-cache bash runuser \
 && test "$(apk info --installed --verbose musl)" = "$musl"

FROM consumer AS tools
ARG LLVM_MAJOR
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# Use GNU ld for the same trace format as the glibc recipe. Keep Alpine's target defaults and
# override its GCC runtime selection for every link, including links that discard LDFLAGS.
RUN apk add --no-cache binutils bison "clang$LLVM_MAJOR" cmake compiler-rt file flex libatomic \
    libc++-dev linux-headers "llvm$LLVM_MAJOR" llvm-libunwind-dev \
    make musl-dev ninja patchelf perl pkgconf python3 tar xz \
 && printf '%s\n' --rtlib=compiler-rt --unwindlib=none --ld-path=/usr/local/bin/traced-ld \
    >> "/etc/clang$LLVM_MAJOR/$(uname -m)-alpine-linux-musl.cfg" \
 && test -x /usr/bin/ld.bfd \
 && node --version
COPY --chmod=0755 traced-ld.sh /usr/local/bin/traced-ld

FROM tools AS llvm-runtimes
ARG LLVM_MAJOR
ARG LLVM_RUNTIME_VERSION=22.1.3
ADD --checksum=sha256:2488c33a959eafba1c44f253e5bbe7ac958eb53fa626298a3a5f4b87373767cd \
    https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_RUNTIME_VERSION}/llvm-project-${LLVM_RUNTIME_VERSION}.src.tar.xz /tmp/llvm.tar.xz
# Alpine's static libc++abi archive uses executable-only TLS relocations. ICU needs PIC objects.
RUN set -eu; \
    mkdir /tmp/llvm; \
    tar -xJf /tmp/llvm.tar.xz -C /tmp/llvm --strip-components=1; \
    cmake -G Ninja -S /tmp/llvm/runtimes -B /tmp/runtimes \
      -DCMAKE_C_COMPILER="/usr/lib/llvm$LLVM_MAJOR/bin/clang" \
      -DCMAKE_CXX_COMPILER="/usr/lib/llvm$LLVM_MAJOR/bin/clang++" \
      -DCMAKE_CXX_FLAGS=-stdlib=libc++ -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_INSTALL_PREFIX=/opt/portable-llvm \
      -DCMAKE_INSTALL_LIBDIR=lib -DLLVM_ENABLE_PER_TARGET_RUNTIME_DIR=OFF \
      -DLLVM_ENABLE_RUNTIMES='libcxx;libcxxabi;libunwind' -DLLVM_INCLUDE_TESTS=OFF \
      -DLIBCXX_HAS_MUSL_LIBC=ON \
      -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_SHARED=OFF -DLIBUNWIND_ENABLE_SHARED=OFF \
      -DLIBCXX_USE_COMPILER_RT=ON -DLIBCXXABI_USE_COMPILER_RT=ON -DLIBUNWIND_USE_COMPILER_RT=ON \
      -DLIBCXXABI_USE_LLVM_UNWINDER=ON; \
    cmake --build /tmp/runtimes --parallel "$(nproc)"; \
    cmake --install /tmp/runtimes; \
    printf '%s\n' "$LLVM_RUNTIME_VERSION" > /opt/portable-llvm/version

FROM tools AS build
ARG ALPINE_IMAGE
ARG LLVM_MAJOR
# pgTAP applies patches when generating its SQL installation script.
RUN apk add --no-cache patch
COPY --from=llvm-runtimes /opt/portable-llvm /opt/portable-llvm
COPY --chmod=0755 clang-cxx.sh /usr/local/bin/portable-clang-cxx
COPY musl.Dockerfile traced-ld.sh clang-cxx.sh /usr/local/share/portable-postgres/recipe/
RUN printf '%s\n' "$ALPINE_IMAGE" > /usr/local/share/portable-postgres/recipe/alpine-image \
 && printf '%s\n' "$LLVM_MAJOR" > /usr/local/share/portable-postgres/recipe/llvm-major
