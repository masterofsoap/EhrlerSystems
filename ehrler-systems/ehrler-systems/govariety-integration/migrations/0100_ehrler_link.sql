-- Adds the link between a GoVariety user and their Ehrler Systems account.
-- Copy into GoVariety's migrations folder (renumber to follow its last migration) and apply:
--   npx wrangler d1 migrations apply <govariety-db-name> --remote
ALTER TABLE users ADD COLUMN ehrler_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_ehrler_sub ON users(ehrler_sub) WHERE ehrler_sub IS NOT NULL;
