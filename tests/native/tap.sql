-- Emits real TAP assertions for interpretation by a TAP runner, without Perl in the bundle.
BEGIN;
SELECT plan(6);
SELECT is((SELECT count(*)::integer FROM pg_extension WHERE extname IN
  ('vector', 'timescaledb', 'pg_textsearch', 'hypopg', 'plpgsql_check', 'pg_cron', 'pg_partman', 'pgtap')), 8,
  'all selected extensions coexist');
-- On three rows the planner prefers a sequential scan; the assertion must go through the HNSW index.
SET LOCAL enable_seqscan = off;
SELECT is((SELECT id FROM embeddings ORDER BY embedding <-> '[1,0,0]' LIMIT 1), 1, 'vector nearest neighbor');
RESET enable_seqscan;
SELECT is(current_setting('timescaledb.telemetry_level'), 'off', 'TimescaleDB telemetry disabled');
SELECT is((SELECT count(*)::integer FROM measurements), 2, 'hypertable retains rows');
SELECT ok(EXISTS (SELECT 1 FROM pg_class WHERE relname = 'document_index'), 'BM25 index created');
SELECT ok(EXISTS (SELECT 1 FROM cron_proof), 'explicit cron job executed');
SELECT * FROM finish();
ROLLBACK;
