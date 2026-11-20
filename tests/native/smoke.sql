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

SHOW timescaledb.telemetry_level;
SELECT extname, extversion FROM pg_extension ORDER BY extname;
