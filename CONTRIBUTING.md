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
  The Ninja, CMake and OpenSSL steps use up to `BUILD_JOBS` parallel compile jobs (4 by default).
  pgvector compiles serially with NMake.
- `pnpm binaries:assemble:windows`: reassemble the last matching Windows SDK with current notices and metadata.
- `pnpm binaries:prune:windows`: preview Windows work directories, their sizes and retention status.
  Add `--remove <name> [name ...]` to remove selected directories from the preview.
- `pnpm binaries:test:windows`: test the relocated Windows candidate with native SQL and TAP.
- `pnpm binaries:build:macos`: build and package the macOS arm64 candidate with the pinned Xcode.
- `pnpm binaries:assemble:macos`: reassemble the last matching macOS SDK with current notices and metadata.
- `pnpm binaries:test:macos`: test the relocated macOS candidate with the same native SQL and TAP proof as Linux.
- `pnpm binaries:validate:candidate <target> <installation>`: check candidate layout, hashes, architecture, and permissions.
- `pnpm binaries:validate <target> <installation>`: additionally require reviewed licenses and host prerequisites.
- `pnpm binaries:verify:archive <archive> <trusted-sha256>`: verify archive bytes before trusting their metadata.
- `pnpm binaries:compare <installation> <installation>`: report extension versions and files that differ between two targets.
- `pnpm binaries:compare --require-all-targets <downloads>`: compare the `manifest-<target>` directories from a hosted Build.
  Each directory must contain the manifest for its named target.
- `pnpm binaries:review <target> [installation] [--output file] [--summary file]`: write a licence review draft for the last or given candidate, starting from the tracked review, and list what still blocks a release.
- `pnpm binaries:release <downloads> <output> <owner/repository> [--require-all-targets]`: prepare release assets, including the source bundle, from downloaded archives in a new output directory; with `--require-all-targets`, every archive must also carry a verified review, and every target must be present.
- `pnpm binaries:update-pins [--summary <file>]`: pin the newest upstream release of every source and set the packaging revision.

## Building native archives

The [Build workflow](.github/workflows/build.yml) builds and tests Linux x64, Windows x64 and macOS arm64 archives on GitHub Actions.
It skips changes to Markdown files alone; the [Documentation workflow](.github/workflows/docs.yml) runs `pnpm check` for them.
Each job records the archive's SHA-256 in its summary.
On each target the native tests restore gzip and LZ4 dumps and use the bundled `pg_verifybackup`
to check compressed base backups against their manifests.
A final job requires a payload manifest for every target and fails when their PostgreSQL version, source pins,
or extension versions and files differ.
Every run also shares the archive and checksum as a workflow artifact, `portable-postgres-<target>`,
which signed-in GitHub users can download from the run's page for 14 days.
Build runs, manual ones included, check candidates without release validation,
so these archives are unreviewed candidates for testing and not for redistribution.
A dry run of the [Release workflow](#releasing) runs release validation on each archive without publishing.

Run `pnpm install --frozen-lockfile` from the repository root before building for any target.
Every native build uses fresh source, object, and SDK directories.
Reassembly checks that the saved source identities and build recipe still match the current ones.
It also verifies the current project-notice anchors against the saved sources.
A reassembly that finishes after a newer build has started keeps that build as the last one, and warns that its own candidate is not recorded.
A change to a build script, a source patch, the Windows SQL installer, or a build tool pin therefore needs a fresh build.
Candidate metadata follows [native artifact format 1](docs/native-artifact.md).
Release validation deliberately fails until the artifact's license inventory and host prerequisites are verified.

An archive is named after its release, for example `portable-postgres-18.7-r1-linux-x64-glibc.tar.gz`.
The name combines the pinned PostgreSQL version with the packaging revision in `binaries/sources/revision.json`.
The revision counts the releases of one PostgreSQL version.
Leave it unchanged while the current revision is unreleased.
After a release, the first change to the archives that keeps the PostgreSQL version,
such as an extension pin, a build recipe, or a review file, takes the next revision.
Reset it to 1 when the PostgreSQL pin changes.

### Linux x64

The workflow builds on Ubuntu 22.04 with Clang and compiler-rt inside a Docker container.
OpenSSL, zlib, LZ4 and ICU are built before PostgreSQL, using ICU's complete release locale data.
Its C++ compiler wrapper links LLVM's libc++, libc++abi and libunwind statically,
so consumers need only the recorded glibc libraries.
`binaries/linux/base.json` pins the Ubuntu image, the glibc baseline, and the LLVM major version.
It checks the compiler link plan for GCC runtime contributions and measures the glibc symbol requirements of every packaged ELF file.
The image's `clang.cfg` makes Clang link through `binaries/linux/image/traced-ld.sh`,
which records what each link copies into its output.
Packaging checks the record of every image in the candidate, also when it reassembles a build.
Rebuild the image after changing the Dockerfile, `traced-ld.sh` or `clang-cxx.sh`.
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
OpenSSL also needs native Strawberry Perl at `C:\Strawberry\perl\bin\perl.exe`,
or at the executable path set in `OPENSSL_BUILD_PERL`.
The build fetches the pinned NASM assembler and the pinned jom make tool for OpenSSL.
Create the isolated Meson environment before the first Windows build.
A fresh build stops when its Meson differs from the pin in `binaries/windows/requirements.txt`;
the `pip install` line below then installs the pinned version.

```powershell
python -m venv binaries/work/windows-toolchain
& binaries/work/windows-toolchain/Scripts/python.exe -m pip install --require-hashes --only-binary=:all: -r binaries/windows/requirements.txt
pnpm binaries:build:windows
pnpm binaries:test:windows
```

At the end of a Windows build or reassembly, cleanup can remove work directories from earlier
successfully packaged builds, including their SDKs, sources, object files and build logs.
Save any logs you need before starting a replacement build.
Automatic cleanup requires a recorded packaged candidate and keeps its work directory, directories
still in use, failed builds and legacy work directories.
When another checkout reassembles the same SDK, cleanup keeps its build tree until that reader exits.
Use `pnpm binaries:prune:windows` to preview what remains.

The Windows build selects Visual Studio Community, Professional or Enterprise with the C++ tools,
and any other installation with them, such as Build Tools alone, only when none of these is installed.
It never selects a preview or Insiders installation.
The scripts use that installation's x64 toolchain and bundled Ninja.
The ICU CMake recipe reads upstream's source lists and runs its data generator against the full data archive.
Only its common, internationalization and data DLLs enter the runtime.
The linker must support recording its input paths with `/LINKREPROFULLPATHRSP`
(Visual Studio 2022 17.11 or later).
Packaging checks the link map of every image and fails when one links static code from a Microsoft library
other than `msvcrt.lib`, `vcruntime.lib`, and the reviewed `vector_algorithms.obj`
and `xonce2.obj` members of `msvcprt.lib`, for example from the Windows SDK;
[native artifact format 1](docs/native-artifact.md) describes the check.
They keep parser generators and other build-only tools outside the runtime archive.
Native proofs retain private diagnostic directories and shut down their owned instance.

### macOS arm64

Build on an Apple silicon Mac with CMake and the Xcode version listed in `binaries/macos/base.json`.
Install Xcode at the specified path.
The build uses Apple's Bison, Flex and Perl.
Use a checkout path without spaces because PGXS makefiles split paths at spaces.

```sh
pnpm binaries:build:macos
pnpm binaries:test:macos
```

#### Toolchain and licence review

Both the TypeScript and compiled drivers read the checkout's `binaries/macos/base.json`.
It sets the Xcode version and path, the minimum macOS version, and the paths to Bison and Flex.
Changing these pins requires a fresh build.

The build records the host macOS version and the versions of Xcode, Bison and Flex used to build PostgreSQL.
Review the PostgreSQL component again if Xcode, Bison or Flex changes, or if the previous review lacks those versions.

#### Archive checks

- **Minimum macOS version.** Packaging rejects any binary that requires a newer macOS than the configured minimum.
- **Linked code.** The compiler wrapper saves each binary's linker map under its `LC_UUID`.
  Packaging checks these maps on every assembly and rejects static code copied from outside the build.
  The binaries use compiler-rt and the C runtime through macOS's `libSystem`.
- **Relocation.** The build gives bundled libraries `@rpath` names and sets search paths relative to each binary.
  It then signs the binaries again with ad-hoc signatures.
  Packaging rejects library paths outside the installation and macOS's system libraries.

#### CI consumer test

On the `macos-15` runner, the workflow hides Xcode and the Command Line Tools before running
`binaries/macos/test-consumer.sh` without Node.js.
The script stops if it can still find a compiler.

1. The script marks the archive as a browser download and extracts it with the system `tar`.
   It records whether `initdb` and `postgres` retain the quarantine flag and whether `initdb --version` runs.
2. It moves the installation, runs the native SQL tests, and checks the loader trace for libraries outside the
   archive and the macOS system directories.
3. The workflow restores the build tools and validates both TAP transcripts.

## Updating pinned sources

`binaries/sources/sources.json` pins PostgreSQL, OpenSSL, ICU, zlib, LZ4 and every separately released extension by version, archive URL, and SHA-256.
The contrib modules that the archives include come from the PostgreSQL pin;
`contribExtensions` in `binaries/artifact/runtime-layout.ts` selects them.
Its `upstream` entries say where new releases come from, so the pins are not edited by hand.
`pnpm binaries:update-pins` finds the newest stable release of each source,
keeping PostgreSQL within its pinned major version, and downloads every changed archive.
OpenSSL stays on the 3.5 LTS patch series.
PostgreSQL, OpenSSL and LZ4 release archives are checked against their publishers' SHA-256 checksum files.
For named GitHub release assets such as zlib and ICU, the updater checks the exact archive's SHA-256
from the selected release when there is no separate checksum file.
GitHub publishes no checksum for generated tag archives, so the first download defines their pin.
The command also sets the packaging revision: a new PostgreSQL release restarts it at 1,
and other changes open the next revision once the current one has been released.

The [Update Sources workflow](.github/workflows/update-sources.yml) runs the command every Monday
and opens or refreshes a pull request on the `dependencies/sources` branch.
It skips the refresh once the branch contains a reviewer's changes.
For a manual run, select the intended base branch.
The updater refuses a tag, its own branch, or a base that conflicts with an open pull request from the same update branch.
If someone pushes while the updater is preparing a refresh, their commit stays on the branch.
After a squash merge, deleting the merged pull request branch lets the next update create a fresh one.
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

Each target has a tracked review file: `binaries/linux/review.json`, `binaries/windows/review.json` and `binaries/macos/review.json`.
It holds the licence inventory and the host requirements that the build writes into the archive manifest.
The build writes only what still matches the candidate: a part that `pnpm binaries:review` would reopen is pending,
and host requirements that it would reopen are `null`.
Without the file, the build produces a candidate whose review is pending.

1. Build a candidate for the target.
2. Run `pnpm binaries:review <target>` to write `review-draft.json` next to the build output.
   The draft assigns every shipped file to a component, including one component per toolchain part
   linked into native binaries (`compiler-rt`, `glibc-startup` and `llvm-cxx-runtime` on Linux,
   `msvc-runtime` on Windows, none on macOS),
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
3. For a review that needs edits, start with the new draft and save it as the target's review file.
   Keep the draft's current file lists, notice hashes and signatures.
   Fill in the licences and evidence of a new component and the requirement, licence and evidence of a new host library.
   When you change a component's licences, add evidence explaining the new licences.
   A dated entry from a previous approval records what you accepted under the earlier licences.
   Keep each drafted library and its drafted `requirement`: release validation requires an entry for every
   imported host library and the measured glibc requirement, such as `GLIBC_2.34 or newer`.
   A component that you add can describe part of an image, but every image must stay in the files
   of the source component that built it.
4. Approve the review with `pnpm binaries:approve <target>`.
   It lists the parts it approves, asks you to confirm, and sets them to `verified` in the review file.
   The preview includes edits to previously verified coverage, licences and host requirements.
   A removed component's entry shows up to ten paths that other components still list and counts any others.
   It refuses and names any part that still lacks licences, evidence, or host library details.
   For `msvc-runtime`, it requires a reviewed Visual Studio product line and the digest of the release notice.
   A Build Tools candidate carries a different notice even on a reviewed line.
   It compares the edited draft with the review committed at `HEAD` to recover evidence for reopened components
   whose licences you kept.
   Until you commit the approved review, another approval can list the same changes.
   Approving is your statement that you checked these parts, so nobody edits the statuses by hand.
5. Rebuild and run `pnpm binaries:validate <target> <installation>`.

A review stays valid while the shipped files, the licence texts it read, the notice signatures of each source tree,
and the toolchain line are unchanged, so a rebuild of the same pins keeps it.
A source update usually reopens its own component: an extension release adds an upgrade script,
and a PostgreSQL release changes a few notice lines or the year in a licence file.
The Build workflow lists the reopened parts in its job summary and uploads the draft as `review-draft-<target>`,
so a pull request shows what needs a review without a local build.
When the changes leave the licences as they are, check out the pull request's commit and run
`pnpm binaries:approve <target> <run-id>` with the ID of its Build run.
The command uses the checkout's default GitHub repository and verifies that Build produced the draft,
either directly or as the workflow called by Release.
For a pull request, it checks the merge commit recorded in the Build job against GitHub's commit data
and the draft's Git checkout record.
You can check out the PR head or the built merge commit.
Its tree must match the tree that CI built before the command lists changes and asks you to confirm.
If the base branch introduced differences, update the pull request branch and use the new Build run.
Use a fresh Build run if the checkout record or the PR job's commit is missing.
Each reopened component keeps its licences and the evidence of its earlier review,
and gains a dated line that names the accepted changes, such as
`2026-11-22, Build run 123 at abc1234: accepted 2 notice signatures added; files added: vector--0.8.7--0.8.8.sql.`
Add `--note "<reason>"` to record why you accepted those changes in the dated evidence entry.
Approval refuses `--note` if no component would receive a dated entry.
Then commit the review files to the pull request.
If an update brings another licence or code that needs its own component,
edit the current draft as in step 3 and approve it without a run ID.
To review a reopened source, compare its licence, copyright, and notice files between the two releases,
look for newly bundled third-party code with its own licence, and skim the release notes.
The job summary shows up to 20 notice signature changes per component.
It lists additions first as `licence text added`, with up to three example paths each,
then removals as `licence text gone`.
If the previous review has no signature list, the summary gives the number of signatures to review.
To see every change, compare each component's `noticeSignatures` in the uploaded draft
with the same component in the target's tracked review.
Read the added text in the upstream source, decide whether it ships and under which licence,
and add a component or a retained notice where needed.
Newly bundled code can reuse an existing notice or carry no detected notice,
so check every updated source's release notes for it.
A year-only change on a copyright line leaves its signature unchanged.
It still reopens the component if the changed file is a pinned notice.

The toolchain components carry fixed licences.
`compiler-rt` carries `Apache-2.0 WITH LLVM-exception`.
`llvm-cxx-runtime` covers the LLVM C++ runtimes linked into ICU's code libraries.
It requires `Apache-2.0 WITH LLVM-exception` and retains their upstream licence texts.
ICU's data library contains no executable code and needs no linked-runtime component.
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
A release needs the archives of all three targets, each with a verified review.
Only a run from `main` creates a release.

The `dry-run` input, enabled by default, builds every target that has a recipe and runs release validation on it,
without creating a tag or release, so a pending review fails it as it would fail a release.
A dry run stops after the build jobs.
To rehearse asset preparation from candidate archives, run `pnpm binaries:release` without `--require-all-targets`.
Each supplied `portable-postgres-*.tar.gz` must belong to the current revision and a supported target,
even when only one target is supplied.
A local [act](https://github.com/nektos/act) run covers the same build jobs, release validation included:

```sh
act workflow_dispatch -W .github/workflows/release.yml --input dry-run=true --matrix output:linux-x64
```

For a candidate check without release validation, run the Build workflow instead (`-W .github/workflows/build.yml`).

act's artifact server does not accept the artifact upload action this workflow uses, so act cannot hand archives to the release job.
The release job's checks, checksums, descriptor, and notes are covered by `tests/release.test.ts` instead.
