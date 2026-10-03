CREATE TABLE IF NOT EXISTS shop_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS shop_settings (id text PRIMARY KEY, data jsonb NOT NULL);
INSERT INTO shop_settings VALUES ('transaction-lock', '{}') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS shop_users (
 id text PRIMARY KEY, data jsonb NOT NULL,
 email text GENERATED ALWAYS AS (lower(data->>'email')) STORED UNIQUE NOT NULL,
 role text GENERATED ALWAYS AS (data->>'role') STORED NOT NULL CHECK (role IN ('owner','customer'))
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_one_owner ON shop_users(role) WHERE role='owner';
CREATE TABLE IF NOT EXISTS shop_products (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS shop_variants (
 product_id text REFERENCES shop_products(id) ON DELETE CASCADE, variant_key text NOT NULL,
 stock integer CHECK (stock >= 0), PRIMARY KEY (product_id, variant_key)
);
CREATE TABLE IF NOT EXISTS shop_orders (
 id text PRIMARY KEY, data jsonb NOT NULL,
 user_id text GENERATED ALWAYS AS (data->>'userId') STORED NOT NULL REFERENCES shop_users(id),
 checkout_key text GENERATED ALWAYS AS (data->>'idempotencyKey') STORED,
 UNIQUE(user_id, checkout_key)
);
CREATE INDEX IF NOT EXISTS shop_orders_customer ON shop_orders(user_id);
CREATE TABLE IF NOT EXISTS shop_order_items (
 order_id text REFERENCES shop_orders(id) ON DELETE CASCADE, item_index integer NOT NULL,
 data jsonb NOT NULL, PRIMARY KEY(order_id, item_index),
 CHECK ((data->>'quantity')::integer > 0), CHECK ((data->>'price')::numeric >= 0)
);
CREATE TABLE IF NOT EXISTS shop_sessions (
 id text PRIMARY KEY CHECK (length(id)=64), data jsonb NOT NULL,
 user_id text GENERATED ALWAYS AS (data->>'userId') STORED NOT NULL REFERENCES shop_users(id) ON DELETE CASCADE,
 expires bigint GENERATED ALWAYS AS ((data->>'expires')::bigint) STORED NOT NULL
);
CREATE INDEX IF NOT EXISTS shop_sessions_expiry ON shop_sessions(expires);
CREATE TABLE IF NOT EXISTS shop_challenges (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS shop_inquiries (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS shop_uploads (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS shop_limits (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS shop_audit (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), action text NOT NULL, entity_id text NOT NULL);
