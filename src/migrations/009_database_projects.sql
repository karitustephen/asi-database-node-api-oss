ALTER TABLE databases ADD COLUMN project_id TEXT;

CREATE INDEX IF NOT EXISTS databases_tenant_project_idx
  ON databases (tenant_id, project_id);
