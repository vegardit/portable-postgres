# Native artifact format 1

This contract describes the native installation independently of Node.js, npm, and wrapper versions.
It covers Linux x64 with glibc, Windows x64 and macOS arm64.

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
The release's source bundle comes from the same checkout:
its committed files and the source archives that its pins name, packed like an archive, so one commit gives one bundle.
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
All three targets contain the same core PostgreSQL programs, including `ecpg`, and the same extensions.
The extension payload contains PL/pgSQL and the extensions listed below.
The packager excludes every other PostgreSQL contrib module with its SQL and data files, upstream test helpers,
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
The licence review covers the payload file list, the hashes of retained notices,
the notice signatures in each upstream source tree, and the toolchain line.
A change to any of these reopens the affected component.

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
| `target`            | Exact `linux-x64-glibc`, `windows-x64` or `macos-arm64`.                                             |
| `postgresqlVersion` | Exact PostgreSQL 18 minor release from the recorded source pin.                                      |
| `executables`       | Relative paths for `postgres`, `initdb`, `pg_ctl`, and `psql`.                                       |
| `extensions`        | Every selected extension's installation version, control, SQL files, and native libraries.           |
| `sources`           | Source release URLs, SHA-256 values, declared licenses, original notice paths, and retained notices. |
| `hostEvidence`      | Observed component versions and their evidence; these do not imply minimum prerequisites.            |
| `hostRequirements`  | Verified OS/CPU/library prerequisites, or `null` while those are unresolved.                         |
| `buildProfile`      | Apache-only TimescaleDB, telemetry disabled, SQL-only pg_partman and pgTAP.                          |
| `licenseInventory`  | Explicit pending/verified review and component-to-file coverage.                                     |
| `files`             | Complete sorted payload inventory, file hashes, executable flags, and symlink targets.               |

The executable paths are `bin/<name>` on Linux and macOS and `bin/<name>.exe` on Windows.
Windows requires x64 PE images and Linux requires x64 ELF images.
macOS requires thin, signed 64-bit arm64 Mach-O images with the macOS build platform.
For the macOS 15 baseline, the validator accepts `CPU_SUBTYPE_ARM64_ALL` and `CPU_SUBTYPE_ARM64_V8`.
The validator requires executable images in `bin/`, linked client dylibs in `lib/`, and dylibs or bundles for
server and extension modules.
It checks that each Mach-O signature command points to a nonempty region inside the file and beyond the load commands.
Library names and search paths must have a terminating NUL within their own Mach-O load command.
The macOS build checks signature integrity with `codesign --verify --strict`.
Header inspection identifies file format and architecture.
It does not prove the compiled PostgreSQL version, ABI compatibility, extension behavior, or host compatibility.
Those require builder provenance and native execution against the exact artifact.

`hostEvidence` entries contain `component`, `version`, and `evidence` strings.
For example, record the Windows version used to run the native SQL tests.
Establish the minimum supported version separately through compatibility testing.

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
Windows requires `ucrtbase.dll`.
Release validation requires an entry for each prerequisite and for every DLL that the packaged files import
(the `PE host library imports` evidence), unless the archive supplies that DLL in `bin/`.
Release validation also rejects obsolete `measured: true` entries.
Reviewers can retain indirect dependencies as manually added entries.
Windows looks for imports next to the program, and every program is in `bin/`;
a DLL elsewhere in the archive, such as an extension module in `lib/`, never satisfies an import.
On Linux the glibc entry's `requirement` must be the measured one, for example `GLIBC_2.34 or newer`,
so a published minimum always describes the archive's own binaries.
A supported CPU baseline must also come from evidence, rather than just the compiler host's capabilities.

The macOS target requires macOS 15 or newer on Apple silicon.
The build reads the deployment version and imported libraries from every image's load commands.
It rejects an image with a minimum above the deployment target.
The host review lists the imported system libraries and records the highest image minimum
as the requirement for `/usr/lib/libSystem.B.dylib`.
Absolute system imports must start with `/usr/lib/` or `/System/Library/` and contain no `..` path component.
Bundled imports use `@rpath/<name>` and a search path relative to the image that reaches `lib/`.
The build verifies each image's ad-hoc signature after relocation.

## ICU collations

Every installation must include ICU in its source pins.
It must carry ICU's common, internationalization and full data libraries.
The runtime keeps their versioned library names and loader aliases.
Windows places `icuuc<major>.dll`, `icuin<major>.dll` and `icudt<major>.dll` in `bin/`.
Linux and macOS place the corresponding `libicuuc`, `libicui18n` and `libicudata` libraries in `lib/`.
Their files belong to the `icu` licence component.
The Windows code libraries use the bundled `libc++.dll`.
ICU's build tools, headers and make fragments stay outside the runtime.

Linux statically links LLVM's C++ runtimes into ICU's code libraries.
The `llvm-cxx-runtime` component covers those files and retains the LLVM licence notices.
The data library has no executable code or runtime startup objects.
Link auditing checks its ELF load segments or PE sections before allowing that layout.
All code-bearing images still require their complete startup and runtime link evidence.

ICU support does not select a database's default locale.
Native proofs exercise per-column collations, indexed sort order, nondeterministic equality,
and a database whose default provider is ICU.

## TLS runtime

Every archive pins an OpenSSL 3.5 source and includes both shared libraries under their loader names.
Windows places `libssl-3-x64.dll` and `libcrypto-3-x64.dll` in `bin/`.
Linux places `libssl.so.3` and `libcrypto.so.3` in `lib/`, and macOS uses
`libssl.3.dylib` and `libcrypto.3.dylib` there.
PostgreSQL uses OpenSSL's built-in provider.
For external providers, the default search directory is `/etc/ssl/ossl-modules` on Linux and macOS.
Windows uses OpenSSL's build-time Program Files default, `OpenSSL\lib\ossl-modules` under that directory.
Set `OPENSSL_MODULES` to use another provider directory.
The native proof uses a caller-supplied certificate after relocating the archive.

## Compression libraries

Every archive pins zlib and LZ4 and carries each shared library under its loader name.
Windows uses `bin/libz.dll` and `bin/lz4.dll`, Linux uses `lib/libz.so.1` and `lib/liblz4.so.1`,
and macOS uses `lib/libz.1.dylib` and `lib/liblz4.1.dylib`.
Each library belongs to its own source licence component.

## Extension installation versions

All selected extensions are mandatory.
Nine come from their own source pins:

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
| `pgmq`          | `pgmq`             | SQL/PLpgSQL only.                           |

Eight are contrib modules that the pinned PostgreSQL source builds:
`btree_gist`, `citext`, `hstore`, `ltree`, `pg_stat_statements`, `pg_trgm`, `pgcrypto` and `unaccent`.
Their entries name `postgresql` as `sourceId`, and each has one native library.
`pgcrypto` uses the bundled OpenSSL and zlib.
`unaccent` reads its default rules from `share/tsearch_data/unaccent.rules`.
The make recipes build exactly these modules.
Meson builds all of contrib on Windows, and the packager keeps only these.

An extension entry contains `sourceId`, `name`, `version`, `control`, `sql`, and `libraries`.
Its installation `version` is read from the control file's `default_version`.
It can differ from the source release in `sources`.
For example, pg_cron 1.6.8 declares SQL version 1.6 and plpgsql_check 2.10.16 declares SQL version 2.10.

The SQL list must provide a base installation or an upgrade chain reaching that default version.
A direct `<name>--<default_version>.sql` file is not always present.
pg_cron supplies a base 1.0 script followed by upgrade scripts.
Deleting a required script or native library invalidates the installation.

Libraries use `.so` on Linux, `.dll` on Windows and `.dylib` on macOS.
TimescaleDB includes both its loader and the library named for its exact source release.
Each fresh build checks the source files in CMake's compilation database.
It rejects a file under `tsl/` or one whose leading C comment contains upstream's Timescale License declaration.
After changing this check, rebuild each target before reassembling it.
The client library is `lib/libpq.so.5` on Linux, `bin/libpq.dll` on Windows and `lib/libpq.5.dylib` on macOS.

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

Linux and macOS links must resolve directly to ordinary files inside the installation.
Escaping, absolute, dangling, chained, and directory links are rejected.
Hard-linked files and special filesystem objects are rejected.
Windows links remain unsupported until their creation and extraction semantics have native evidence.

Validating an extracted Linux or macOS artifact requires a POSIX host to read its executable permissions.
Both targets reject group/world-writable files or directories and setuid or setgid bits.
The owner must be able to execute every core PostgreSQL program.
Windows validation checks executable file headers, and the installer verifies ACLs.
The archive SHA-256 check works on every host.

## Source patches

The builds compile the pinned source archives as released, with one exception:
the Windows build applies the patch files in `binaries/windows/patches/<source ID>/` after it extracts the sources
and before it compiles.
`windowsPatches` in `binaries/windows/build.ts` lists them; they apply in path order.
The patches and the code that applies them are part of the Windows recipe identity.
A patch changes one file. Each hunk's old lines must occur exactly once in the extracted file and its new lines not at all,
so the build fails when a source update changed the patched lines or already contains the change.

The Windows patches select UCRT setjmp in PostgreSQL, enable the existing memmem fallback in plpgsql_check,
and teach the TimescaleDB Windows build to use the MinGW import library and Windows version-query types.
Retire each patch when its upstream release includes the corresponding fix.

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

Some code needs a licence text that its source does not contain.
PostgreSQL uses Unicode data in its tables and encoding maps, fast-crc32 in its AVX-512 CRC code,
and Project X0213 data in two Japanese encoding maps.
It also uses stemmers from the Snowball project and stopword lists published on its website.

The project excludes `share/tsearch_data/nepali.stop` from the scope of the Snowball website notice.
PostgreSQL received that list in a 2018 patch submitted under the project's patch-submission terms.
Its provenance before submission remains unverified.
See the [original patch](https://www.postgresql.org/message-id/attachment/58772/nepali_snowball.patch)
and [PostgreSQL's submission terms](https://wiki.postgresql.org/wiki/Submitting_a_Patch).

The repository keeps these texts in `binaries/sources/notices/<source-id>/`, byte for byte as retrieved,
and the source's `projectNotices` in `sources.json` pin each one with its origin, what it covers, and its SHA-256.
They ship as `notices/<source-id>-<file>` and count among the source's required notices.
Packaging refuses a text whose bytes differ from its pin.
Candidate validation requires a manifest digest for each project notice required by a matching upstream pin
and compares the shipped bytes with the digest recorded for that packaging revision.
To update a notice, replace the text, update its SHA-256 and origin, and review the change.
A new digest reopens the component's review.

Each project notice also pins the source facts it depends on as `anchors`:
the Snowball commit in PostgreSQL's `src/backend/snowball/README`, PostgreSQL's Unicode version and the inputs of
its encoding maps, the stopword lists, the attributed fast-crc32 block, and the headers of the Project X0213 tables.
An anchor selects lines of one file (matching a pattern, or a block from one start line through the next end line)
and pins them as text or by SHA-256, or it pins a set of files by their names and contents.
A fresh build checks every anchor right after extracting the sources, before compiling.
Reassembly checks the current anchors against the saved source tree before packaging.
An anchor mismatch names the changed fact so the reviewer can check the notice before updating its pin.
Release preparation compares the archived manifest's required notice paths, project-notice origins,
coverage, digests, and anchors with the release checkout.

A source update can also bring licence text that no pinned notice contains, such as newly bundled third-party code.
So each fresh build scans every file of every source tree for copyright, licence and grant lines,
right after extraction and before patching or compiling.
A file's signature includes its distinct notice lines and their continuations in comments.
For example, a holder or a grant can span several consecutive one-line C comments.
In a C header, attribution and responsibility clauses can appear between a copyright and its grant,
or in later paragraphs of the notice.
In M4 files, a licence notice can span consecutive `dnl` comments or consecutive `#` comments.
A bare comment marker separates paragraphs, and a physical blank line ends the block.
In both shell scripts and M4 files, the scanner keeps hash-comment grant paragraphs such as
Autoconf's permission to copy its generated script, along with warranty and redistribution conditions.
In other consecutive one-line comments, a full stop ends a continuation unless the next line
states a notice or starts a numbered clause.
An SPDX tag line also ends it, because each tag is complete on one line.
This keeps ordinary translator credits and SQL test descriptions out of the preceding notice.
In a README, Markdown document, or plain text file, a heading such as `Copyright and License`
includes the whole section up to the next heading of equal or higher level.
In C comments containing Perl POD, the scanner keeps the labelled licence section through its
last paragraph and skips the Perl implementation that can follow the documentation.
In SGML, it records the holder and legal notice from the `<copyright>` and `<legalnotice>` elements,
ignoring copyright years and the document date.
The scanner normalizes comment markers, spacing, and years on copyright lines.
A licence file of its own, such as `LICENSE`, `COPYING` or `NOTICE`, is fingerprinted whole instead,
by its path and the SHA-256 of its normalized text, because its conditions often sit in lines without a keyword.
The scan covers the whole tree, not only the compiled files:
tracing what each image compiles needs heuristics that an upstream build change can break,
and the release's source bundle redistributes the whole tree anyway.
The build stores the scan in its work directory.
After changing the scanner, rebuild each target before reassembling it.
Before creating a candidate or auditing its native images, packaging checks that the saved scan
has an entry for every pinned source and that its signatures and example paths contain nonblank text.
Candidate validation requires a `noticeSignatures` array on every source entry.
An empty array records a completed scan that found no signatures.
Each entry has a `signature` string and a `files` array with up to three example paths from the source tree.
A signature is unique within its source, and capitalization is significant.
Manifest validation also enforces the three-path limit on supplied candidates.
Storing the text as a value lets Windows PowerShell 5.1 read case-distinct signatures with `ConvertFrom-Json`.
The review component of the source lists the signatures that its review covered.
A signature that comes or goes reopens the component.
The summary shows up to 20 changes per component, additions first, with up to three example paths per addition.
For the full change, compare the component's `noticeSignatures` in the uploaded `review-draft-<target>`
with its list in the target's tracked review.
Release validation checks that each source's reviewed signature list matches its scan.
Newly bundled code can reuse an existing notice or carry no detected notice.
Reviewers must also check which files a directory's licence covers.

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
- `noticeSignatures`: for a source component, the notice signatures of the source tree that the review covered.
- `toolchain`: the reviewed line for linked toolchain components, the compiler and linked-object inventory for native sources on Windows, or the parser generator identity for PostgreSQL on macOS.
- `evidence`: references explaining the exact review and contribution.
  When approval carries forward earlier evidence for a reopened component, it adds a dated line naming the changes.
  A changed licence set needs new evidence from the reviewer.

Multiple reviewed components may contribute to the same binary, such as source code and a compiler runtime.
Every payload file must have reviewed component coverage.
Every native image must also be in the files of a source component, even when another component describes part of it.
Each code-bearing image must also be covered by its linked toolchain components.
The LLVM C++ runtime component covers ICU's code libraries.
The generated ICU data library needs no linked-runtime coverage.

| Target  | Component          | Linked code                                                          | Toolchain line in `hostEvidence`      |
| ------- | ------------------ | -------------------------------------------------------------------- | ------------------------------------- |
| Linux   | `compiler-rt`      | Clang's runtime builtins and startup objects                         | `Clang major version`                 |
| Linux   | `glibc-startup`    | glibc's `Scrt1.o`, `crti.o`, `crtn.o` and `libc_nonshared.a` members | `glibc`                               |
| Linux   | `llvm-cxx-runtime` | LLVM's libc++, libc++abi and libunwind linked into ICU               | `Clang major version`                 |
| Windows | `mingw-runtime`    | MinGW-w64 startup, LLVM runtime code and bundled runtime DLLs        | `CLANG64 packages and linked objects` |

The macOS linker maps must cover every image and have a complete list of object files.
The audit resolves each input against the original link directory and build root, including after a checkout move.
It admits build inputs, linker-synthesized entries and dynamic library stubs.
The PostgreSQL source review also covers the generated parser and scanner code.
Its `toolchain` matches the `PostgreSQL parser generators` host evidence,
which identifies Xcode and the Bison and Flex used by configure.
A missing or changed identity requires a new PostgreSQL component review.

The Linux build records its toolchain lines in the build container when it compiles, and reassembly reuses them as well,
so a reassembly on another host cannot describe another compiler or glibc.
These lines change rarely, unlike toolset updates, and the toolchain's licence terms follow them.
Clang links every Linux image through the build image's `traced-ld`,
which records the link's input files and archive members under the output's build ID.
Packaging, including a reassembly, fails when an image in the candidate has no such record, wherever the image lies,
and when a record shows GCC's runtime or any other glibc code,
so the `glibc-startup` review keeps matching what is linked into each image.
For Windows, LLD reports the resolved input files and the members it loads from each archive.
A link record is identified by the SHA-256 of the linked image.
Each assembly verifies those records and the pinned bytes of the two shared runtime DLLs.
The ICU data DLL is checked separately for executable sections and an entry point.
The `mingw-runtime` review binds the package list and per-image member inventory,
and retains the toolchain notices in `notices/mingw-runtime.txt`.
The complete receipt is published atomically after the fresh build checks every image.
Each native source has a `CLANG64 packages and linked objects: <source ID>` entry for its own images.

The current Windows pins require the following licences on `mingw-runtime`.

- LLVM builtins and libc++ use `Apache-2.0 WITH LLVM-exception`.
  The Ryu code in libc++'s floating-point `to_chars` also carries `BSL-1.0`.
- The winpthreads DLL carries `MIT` and `BSD-3-Clause`.
- MinGW startup and UCRT helpers include public-domain code (`LicenseRef-Public-Domain`).
  The linked `signgam` and scanf formatter carry `ZPL-2.1`.
- The linked `getopt` carries `ISC` and `BSD-2-Clause`.
  `LicenseRef-MinGW-gdtoa` identifies the Lucent and David Gay conversion notices in the shipped runtime notice.
  `LicenseRef-MinGW-printf` identifies Keith Marshall's grant for the printf formatter in the same notice.

When the pins or linked members change, compare the new inventory with the corresponding upstream sources.
Update the required licences and notices for any changed contributions before approving the review.
See the [pinned MinGW sources](https://github.com/mingw-w64/mingw-w64/tree/e3d18511f)
and the [pinned libc++ Ryu code](https://github.com/llvm/llvm-project/blob/llvmorg-23.1.5/libcxx/src/include/ryu/ryu.h).

Each source's component must list all its retained notices in `notices`.
Each extension's source component must list its control file, SQL files, and native libraries in `files`;
for the contrib modules that is the `postgresql` component.
The `icu` component must list ICU's native libraries.
The `openssl` component must list both TLS libraries.
The `postgresql` component must list every remaining native image, because PostgreSQL's own build makes them.
A compiler's license metadata alone does not describe its emitted runtime contributions.

Release validation is the default.
It requires a verified inventory, all selected source components, complete reviewed file coverage,
source and toolchain coverage of every native image, retained notices, and verified host prerequisites.
It compares the host prerequisites with the build's measurement, so it also requires that measurement:
`PE host library imports` on Windows, `ELF glibc symbol requirements` on Linux,
and `Mach-O host library imports` and `Mach-O minimum macOS version` on macOS.
Each cited notice must be a regular file whose SHA-256 matches the reviewed digest.
Each toolchain component must match its reviewed toolchain line.
Release validation rejects GPL/AGPL contributions, including GCC's own runtime under
`GPL-3.0-or-later WITH GCC-exception-3.1`, unresolved components, and licenses outside the explicit permitted set.
The Linux `compiler-rt` component must carry `Apache-2.0 WITH LLVM-exception`.
Other components can also use this licence.
The Linux `glibc-startup` component must carry `LGPL-2.1-or-later WITH GCC-exception-2.0`.
The glibc startup sources include the linking exception, which permits linking them into a program and distributing the result.

Some reviewed source code is under licences outside the permitted set.
Each listed source component must carry the licences for the code it ships in every build.
Toolchain components have the separate requirements above.

| Component    | Licence                     | Code                                                                      |
| ------------ | --------------------------- | ------------------------------------------------------------------------- |
| `postgresql` | `Spencer-99`, `TCL`         | Henry Spencer's regex package and the Tcl code in it                      |
| `postgresql` | `BSL-1.0`                   | Ryu (`src/common/d2s.c`, `f2s.c`), used under the Boost licence           |
| `postgresql` | `LicenseRef-GEQO-Whitley`   | GEQO (`src/backend/optimizer/geqo`), granted for free distribution        |
| `postgresql` | `LicenseRef-pg-dump-Warner` | parts of pg_dump                                                          |
| `postgresql` | `LicenseRef-rbtree-Niemann` | `src/backend/lib/rbtree.c`                                                |
| `postgresql` | `LicenseRef-X0213`          | the EUC-JIS-2004 and Shift_JIS-2004 conversion maps                       |
| `pg_cron`    | `Vixie-Cron`                | Paul Vixie's cron code, which may be sold only with buildable source      |
| `pg_cron`    | `BSD-4.3TAHOE`              | `bitstring.h`, developed by the University of California, Berkeley        |
| `icu`        | `ICU`, `NAIST-2003`         | Legacy ICU terms and IPADIC dictionary data retained in `notices/icu.txt` |

The `LicenseRef-` texts and the other notices ship among the source's retained notices.
These licences are not host licences either.

Other additions require a deliberate repository policy change and review.

Host-library licensing is separate from bundled-file coverage.
The host allowlist includes the reviewed LGPL glibc, Windows and Apple macOS terms.
This does not permit bundling LGPL libraries or infer redistribution rights from their presence on a host.

Filename exclusions reject obvious TimescaleDB Community libraries and forbidden helper profiles.
They do not replace build-option evidence, compiled-source review, or an inventory covering generated SQL and binaries.
A verified status is a review attestation, which `pnpm binaries:approve` records after listing what it approves.
The validator checks its consistency and completeness; it cannot replace the underlying license investigation.

## Build-tool API

`binaries/artifact/artifact.ts` provides side-effect-free imports and explicit filesystem operations:

- `writeArtifactManifest(installation, options)` creates metadata in a newly assembled staging candidate.
  Supply `options.noticeSignatures` with a scan entry for every pinned source.
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
Safe extraction, full dependency/license closure, and final release acceptance remain separate work.
