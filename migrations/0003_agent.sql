-- Ehrler Systems agent: tool activity, uploads, connected accounts, paused runs, scheduled tasks.

-- Tool activity, images and attachments shown with a message (JSON array).
ALTER TABLE messages ADD COLUMN parts TEXT;

-- Uploaded and generated files. Bytes live in KV under "file:<id>".
CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,                  -- fil_xxx
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'upload',    -- upload | generated
  text_cache TEXT,                              -- extracted text (documents)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, created_at DESC);

-- Accounts the user connected (Google, GitHub). Tokens are encrypted when TOKEN_ENCRYPTION_KEY is set.
CREATE TABLE IF NOT EXISTS connections (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,                  -- google | github
  account       TEXT,                           -- email / login shown in the UI
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER,
  scope         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  verifier   TEXT,
  expires_at INTEGER NOT NULL
);

-- An agent run paused for an approval or for code to run in the browser.
CREATE TABLE IF NOT EXISTS agent_runs (
  id              TEXT PRIMARY KEY,             -- run_xxx
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL,
  model           TEXT NOT NULL,
  state           TEXT NOT NULL,                -- JSON: messages, parts, pending call, step
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

-- Recurring tasks ("every morning, summarize my inbox").
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,                 -- tsk_xxx
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  schedule    TEXT NOT NULL,                    -- JSON: {freq: daily|weekly|hourly|once, time:"08:00", days:[1..7], tz:"America/Denver", at}
  deliver     TEXT NOT NULL DEFAULT 'app',      -- app | email
  enabled     INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_status TEXT,
  conversation_id TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
