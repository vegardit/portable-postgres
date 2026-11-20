# Native artifact format 1

This contract describes the native installation independently of Node.js, npm, and wrapper versions.
The current implementations cover the measured Linux x64 glibc and Windows x64 layouts.
macOS arm64 remains a required target; its layout and baseline are not established by this contract yet.

A candidate can pass layout and integrity checks while its release license review or host prerequisites remain unresolved.
Candidate validation is preparation evidence.
It does not approve distribution or declare a supported host.

## Archive and discovery

The archive is a gzip-compressed USTAR archive.
It holds only regular files, directories and symbolic links in plain USTAR headers, without PAX or GNU metadata,
because tar readers apply such metadata differently.
The packer checks its own output against this format,
so a payload name outside printable ASCII, or too long for the USTAR name and prefix fields, cannot be packed.

Each build job validates its archive after packing: it unpacks the finished archive with GNU tar,
runs the native tests on that tree, and in release mode runs release validation on it before uploading.
The release job trusts the archives of its own workflow run and does not unpack them again,
because whoever could change an archive there could also change the manifest and review it would be checked against.
It checks what a build job cannot: that every archive belongs to the release version and the checkout's source pins,
carries a verified review, exists for every target, and ships the same contents as the others.
The build provenance attestation and `SHA256SUMS` then identify the published bytes.
The packager writes entries in ordinal path order, with empty owner fields and a fixed modification time of 2000-01-01 UTC.
Tar readers treat the empty owner fields as UID and GID 0, so the archive names no builder account.
This normalization covers archive metadata. The bytes inside each file depend on the native build.
Its entries belong directly to the installation root:

```text
native-artifact.json
bin/
lib/
share/
  extension/
notices/
```

Consumers do not need Node.js or npm to extract or run the installation.
Build environments may use Node.js and native build tools.
Linux and Windows contain the same core PostgreSQL programs, including `ecpg`, and the same extensions.
The extension payload contains PL/pgSQL and the eight extensions listed below.
The packager excludes optional PostgreSQL contrib modules and their SQL and data files, upstream test helpers,
development headers, PGXS, static libraries, and optional SDK documentation.
It also excludes pg_partman's worker and Python helpers, pgTAP's Perl runner, and TimescaleDB Community libraries.

A consumer first verifies the entire archive SHA-256 against a trusted descriptor obtained independently.
A hash downloaded beside an untrusted archive is not an independent trust anchor.
After safe extraction, read `native-artifact.json`, require the supported format/target,
validate the complete payload, and discover programs through `executables`.
Each executable path is relative to the installation root.
No global PostgreSQL installation, PATH discovery, account creation, or privilege elevation belongs to provisioning.

The metadata file is covered by the archive digest.
It does not hash itself recursively.
Every other payload file or symlink is listed in `files`.
The archive digest must be calculated after metadata is written.
Changing any archive content invalidates the earlier digest.
The licence review covers the list of payload files and the licence texts it read, rather than exact bytes.
A rebuild or source update with the same file list and unchanged licence notices keeps its review.
A new or renamed file, a changed notice, or a new toolchain line needs a review first.

An installation validator operates after extraction.
It does not protect an extractor that has already followed an unsafe tar entry.
The future installer must independently reject unsafe paths, archive links, special files,
and extraction outside its owned staging directory before writing those entries.

## Identity and compatibility

| Field               | Meaning                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `format`            | Exact string `portable-postgres-native`.                                                             |
| `formatVersion`     | Integer `1`; independent of wrapper semantic versioning.                                             |
| `packagingRevision` | Positive integer selected for a native packaging revision.                                           |
| `target`            | Exact `linux-x64-glibc` or `windows-x64`.                                                            |
| `postgresqlVersion` | Exact PostgreSQL 18 minor release from the recorded source pin.                                      |
| `executables`       | Relative paths for `postgres`, `initdb`, `pg_ctl`, and `psql`.                                       |
| `extensions`        | All eight extension installation versions, controls, SQL files, and native libraries.                |
| `sources`           | Source release URLs, SHA-256 values, declared licenses, original notice paths, and retained notices. |
| `hostEvidence`      | Observed component versions and their evidence; these do not imply minimum prerequisites.            |
| `hostRequirements`  | Verified OS/CPU/library prerequisites, or `null` while those are unresolved.                         |
| `buildProfile`      | Apache-only TimescaleDB, telemetry disabled, SQL-only pg_partman and pgTAP.                          |
| `licenseInventory`  | Explicit pending/verified review and component-to-file coverage.                                     |
| `files`             | Complete sorted payload inventory, file hashes, executable flags, and symlink targets.               |

The exact executable paths are `bin/<name>` for Linux and `bin/<name>.exe` for Windows.
All shipped PE/ELF programs and shared libraries must match the target's x64 machine architecture.
Header inspection identifies file format and architecture.
It does not prove the compiled PostgreSQL version, ABI compatibility, extension behavior, or host compatibility.
Those require builder provenance and native execution against the exact artifact.

`hostEvidence` entries contain `component`, `version`, and `evidence` strings.
For example, a VCRUNTIME version observed on a developer workstation belongs here.
It must not become a minimum supported VCRUNTIME version without compatibility evidence.

A non-null `hostRequirements` contains `status: "verified"`, OS and CPU descriptions,
and a library list with `name`, `requirement`, `license`, and `evidence`.
Each library appears once; names compare case-insensitively, so `glibc` and `GLIBC` are the same library.
A library's optional boolean `measured` records where its review entry came from:
`true` when a build measured the library as the entry was drafted, absent when a reviewer added it,
for example for a library that another one loads. An entry keeps that origin in later reviews,
so `measured` does not say what the current build imports; the build's host measurement in `hostEvidence` does.
The Linux x64 build targets Ubuntu 22.04 and glibc 2.35.
The build records the highest required glibc symbol version across all packaged ELF files and rejects versions above 2.35.
The validated PostgreSQL 18.7 Linux archive requires symbols through `GLIBC_2.34`.
The workflow runs the resulting archive in a separate Ubuntu 22.04 container to check native startup, authentication, and SQL.
Windows requires explicit `vcruntime140.dll` and `ucrtbase.dll` prerequisites.
These libraries are host requirements, separate from files bundled in the archive.
Release validation requires a library entry for each of them and for every DLL that the packaged files import
(the `PE host library imports` evidence), unless the archive supplies that DLL in `bin/`.
Release validation also rejects obsolete `measured: true` entries.
Reviewers can retain indirect dependencies as manually added entries.
Windows looks for imports next to the program, and every program is in `bin/`;
a DLL elsewhere in the archive, such as an extension module in `lib/`, never satisfies an import.
On Linux the glibc entry's `requirement` must be the measured one, for example `GLIBC_2.34 or newer`,
so a published minimum always describes the archive's own binaries.
A supported CPU baseline must also come from evidence, rather than just the compiler host's capabilities.

## Extension installation versions

All eight selected extensions are mandatory:

| Source ID       | Database extension | Native profile                              |
| --------------- | ------------------ | ------------------------------------------- |
| `pgvector`      | `vector`           | Native library.                             |
| `timescaledb`   | `timescaledb`      | Apache-only loader and versioned library.   |
| `pg_textsearch` | `pg_textsearch`    | Native library; inline maintenance profile. |
| `hypopg`        | `hypopg`           | Native library.                             |
| `plpgsql_check` | `plpgsql_check`    | Native library; on-demand checks.           |
| `pg_cron`       | `pg_cron`          | Native library; explicit scheduling.        |
| `pg_partman`    | `pg_partman`       | SQL only.                                   |
| `pgtap`         | `pgtap`            | SQL/PLpgSQL only.                           |

An extension entry contains `sourceId`, `name`, `version`, `control`, `sql`, and `libraries`.
Its installation `version` is read from the control file's `default_version`.
It can differ from the source release in `sources`.
For example, pg_cron 1.6.8 declares SQL version 1.6 and plpgsql_check 2.10.16 declares SQL version 2.10.

The SQL list must provide a base installation or an upgrade chain reaching that default version.
A direct `<name>--<default_version>.sql` file is not always present.
pg_cron supplies a base 1.0 script followed by upgrade scripts.
Deleting a required script or native library invalidates the installation.

Libraries use `.so` on the current Linux target and `.dll` on Windows.
TimescaleDB includes both its loader and the library named for its exact source release.
The PostgreSQL client library is also required: `lib/libpq.so.5` on Linux and `bin/libpq.dll` on Windows.

Bundling makes extensions available.
It does not create them in databases or imply preload settings.
Native activation and SQL tests remain separate acceptance requirements.

## Paths, links, and permissions

All manifest payload paths use relative forward-slash notation.
Absolute/drive paths, parent segments, empty segments, backslashes, control characters,
Windows reserved names, alternate data streams, and trailing dots/spaces are rejected.
Payload paths belong under `bin/`, `lib/`, `share/`, or `notices/`.
Names that collide after case conversion are rejected.

`files` is sorted by the path's ordinal string order.
JSON object key order is not significant.
A file entry contains `path`, `kind: "file"`, lowercase hexadecimal `sha256`, and `executable`.
A link entry contains `path`, `kind: "symlink"`, and its relative `target`.

Linux links must resolve directly to ordinary files inside the installation.
Escaping, absolute, dangling, chained, and directory links are rejected.
Hard-linked files and special filesystem objects are rejected.
Windows links remain unsupported until their creation and extraction semantics have native evidence.

Validating an extracted Linux artifact requires a POSIX host to read its executable permissions.
Linux validation rejects group/world-writable files or directories and setuid or setgid bits.
The owner must be able to execute every core PostgreSQL program.
Windows validation checks executable file headers, and the installer verifies ACLs.
The archive SHA-256 check works on either host.

## Notices and license gate

Source `license` fields describe source declarations.
They do not establish the license of every emitted binary, linked runtime contribution, or installed file.

Each source retains its primary license at `notices/<source-id>.txt`.
Its `notice` field names that primary file.
Its `notices` array names every retained required notice.
Additional paths declared in source `noticeFiles` map to
`notices/<source-id>-<original-path-with-slashes-replaced-by-hyphens>`.
A source notice ending in `.h` receives an additional `.txt` suffix in the archive.
The pinned TimescaleDB and pg_textsearch NOTICE files are mandatory.
Configured exact-pin notices remain mandatory even if a later metadata edit omits their declaration.

The complete payload inventory includes notices and their hashes.
Upstream text remains intact.
A renamed copy does not change its legal terms.

`licenseInventory` contains `status` and `components`.
Each component contains:

- `id`: stable component identity, including source IDs and any additional linked/generated/runtime components;
  each ID appears once, in a manifest and in a tracked review.
- `licenses`: exact approved license identifiers.
- `status`: `pending` or `verified`.
- `files`: payload paths to which this component contributes.
- `notices`: retained notice paths.
- `noticeSha256`: the SHA-256 of each notice as the review read it.
- `toolchain`: for the toolchain component only, the toolchain line that the review covers.
- `evidence`: references explaining the exact review and contribution.

Multiple reviewed components may contribute to the same binary, such as source code and a compiler runtime.
Every payload file must have reviewed component coverage.
Every native image must also be in the files of a source component, even when another component describes part of it.
And it must be covered by each of the target's toolchain components,
because the linker adds that code to every image:

| Target  | Component       | Linked code                                                          | Toolchain line in `hostEvidence` |
| ------- | --------------- | -------------------------------------------------------------------- | -------------------------------- |
| Linux   | `compiler-rt`   | Clang's runtime builtins and startup objects                         | `Clang major version`            |
| Linux   | `glibc-startup` | glibc's `Scrt1.o`, `crti.o`, `crtn.o` and `libc_nonshared.a` members | `glibc`                          |
| Windows | `msvc-runtime`  | MSVC code from `msvcrt.lib`, `vcruntime.lib` and `oldnames.lib`      | `Visual Studio product line`     |

The Windows build also records the `Visual Studio edition`, its `Visual Studio channel`, and the `MSVC toolset`.
It records them for the installation it compiles with, and reassembly reuses them.
The Linux build records its toolchain lines in the build container when it compiles, and reassembly reuses them as well,
so a reassembly on another host cannot describe another compiler or glibc.
These lines change rarely, unlike toolset updates, and the toolchain's licence terms follow them.
Clang links every Linux image through the build image's `traced-ld`,
which records the link's input files and archive members under the output's build ID.
Packaging, including a reassembly, fails when an image in the candidate has no such record, wherever the image lies,
and when a record shows GCC's runtime or any other glibc code,
so the `glibc-startup` review keeps matching what is linked into each image.
A toolchain component lists only native images and its own notice.
Windows archives ship the project's notice for the linked Microsoft code at `notices/msvc-runtime.txt`.
A candidate built with a Visual Studio line or product that release validation refuses, such as Visual Studio 2022
or Build Tools alone, ships a candidate text there instead,
which names the line and product and says not to redistribute the binaries.
The `msvc-runtime` component must list it in `files` and `notices`, so a changed notice text reopens its review.
Each source's component must list all its retained notices in `notices`.
Each extension's source component must list its control file, SQL files, and native libraries in `files`.
The `postgresql` component must list every other native image, because PostgreSQL's own build makes them.
A compiler's license metadata alone does not describe its emitted runtime contributions.

Release validation is the default.
It requires a verified inventory, all selected source components, complete reviewed file coverage,
source and toolchain coverage of every native image, retained notices, and verified host prerequisites.
It compares the host prerequisites with the build's measurement, so it also requires that measurement:
`PE host library imports` on Windows and `ELF glibc symbol requirements` on Linux.
Each cited notice must be a regular file whose SHA-256 matches the reviewed digest.
Each toolchain component must match its reviewed toolchain line.
A notice comparison does not detect bundled third-party code that brings its own licence
while the source's main licence files stay unchanged.
It rejects GPL/AGPL contributions, including GCC's own runtime under
`GPL-3.0-or-later WITH GCC-exception-3.1`, unresolved components, and licenses outside the explicit permitted set.
The Linux `compiler-rt` component must carry `Apache-2.0 WITH LLVM-exception`.
Other components can also use this licence.
Two licences are permitted only on one toolchain component of one target, and that component must carry them:

| Target  | Component       | Licence                                                  |
| ------- | --------------- | -------------------------------------------------------- |
| Linux   | `glibc-startup` | `LGPL-2.1-or-later WITH GCC-exception-2.0`               |
| Windows | `msvc-runtime`  | `LicenseRef-Microsoft-VisualStudio-2026-Linked-CRT-Code` |

glibc's startup sources add that exception to the LGPL, which permits linking them into any program and
distributing the result; SPDX lists glibc's wording as a reference text for the exception.

The Visual Studio identifier is the only proprietary licence that release validation admits.
It covers the static code from Visual Studio toolset libraries that the linker copies into every Windows image:
the startup objects of `msvcrt.lib`, members of `vcruntime.lib`, and aliases from `oldnames.lib`.
Microsoft's Distributable List names runtime files, not this linked code.
The project applies the conditions of the Distributable Code section to it, and `notices/msvc-runtime.txt` passes them on.
The identifier belongs to Visual Studio 2026, which reports the product line `18`.
Release validation refuses a Windows build from any other product line until its terms are reviewed.
It also refuses any Visual Studio product other than Community, Professional or Enterprise, such as Build Tools alone,
because only these editions share the reviewed Distributable Code section.
Such builds still produce candidates, and the build warns about them.
The recorded edition shows what was installed, not which licence its user holds.
The build never selects a preview or Insiders installation of Visual Studio.

Other additions require a deliberate repository policy change and review.

Host-library licensing is separate from bundled-file coverage.
The host allowlist additionally recognizes reviewed LGPL glibc and the Windows/Visual C++ host-runtime terms.
This does not permit bundling LGPL libraries or infer redistribution rights from their presence on a host.

Filename exclusions reject obvious TimescaleDB Community libraries and forbidden helper profiles.
They do not replace build-option evidence, compiled-source review, or an inventory covering generated SQL and binaries.
A verified status is a review attestation.
The validator checks its consistency and completeness; it cannot replace the underlying license investigation.

## Build-tool API

`binaries/artifact/artifact.ts` provides side-effect-free imports and explicit filesystem operations:

- `writeArtifactManifest(installation, options)` creates metadata in a newly assembled staging candidate.
  It refuses to overwrite existing metadata and validates the candidate layout after writing.
  License review defaults to pending and host requirements default to `null`.
- `validateArtifact(installation, expectedTarget, options?)` validates metadata, paths, target architecture,
  complete content hashes, required extension files, the server and encoding conversion modules that
  PostgreSQL always builds, notices, permissions, and the release gate.
  The default mode is `release`.
  An explicit `mode: "candidate"` is limited to feasibility layout/integrity checks and retains unresolved review state.
  Unknown modes fail.
- `verifyArtifactArchive(archive, expectedSha256)` checks the entire archive digest before metadata is trusted.
  The caller must obtain that expected digest through a trusted channel.

The API does not download, extract, start PostgreSQL, delete an installation, or approve publication.
Another language can implement the same checks against the JSON and archive without importing TypeScript.
MacOS layout, safe extraction, full dependency/license closure, and final release acceptance remain separate work.
