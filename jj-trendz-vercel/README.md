# JJ TrendZ — Vercel v0.9

This folder is a standalone Vercel project with the latest storefront and owner studio. It uses Postgres for shop data, Vercel Blob for photographs, and Resend for email. UPI remains a manual testing flow; no automatic payment confirmation is implemented.

## What changed

- Latest categories, galleries, colour/size variants, stock, filters, discounts, recommendations, editable homepage and order tracking.
- Customer and owner login require an emailed OTP. Owner sessions expire after eight hours. Customer password recovery verifies an email code and revokes old sessions.
- Session tokens are hashed in the database. Owner credential rotation invalidates owner sessions and outstanding owner verification codes.
- Shared database request limits, atomic inquiry limits, expiring verification codes, and hourly cleanup.
- Retry-safe checkout keys, transactional inventory reservation, and stale product-edit detection.
- Individual photo uploads below Vercel's request limit; real image decoding/re-encoding strips metadata and rejects malformed files. New photo references must come from authenticated uploads.
- Private API caching, trusted origins, CSP/framing headers, and generic unexpected errors with log references.
- Editable privacy, terms, delivery, and return/cancellation policies under Owner → Shop policies.

## Deploy in this order

1. Use a Vercel plan that supports a commercial shop and hourly cron. Hobby is restricted to non-commercial personal use. Cloudflare is not required and has not been configured.
2. Push **the contents of this folder** into a GitHub repository, keeping its structure. If pushing the whole workspace instead, set Vercel's Root Directory to `jj-trendz-vercel`.
3. Create a Neon database and a PUBLIC Vercel Blob store. Connect separate databases/storage for production and previews. Never point experimental previews at the production database.
4. Verify a sending domain in Resend and add its required DNS records. Configure the runtime values in `.env.example` in Vercel. `APP_ORIGIN` must be the exact production HTTPS origin without a trailing slash. For the first deployment it can be your stable project `.vercel.app` origin; update it when connecting your custom domain. `VERCEL_URL` is also accepted automatically; system-provided preview branch URLs are accepted only for previews.
5. Generate independent secrets for `OTP_SECRET` and `CRON_SECRET`, each at least 32 random characters. Keep those stable across redeploys. Generate a separate 32-byte hexadecimal `BACKUP_KEY` for administrative backups. Never send these values in chat or commit them.
6. Before deploying this new code to existing customers, take a database backup in Neon and pause writes on the old site. Stop old deployments from writing to the legacy database during and after migration: the old and new schemas do not synchronize.
7. On a trusted local machine, install Node 22 and run `npm ci`. Supply `MIGRATION_DATABASE_URL` and `OWNER_EMAIL` through private shell environment variables or a secrets manager, then run `npm run migrate`. Use the database admin connection for migration, not the restricted runtime connection. Migrations are not run automatically during builds or requests.
8. Create a restricted database runtime login using Neon's console. Adapt and run `migrations/runtime-permissions.sql` as the admin role. Configure Vercel's `DATABASE_URL` with that login's TLS-enabled pooled connection. Do not add the admin connection to Vercel runtime variables.
9. Import the repo in Vercel. Framework: Other; build: `npm run build`; output: `public`. These settings are also in `vercel.json`. Deploy after migration. The hourly `/api/maintenance` cron uses Vercel's `CRON_SECRET` Authorization header.
10. Open `/owner`, enter `OWNER_EMAIL` and `OWNER_PASSWORD`, and enter the emailed verification code. Populate stock, contact details, delivery charges and real business policies. Upload a photo and place a controlled test order. Check OTP and inquiry delivery in real mailboxes.
11. Connect your domain and test the storefront in an incognito browser. Make the intended production domain public in Deployment Protection settings; keep previews protected. Vercel login protection is separate from JJ TrendZ owner login.

The existing deployment URL in the earlier review required Vercel authentication. No account settings or live database were changed by the code upgrade.

## Database migration and recovery

`npm run migrate` runs a transaction and preserves legacy `jj_trendz_state` products, customers, inquiries, orders and settings. It creates separate users, products, variants, orders, order items, sessions, verification challenges, inquiries, uploads, rate-limit, settings, and audit tables. Old sessions are intentionally revoked. Legacy stock remains unset until the owner supplies a quantity; the migration does not invent inventory. The original legacy table remains untouched as a migration recovery source and should be retained privately only as long as your recovery policy requires.

Migration is rerunnable. Changing `OWNER_EMAIL` requires rerunning it; changing `OWNER_PASSWORD` requires redeploying. A customer/owner email collision fails instead of granting a customer owner access. Test the migration on an isolated copy first. Do not simply roll back to an older application after accepting new orders: old code reads the legacy schema and would miss new orders.

The adapter writes only changed records and enforces stock and order uniqueness constraints in Postgres. To retain one shared implementation with localhost, it currently assembles a shop snapshot and serializes writes with a transaction lock. This is deliberately scoped to a small boutique, not a high-volume marketplace. Measure database size/latency as the shop grows; route-specific queries and finer inventory locks are the next scaling step. Audit records currently identify the changed entity/action/time, not a full before/after history.

### Encrypted backups

Configure Neon's point-in-time restore/retention in its dashboard and rehearse restoring to an isolated branch. Provider retention and billing settings cannot be established from the application code.

For an additional encrypted database export, set `DATABASE_URL` to an authorized connection and `BACKUP_KEY` privately, then run:

```sh
npm run backup -- /private/backups/jj-trendz.backup
```

The command uses AES-256-GCM, creates a private file, and refuses to overwrite an existing backup. Store the key separately. Copy backups to independent private storage on a schedule; the repository does not upload backups automatically.

For a restore rehearsal, point `MIGRATION_DATABASE_URL` at a **new empty database**, set `RESTORE_TO_EMPTY_DATABASE=yes` and the matching `BACKUP_KEY`, then run:

```sh
npm run restore -- /private/backups/jj-trendz.backup
npm run migrate
```

Restore refuses a nonempty shop and revokes sessions/OTP codes. Validate order counts, stock, owner access and customer recovery before considering a traffic switch. Backups contain image URLs, not image bytes: independently retain/export Blob objects too. Deleted, unused uploaded images are removed after a 24-hour grace period, so a historical database restore may require restoring those image objects as well.

## Stock reservations and manual payments

Reservations last 24 hours before review. Hourly maintenance automatically cancels unpaid orders that never received any payment request and restores their stock exactly once. Orders with a UPI QR or payment link are flagged for owner review and retain stock, because a real receipt might exist. The owner must check receipts and disable active links before cancelling/releasing those orders. A QR shown previously cannot be remotely revoked. This is intentionally conservative while payment confirmation is manual.

A saved checkout key makes a repeated request return the original order; changed details under the same key are rejected. Owner editors include a product revision, so a sale while an editor is open makes an outdated save fail instead of resetting inventory.

## Photos and email

Each photo is uploaded in a separate authenticated request of at most 2 MB binary (under 3 MB as base64). The server validates dimensions and decodes/re-encodes as WebP. A five-photo gallery therefore avoids a single oversized Vercel request. Public product photos are appropriate for the Blob store; do not use it for customer documents. Orphan uploads are removed by maintenance after one day.

Email failures do not erase inquiries. The owner sees pending delivery and can retry. Payment-link and tracking emails retain their existing retry controls. OTP codes are never exposed by the production API. Configure alerting for Resend delivery failures, database/storage failures, function errors, and spending in the respective service dashboards.

## Verification and maintenance

```sh
npm ci
npm run check
npm test
npm audit --omit=dev
```

Tests cover permissions/OTP, retry-safe checkout, stock conflicts, customer isolation, upload validation, request limits, cleanup, and Postgres migration/constraints/rollback using an isolated PGlite Postgres engine. They do not replace a real Neon/Blob/Resend staging test or confirm your Vercel settings.

When working from the parent localhost workspace, shared source files are generated with `npm run sync:vercel`; `npm run check:vercel-sync` detects drift. Edit shared UI/business logic in the parent files. This folder remains self-contained when uploaded alone.

Official references: [Vercel payload limits](https://vercel.com/docs/functions/limitations), [Vercel cron configuration](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Postgres transactions](https://node-postgres.com/features/transactions), [Resend domain setup](https://resend.com/docs/dashboard/domains/introduction).
