-- Runs BM25 indexing and a ranked query with pg_textsearch as the only preloaded library, so that a
-- dependency on TimescaleDB, which the combined proof also preloads, cannot go unnoticed.
DO $$
BEGIN
  IF current_setting('shared_preload_libraries') <> 'pg_textsearch' THEN
    RAISE EXCEPTION 'Expected pg_textsearch to be the only preloaded library, not %',
      current_setting('shared_preload_libraries');
  END IF;
END
$$;
CREATE EXTENSION pg_textsearch;
CREATE TABLE documents (id integer PRIMARY KEY, content text);
INSERT INTO documents VALUES (1, 'database postgres database'), (2, 'gardening flowers');
CREATE INDEX document_index ON documents USING bm25(content) WITH (text_config='english');
DO $$
BEGIN
  IF (SELECT id FROM documents ORDER BY content <@> 'database' LIMIT 1) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Expected document 1 to rank first for the BM25 query';
  END IF;
END
$$;
