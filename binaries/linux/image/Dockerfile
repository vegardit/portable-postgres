# SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
# SPDX-FileContributor: Sebastian Thomschke
# SPDX-License-Identifier: Apache-2.0
# SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres

# Builds native x64 and arm64 Linux PostgreSQL against Ubuntu 22.04's glibc using LLVM compiler-rt.
ARG UBUNTU_IMAGE=scratch
# The Node major floats like the CI host's Node. Here Node only orchestrates, hashes and packs, so a
# release can change the archive's compression bytes but never the compiled payload.
FROM node:26-bookworm-slim AS node

FROM ${UBUNTU_IMAGE}
# The LLVM major comes from base.json, which the build scripts and the ELF inspection read as well.
ARG LLVM_MAJOR
COPY --from=node /usr/local/bin/node /usr/local/bin/node

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN test -n "$LLVM_MAJOR" \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gpg \
 && curl --fail --show-error --silent --location https://apt.llvm.org/llvm-snapshot.gpg.key -o /tmp/llvm.asc \
 && gpg --batch --show-keys --with-colons /tmp/llvm.asc \
    | awk -F: '$1 == "pub" { keys++ } $1 == "fpr" && $10 == "6084F3CF814B57C1CF12EFD515CF4D18AF4F7421" { trusted++ } END { exit !(keys == 1 && trusted == 1) }' \
 && gpg --batch --dearmor -o /usr/share/keyrings/llvm.gpg /tmp/llvm.asc \
 && printf '%s\n' "deb [signed-by=/usr/share/keyrings/llvm.gpg] https://apt.llvm.org/jammy/ llvm-toolchain-jammy-$LLVM_MAJOR main" > /etc/apt/sources.list.d/llvm.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
    bison build-essential "clang-$LLVM_MAJOR" cmake file flex "libclang-rt-$LLVM_MAJOR-dev" "llvm-$LLVM_MAJOR" \
     "libc++-$LLVM_MAJOR-dev" "libc++abi-$LLVM_MAJOR-dev" "libunwind-$LLVM_MAJOR-dev" \
     patchelf perl pkg-config python3 \
 && rm -rf /var/lib/apt/lists/* /tmp/llvm.asc \
 # Clang reads clang.cfg next to its binary on every call, so even a link whose recipe drops LDFLAGS
 # uses compiler-rt instead of GCC's GPL runtime and links through traced-ld, which records the link's
 # inputs for the build's checks. Compile-only calls accept these options silently.
 && test -x /usr/bin/ld.bfd \
 && printf '%s\n' --rtlib=compiler-rt --unwindlib=none --ld-path=/usr/local/bin/traced-ld \
    > "/usr/lib/llvm-$LLVM_MAJOR/bin/clang.cfg" \
 && node --version
COPY --chmod=0755 traced-ld.sh /usr/local/bin/traced-ld
COPY --chmod=0755 clang-cxx.sh /usr/local/bin/portable-clang-cxx
# A fresh build compares these with the checkout's recipe, so that it never runs in an image that an older
# recipe built.
ARG UBUNTU_IMAGE
COPY Dockerfile traced-ld.sh clang-cxx.sh /usr/local/share/portable-postgres/recipe/
RUN printf '%s\n' "$UBUNTU_IMAGE" > /usr/local/share/portable-postgres/recipe/ubuntu-image \
 && printf '%s\n' "$LLVM_MAJOR" > /usr/local/share/portable-postgres/recipe/llvm-major
