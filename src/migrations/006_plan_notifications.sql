DROP INDEX IF EXISTS idx_usage_notifications_tenant_created;

ALTER TABLE usage_notifications RENAME TO usage_notifications_legacy;

CREATE TABLE usage_notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,
  plan TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  usage_percent REAL NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, period, plan, threshold),
  FOREIGN KEY (tenant_id, period) REFERENCES usage_periods(tenant_id, period)
);

INSERT INTO usage_notifications (
  id, tenant_id, period, plan, threshold, usage_percent, state, created_at
)
SELECT
  old.id, old.tenant_id, old.period, COALESCE(usage.plan, 'starter'),
  old.threshold, old.usage_percent, old.state, old.created_at
FROM usage_notifications_legacy AS old
LEFT JOIN usage_periods AS usage
  ON usage.tenant_id = old.tenant_id AND usage.period = old.period;

DROP TABLE usage_notifications_legacy;

CREATE INDEX IF NOT EXISTS idx_usage_notifications_tenant_created
  ON usage_notifications (tenant_id, created_at DESC);
