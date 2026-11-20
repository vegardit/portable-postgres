-- Confirms that the native acceptance gate detects a failed assertion even when psql exits successfully.
BEGIN;
SELECT plan(1);
SELECT is(1, 2, 'deliberate assertion failure for the runner proof');
SELECT * FROM finish();
ROLLBACK;
