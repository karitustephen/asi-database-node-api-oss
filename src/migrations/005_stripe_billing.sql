ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT;

ALTER TABLE tenants ADD COLUMN stripe_subscription_id TEXT;

ALTER TABLE tenants ADD COLUMN billing_status TEXT NOT NULL DEFAULT 'starter';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_stripe_subscription
  ON tenants (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL
);
