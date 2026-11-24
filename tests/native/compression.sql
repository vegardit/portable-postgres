-- Verify the restored contents and the compression method PostgreSQL actually used for storage.
DO $$
BEGIN
  IF (SELECT count(*) FROM compression_sample) <> 1
     OR NOT EXISTS (SELECT FROM compression_sample
                    WHERE value = repeat('portable-postgres', 1024)
                      AND pg_column_compression(value) = 'lz4') THEN
    RAISE EXCEPTION 'Expected the original row stored with LZ4 after restore';
  END IF;
END
$$;
