#!/usr/bin/env bash
#
# SPDX-FileCopyrightText: © Vegard IT GmbH (https://vegardit.com)
# SPDX-FileContributor: Sebastian Thomschke
# SPDX-License-Identifier: Apache-2.0
# SPDX-ArtifactOfProjectHomePage: https://github.com/vegardit/portable-postgres

# Proves authenticated native startup and selected extension coexistence without the wrapper.
set -euo pipefail
project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ $# -ne 1 || -z $1 ]]; then
  echo 'Usage: bash smoke.sh <installation>' >&2
  exit 2
fi
installation=$(cd -- "$1" && pwd)
if [[ ${NATIVE_CLEAN_CONSUMER:-0} == 1 ]]; then
  for build_tool in node npm pnpm cc gcc clang make cmake docker; do
    if command -v "$build_tool" >/dev/null 2>&1; then
      echo "Unexpected tool in clean consumer: $build_tool" >&2
      exit 1
    fi
  done
fi
if [[ $(id -u) == 0 ]]; then
  exec runuser -u nobody -- env -i PATH=/usr/bin:/bin HOME=/nonexistent \
    bash "$project_root/binaries/linux/smoke.sh" "$installation"
fi
umask 077
export LC_ALL=C
unset "${!PG@}"
# Locale data must come from the archive during the proof.
unset ICU_DATA
# A developer SDK on the host must not supply either process's TLS libraries.
unset LD_LIBRARY_PATH
if [[ $(uname -s) == Linux ]]; then
  for program in postgres psql pg_dump; do
    loaded=$(LD_TRACE_LOADED_OBJECTS=1 "$installation/bin/$program")
    libraries=(libcrypto.so.3 libssl.so.3)
    if [[ $program == pg_dump ]]; then libraries+=(libz.so.1 liblz4.so.1); fi
    for lib in "${libraries[@]}"; do
      # Keep spaces in the installation path and resolve loader paths containing ../lib.
      path=$(awk -v lib="$lib" '$1 == lib && $2 == "=>" { sub(/^.* => /, ""); sub(/ \(0x[0-9a-f]+\)$/, ""); print }' <<< "$loaded")
      if [[ ! "$path" -ef "$installation/lib/$lib" ]]; then
        echo "$program did not load the bundled $lib" >&2
        exit 1
      fi
    done
  done
fi
# Preserve diagnostic data on failure; this proof never removes an installation or cluster.
proof_work=$(mktemp -d /tmp/portable-postgres-proof.XXXXXXXX)
# The clean consumer copies this directory even on failure. Keep the cluster and credentials outside it.
proof_root="$proof_work/logs"
mkdir "$proof_root"
printf 'Native proof evidence: %s\n' "$proof_root"
pg_ctl="$installation/bin/pg_ctl"
data="$proof_work/data"
password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
printf '%s\n' "$password" > "$proof_work/password"
"$installation/bin/initdb" -D "$data" -U proof --pwfile="$proof_work/password" \
  --auth-host=scram-sha-256 --auth-local=scram-sha-256 --encoding=UTF8 --no-locale > "$proof_root/initdb.log"
cat -- "$project_root/tests/native/server.conf" >> "$data/postgresql.conf"
stop_owned_server() {
  "$pg_ctl" -D "$data" -m fast -w -t 30 stop
}
cleanup_on_exit() {
  local status=0
  "$pg_ctl" -D "$data" status > "$proof_root/failure-status.log" 2>&1 || status=$?
  if [[ $status -eq 0 ]]; then
    stop_owned_server || echo "Could not stop the proof server at $data" >&2
  elif [[ $status -ne 3 ]]; then
    echo "Could not check the proof server; inspect $proof_root/failure-status.log" >&2
  fi
}
trap cleanup_on_exit EXIT
# Starts the cluster on a free port with the given server log, and sets $port.
start_server() {
  local log=$proof_root/$1 attempt
  for ((attempt = 1; ; attempt++)); do
    port=$((16384 + RANDOM))
    if "$pg_ctl" -D "$data" -l "$log" -o "-p $port" -w -t 30 start; then
      return
    fi
    status=0
    "$pg_ctl" -D "$data" status > "$proof_root/start-status.log" 2>&1 || status=$?
    # A retry may only follow an unusable port with no running server in this cluster.
    # The messages are portFailures in binaries/native-proof.ts.
    if [[ $attempt -ge 4 || $status -ne 3 ]] ||
      ! grep -Eq 'could not bind|could not create any TCP/IP sockets' "$log"; then
      echo "Could not start PostgreSQL; inspect $log" >&2
      exit 1
    fi
    mv -- "$log" "${log%.log}-$attempt.log"
  done
}
stop_and_confirm() {
  stop_owned_server
  status=0
  "$pg_ctl" -D "$data" status > "$proof_root/status.log" 2>&1 || status=$?
  if [[ $status -ne 3 ]]; then
    echo "Could not confirm PostgreSQL shutdown; inspect $proof_root/status.log" >&2
    exit 1
  fi
}
start_server server.log
# Any port and database: every start picks a free port, and the pg_textsearch run uses its own database.
printf '127.0.0.1:*:*:proof:%s\n' "$password" > "$proof_work/pgpass"
unset password
export PGPASSFILE="$proof_work/pgpass"
"$installation/bin/psql" -X -w -h 127.0.0.1 -p "$port" -U proof -d postgres \
  -v ON_ERROR_STOP=1 -f "$project_root/tests/native/smoke.sql" > "$proof_root/sql.log"
cat "$proof_root/sql.log"
connection=(-w -h 127.0.0.1 -p "$port" -U proof)
for codec in gzip lz4; do
  database="restore_$codec"
  "$installation/bin/pg_dump" "${connection[@]}" -d postgres -Fc --compress="$codec" \
    -t public.compression_sample -f "$proof_work/$codec.dump"
  "$installation/bin/createdb" "${connection[@]}" "$database"
  "$installation/bin/pg_restore" "${connection[@]}" --exit-on-error -d "$database" "$proof_work/$codec.dump"
  "$installation/bin/psql" "${connection[@]}" -X -v ON_ERROR_STOP=1 -d "$database" \
    -f "$project_root/tests/native/compression.sql"
  "$installation/bin/pg_basebackup" "${connection[@]}" -D "$proof_work/backup-$codec" \
    -Ft -X none --checkpoint=fast --compress="$codec"
  suffix=$codec
  if [[ $codec == gzip ]]; then suffix=gz; fi
  test -s "$proof_work/backup-$codec/base.tar.$suffix"
  "$installation/bin/pg_verifybackup" --no-parse-wal "$proof_work/backup-$codec"
done
"$installation/bin/psql" -X -w -h 127.0.0.1 -p "$port" -U proof -d postgres \
  -v ON_ERROR_STOP=1 -qAt -f "$project_root/tests/native/tap.sql" > "$proof_root/results.tap"
cat "$proof_root/results.tap"
"$installation/bin/psql" -X -w -h 127.0.0.1 -p "$port" -U proof -d postgres \
  -v ON_ERROR_STOP=1 -qAt -f "$project_root/tests/native/tap-failure.sql" > "$proof_root/failure.tap"
# Check the denial case without a credential file or interactive password prompt.
status=0
PGPASSFILE=/dev/null "$installation/bin/psql" -X -w -h 127.0.0.1 -p "$port" -U proof -d postgres \
  -c 'SELECT 1' > "$proof_root/denied.log" 2>&1 || status=$?
if [[ $status -ne 2 ]] || ! grep -Fq 'fe_sendauth: no password supplied' "$proof_root/denied.log"; then
  echo "Expected PostgreSQL to require a password; inspect $proof_root/denied.log" >&2
  exit 1
fi
stop_and_confirm
# Users may preload pg_textsearch alone, so it must not depend on TimescaleDB, which the run above also preloads.
cat -- "$project_root/tests/native/textsearch.conf" >> "$data/postgresql.conf"
tls="$project_root/tests/native/tls"
cp "$tls/server-cn-only+server_ca.crt" "$data/server.crt"
cp "$tls/server-cn-only.key" "$data/server.key"
chmod 600 "$data/server.key"
cp "$tls/pg_hba.conf" "$data/pg_hba.conf"
start_server server-textsearch.log
# Connect to loopback even for the deliberately wrong hostname. DNS failure cannot satisfy this test.
export PGHOSTADDR=127.0.0.1 PGHOST=common-name.pg-ssltest.test PGSSLMODE=verify-full
# Keep libpq from reading the developer's certificates or revocation list. The proof uses no CRL.
export PGSSLROOTCERT="$tls/root_ca.crt" PGSSLCERTMODE=disable PGSSLCRL="$proof_work/no.crl"
sed "s/^127\.0\.0\.1:/$PGHOST:/" "$proof_work/pgpass" > "$proof_work/tls-pgpass"
export PGPASSFILE="$proof_work/tls-pgpass"
"$installation/bin/psql" -X -w -p "$port" -U proof -d postgres \
  -v ON_ERROR_STOP=1 -q -c 'CREATE DATABASE textsearch_only'
"$installation/bin/psql" -X -w -p "$port" -U proof -d textsearch_only \
  -v ON_ERROR_STOP=1 -f "$project_root/tests/native/textsearch.sql" > "$proof_root/textsearch.log"
cat "$proof_root/textsearch.log"
tls_psql=("$installation/bin/psql" -X -w -p "$port" -U proof -d postgres -qAt)
"${tls_psql[@]}" -c 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()' > "$proof_root/tls.log"
if [[ $(< "$proof_root/tls.log") != t ]]; then
  echo "Expected an encrypted connection; inspect $proof_root/tls.log" >&2
  exit 1
fi
expect_denied() {
  local label=$1 reason=$2 status=0
  shift 2
  env "$@" "${tls_psql[@]}" -c 'SELECT 1' > "$proof_root/$label.log" 2>&1 || status=$?
  if [[ $status != 2 ]] || ! grep -Fq "$reason" "$proof_root/$label.log"; then
    echo "Expected $reason; inspect $proof_root/$label.log" >&2
    return 1
  fi
}
expect_denied tls-hostname 'does not match host name' PGHOST=wrong.test
expect_denied tls-ca 'certificate verify failed' PGSSLROOTCERT="$tls/client_ca.crt"
expect_denied tls-plaintext 'no encryption' PGSSLMODE=disable
stop_and_confirm
trap - EXIT
printf 'NATIVE_PROOF_DIRECTORY=%s\n' "$proof_root"
