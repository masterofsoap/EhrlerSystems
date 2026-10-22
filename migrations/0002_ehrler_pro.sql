-- Ehrler Pro: plans, Stripe subscriptions and monthly usage metering.

ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- Usage units charged for each assistant reply (an estimate of AI compute).
ALTER TABLE messages ADD COLUMN units INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS subscriptions (
  id                   TEXT PRIMARY KEY,          -- Stripe subscription id (sub_…)
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id          TEXT NOT NULL,             -- Stripe customer id (cus_…)
  status               TEXT NOT NULL,             -- active, trialing, past_due, canceled, …
  price_id             TEXT,
  current_period_end   INTEGER,                   -- ms
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);

-- Stripe webhook events already processed (idempotency).
CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
