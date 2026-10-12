CREATE INDEX IF NOT EXISTS idx_projects_tenant_created
  ON projects (tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_databases_tenant_created
  ON databases (tenant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry
  ON sessions (user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_api_keys_user_revoked
  ON api_keys (user_id, revoked);

CREATE INDEX IF NOT EXISTS idx_audit_log_created
  ON audit_log (created_at);

CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_captured
  ON usage_events (tenant_id, captured_at);
