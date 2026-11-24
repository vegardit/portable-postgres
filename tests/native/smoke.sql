-- Exercises the full native bundle together; failures must stop the SQL client.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_extension WHERE extname <> 'plpgsql') THEN
    RAISE EXCEPTION 'Selected extensions must not be created automatically';
  END IF;
END
$$;
CREATE EXTENSION vector;
CREATE EXTENSION timescaledb;
CREATE EXTENSION pg_textsearch;
CREATE EXTENSION hypopg;
CREATE EXTENSION plpgsql_check;
CREATE EXTENSION pg_cron;
CREATE SCHEMA partman;
CREATE EXTENSION pg_partman SCHEMA partman;
CREATE EXTENSION pgtap;
CREATE EXTENSION pgmq;
CREATE EXTENSION btree_gist;
CREATE EXTENSION citext;
CREATE EXTENSION hstore;
CREATE EXTENSION ltree;
CREATE EXTENSION pg_stat_statements;
CREATE EXTENSION pg_trgm;
CREATE EXTENSION pgcrypto;
CREATE EXTENSION unaccent;

-- Match the exact index name in the structured plan because a sequential scan can return the same rows.
-- With executed, the query runs under EXPLAIN ANALYZE and the index node must have run at least once;
-- a plan alone does not exercise the index's scan code. HypoPG's hypothetical indexes can only be planned.
CREATE FUNCTION pg_temp.assert_plan_uses_index(query text, expected_index text, executed boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  query_plan jsonb;
BEGIN
  IF executed THEN
    EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || query INTO query_plan;
  ELSE
    EXECUTE 'EXPLAIN (FORMAT JSON) ' || query INTO query_plan;
  END IF;
  IF NOT jsonb_path_exists(
    query_plan,
    CASE WHEN executed THEN '$.** ? (@."Index Name" == $expected && @."Actual Loops" > 0)'
         ELSE '$.**."Index Name" ? (@ == $expected)' END::jsonpath,
    jsonb_build_object('expected', expected_index)
  ) THEN
    RAISE EXCEPTION 'Expected query plan to % index %', CASE WHEN executed THEN 'run' ELSE 'use' END,
      expected_index USING DETAIL = query_plan::text;
  END IF;
END
$$;

CREATE TABLE embeddings (id integer PRIMARY KEY, embedding vector(3));
INSERT INTO embeddings VALUES (1, '[1,0,0]'), (2, '[0,1,0]'), (3, '[0,0,1]');
CREATE INDEX embedding_index ON embeddings USING hnsw (embedding vector_l2_ops);
SET enable_seqscan = off;
SELECT pg_temp.assert_plan_uses_index(
  $query$SELECT id FROM embeddings ORDER BY embedding <-> '[1,0,0]' LIMIT 1$query$,
  'embedding_index', executed => true);
-- LIMIT 0 plans the index scan but never runs it, so the check must reject it.
DO $$
BEGIN
  PERFORM pg_temp.assert_plan_uses_index(
    $query$SELECT id FROM embeddings ORDER BY embedding <-> '[1,0,0]' LIMIT 0$query$,
    'embedding_index', executed => true);
  RAISE EXCEPTION 'The HNSW check accepted an index scan that never ran';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'The HNSW check accepted%' THEN RAISE; END IF;
END
$$;
-- The same settings give the same plan, so this result comes from the HNSW scan.
DO $$
BEGIN
  IF (SELECT id FROM embeddings ORDER BY embedding <-> '[1,0,0]' LIMIT 1) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Expected the HNSW scan to return row 1 as the nearest neighbour';
  END IF;
END
$$;
RESET enable_seqscan;

CREATE TABLE measurements (recorded_at timestamptz NOT NULL, value integer);
SELECT create_hypertable('measurements', by_range('recorded_at'));
INSERT INTO measurements VALUES ('2026-01-01', 1), ('2026-02-01', 2);
SELECT time_bucket('1 day', recorded_at), sum(value) FROM measurements GROUP BY 1 ORDER BY 1;
SELECT show_chunks('measurements');

CREATE TABLE documents (id integer PRIMARY KEY, content text);
INSERT INTO documents VALUES (1, 'database postgres database'), (2, 'gardening flowers');
CREATE INDEX document_index ON documents USING bm25(content) WITH (text_config='english', compaction='inline');
DO $$
BEGIN
  IF (SELECT id FROM documents ORDER BY content <@> 'database' LIMIT 1) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Expected document 1 to rank first for the BM25 query';
  END IF;
END
$$;

SET enable_seqscan = off;
DO $$
DECLARE
  hypothetical_index text;
BEGIN
  -- HypoPG keeps indexes in this session, and the planner must see the generated index before reset.
  SELECT indexname INTO STRICT hypothetical_index FROM hypopg_create_index('CREATE INDEX ON documents (content)');
  PERFORM pg_temp.assert_plan_uses_index(
    $query$SELECT id FROM documents WHERE content = 'database postgres database'$query$,
    hypothetical_index);
END
$$;
RESET enable_seqscan;
SELECT hypopg_reset();
CREATE FUNCTION invalid_proof_function() RETURNS integer LANGUAGE plpgsql AS $$
BEGIN RETURN nonexistent_proof_variable; END
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM plpgsql_check_function_tb('invalid_proof_function()'::regprocedure)
    WHERE sqlstate = '42703' AND level = 'error'
  ) THEN
    RAISE EXCEPTION 'Expected plpgsql_check to report an undefined-column error';
  END IF;
END
$$;
-- The job records its own run: unscheduling can rewrite pg_cron's run history for a job still in flight.
CREATE TABLE cron_proof (ran_at timestamptz NOT NULL DEFAULT now());
SELECT cron.schedule('proof-job', '1 second', 'INSERT INTO cron_proof DEFAULT VALUES');
DO $$
BEGIN
  FOR attempt IN 1..100 LOOP
    EXIT WHEN EXISTS (SELECT FROM cron_proof);
    PERFORM pg_sleep(0.1);
  END LOOP;
  IF NOT EXISTS (SELECT FROM cron_proof) THEN
    RAISE EXCEPTION 'Scheduled proof job did not run within 10 seconds';
  END IF;
END
$$;
SELECT cron.unschedule('proof-job');

CREATE TABLE ordinary_events (recorded_at timestamptz NOT NULL, payload text) PARTITION BY RANGE (recorded_at);
SELECT partman.create_parent(p_parent_table := 'public.ordinary_events', p_control := 'recorded_at',
  p_interval := '1 day', p_premake := 2);
CALL partman.run_maintenance_proc();
-- EUC_TW to BIG5 has its own conversion module; Unicode escapes keep this file ASCII for any client encoding.
DO $$
BEGIN
  IF convert(convert_to(U&'\4E2D\6587', 'EUC_TW'), 'EUC_TW', 'BIG5') <> convert_to(U&'\4E2D\6587', 'BIG5') THEN
    RAISE EXCEPTION 'EUC_TW to BIG5 conversion returned unexpected bytes';
  END IF;
END
$$;

CREATE COLLATION proof_german (provider = icu, locale = 'de-DE');
CREATE COLLATION proof_case_insensitive (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
CREATE TABLE icu_words (word text COLLATE proof_german NOT NULL);
INSERT INTO icu_words VALUES ('z'), (U&'\00E4'), ('a');
CREATE INDEX icu_words_index ON icu_words (word);
SET enable_seqscan = off;
SELECT pg_temp.assert_plan_uses_index(
  $query$SELECT word FROM icu_words WHERE word >= U&'\00E4' ORDER BY word$query$,
  'icu_words_index', executed => true);
DO $$
BEGIN
  IF (SELECT array_agg(word ORDER BY word) FROM icu_words) IS DISTINCT FROM ARRAY['a', U&'\00E4', 'z'] THEN
    RAISE EXCEPTION 'The ICU index did not return German collation order';
  END IF;
  -- Byte order would exclude z from this range. German collation must return both rows through the index.
  IF (SELECT count(*) FROM icu_words WHERE word >= U&'\00E4') <> 2 THEN
    RAISE EXCEPTION 'The ICU index did not apply the German range comparison';
  END IF;
  IF NOT ('A' COLLATE proof_case_insensitive = 'a')
     OR 'a' COLLATE proof_case_insensitive = U&'\00E4' THEN
    RAISE EXCEPTION 'The ICU nondeterministic collation did not preserve accent-sensitive, case-insensitive equality';
  END IF;
END
$$;
RESET enable_seqscan;

SELECT pgmq.create('proof_queue');
SELECT pgmq.send('proof_queue', '{"proof": 1}'::jsonb);
DO $$
DECLARE
  received record;
BEGIN
  SELECT * INTO STRICT received FROM pgmq.read(queue_name => 'proof_queue', vt => 30, qty => 1);
  IF received.message IS DISTINCT FROM '{"proof": 1}'::jsonb THEN
    RAISE EXCEPTION 'pgmq returned an unexpected message';
  END IF;
  -- The visibility timeout hides the message from a second reader until it is archived or expires.
  IF EXISTS (SELECT FROM pgmq.read(queue_name => 'proof_queue', vt => 30, qty => 1))
     OR NOT pgmq.archive('proof_queue', received.msg_id) THEN
    RAISE EXCEPTION 'pgmq did not hide and archive the message it delivered';
  END IF;
END
$$;

-- An equality operator in a GiST exclusion constraint needs btree_gist's operator classes.
CREATE TABLE bookings (room integer, during tstzrange, EXCLUDE USING gist (room WITH =, during WITH &&));
INSERT INTO bookings VALUES (1, '[2026-01-01, 2026-01-02)'), (2, '[2026-01-01, 2026-01-02)');
DO $$
BEGIN
  INSERT INTO bookings VALUES (1, '[2026-01-01 12:00, 2026-01-03)');
  RAISE EXCEPTION 'The btree_gist exclusion constraint accepted an overlapping booking';
EXCEPTION WHEN exclusion_violation THEN
  NULL;
END
$$;

CREATE INDEX document_trigram_index ON documents USING gin (content gin_trgm_ops);
SET enable_seqscan = off;
SELECT pg_temp.assert_plan_uses_index(
  $query$SELECT id FROM documents WHERE content LIKE '%postgres%'$query$,
  'document_trigram_index', executed => true);
RESET enable_seqscan;

DO $$
DECLARE
  password_hash text := crypt('proof', gen_salt('bf', 4));
BEGIN
  IF 'Portable'::citext <> 'PORTABLE'::citext THEN
    RAISE EXCEPTION 'citext compared case-sensitively';
  END IF;
  IF ('a=>1, b=>2'::hstore -> 'b') IS DISTINCT FROM '2' THEN
    RAISE EXCEPTION 'hstore returned an unexpected value';
  END IF;
  IF NOT ('Top.Science.Astronomy'::ltree <@ 'Top.Science'::ltree) THEN
    RAISE EXCEPTION 'ltree did not recognize a descendant path';
  END IF;
  IF similarity('postgres', 'postgras') NOT BETWEEN 0.4 AND 0.9 THEN
    RAISE EXCEPTION 'pg_trgm returned an unexpected similarity';
  END IF;
  -- The rules come from share/tsearch_data/unaccent.rules, which the extension reads on first use.
  IF unaccent(U&'H\00F4tel') IS DISTINCT FROM 'Hotel' THEN
    RAISE EXCEPTION 'unaccent did not remove the accent';
  END IF;
  -- The digest and the cipher run in the bundled OpenSSL; ZIP compression runs in the bundled zlib.
  IF encode(digest('abc', 'sha256'), 'hex')
       <> 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
     OR crypt('proof', password_hash) IS DISTINCT FROM password_hash
     OR crypt('other', password_hash) = password_hash
     OR pgp_sym_decrypt(pgp_sym_encrypt(repeat('proof', 100), 'key', 'compress-algo=1'), 'key')
       <> repeat('proof', 100) THEN
    RAISE EXCEPTION 'pgcrypto returned an unexpected digest, password hash or PGP message';
  END IF;
  -- The view fails unless the server preloaded pg_stat_statements; this session has run statements.
  IF NOT EXISTS (SELECT FROM pg_stat_statements WHERE calls > 0) THEN
    RAISE EXCEPTION 'pg_stat_statements recorded no statement';
  END IF;
END
$$;

-- Keep a table that both dump proofs can restore independently of the extensions.
CREATE TABLE compression_sample (value text COMPRESSION lz4);
INSERT INTO compression_sample VALUES (repeat('portable-postgres', 1024));

SHOW timescaledb.telemetry_level;
SELECT extname, extversion FROM pg_extension ORDER BY extname;

-- A per-column collation does not prove that a database can use ICU as its default provider.
CREATE DATABASE icu_default TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'de-DE';
\connect icu_default
DO $$
BEGIN
  IF (SELECT datlocprovider FROM pg_database WHERE datname = current_database()) <> 'i'
     OR NOT (U&'\00E4' < 'z') THEN
    RAISE EXCEPTION 'The database did not use its ICU default locale';
  END IF;
END
$$;
\connect postgres
