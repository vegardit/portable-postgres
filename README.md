# portable-postgres

[![Build Status](https://github.com/vegardit/portable-postgres/workflows/Build/badge.svg "GitHub Actions")](https://github.com/vegardit/portable-postgres/actions?query=workflow%3A%22Build%22)
[![License](https://img.shields.io/github/license/vegardit/portable-postgres.svg?color=blue&label=License)](LICENSE.txt)

1. [What is it?](#what-is-it)
1. [Platforms](#platforms)
1. [What is included](#what-is-included)
1. [Limitations](#limitations)
1. [Usage](#usage)
1. [Alternatives](#alternatives)
1. [Contributing](#contributing)
1. [License](#license)

## <a name="what-is-it"></a>What is it?

PostgreSQL 18 in a native archive for local development and integration tests.
Extract the archive and run PostgreSQL directly on your machine.

> **Status:** pre-release. No archives are published yet.
> GitHub Actions will build the `.tar.gz` archives for download from GitHub Releases.
> The Node.js wrapper will follow on npm.

## <a name="platforms"></a>Platforms

| Platform          | Status | Host requirement                                            |
| ----------------- | ------ | ----------------------------------------------------------- |
| Linux x64 (glibc) | Built  | glibc 2.35 or newer; tested on Ubuntu 22.04.                |
| Windows x64       | Built  | Microsoft Visual C++ Redistributable and the Universal CRT. |
| macOS arm64       | Built  | macOS 15 or newer on Apple silicon.                         |

Linux distributions based on musl, such as Alpine, are not supported.

## <a name="what-is-included"></a>What is included

The archives contain PostgreSQL 18 and the extensions below.
They bundle ICU and its complete locale data for language-aware sorting on every platform.
The exact source releases and their checksums are listed in [`binaries/sources/sources.json`](binaries/sources/sources.json).

| Extension                                                             | What it does                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [pgvector](https://github.com/pgvector/pgvector)                      | Stores vectors and finds similar ones.                                     |
| [TimescaleDB](https://github.com/timescale/timescaledb) (Apache-only) | Adds hypertables for storing and querying time-series data.                |
| [pg_textsearch](https://github.com/timescale/pg_textsearch)           | Adds full-text search that ranks matches by relevance using BM25.          |
| [HypoPG](https://github.com/HypoPG/hypopg)                            | Shows how a proposed index would affect a query plan before you create it. |
| [plpgsql_check](https://github.com/okbob/plpgsql_check)               | Finds errors in PL/pgSQL functions and procedures before you run them.     |
| [pg_cron](https://github.com/citusdata/pg_cron)                       | Schedules SQL jobs to run inside PostgreSQL.                               |
| [pg_partman](https://github.com/pgpartman/pg_partman) (SQL only)      | Creates and maintains table partitions based on time or integer values.    |
| [pgTAP](https://github.com/theory/pgtap) (SQL only)                   | Adds SQL assertions for testing database schemas and behavior.             |

## <a name="limitations"></a>Limitations

The archives are built for development and tests, with as few external dependencies as possible.
Do not use them for production databases.

- No TLS: PostgreSQL is built without OpenSSL, so connections are unencrypted.
- No zlib, LZ4, or Zstandard compression, including for `pg_dump` and `pg_basebackup`.
- `psql` has no line editing or command history, because readline is excluded.
- TimescaleDB is the Apache-only build.
  Features under the Timescale License, such as compression and continuous aggregates, are not included.
- pg_partman has no background worker.
  Call `partman.run_maintenance_proc()` yourself, for example from a pg_cron job.
- pg_textsearch ranks with statistics over all indexed rows, including rows that row-level security hides.
  A user who knows a term can learn how often it occurs in rows they cannot read.
  A superuser can set `pg_textsearch.allow_rls = off` to refuse creating or rebuilding BM25 indexes on tables with row-level security,
  and enabling row-level security on tables that have them.
  The setting is checked only when these commands run, so indexes created while it was on keep working.
  On a partitioned table, each partition keeps its own statistics, so scores from different partitions are not comparable.
- pgTAP comes without the `pg_prove` command-line runner.
  Run the test SQL with `psql` and read the TAP output.

## <a name="usage"></a>Usage

Choose an archive for your platform and verify its SHA-256 against a trusted digest before extracting it.
The commands below run from the extracted directory.
Keep the database and its log outside that directory, so that it holds only the archive's files and can be replaced.
On Linux and macOS, `initdb` creates the data directory, and any missing parent, readable only by you.
On Windows, the directory below lies in your own profile.
`--pwprompt` asks for the password of the `postgres` user, so the password is never written to a file or the shell history.

On macOS the programs are ad-hoc signed.
In the macOS 15.8.2 runner test, the stock `tar` preserved the download quarantine on the executables
and `bin/initdb --version` ran with Gatekeeper enabled.

Create a data directory:

```sh
pgwork="$HOME/portable-postgres"
bin/initdb -D "$pgwork/data" -U postgres --pwprompt --auth=scram-sha-256 --encoding=UTF8 --no-locale
```

On Windows, in `cmd.exe`:

```bat
set "pgwork=%LOCALAPPDATA%\portable-postgres"
bin\initdb.exe -D "%pgwork%\data" -U postgres --pwprompt --auth=scram-sha-256 --encoding=UTF8 --no-locale
```

For an ICU default locale, replace `--no-locale` in the initialization command with
`--locale-provider=icu --icu-locale=de-DE`, using the locale you need.
An existing database can also use individual ICU collations.

```sql
CREATE COLLATION german (provider = icu, locale = 'de-DE');
```

An ICU update can change sort order.
Rebuild affected indexes before refreshing their recorded collation versions.
See the [PostgreSQL collation maintenance guidance](https://www.postgresql.org/docs/18/sql-altercollation.html).

TimescaleDB, pg_textsearch, and pg_cron must be loaded when the server starts.
If you use any of them, add this line to `postgresql.conf` in the data directory first, listing only the ones you need:

```ini
shared_preload_libraries = 'timescaledb,pg_textsearch,pg_cron'
```

pg_cron keeps its jobs in one database and by default runs each job over a new client connection,
which the password authentication above refuses without a stored password.
If you use pg_cron, add these lines as well, so that jobs run in background workers instead:

```ini
cron.database_name = 'postgres'
cron.use_background_workers = on
max_worker_processes = 16
```

`max_worker_processes` limits all background workers, including those of pg_cron and TimescaleDB.
The archives' native tests run with these settings.

Start the server, connect, and stop the server again:

```sh
bin/pg_ctl -D "$pgwork/data" -l "$pgwork/server.log" -o "-p 5432" -w start
bin/psql -h 127.0.0.1 -p 5432 -U postgres -d postgres
bin/pg_ctl -D "$pgwork/data" -m fast -w stop
```

On Windows:

```bat
bin\pg_ctl.exe -D "%pgwork%\data" -l "%pgwork%\server.log" -o "-p 5432" -w start
bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d postgres
bin\pg_ctl.exe -D "%pgwork%\data" -m fast -w stop
```

Enable the extensions you need with `CREATE EXTENSION` in each database:

```sql
CREATE EXTENSION vector;
```

Install pg_partman in the `partman` schema to use `partman.run_maintenance_proc()`.

```sql
CREATE SCHEMA partman;
CREATE EXTENSION pg_partman SCHEMA partman;
```

pg_cron can only be created in the database that `cron.database_name` names.
To run a job in another database, schedule it with `cron.schedule_in_database()`, which takes that database's name.

For archive layout and platform requirements, see the [native artifact format](docs/native-artifact.md).

## <a name="alternatives"></a>Alternatives

portable-postgres is a native PostgreSQL server with a fixed set of extensions that runs without a container runtime or an installation.
The table compares it with other ways to run PostgreSQL locally, as of November 2026.

|                                                         | portable-postgres     | [Docker image](https://hub.docker.com/_/postgres) | [PGlite](https://pglite.dev)        | [Zonky Embedded Postgres Binaries](https://github.com/zonkyio/embedded-postgres-binaries) | [EDB installers](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads) |
| ------------------------------------------------------- | --------------------- | ------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Runs as                                                 | Native server         | Server in a container                             | WebAssembly in a JavaScript runtime | Native server                                                                             | Installed native server                                                                |
| Works without a container runtime                       | ✅                    | ❌                                                | ✅                                  | ✅                                                                                        | ✅                                                                                     |
| Multiple connections                                    | ✅                    | ✅                                                | ❌                                  | ✅                                                                                        | ✅                                                                                     |
| pgvector, pg_textsearch, pgTAP                          | ✅ Included           | ❌ Not included                                   | ✅ Separate npm packages            | ❌ Not included                                                                           | ❌ Not included                                                                        |
| TimescaleDB, pg_cron, HypoPG, plpgsql_check, pg_partman | ✅ Included           | ❌ Not included                                   | ❌ Not available                    | ❌ Not included                                                                           | ❌ Not included                                                                        |
| TLS                                                     | ❌                    | ✅                                                | Not applicable                      | ✅                                                                                        | ✅                                                                                     |
| ICU collations                                          | ✅                    | ✅                                                | ✅                                  | ✅                                                                                        | ✅                                                                                     |
| Linux x64 (glibc)                                       | ✅                    | ✅                                                | ✅                                  | ✅                                                                                        | ❌                                                                                     |
| Linux x64 (musl)                                        | ❌                    | ✅                                                | ✅                                  | ✅                                                                                        | ❌                                                                                     |
| Windows x64                                             | ✅                    | In a Linux VM                                     | ✅                                  | ✅                                                                                        | ✅                                                                                     |
| macOS arm64                                             | ✅                    | In a Linux VM                                     | ✅                                  | ✅                                                                                        | ✅                                                                                     |
| Intended for                                            | Development and tests | Any use, including production                     | Embedding in applications, tests    | Tests                                                                                     | Any use, including production                                                          |

The Docker image and the EDB installers also support compression, which portable-postgres lacks; see [Limitations](#limitations).
You can add extensions to the Docker image by building your own image on top of it.
The Embedded Postgres Binaries contain only `initdb`, `pg_ctl`, and `postgres`.
Wrappers such as the [`embedded-postgres`](https://github.com/leinelissen/embedded-postgres) npm package download and start them for you.

## <a name="contributing"></a>Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for build and test instructions.

## <a name="license"></a>License

All files are released under the [Apache License 2.0](LICENSE.txt).

Individual files contain the following tag instead of the full license text:

```
SPDX-License-Identifier: Apache-2.0
```

This enables machine processing of license information based on the SPDX License Identifiers that are available here: https://spdx.org/licenses/.

PostgreSQL, extensions, and their dependencies retain their own licenses and notices.
The archives include those notices in their `notices/` directory.
If you redistribute an archive, follow the applicable license terms for each component.
These include the following conditions.

- PostgreSQL's genetic query optimizer contains code by Darrell L. Whitley, granted "for free distribution" on condition that his name and notice are included in any copy (`notices/postgresql-src-backend-optimizer-geqo-geqo_cx.c`).
- pg_cron contains Paul Vixie's cron code, which "May be sold if buildable source is provided to buyer" (`notices/pg_cron-src-entry.c`).
  Every release attaches `portable-postgres-<version>-sources.tar.gz` for this: this repository at the release commit, with the source archives that its archives were built from.

pg_cron includes software developed by the University of California, Berkeley (`notices/pg_cron-include-bitstring.h.txt`).

### Microsoft code in the Windows archives

The released Windows archives are built with Microsoft Visual Studio 2026.
As in every program built with it, the linker adds a small amount of Microsoft runtime code to each Windows program and library.
If you redistribute a released Windows archive, the conditions in its [notices/msvc-runtime.txt](binaries/windows/notices/msvc-runtime.txt) apply to that code.
An archive that you build yourself with another Visual Studio version contains another `notices/msvc-runtime.txt`, which applies instead.
