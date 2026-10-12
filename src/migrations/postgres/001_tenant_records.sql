CREATE SCHEMA IF NOT EXISTS tenant_data;

CREATE TABLE tenant_data.records (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  database_id TEXT NOT NULL,
  record_key TEXT NOT NULL CHECK (length(record_key) BETWEEN 1 AND 256),
  value JSONB NOT NULL CHECK (octet_length(value::text) <= 65536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (database_id, record_key)
);

ALTER TABLE tenant_data.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_data.records FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_records_isolation ON tenant_data.records
  USING (
    tenant_id = current_setting('asi.tenant_id', true)
    AND project_id = current_setting('asi.project_id', true)
    AND database_id = current_setting('asi.database_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('asi.tenant_id', true)
    AND project_id = current_setting('asi.project_id', true)
    AND database_id = current_setting('asi.database_id', true)
  );

GRANT USAGE ON SCHEMA tenant_data TO CURRENT_USER;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_data.records TO CURRENT_USER;
