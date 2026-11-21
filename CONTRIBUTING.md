# Contributing

## Tooling

Use pnpm 12 for all Node.js builds, TypeScript 7 for compilation, dprint for formatting,
and oxlint for TypeScript linting.
Install Node.js 26 or newer; pnpm checks the installed version and does not download a runtime.
Use the pinned tools in the package manifest and lockfile.
The private root package contains shared binary build orchestration in TypeScript.
The publishable wrapper belongs in `wrappers/node/` and is a separate package.
Node.js may be required in build environments; native archive consumers must not need it.
Do not copy application code from other projects or reference wrapper implementations, tests, or automation.

## Changes and validation

Keep changes focused and re-read current files before editing.
Document each source file's purpose in the language's conventional location.
Use plain English and semantic line breaks in Markdown.
Preserve existing line endings; shell scripts always use LF.
Exclude upstream checkouts and generated outputs from formatting, linting, tests, and packages.

Run the checks on each affected target and run the native SQL tests for changes to the distribution.

## Native builds and safety

Use verified upstream releases with pinned identities and integrity checks.
Keep research checkouts separate from reproducible build inputs.
Never distribute GPL or AGPL components in native archives or npm packages.
Inspect transitive and linked dependencies, helper executables, licenses, and required notices.
Build TimescaleDB in Apache-only mode and inspect packaged files.
Do not silently reduce the extension bundle or target matrix.
Never delete caller-owned data or act on a process whose ownership is uncertain.

## Development commands

- `pnpm install --frozen-lockfile`: install pinned tools.
- `pnpm format:check`: check formatting of project-owned files.
- `pnpm format:fix`: format those files.
- `pnpm lint`: lint project-owned JavaScript and TypeScript once source files exist.

- `pnpm build`: compile the private binary build tooling with TypeScript 7.
- `pnpm typecheck`: check the build tooling and tests.
- `pnpm test`: run build-tool regression tests.
- `pnpm check`: run formatting, lint, typecheck, build, and unit checks.
- `pnpm binaries:fetch`: check the SHA-256 of each pinned source archive and download any missing archives.
- `pnpm binaries:build:linux`: compile and package PostgreSQL inside the Linux build environment below.
- `pnpm binaries:assemble:linux`: assemble a fresh Linux runtime from the last development installation.
- `pnpm binaries:test:linux`: run the Linux native SQL and TAP proofs against the last assembled runtime.
- `pnpm binaries:test:linux:clean <trusted-archive.tar.gz>`: test a Linux archive in the clean Docker consumer.
- `pnpm binaries:build:windows`: build and package the Windows candidate with MSVC.
  Both builds run `BUILD_JOBS` parallel compile jobs, 4 unless the variable is set.
- `pnpm binaries:assemble:windows`: reassemble the last matching Windows SDK with current notices and metadata.
- `pnpm binaries:test:windows`: test the relocated Windows candidate with native SQL and TAP.
- `pnpm binaries:validate:candidate <target> <installation>`: check candidate layout, hashes, architecture, and permissions.
- `pnpm binaries:validate <target> <installation>`: additionally require reviewed licenses and host prerequisites.
- `pnpm binaries:verify:archive <archive> <trusted-sha256>`: verify archive bytes before trusting their metadata.
- `pnpm binaries:compare <installation> <installation>`: report extension versions and files that differ between two targets.
- `pnpm binaries:review <target> [installation] [--output file] [--summary file]`: write a licence review draft for the last or given candidate, starting from the tracked review, and list what still blocks a release.
- `pnpm binaries:release <downloads> <output> <owner/repository> [--require-all-targets]`: prepare release assets, including the source bundle, from downloaded archives in a new output directory; with `--require-all-targets`, every archive must also carry a verified review, and every target must be present.
- `pnpm binaries:update-pins [--summary <file>]`: pin the newest upstream release of every source and set the packaging revision.

## Building native archives

The [Build workflow](.github/workflows/build.yml) builds and tests Linux x64 and Windows x64 archives on GitHub Actions.
It skips changes to Markdown files alone; the [Documentation workflow](.github/workflows/docs.yml) runs `pnpm check` for them.
Each job records the archive's SHA-256 in its summary.
Private CI runs also retain the archive and checksum as workflow artifacts.
A manual run with `validation: release` also runs release validation on each archive.
In a public repository it uploads no archive; only the Release workflow does, after release validation.

Run `pnpm install --frozen-lockfile` from the repository root before building for either target.
Every native build uses fresh source, object, and SDK directories.
Reassembly checks that the saved source identities and build recipe still match the current ones.
It also verifies the current project-notice anchors against the saved sources.
A reassembly that finishes after a newer build has started keeps that build as the last one, and warns that its own candidate is not recorded.
A change to a build script, a source patch, the Windows SQL installer, or a build tool pin therefore needs a fresh build.
Candidate metadata follows [native artifact format 1](docs/native-artifact.md).
Release validation deliberately fails until the artifact's license inventory and host prerequisites are verified.

An archive is named after its release, for example `portable-postgres-18.7-r1-linux-x64-glibc.tar.gz`.
The name combines the pinned PostgreSQL version with the packaging revision in `binaries/sources/revision.json`.
Increase the revision for any change to the archives that keeps the PostgreSQL version,
such as an extension pin, a build recipe, or a review file.
Reset it to 1 when the PostgreSQL pin changes.

### Linux x64

The workflow builds on Ubuntu 22.04 with Clang and compiler-rt inside a Docker container.
`binaries/linux/base.json` pins the Ubuntu image, the glibc baseline, and the LLVM major version.
It checks the compiler link plan for GCC runtime contributions and measures the glibc symbol requirements of every packaged ELF file.
The image's `clang.cfg` makes Clang link through `binaries/linux/image/traced-ld.sh`,
which records what each link copies into its output.
Packaging checks the record of every image in the candidate, also when it reassembles a build.
Rebuild the image after changing the Dockerfile or `traced-ld.sh`.
A fresh build stops when the image was built from another Dockerfile, `traced-ld.sh`, or `base.json`.
To build locally on Linux, run the same container from the repository root:

```sh
image=$(node -p 'require("./binaries/linux/base.json").image')
llvm=$(node -p 'require("./binaries/linux/base.json").llvm')
docker build --platform linux/amd64 --tag portable-postgres-linux-build \
  --build-arg "UBUNTU_IMAGE=$image" --build-arg "LLVM_MAJOR=$llvm" binaries/linux/image
docker run --rm --platform linux/amd64 --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD,target=/workspace" --workdir /workspace \
  portable-postgres-linux-build node binaries/linux/build.ts build
pnpm binaries:test:linux
```

The fixed container path lets upstream build tools run even when the host checkout path contains spaces.
The build records paths relative to the directory containing `binaries/output/linux-x64/last-build.json`,
so the host and the container can both locate the SDK, installation, and archive.
Run `pnpm binaries:test:linux:clean <archive>` against a trusted archive.
This is the same check the workflow runs on the exact archive it produces.
The clean Ubuntu 22.04 consumer runs PostgreSQL without build tools or network access.

### Windows x64

Windows builds need Visual Studio C++ tools, CMake, Python, 7-Zip, and Git's Perl.
Create the isolated Meson environment before the first Windows build.
A fresh build stops when its Meson differs from the pin in `binaries/windows/requirements.txt`;
the `pip install` line below then installs the pinned version.

```powershell
python -m venv binaries/work/windows-toolchain
& binaries/work/windows-toolchain/Scripts/python.exe -m pip install --require-hashes --only-binary=:all: -r binaries/windows/requirements.txt
pnpm binaries:build:windows
pnpm binaries:test:windows
```

The Windows build selects Visual Studio Community, Professional or Enterprise with the C++ tools,
and any other installation with them, such as Build Tools alone, only when none of these is installed.
It never selects a preview or Insiders installation.
The scripts use that installation's x64 toolchain and bundled Ninja.
The linker must support recording its input paths with `/LINKREPROFULLPATHRSP`
(Visual Studio 2022 17.11 or later).
Packaging checks the link map of every image and fails when one links static code from a Microsoft library
other than `msvcrt.lib` and `vcruntime.lib`, for example from the Windows SDK;
[native artifact format 1](docs/native-artifact.md) describes the check.
They keep parser generators and other build-only tools outside the runtime archive.
Native proofs retain private diagnostic directories and shut down their owned instance.

## Updating pinned sources

`binaries/sources/sources.json` pins PostgreSQL and every extension by version, archive URL, and SHA-256.
Its `upstream` entries say where new releases come from, so the pins are not edited by hand.
`pnpm binaries:update-pins` finds the newest stable release of each source,
keeping PostgreSQL within its pinned major version, and downloads every changed archive.
PostgreSQL archives are checked against the checksum PostgreSQL publishes.
GitHub publishes no checksum for tag archives, so the first verified download defines their pin.
The command also sets the packaging revision: a new PostgreSQL release restarts it at 1,
and other changes open the next revision once the current one has been released.

The [Update Sources workflow](.github/workflows/update-sources.yml) runs the command every Monday
and opens or refreshes a pull request on the `dependencies/sources` branch.
The Build workflow then checks that every target still compiles and passes the native tests with the new releases.
The build also fails when a notice file that `noticeFiles` pins no longer exists in the updated source:
find where its text moved, or whether the code it covers went, and update the pin.
A notice whose text changed ships under the same path, and the review lists its component as reopened.
The Windows build fails when a source patch in `binaries/windows/patches/` no longer applies.
Then check whether the updated source still needs the patch, as "Source patches" in
[native artifact format 1](docs/native-artifact.md) describes, and update or remove it.
The workflow creates the pull request with a GitHub App, so that its checks run without a manual approval.
Configure the App's ID as the `PR_UPDATER_APP_ID` variable and its private key as the `PR_UPDATER_APP_PRIVATE_KEY` secret.
The Windows build tools in `binaries/windows/tools.json` are not covered and are updated by hand.

## Reviewing licences and host requirements

Each target has a tracked review file: `binaries/linux/review.json` and `binaries/windows/review.json`.
It holds the licence inventory and the host requirements that the build writes into the archive manifest.
The build writes only what still matches the candidate: a part that `pnpm binaries:review` would reopen is pending,
and host requirements that it would reopen are `null`.
Without the file, the build produces a candidate whose review is pending.

1. Build a candidate for the target.
2. Run `pnpm binaries:review <target>` to write `review-draft.json` next to the build output.
   The draft assigns every shipped file to a component, including one component per toolchain part
   linked into native binaries (`compiler-rt` and `glibc-startup` on Linux, `msvc-runtime` on Windows),
   and records the hash of every licence notice and the toolchain line.
   It starts from the tracked review and lists the parts it reopens.
   When it reopens nothing, it also lists anything the release gate would still reject.
   It always lists a Visual Studio line or edition that releases do not admit, which no review can resolve.
   Reopened components keep their previous licences as a starting point but no evidence,
   because a source's declared licence does not establish the licence of built files.
   A component that is still pending but unchanged keeps its evidence and is listed as not verified yet.
   Components that you added to the review yourself, such as code that a source bundles,
   are kept while their files still ship and reopened when their files or notices change.
   A component with none of its files left is dropped.
   Files that you add to a drafted source component, and notices that you add to any drafted component,
   are kept the same way while they ship. A toolchain component's files always follow the current images.
   A host library that you add, such as one that another library loads, is kept as well;
   it reopens nothing by itself. A new import, a changed measured requirement,
   and a measured library that the build no longer imports reopen the host requirements.
3. Review each pending part: complete the licences, evidence, and host requirements,
   set the statuses to `verified`, and save the result as the target's review file.
   Keep each drafted library and its drafted `requirement`: release validation requires an entry for every
   imported host library and the measured glibc requirement, such as `GLIBC_2.34 or newer`.
   A component that you add can describe part of an image, but every image must stay in the files
   of the source component that built it.
4. Rebuild and run `pnpm binaries:validate <target> <installation>`.

A review stays valid while the shipped files, the licence texts it read, and the toolchain line are unchanged.
Most source updates therefore keep their review.
The Build workflow lists the reopened parts in its job summary and uploads the draft as `review-draft-<target>`,
so a pull request shows what needs a review without a local build.
To review a reopened source, compare its licence, copyright, and notice files between the two releases,
look for newly bundled third-party code with its own licence, and skim the release notes.
The notice comparison cannot detect such bundled code while the main licence files stay unchanged,
so also skim the release notes of every other updated source for it, and add a component for any that you find.
A new copyright year in a licence file also reopens its component.

The toolchain components carry fixed licences.
`compiler-rt` carries `Apache-2.0 WITH LLVM-exception`.
`glibc-startup` carries `LGPL-2.1-or-later WITH GCC-exception-2.0`.
`msvc-runtime` carries `LicenseRef-Microsoft-VisualStudio-2026-Linked-CRT-Code`.
Its draft also lists the project's notice `notices/msvc-runtime.txt` for the linked Microsoft code,
whose text the review approves together with the images.
Review the Windows target from a build on the `windows-2025` runner, which uses Visual Studio 2026 Enterprise.
Local Windows builds with another Visual Studio line, such as 2022, or with Build Tools alone produce candidates only:
`pnpm binaries:review` names the release gap for them and reopens `msvc-runtime`, whose notice differs, and release validation refuses them.
Such a candidate ships `binaries/windows/notices/msvc-runtime-candidate.txt` instead of the reviewed notice,
with the line and product that Visual Studio reports filled in; that text says not to redistribute it.
A new Visual Studio product line needs a review of its licence terms and a repository change that admits it.

## Releasing

Native releases are published only by the [Release workflow](.github/workflows/release.yml), started manually.
A release is tagged `native-v<version>`, for example `native-v18.7-r1`, and is never changed after publishing.
A correction needs the next packaging revision.

The workflow builds every target in release mode, so each build job unpacks its finished archive with GNU tar
and runs the native tests and release validation on it before it uploads the archive.
The release job trusts the archives of its own run and does not unpack them again.
It checks that every archive belongs to the computed version and to the checkout's source pins and carries a verified review,
checks that no target is missing, compares the targets,
writes `SHA256SUMS`, a descriptor with each archive's URL and SHA-256, and the release notes,
packs the source bundle, attests the build provenance, and publishes the release from a draft.
The source bundle, `portable-postgres-<version>-sources.tar.gz`, holds the release commit's files
with the pinned source archives in `binaries/work/downloads/`, where a build from it finds and verifies them,
so that whoever passes an archive on can also pass on the source it was built from.
The bundle leaves out build tools. For prerequisites and setup, see [Building native archives](#building-native-archives).
Creating the bundle requires a clean tracked working tree.
A release also needs a macOS arm64 archive, which has no recipe yet.
Until the macOS target exists, the release job therefore fails after the build jobs, and only dry runs succeed.
Protect the `release` environment with required reviewers so publication needs a manual approval.

The `dry-run` input, enabled by default, builds and checks the candidates without creating a tag or release.
In a public repository a dry run stops after the build jobs.
In a private repository it prepares the assets with read-only permissions.
Each supplied `portable-postgres-*.tar.gz` must belong to the current revision and a supported target,
even when the dry run contains only one target.
A local [act](https://github.com/nektos/act) run covers the same build jobs:

```sh
act workflow_dispatch -W .github/workflows/release.yml --input dry-run=true --matrix output:linux-x64
```

act's artifact server does not accept the artifact upload action this workflow uses, so act cannot hand archives to the release job.
The release job's checks, checksums, descriptor, and notes are covered by `tests/release.test.ts` instead.
