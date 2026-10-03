-- Run as the migration/admin role after creating a separate runtime login in Neon.
-- Replace jj_runtime with that login's role name. Never paste its password here.
GRANT USAGE ON SCHEMA public TO jj_runtime;
GRANT SELECT ON shop_migrations TO jj_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
 shop_settings, shop_users, shop_products, shop_variants, shop_orders,
 shop_order_items, shop_sessions, shop_challenges, shop_inquiries,
 shop_uploads, shop_limits TO jj_runtime;
GRANT INSERT ON shop_audit TO jj_runtime;
GRANT USAGE, SELECT ON SEQUENCE shop_audit_id_seq TO jj_runtime;
-- No runtime access to legacy jj_trendz_state or schema creation is needed.
