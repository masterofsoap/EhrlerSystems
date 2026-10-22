-- Ehrler Systems core schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,               -- usr_xxx
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,                  -- pbkdf2$iter$salt$hash
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,                -- sha256 of the cookie value
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  key        TEXT NOT NULL,                     -- "email:<x>" or "ip:<x>"
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(key, created_at);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,                  -- cnv_xxx
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'chat',      -- chat | code
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,             -- msg_xxx
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL,                -- user | assistant
  content         TEXT NOT NULL,
  model           TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user_day ON messages(user_id, role, created_at);

-- ── "Sign in with Ehrler Systems" (OAuth 2.0 authorization code + PKCE) ──

CREATE TABLE IF NOT EXISTS oauth_clients (
  id            TEXT PRIMARY KEY,               -- e.g. "govariety"
  name          TEXT NOT NULL,                  -- shown on the consent screen
  secret_hash   TEXT,                           -- sha256 of client secret; NULL = public (PKCE-only) client
  redirect_uris TEXT NOT NULL,                  -- JSON array of exact allowed URIs
  homepage_url  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  scope          TEXT NOT NULL,
  code_challenge TEXT,
  expires_at     INTEGER NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                     -- access | refresh
  client_id  TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id, client_id);

CREATE TABLE IF NOT EXISTS oauth_grants (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id)
);
