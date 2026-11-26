# Contributing

Thank you for your interest in contributing to portable-postgres!

Whether you've found a bug, have an idea for an extension, or spotted a step in this guide that's hard to follow,
we'd love to hear from you.

## Contents

- [How to contribute](#how-to-contribute)
- [Tooling](#tooling)
- [Changes and validation](#changes-and-validation)
- [Native builds and safety](#native-builds-and-safety)
- [Building native archives](#building-native-archives)
- [Updating pinned sources](#updating-pinned-sources)
- [Updating license and host evidence in your PR](#updating-license-and-host-evidence-in-your-pr)
- [Development commands](#development-commands)

## How to contribute

### Issues

We use [GitHub Issues](https://github.com/vegardit/portable-postgres/issues) to track bugs and feature requests.
If you've run into a problem with an archive, please tell us which version you used and which operating system and CPU architecture you ran it on.
Let us know what you tried, what you expected, and what happened instead.
Those details help us reproduce the problem on the right platform.

### Pull requests

If you have a small fix, you're welcome to open a pull request directly.
Before starting a larger change, please open an issue so we can discuss it together.
For example, if you'd like to add a platform, change which extensions we ship, or revise the archive format,
we'd like to hear what you have in mind before you spend time implementing it.

When you open your pull request, please describe what you changed and why, link any related issue, and tell us which checks you ran.
If you're responsible for accepting a pull request or publishing a release, see the [maintainer guide](docs/maintaining.md).

### Contributor responsibilities

Please make sure you have the rights to contribute the work you're submitting, including any permission you need from your employer.
Our [pull request template](.github/PULL_REQUEST_TEMPLATE.md) includes the contribution declaration we ask you to confirm when you submit your work.

## Tooling

- **Node.js and pnpm.** Install Node.js 26 or newer and use pnpm 12 for all Node.js builds.
  pnpm checks the Node.js version already on your machine.
  Run `pnpm install --frozen-lockfile` from the repository root to install the tools pinned in [package.json](package.json) and [pnpm-lock.yaml](pnpm-lock.yaml).
- **Compilation, formatting and linting.** Use TypeScript 7 to compile, dprint to format and oxlint to lint TypeScript.
  See [Development commands](#development-commands) for the corresponding pnpm scripts.
- **Python.** The test suite (`pnpm test` or `pnpm check`) requires Python 3.
  Put `python` on `PATH` on Windows or `python3` on Linux and macOS.
  To match CI, install the version in [.python-version](.python-version).

The private root package contains the TypeScript tooling we use to build native archives.
People who download an archive can extract it and run PostgreSQL without Node.js.
Do not copy application code from other projects or reference wrapper implementations, tests, or automation.

## Changes and validation

Please keep your pull request focused on the problem you're solving so we can see what changed and why.

- **Source files.** Document the purpose of each source file you add or change where readers of that language expect to find it.
  Preserve the file's existing line endings. Shell scripts always use LF.
- **Documentation.** Write in plain English and start each sentence on a new source line in Markdown.
  This keeps the diff focused when someone edits a sentence later.
- **Project files.** Keep upstream checkouts and generated outputs out of formatting, linting, tests and packages.

Run `pnpm check` from the repository root to check formatting, linting, types, compilation and unit tests.
Run the relevant checks on each target your change affects.
If you change the native distribution, also run its native SQL tests on each affected target.
You'll find the platform-specific commands under [Building native archives](#building-native-archives).

## Native builds and safety

- **Build from verified sources.** Use the pinned upstream releases and verify each archive against its recorded SHA-256.
  If you're investigating an upstream change, keep that checkout separate from the sources used to build a distributable archive.
- **Check what ships.** Inspect the packaged files, including helper executables and code linked into binaries.
  Include indirect dependencies in your license review and check that the package carries every required notice.
  Build TimescaleDB in Apache-only mode and check its packaged files.
  Never distribute GPL or AGPL components in a native archive or npm package.
- **Keep changes to platform and extension support visible.** If a build fails on one target or with one extension,
  tell us which one failed. If you're proposing to drop support, explain the change in the pull request.
- **Protect the caller's data and processes.** Never delete data that belongs to the caller.
  Before acting on a process, confirm that it belongs to the operation you're running.
  For example, if a test can't confirm that it started a PostgreSQL server, leave that server running.

## Building native archives

To build locally, run `pnpm install --frozen-lockfile` from the repository root.
Then follow the instructions for [Linux](#linux-x64-and-arm64), [Windows](#windows-x64), or [macOS](#macos-arm64).
To download an archive that CI has already built, see [CI checks and downloads](#ci-checks-and-downloads).

### Linux x64 and arm64

Run these commands from the repository root on an x64 or arm64 Linux host.
Docker builds for the host architecture using Ubuntu 22.04, Clang and compiler-rt.
The fixed `/workspace` path lets upstream tools build even when the host checkout path contains spaces.

```sh
image=$(node -p 'require("./binaries/linux/base.json").image')
llvm=$(node -p 'require("./binaries/linux/base.json").llvm')
docker build --tag portable-postgres-linux-build \
  --build-arg "UBUNTU_IMAGE=$image" --build-arg "LLVM_MAJOR=$llvm" binaries/linux/image
docker run --rm --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD,target=/workspace" --workdir /workspace \
  portable-postgres-linux-build node binaries/linux/build.ts build
pnpm binaries:test:linux
```

Find the SDK, installation and archive through `last-build.json` in `binaries/output/linux-x64/`
or `binaries/output/linux-arm64/`.
Paths in that record are relative to its directory so they work on both the host and the container.

Rebuild the Docker image if you change the pins in [base.json](binaries/linux/base.json), the Dockerfile,
`traced-ld.sh` or `clang-cxx.sh`. A fresh build checks that the image matches the current recipe.

#### Test the packaged archive

Run `pnpm binaries:test:linux:clean <linux-target> <archive>` on a trusted archive.
Choose `linux-x64-glibc` or `linux-arm64-glibc` to match its architecture.
CI runs this same test on the exact archive it produces.

For the test environment and its recorded evidence, see [CI consumer tests](docs/native-artifact.md#ci-consumer-tests).

### Windows x64

Windows builds need CMake, Python, 7-Zip and native Windows Perl.
Set `PG_BUILD_PERL` to its executable if it is outside `PATH`.

Save any logs you need before starting a replacement build.
After a successful build or reassembly, cleanup can remove older builds, including their SDKs, sources, object files and logs.

Before the first build, create the isolated Meson environment and install the pinned version as shown below.
If a later build reports a Meson version mismatch, repeat the `pip install` command.

```powershell
python -m venv binaries/work/windows-toolchain
& binaries/work/windows-toolchain/Scripts/python.exe -m pip install --require-hashes --only-binary=:all: -r binaries/windows/requirements.txt
pnpm binaries:build:windows
pnpm binaries:test:windows
```

Use `pnpm binaries:prune:windows` to see each work directory's status.
Automatic cleanup keeps incomplete builds.
To remove an inactive incomplete build and its logs, select it explicitly with `--remove <name>`.
Both modes keep the recorded build and directories still in use, including an SDK that another checkout is reassembling.
If you select an unrecognized directory, the command rejects the entire selection before removing anything.

### macOS arm64

Build on an Apple silicon Mac with CMake and the Xcode version listed in `binaries/macos/base.json`.
Install Xcode at the specified path.
The build uses Apple's Bison, Flex and Perl.
Use a checkout path without spaces because PGXS makefiles split paths at spaces.

```sh
pnpm binaries:build:macos
pnpm binaries:test:macos
```

Run a fresh build after changing the macOS toolchain pins.
If Xcode, Bison or Flex changes, or the previous review lacks those versions, update the PostgreSQL component review.
See the [artifact contract](docs/native-artifact.md#identity-and-compatibility) for the deployment target, relocation and signature checks.

### Reassembling a previous build

A fresh build creates new source, object and SDK directories.
Reassembly packages the saved SDK again.
It checks that the source identities and build recipe still match and verifies the project-notice anchors against the saved sources.

Run a fresh build after changing a build script, source patch, Windows SQL installer or build tool pin.
If a newer build starts while reassembly is running, the newer build keeps its place as the last build.
Reassembly warns that its own candidate was not recorded.

### Archive names and revisions

The archive name includes the pinned PostgreSQL version, packaging revision and target,
for example `portable-postgres-18.7-r1-linux-x64-glibc.tar.gz`.
Windows archives use `.zip`.

The packaging revision in `binaries/sources/revision.json` counts releases of one PostgreSQL version.

| When                                                                       | Revision                                                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The PostgreSQL pin changes                                                 | Reset to 1.                                                                                          |
| The current revision is unreleased                                         | Keep the current revision.                                                                           |
| The current revision was released and PostgreSQL stays at the same version | Increment on the first archive change, such as an extension pin, build recipe or review file change. |

### CI checks and downloads

When you change the native distribution, the [Build workflow](.github/workflows/build.yml) builds and tests all four targets.
If a job fails, open its summary to see which check needs attention.
If release validation failed because a review is incomplete, CI has already uploaded the draft you need to
[update the evidence on your pull request](#updating-license-and-host-evidence-in-your-pr).

Pull requests that change only Markdown or the stale-issue workflow skip native builds.
For them, the Build workflow runs `pnpm check` through the [Documentation workflow](.github/workflows/docs.yml).

**Download a candidate.** Sign in to GitHub and open the workflow run.
The `portable-postgres-<target>` artifact contains the archive and its checksum and is available for 14 days.
The target job also records the SHA-256 in its summary.
Use [published releases](https://github.com/vegardit/portable-postgres/releases) for redistribution.

Before we merge your pull request, the `Native release readiness` check must pass.

## Updating pinned sources

To propose an upstream update, run `pnpm binaries:update-pins` from the repository root.
Only one updater can run in a checkout at a time.
If an interrupted run leaves `binaries/work/update-pins.lock`, confirm the updater has stopped,
then remove the empty lock directory and retry.
Review the new versions, archive URLs and hashes in [sources.json](binaries/sources/sources.json)
and check the [packaging revision](#archive-names-and-revisions).
The updater keeps PostgreSQL within its pinned major version and OpenSSL on the 3.5 LTS patch series.
The contrib modules selected in [runtime-layout.ts](binaries/artifact/runtime-layout.ts) come from the PostgreSQL pin.
For changes to the Windows toolchain, update [clang64.json](binaries/windows/clang64.json) and [tools.json](binaries/windows/tools.json) by hand.

If the update fails CI, use the job summary to find what needs changing.

- **A pinned notice is missing.** Find out where its text moved or whether the code it covered was removed.
  Update the source's `noticeFiles` entry accordingly.
- **A notice changed at the same path.** The archive includes the new text.
  [Update the evidence for the reopened component](#updating-license-and-host-evidence-in-your-pr) on the same pull request.
- **A Windows patch no longer applies.** Check whether the updated source still needs the patch in `binaries/windows/patches/`.
  Update or remove it following the [source patch instructions](docs/native-artifact.md#source-patches).

## Updating license and host evidence in your PR

If your change affects what an archive ships or needs from its host, Build can flag a gap in the recorded evidence.
Update the file for each affected target on your pull request.

| Build target        | Tracked review file                                                  |
| ------------------- | -------------------------------------------------------------------- |
| `linux-x64-glibc`   | [binaries/linux/review-x64.json](binaries/linux/review-x64.json)     |
| `linux-arm64-glibc` | [binaries/linux/review-arm64.json](binaries/linux/review-arm64.json) |
| `windows-x64`       | [binaries/windows/review.json](binaries/windows/review.json)         |
| `macos-arm64`       | [binaries/macos/review.json](binaries/macos/review.json)             |

1. **Get the draft for the target.** Open the pull request's Build run and download `review-draft-<target>`.
   The job summary lists what reopened.
   To generate the same draft locally, build a candidate and run `pnpm binaries:review <target>`.
   It writes `review-draft.json` beside the build output.
   Use `--output <new-file>` to keep an earlier draft and any notes you have added.
2. **Check what changed.** Compare the draft with the tracked review.
   For each reopened component, check the shipped files and licenses against the upstream source.
   Read the release notes for each updated source and look for newly bundled code, even if its notices look familiar.
   Compare the draft's `noticeSignatures` with the tracked review for the full list of changed signatures.
3. **Update the evidence.** Use the draft as the target's review file.
   Check that its `target` matches the archive you reviewed.
   If the tracked review changed after the draft was generated, get a fresh draft from the updated review
   before copying it so you keep the latest reviewer notes.
   Keep its current file lists, notice hashes and signatures.
   - For a new or reopened component, record the licenses and the evidence that they cover the built files.
     If the licenses changed, explain why.
     If the earlier evidence still holds, cite the commit on `main` that approved it instead of copying it.
     Cite only commits on `main` and workflow runs that are kept; a pull request commit or deleted run can disappear.
   - Keep every drafted host library and its measured requirement, such as `GLIBC_2.34 or newer`.
     For a new host library, fill in its requirement, license and evidence.
     If a measured requirement changed, the draft clears that library's evidence; record evidence for the new requirement.
     For an initial Windows review, also record the tested Windows version and CPU requirements.
   - If several components contribute code to a binary, credit each one.
     Keep the binary in the file list of the source component that built it.
4. **Verify your changes.** Run `pnpm exec dprint fmt <review-file>` on the copied file
   to apply the checkout's formatting, including Windows line endings.
   Commit the updated file to the pull request.
   Build validates the extracted archive and reports remaining gaps.
   For local verification, rebuild the installation and run `pnpm binaries:validate <target> <installation>`.

The maintainer reviewing your pull request decides whether the evidence covers the change.
Merging into `main` records that approval.

## Development commands

### Setup and project checks

- `pnpm install --frozen-lockfile`: install pinned tools.
- `pnpm format:check`: check formatting of project-owned files.
- `pnpm format:fix`: format those files.
- `pnpm lint`: lint project-owned JavaScript and TypeScript once source files exist.
- `pnpm build`: compile the private binary build tooling with TypeScript 7.
- `pnpm typecheck`: check the build tooling and tests.
- `pnpm test`: run build-tool regression tests.
- `pnpm check`: run formatting, lint, typecheck, build, and unit checks.

### Source pins and native builds

- `pnpm binaries:update-pins [--summary <file>]`: pin the newest upstream release of every source and set the packaging revision.
- `pnpm binaries:fetch`: check the SHA-256 of each pinned source archive and download any missing archives.
- `pnpm binaries:build:linux`: compile and package PostgreSQL inside the [Linux build environment](#linux-x64-and-arm64).
- `pnpm binaries:assemble:linux`: assemble a fresh Linux runtime from the last development installation.
- `pnpm binaries:test:linux`: run the Linux native SQL and TAP proofs against the last assembled runtime.
- `pnpm binaries:test:linux:clean <linux-target> <trusted-archive.tar.gz>`: test a Linux archive in the clean Docker consumer.
- `pnpm binaries:build:windows`: build and package the Windows candidate with Clang, LLD and MinGW-w64.
  Set `BUILD_JOBS` to adjust parallel compilation (4 jobs by default).
- `pnpm binaries:assemble:windows`: reassemble the last matching Windows SDK with current notices and metadata.
- `pnpm binaries:test:windows`: test the relocated Windows candidate with native SQL and TAP.
- `pnpm binaries:prune:windows`: preview Windows work directories, their sizes and retention status.
  Add `--remove <name> [name ...]` to remove selected directories from the preview.
- `pnpm binaries:build:macos`: build and package the macOS arm64 candidate with the pinned Xcode.
- `pnpm binaries:assemble:macos`: reassemble the last matching macOS SDK with current notices and metadata.
- `pnpm binaries:test:macos`: test the relocated macOS candidate with the same native SQL and TAP proof as Linux.

### Archive verification and review

- `pnpm binaries:verify:archive <archive> <trusted-sha256>`: verify archive bytes before trusting their metadata.
- `pnpm binaries:validate:candidate <target> <installation>`: check candidate layout, hashes, architecture, and permissions.
- `pnpm binaries:review <target> [installation] [--output file] [--summary file]`: write a license review draft for the last or given candidate, starting from the tracked review, and list what still blocks a release.
- `pnpm binaries:validate <target> <installation>`: additionally require reviewed licenses and host prerequisites.
- `pnpm binaries:compare <installation> <installation>`: report extension versions and files that differ between two targets.
