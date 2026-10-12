CREATE TABLE IF NOT EXISTS usage_periods (
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,
  plan TEXT NOT NULL,
  included_operations INTEGER NOT NULL,
  used_operations INTEGER NOT NULL DEFAULT 0,
  reserved_operations INTEGER NOT NULL DEFAULT 0,
  grace_started_at TEXT,
  grace_deadline TEXT,
  PRIMARY KEY (tenant_id, period),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS usage_reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,
  operations INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, period) REFERENCES usage_periods(tenant_id, period)
);

CREATE INDEX IF NOT EXISTS idx_usage_reservations_expiry
  ON usage_reservations (expires_at);

CREATE TABLE IF NOT EXISTS billable_usage_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,
  operation TEXT NOT NULL,
  operations INTEGER NOT NULL,
  actor TEXT NOT NULL,
  resource TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, period) REFERENCES usage_periods(tenant_id, period)
);

CREATE INDEX IF NOT EXISTS idx_billable_usage_tenant_period
  ON billable_usage_events (tenant_id, period, occurred_at DESC);

CREATE TABLE IF NOT EXISTS usage_notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  usage_percent REAL NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, period, threshold),
  FOREIGN KEY (tenant_id, period) REFERENCES usage_periods(tenant_id, period)
);

CREATE INDEX IF NOT EXISTS idx_usage_notifications_tenant_created
  ON usage_notifications (tenant_id, created_at DESC);
