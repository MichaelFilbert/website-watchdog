CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE monitors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url              text NOT NULL,
  name             text NOT NULL,
  webhook_url      text,
  interval_seconds integer NOT NULL DEFAULT 300 CHECK (interval_seconds >= 10),
  active           boolean NOT NULL DEFAULT true,
  next_check_at    timestamptz NOT NULL DEFAULT now(),
  last_checked_at  timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX monitors_due_idx ON monitors (next_check_at) WHERE active;

CREATE TABLE snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id   uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  text         text NOT NULL,
  fetch_method text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX snapshots_monitor_idx ON snapshots (monitor_id, created_at DESC);

CREATE TABLE changes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id           uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  previous_snapshot_id uuid NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  snapshot_id          uuid NOT NULL UNIQUE REFERENCES snapshots(id) ON DELETE CASCADE,
  added                jsonb NOT NULL,
  removed              jsonb NOT NULL,
  context              jsonb NOT NULL DEFAULT '[]',
  -- pending -> classified | filtered_noise | failed
  status               text NOT NULL CHECK (status IN ('pending', 'classified', 'filtered_noise', 'failed')),
  meaningful           boolean,
  category             text CHECK (category IN ('price', 'availability', 'policy', 'content', 'outage', 'noise')),
  severity             text CHECK (severity IN ('low', 'medium', 'high')),
  summary              text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  classified_at        timestamptz
);
CREATE INDEX changes_monitor_idx ON changes (monitor_id, created_at DESC);

CREATE TABLE jobs (
  id              bigserial PRIMARY KEY,
  type            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  idempotency_key text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 5,
  run_at          timestamptz NOT NULL DEFAULT now(),
  locked_by       text,
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs (run_at, id) WHERE status = 'queued';
CREATE INDEX jobs_lease_idx ON jobs (locked_until) WHERE status = 'running';

-- One row per delivery attempt (the delivery log).
CREATE TABLE webhook_deliveries (
  id          bigserial PRIMARY KEY,
  change_id   uuid NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  url         text NOT NULL,
  attempt     integer NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('success', 'failure')),
  status_code integer,
  error       text,
  duration_ms integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_change_idx ON webhook_deliveries (change_id);
-- Database-level guarantee: a change is successfully delivered at most once.
CREATE UNIQUE INDEX webhook_deliveries_one_success ON webhook_deliveries (change_id) WHERE outcome = 'success';

CREATE TABLE llm_calls (
  id            bigserial PRIMARY KEY,
  change_id     uuid REFERENCES changes(id) ON DELETE SET NULL,
  provider      text NOT NULL,
  model         text NOT NULL,
  latency_ms    integer NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd      numeric(12, 6) NOT NULL DEFAULT 0,
  outcome       text NOT NULL, -- ok | malformed | refusal | timeout | rate_limit | error
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
