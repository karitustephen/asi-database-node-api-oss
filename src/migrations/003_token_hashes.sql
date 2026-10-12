ALTER TABLE sessions ADD COLUMN token_hash TEXT;

ALTER TABLE api_keys ADD COLUMN token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash
  ON sessions (token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_token_hash
  ON api_keys (token_hash);
